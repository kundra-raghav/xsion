/**
 * attackScaffold.ts — DETERMINISTIC attack-class coverage (the plan-variance fix, task-critical).
 *
 * THE PROBLEM: SoA re-plans from scratch every run, so WHICH invariant it probes drifts — the fixture's planted
 * end-before-start bug was found only 1 of 3 runs because the "ordering" attack was sometimes simply not planned.
 * A QA tool that gives different coverage on an unchanged app is untrustworthy.
 *
 * THE FIX (advisor): the CHECKLIST lives in CODE, not the prompt (a prompt is a request, not a guarantee). We
 * enumerate the invariant attack CLASSES that apply to each OBSERVED field (from the crawl's requirements[], not
 * synthesized), and for every (class × field) SoA's plan didn't cover, we synthesize the step locally with a
 * MECHANICAL oracle. Same app → same classes every run, at any temperature. SoA still contributes values + richer
 * oracles where it plans them. This is the same "derive from observed data, don't synthesize" principle as the
 * api prober and the field matcher.
 *
 * PURE — no LLM, no IO — so it's fully hermetic-provable (the point: determinism you can assert on a fixture).
 */
import type { BreakStep, BreakField } from './soaClient';

export interface ObservedField { kind: string; label?: string; required?: boolean; maxLength?: number; }

export type AttackClass = 'empty' | 'long' | 'type-mismatch' | 'ordering';

// which classes apply to a field, purely from its kind/required. No app-specific words.
export function classesFor(f: ObservedField): AttackClass[] {
  const cls: AttackClass[] = [];
  if (f.required) cls.push('empty');                                   // a required field must reject blank
  if (/text|string|search|url|tel|email|textarea/i.test(f.kind)) cls.push('long');   // text fields: overflow
  if (/number|date|time|datetime/i.test(f.kind)) cls.push('type-mismatch');          // typed fields: wrong type
  return cls;
}

const EARLY = /\b(start|begin|from|opening|lower|earliest|min|minimum)\b/i;
const LATE = /\b(end|finish|closing|upper|latest|until|max|maximum)\b/i;
// a shared RANGE-ISH stem is what makes two fields the SAME QUANTITY measured at two ends (a real range), vs two
// unrelated fields that happen to carry a directional word. "Start DATE"/"End DATE" share `date`; "First NAME"/
// "Last NAME" share `name` — but `name` isn't range-ish, so it's rejected. Structural: no app-specific labels.
const RANGE_STEM = /\b(date|time|day|month|year|price|amount|cost|count|qty|quantity|value|number|age|score|weight|height|size|range|period|duration|hour|minute)\b/i;

// strip the directional token from a label → the "remainder" (the noun the field is about). Two fields are the
// SAME QUANTITY iff their remainders match. "Start"/"End" → ""/"" (a bare range); "start date"/"end date" →
// "date"/"date"; "First name"/"Last name" → "name"/"name" (matches, but "name" isn't range-ish → not a range).
function remainderOf(label: string): string {
  return label.toLowerCase().replace(EARLY, ' ').replace(LATE, ' ').replace(/\s+/g, ' ').trim();
}

/** ORDERING is a PAIR relation: two fields that are the SAME range-ish quantity measured at two ends — they share a
 *  range-ish stem (date/time/price/count/…), one labelled EARLY (start/from/min), the other LATE (end/to/max). OR
 *  both fields carry a declared min/max (an ordered domain by definition). Structural — "First name"/"Last name"
 *  share `name` (not range-ish) → NOT a pair, so no manufactured "Last before First" attack. Works on any app. */
