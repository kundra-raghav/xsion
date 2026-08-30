/**
 * Hermetic checks for the deterministic attack-class scaffold — the plan-variance fix. Proves: same observed fields
 * → same attack classes EVERY time (no LLM, no randomness), the ordering pair is detected structurally, and the
 * scaffold fills only what SoA's plan MISSED (no duplicates). Run: npx tsx src/brain/attackScaffold.hermetic.ts
 */
import { classesFor, orderingPairs, scaffoldMissing, ObservedField } from './attackScaffold';
import type { BreakStep } from './soaClient';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

console.log('attackScaffold hermetic checks');

// the fixture's real fields: title(text,required), start(date), end(date)
const fields: ObservedField[] = [
  { kind: 'text', label: 'Event title', required: true },
  { kind: 'date', label: 'Start date' },
  { kind: 'date', label: 'End date' },
];

// classesFor
ok('required text → empty + long', JSON.stringify(classesFor(fields[0]).sort()) === JSON.stringify(['empty', 'long']));
ok('date → type-mismatch only (not required)', JSON.stringify(classesFor(fields[1])) === JSON.stringify(['type-mismatch']));

// ordering: start/end date pair detected STRUCTURALLY (no "end before start" hardcode)
const pairs = orderingPairs(fields);
ok('ordering pair detected (Start date → End date)', pairs.length === 1 && pairs[0].early.label === 'Start date' && pairs[0].late.label === 'End date');
ok('no ordering pair when labels lack early/late sense', orderingPairs([{ kind: 'date', label: 'Birthday' }, { kind: 'date', label: 'Anniversary' }]).length === 0);
ok('no ordering pair across different kinds', orderingPairs([{ kind: 'date', label: 'Start date' }, { kind: 'number', label: 'End count' }]).length === 0);
// BOUNDARY CASES (the false-positive guard the advisor flagged):
// bare "Start"/"End" as TEXT (the real fixture case — placeholder truncated to "Start"/"End") → MUST pair (empty remainder).
ok('bare Start/End text fields → pair (empty remainder)', orderingPairs([{ kind: 'text', label: 'Start' }, { kind: 'text', label: 'End' }]).length === 1);
// "First name"/"Last name" → MUST NOT pair (remainder "name" is not range-ish) — the manufactured-broke guard.
ok('First name / Last name → NO pair (name is not a range)', orderingPairs([{ kind: 'text', label: 'First name' }, { kind: 'text', label: 'Last name' }]).length === 0);
// "start date"/"end date" text → pair (shared range-ish remainder "date").
ok('start date / end date text → pair (range remainder)', orderingPairs([{ kind: 'text', label: 'start date' }, { kind: 'text', label: 'end date' }]).length === 1);

// scaffold on an EMPTY plan → must include the ordering attack + empty-title + overflow + type-mismatch
const fromEmpty = scaffoldMissing(fields, []);
const titles = fromEmpty.map((s) => s.title.toLowerCase());
ok('scaffold from empty plan includes the ORDERING attack (the drifting one)', titles.some((t) => /end date before start date/.test(t)));
ok('scaffold from empty plan includes empty-title', titles.some((t) => /empty event title/.test(t)));
ok('scaffold from empty plan includes overflow', titles.some((t) => /overflow event title/.test(t)));
ok('scaffold from empty plan includes a type-mismatch', titles.some((t) => /type mismatch/.test(t)));

// DETERMINISM: same input → identical output, twice.
const a = scaffoldMissing(fields, []).map((s) => s.title);
const b = scaffoldMissing(fields, []).map((s) => s.title);
ok('DETERMINISTIC: identical scaffold on repeat', JSON.stringify(a) === JSON.stringify(b));

// NO DUPLICATE: if SoA already planned the ordering attack AND FILLS BOTH pair fields, the scaffold must NOT add
// another (dedup is keyed on the actual field pair — a titles-only match is NOT trusted, per the loose-regex fix).
const planWithOrdering: BreakStep[] = [{ phase: 'adversarial', title: 'End time before start time', intent: 'x', fields: [{ name: 'Start date', mode: 'literal', value: '2026-08-15' }, { name: 'End date', mode: 'literal', value: '2026-08-10' }], acceptIsDefect: true, value: '', apiHint: '', expectHeld: 'reject', expectBroke: 'accept', codeRef: null }];
ok('scaffold does NOT duplicate an ordering attack that FILLS BOTH pair fields', !scaffoldMissing(fields, planWithOrdering).some((s) => /before/.test(s.title.toLowerCase())));
// but a titles-only "ordering" step with NO fields does NOT suppress (we can't confirm coverage → add ours).
const planTitleOnly: BreakStep[] = [{ phase: 'adversarial', title: 'reverse the order somehow', intent: 'x', fields: [], acceptIsDefect: true, value: '', apiHint: '', expectHeld: 'reject', expectBroke: 'accept', codeRef: null }];
ok('a titles-only ordering step does NOT suppress the scaffold (coverage unconfirmed)', scaffoldMissing(fields, planTitleOnly).some((s) => /before/.test(s.title.toLowerCase())));

// NO DUPLICATE: if SoA already planned empty-title (via mode:empty), don't re-add it.
const planWithEmpty: BreakStep[] = [{ phase: 'adversarial', title: 'blank title', intent: 'x', fields: [{ name: 'Event title', mode: 'empty', value: '' }], acceptIsDefect: true, value: '', apiHint: '', expectHeld: 'reject', expectBroke: 'accept', codeRef: null }];
ok('scaffold does NOT duplicate an empty-title SoA already planned', !scaffoldMissing(fields, planWithEmpty).some((s) => /empty event title/.test(s.title.toLowerCase())));

// ISOLATION: every attack holds all OTHER fields valid so exactly one invariant is violated (else the app's first
// guard preempts — the ordering attack scored held because it left Title blank → "Title required" fired first).
const ordStep = fromEmpty.find((s) => /before/.test(s.title.toLowerCase()))!;
ok('ordering step fills a VALID Title (not left blank)', ordStep.fields.some((f) => f.name.toLowerCase() === 'event title' && f.mode === 'literal' && !!f.value.trim()));
const emptyTitleStep = fromEmpty.find((s) => /empty event title/.test(s.title.toLowerCase()))!;
ok('empty-title attack leaves Title blank but fills Start+End valid', emptyTitleStep.fields.find((f) => f.name.toLowerCase() === 'event title')?.mode === 'empty' && emptyTitleStep.fields.some((f) => /start/.test(f.name.toLowerCase()) && f.mode === 'literal'));

// every scaffold step has a mechanical oracle (no post-hoc judgement)
ok('every scaffold step carries expectHeld + expectBroke', fromEmpty.every((s) => !!s.expectHeld && !!s.expectBroke));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