export function orderingPairs(fields: ObservedField[]): Array<{ early: ObservedField; late: ObservedField }> {
  const pairs: Array<{ early: ObservedField; late: ObservedField }> = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = 0; j < fields.length; j++) {
      if (i === j) continue;
      const a = fields[i], b = fields[j];
      const la = a.label || '', lb = b.label || '';
      if (!(EARLY.test(la) && LATE.test(lb))) continue;
      // SAME-QUANTITY gate: strip the directional word; the remainders must MATCH, and be either EMPTY (a bare
      // Start/End range) or RANGE-ISH (start date/end date). Equal-but-not-range remainders ("name" in First/Last
      // name) are rejected → no manufactured "Last before First" attack. OR: both fields are an ordered kind.
      const ra = remainderOf(la), rb = remainderOf(lb);
      const remaindersMatch = ra === rb && (ra === '' || RANGE_STEM.test(ra));
      const bothOrderedKind = /number|date|time|datetime/i.test(a.kind) && a.kind === b.kind;
      if (!remaindersMatch && !bothOrderedKind) continue;
      pairs.push({ early: a, late: b });
    }
  }
  const seen = new Set<string>();
  return pairs.filter((p) => { const k = `${p.early.label}|${p.late.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** a canonical KEY for "which class × which field" a step covers — so we don't duplicate what SoA already planned. */
function stepCoverageKey(cls: string, fieldLabel: string): string { return `${cls}::${(fieldLabel || '').toLowerCase().replace(/\s+/g, ' ').trim()}`; }

/** infer which (class,field) an existing SoA step already covers, from its title + fields' modes. Best-effort:
 *  we only need to AVOID double-adding, and a false "not covered" just adds a redundant step (deduped by title). */
function coveredByPlan(plan: BreakStep[]): Set<string> {
  const covered = new Set<string>();
  for (const s of plan) {
    const names = (s.fields || []).map((f) => (f.name || '').toLowerCase());
    for (const f of (s.fields || [])) {
      const label = (f.name || '').toLowerCase();
      if (f.mode === 'empty' || f.mode === 'omit') covered.add(stepCoverageKey('empty', label));
      if (f.mode === 'long') covered.add(stepCoverageKey('long', label));
    }
    // ORDERING dedup is keyed on the actual FIELD PAIR (not a loose title regex — that global suppression key was
    // wrongly set by any title containing "order"/"after"/etc, silently killing the scaffold's ordering step and
    // defeating the coverage guarantee). Only suppress an ordering attack when a plan step FILLS BOTH pair fields.
    if (names.length >= 2) {
      for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) {
        if (i !== j) covered.add(`ordering::${names[i]}|${names[j]}`);
      }
    }
  }
  return covered;
}

/** a VALID value for a field's kind — so a scaffold attack can hold every OTHER field valid while violating exactly
 *  one invariant. Without this, the app's FIRST guard (e.g. "title required") preempts the invariant under test and
 *  the verdict is wrong (held when it should be broke). General, per-kind. */
export function validValueFor(f: ObservedField): string {
  if (/date|datetime/i.test(f.kind)) return '2026-08-15';
  if (/^time$/i.test(f.kind)) return '10:00';
  if (/number/i.test(f.kind)) return '5';
  if (/email/i.test(f.kind)) return 'valid@example.com';
  if (/tel|phone/i.test(f.kind)) return '5551234567';
  if (/url/i.test(f.kind)) return 'https://example.com';
  return 'XSION valid';   // text/search/textarea/other
}

/** Build the deterministic set of scaffold steps that SoA's plan is MISSING. mechanical oracle: reject=held, accept=broke.
 *  EVERY attack holds all OTHER fields VALID so exactly ONE invariant is violated (else the app's first guard preempts). */
export function scaffoldMissing(fields: ObservedField[], plan: BreakStep[]): BreakStep[] {
  const covered = coveredByPlan(plan);
  const out: BreakStep[] = [];
  const mk = (title: string, intent: string, bf: BreakField[], acceptIsDefect: boolean): BreakStep => ({
    phase: 'adversarial', title, intent, fields: bf, acceptIsDefect, value: title,
    apiHint: '', expectHeld: 'the app rejects it with a validation message (field error / submit blocked)',
    expectBroke: 'the app ACCEPTS it (saves/creates with no validation error)', codeRef: null,
  });
  // valid fillers for every field EXCEPT the named target(s) — so only the attack's field is invalid.
  const validOthers = (exceptLabels: string[]): BreakField[] => {
    const ex = new Set(exceptLabels.map((l) => l.toLowerCase()));
    return fields.filter((f) => !ex.has((f.label || f.kind).toLowerCase()))
      .map((f) => ({ name: f.label || f.kind, mode: 'literal' as const, value: validValueFor(f) }));
  };
  for (const f of fields) {
    const label = f.label || f.kind;
    for (const cls of classesFor(f)) {
      if (cls === 'empty' && !covered.has(stepCoverageKey('empty', label.toLowerCase()))) {
        // the attack: THIS field blank, all others valid. (leave target unfilled = the empty attack.)
        out.push(mk(`Submit with empty ${label}`, `fill every field validly EXCEPT leave "${label}" blank, then submit`, [...validOthers([label]), { name: label, mode: 'empty', value: '' }], !!f.required));
      } else if (cls === 'long' && !covered.has(stepCoverageKey('long', label.toLowerCase()))) {
        out.push(mk(`Overflow ${label} with a very long value`, `fill "${label}" with a 5000-char value, all other fields valid, then submit`, [...validOthers([label]), { name: label, mode: 'long', value: '5000' }], false));
      } else if (cls === 'type-mismatch' && !covered.has(stepCoverageKey('type', label.toLowerCase()))) {
        out.push(mk(`Type mismatch in ${label}`, `fill "${label}" with a non-${f.kind} value ("abc"), all other fields valid, then submit`, [...validOthers([label]), { name: label, mode: 'literal', value: 'abc' }], true));
        covered.add(stepCoverageKey('type', label.toLowerCase()));   // this field's type class now covered
      }
    }
  }
  // ORDERING: for each early/late pair, a "late < early" attack (end before start) — UNLESS a plan step already
  // fills both pair fields (keyed on the field pair, not a loose title regex).
  for (const p of orderingPairs(fields)) {
    const el = (p.early.label || '').toLowerCase(), ll = (p.late.label || '').toLowerCase();
    if (covered.has(`ordering::${el}|${ll}`) || covered.has(`ordering::${ll}|${el}`)) continue;
    const isDate = /date|time/i.test(p.early.kind) || RANGE_STEM.test(remainderOf(p.early.label || ''));
    const earlyVal = isDate ? '2026-08-15' : '10';
    const lateVal = isDate ? '2026-08-10' : '1';   // deliberately BEFORE/less than the early field
    out.push(mk(`${p.late.label} before ${p.early.label}`,
      `set "${p.early.label}" to ${earlyVal} and "${p.late.label}" to ${lateVal} (an invalid range), ALL OTHER fields valid, and submit`,
      [...validOthers([p.early.label || '', p.late.label || '']), { name: p.early.label || '', mode: 'literal', value: earlyVal }, { name: p.late.label || '', mode: 'literal', value: lateVal }],
      true));
  }
  return out;
}
