/**
 * breakItService.ts — THE BREAK-IT ENGINE (adversarial QA, the soul of Xsion).
 *
 * Replaying a learned flow is NOT testing. This engine TRIES TO BREAK a feature: happy-path baseline → CRUD
 * lifecycle → adversarial attacks → API probing. SoA plans each attack with a PRE-DECLARED oracle (expectHeld =
 * a correct app, expectBroke = the failure signal); the engine executes against the live app and matches what it
 * OBSERVES against that oracle — never a post-hoc "is this a bug?" judgement (the confident-wrong failure mode).
 *
 * VERDICT FLOOR (reused from the audit): a 'broke' finding REQUIRES a mechanically-observed fact — an HTTP 5xx, a
 * console exception, a rendered stack-trace, or the app ACCEPTING clearly-invalid data. A validation error shown
 * = HELD (pass). A selector miss / wrong-page = 'needs-review', NEVER a bug.
 *
 * MUTATION SAFETY (code-enforced, not left to SoA): every value the engine creates is tagged with an identifiable
 * marker `XSION-TEST-<runId>`. The CRUD phase deletes what IT created. The engine NEVER mutates a record it didn't
 * create in this run. Requires the same per-project authorization consent as the security audit.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { breakItPlan, BreakStep } from './soaClient';
import { executeFlow } from './intentRunner';
import { makeFrameHook, FrameHook } from './liveFrame';

export type BreakVerdict = 'held' | 'broke' | 'needs-review' | 'skipped' | 'passed';

export interface BreakFinding {
  phase: string;
  title: string;
  verdict: BreakVerdict;
  detail: string;
  expectHeld?: string;
  expectBroke?: string;
  codeRef?: string | null;
  reproduce?: { intent: string; value?: string; observed: string };
}

export type BreakEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'breakit:finding'; index: number; finding: BreakFinding }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: BreakEvent) { wsServer.broadcastToRun(runId, e as any); }

export interface BreakOpts { repo: string; feature: string; flowId?: string; destructiveAck?: boolean; }

export function startBreakIt(projectId: string, baseUrl: string, opts: BreakOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Break-it · ${opts.feature}` } as any);
  runBreakIt(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'test:think', message: `break-it error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Run failed', kind: 'breakit' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

async function runBreakIt(runId: string, projectId: string, baseUrl: string, opts: BreakOpts) {
  const project = store.getProject(projectId);
  const map = store.getProjectMap(projectId);
  const marker = `XSION-TEST-${runId.slice(0, 8)}`;   // every value we CREATE carries this → only mutate our own

  emit(runId, { type: 'test:phase', phase: 'start', label: 'Planning the attacks', kind: 'breakit' });

  // ── CONSENT GATE: the break-it engine MUTATES the live app (create/update/delete). Same attestation the audit
  // needs. Without it, we run the READ-ONLY phases only (happy-path checks + adversarial that don't submit).
  const authorized = !!(project as any)?.security?.authorized;
  if (!authorized) {
    emit(runId, { type: 'test:think', message: 'Break-it mutates the live app (creates/edits/deletes test data). It needs the per-project "I own/authorize this target" attestation. Running the NON-MUTATING checks only.' });
  }

  // SoA plans the attacks (code-grounded in Mode 1)
  const surface = {
    baseUrl,
    pages: (map?.pages || []).map((p: any) => ({ path: p.path })).slice(0, 30),
    api: (map?.api || []).map((e: any) => (e.graphql ? `${e.gqlKind} ${e.gqlOperation}` : `${e.method} ${e.url}`)).slice(0, 30),
    flows: (map?.flows || []).map((f: any) => ({ name: f.name, steps: f.steps?.length })),
  };
  const { plan, error } = await breakItPlan(opts.repo, { feature: opts.feature, surface });
  if (error) emit(runId, { type: 'test:think', message: `Plan note: ${error}` });
  if (!plan.length) {
    emit(runId, { type: 'test:think', message: 'SoA did not return an attack plan (the feature may be too thin, or the code unreadable).' });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'No plan', kind: 'breakit' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString() });
    return;
  }
  emit(runId, { type: 'test:think', message: `SoA planned ${plan.length} checks: ${countByPhase(plan)}. Every attack has a pre-declared oracle, so a "broke" is mechanically checkable.` });

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Attacking the feature', kind: 'breakit' });
  const findings: BreakFinding[] = [];
  let held = 0, broke = 0, review = 0, skipped = 0;
  // ONE shared frame hook for the whole run — every attack's frames accumulate into a single ordered manifest
  // (frameHook.frames) we attach to the record for playback. Live streaming stays throttled; disk gets every frame.
  const frameHook = makeFrameHook(runId, emit as any);

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    // tag every frame this attack produces with its case index + title → per-case playback clips (frame ↔ finding[i]).
    frameHook.caseIndex = i; frameHook.caseTitle = `[${step.phase}] ${step.title}`;
    emit(runId, { type: 'test:item-start', index: i, title: `[${step.phase}] ${step.title}` });
    const finding = await runStep(runId, baseUrl, step, marker, authorized, opts, frameHook);
    findings.push(finding);
    if (finding.verdict === 'broke') broke++;
    else if (finding.verdict === 'held' || finding.verdict === 'passed') held++;
    else if (finding.verdict === 'skipped') skipped++;
    else review++;

    const status = finding.verdict === 'broke' ? 'fail' : (finding.verdict === 'held' || finding.verdict === 'passed') ? 'pass' : finding.verdict === 'skipped' ? 'skipped' : 'unverifiable';
    emit(runId, { type: 'test:item-result', index: i, status, detail: `${finding.verdict.toUpperCase()} — ${finding.detail}`, evidence: finding.codeRef || undefined });
    emit(runId, { type: 'breakit:finding', index: i, finding });
  }

  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'break-it', feature: opts.feature, marker, findings, frames: frameHook.frames } as any] } as any);
  emit(runId, { type: 'test:phase', phase: 'done', label: 'Attack complete', kind: 'breakit' });
  emit(runId, { type: 'test:think', message: `Done — ${broke} broke, ${held} held, ${review} needs-review, ${skipped} skipped. Findings are oracle-matched${opts.repo ? ' and code-cited' : ''}.` });
  emit(runId, { type: 'test:done', passed: held, failed: broke, skipped: skipped + review, total: plan.length });
}

/** Execute one attack step and judge it against its PRE-DECLARED oracle. */
// exported for hermetic testing (the api-phase + consent guards return before any browser/network I/O)
export async function runStep(runId: string, baseUrl: string, step: BreakStep, marker: string, authorized: boolean, opts: BreakOpts, frameHook?: FrameHook): Promise<BreakFinding> {
  const base: BreakFinding = { phase: step.phase, title: step.title, verdict: 'needs-review', detail: '', expectHeld: step.expectHeld, expectBroke: step.expectBroke, codeRef: step.codeRef };
  const mutating = step.phase === 'crud' || step.phase === 'api' || /submit|create|send|save|delete|update|broadcast|post/i.test(step.intent + ' ' + step.title);

  // SAFETY: a mutating step only runs with authorization. Without it, we record the step + SoA's oracle as
  // needs-review (the reasoning stands; it just wasn't executed live).
  if (mutating && !authorized) {
    return { ...base, verdict: 'needs-review', detail: `mutating step — needs the "I own/authorize this target" attestation to run live. SoA's oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".` };
  }

  // API PROBE: the engine has NO API-request path yet — every step runs through the UI executor. So an 'api' step
  // would silently execute as a form-fill and return a MISLEADING verdict (a UI accept read as an API 201). Until a
  // real API prober exists, record the step as needs-review with SoA's oracle intact (same discipline as the
  // consent gate above). The oracle reasoning is the valuable part; it's what the future prober will execute.
  if (step.phase === 'api') {
    return { ...base, verdict: 'needs-review', detail: `API probe planned but not executed — the engine has no API-request path yet (an 'api' step must NOT run as a UI fill). SoA's oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".${step.apiHint ? ` (${step.apiHint})` : ''}` };
  }

  // Turn the attack into CONCRETE field-fill steps + a submit, from the STRUCTURED `fields` SoA declared. Each field
  // carries an explicit `mode` so the executor never guesses intent from prose (the "(empty)"/"(5000 A's)"
  // placeholder-injection bug: the literal placeholder text used to get typed as the value, so an "empty title"
  // attack actually submitted the string "(empty)" and the app correctly saved it → a fabricated finding).
  //   literal → type `value` exactly   ·   long → type `value`-count filler chars   ·   empty/omit → do NOT fill.
  // A field left 'empty' ON PURPOSE is the attack itself — we must NOT substitute a default, so we skip filling it
  // and rely on the app to reject (or wrongly accept) the blank.
  // Normalize: a 'literal' whose value is whitespace-only is behaviorally IDENTICAL to 'empty' — the intent runner
  // trims fill values (intentRunner parseIntent: `withVal[1].trim()`), so "   " becomes an empty fill regardless.
  // Treat it as 'empty' so it takes the deliberate-blank path (not filled, drove-accounting honest) and a
  // whitespace attack is never scored on an ambiguous fill. Its acceptIsDefect still decides accept-vs-held.
  const fields = (step.fields || []).filter((f) => f && f.name).map((f) =>
    f.mode === 'literal' && f.value && !f.value.trim() ? { ...f, mode: 'empty' as const, value: '' } : f);
  const steps: any[] = [];
  const fillable = fields.filter((f) => f.mode === 'literal' || f.mode === 'long');
  for (const f of fillable) {
    let val = f.value;
    if (f.mode === 'long') { const n = Math.min(parseInt(f.value, 10) || 5000, 20000); val = 'A'.repeat(n); }
    // Tag free-text identity fields with the run marker so we only ever touch our OWN test data — but ONLY when the
    // value is already NON-BLANK (guard on val.trim(), not val: '   ' is truthy, so tagging a whitespace-only title
    // would append the marker and make it non-empty, DEFEATING the whitespace attack and producing a false 'broke').
    // Inherent tension: an attack whose point is a blank/whitespace field can't carry the marker without defeating
    // itself, so if the app wrongly accepts it an untagged row lands — an unavoidable, non-blocking mutation cost
    // (the step is EXPECTED to be rejected; acceptance is precisely the finding).
    const tagged = f.mode === 'literal' && /title|name|body|message|note|subject/i.test(f.name) && val.trim() ? `${val} ${marker}`.slice(0, 200) : val;
    steps.push({ intent: `fill the "${f.name}" field with "${tagged}"` });
  }
  if (fields.length) {
    steps.push({ intent: 'click the Save button', expectedOutcome: step.expectHeld });
  } else {
    // no structured fields → run the raw intent (e.g. a pure click/out-of-order attack)
    steps.push({ intent: step.intent, expectedOutcome: step.expectHeld });
  }
  const flow = { name: step.title, role: 'tester', steps };

  let consoleErrors: string[] = [];
  let observed = '';
  let finalText = '';
  // the flow = one fill per fillable field + a final click. "drove" = the fill steps mostly passed AND the click
  // landed, so the attack actually reached the app (a submit happened). Judged by step PASS, not by kind string.
  const fillSteps = fillable.length;
  const drovePass = { fills: 0, clicked: false };
  try {
    const exec = await executeFlow(flow as any, baseUrl, {
      onConsoleError: (m) => { consoleErrors.push(m); },
      onFrame: frameHook,   // LIVE VIEW + PLAYBACK: shared hook streams live + persists frames for this run
    });
    const sr = exec.stepResults.filter((s) => s.stepIndex >= 0);
    // the first `fillSteps` steps are fills; the last is the click
    sr.forEach((s, i) => { if (i < fillSteps) { if (s.status === 'pass') drovePass.fills++; } else if (s.status === 'pass') drovePass.clicked = true; });
    observed = sr.map((s) => `${s.status}:${s.note || s.attempts?.[0]?.error || ''}`).join(' | ').slice(0, 300);
    finalText = exec.finalText || '';
  } catch (e: any) {
    return { ...base, verdict: 'needs-review', detail: `could not execute the step: ${String(e?.message || e).slice(0, 100)}` };
  }

  // ── THE VERDICT FLOOR (match OBSERVATION vs the pre-declared oracle) ──
  // Signals come from: console errors, the step outcomes, AND the RESULT PAGE TEXT (the "Error…"/"Saved…" message).
  const obsLower = (observed + ' ' + consoleErrors.join(' ') + ' ' + finalText).toLowerCase();
  const hasException = consoleErrors.length > 0;
  const has5xx = /http 5\d\d|status 5\d\d|\b500\b|internal server error/i.test(obsLower);
  const hasStack = /stack|traceback|unhandled|cannot read propert|undefined is not|is not a function/i.test(obsLower);
  // HELD signal: the app rendered a REJECTION (an error/validation message) in the result page.
  const validationShown = /\b(invalid|required|too long|cannot be empty|not allowed|must be|please (enter|fill|provide)|is required|rejected|error:)/i.test((finalText + ' ' + observed).toLowerCase());
  // ACCEPTED-INVALID signal: the app rendered a SUCCESS ("saved/created/added") after we fed it invalid data.
  const successShown = /\b(saved|created|added|success|posted|updated|sent|scheduled)\b/i.test(finalText.toLowerCase());
  // could we even drive the form? the SUBMIT must have happened (click landed), and fills mostly succeeded. For an
  // empty-value attack (fillSteps=0) the click alone submitting the blank form IS the attack — drove=clicked.
  const drove = fields.length === 0 ? true : (drovePass.clicked && (fillSteps === 0 || drovePass.fills >= Math.ceil(fillSteps / 2)));

  const reproduce = { intent: step.intent, value: step.value || undefined, observed: (observed + (finalText ? ` | page: ${finalText.slice(0, 120)}` : '')) };

  // couldn't drive the form → the attack didn't actually reach the app; not a verdict on the app itself.
  if (!drove) {
    return { ...base, verdict: 'needs-review', detail: `couldn't drive the form to run this attack (${drovePass.fills}/${fillSteps} fields filled, submit ${drovePass.clicked ? 'ok' : 'not reached'}) — a test-harness limit, not necessarily an app bug. Observed: ${observed}`, reproduce };
  }

  // happy-path AND crud: these SHOULD succeed (they use valid data). An error is a finding; success is a pass.
  if (step.phase === 'happy' || step.phase === 'crud') {
    if (has5xx || hasException || hasStack) return { ...base, verdict: 'broke', detail: `${step.phase} step threw an error — "${step.expectBroke || 'should have worked'}". Observed: ${observed}`, reproduce };
    if (successShown) return { ...base, verdict: 'passed', detail: `${step.phase} step completed as expected — the app confirmed success.`, reproduce };
    return { ...base, verdict: 'needs-review', detail: `${step.phase} step ran but no explicit success/error was seen. Observed: ${finalText.slice(0, 120)}`, reproduce };
  }

  // adversarial / api / crud: match against the pre-declared oracle. HARD BROKE signals first.
  if (has5xx || hasException || hasStack) {
    return { ...base, verdict: 'broke', detail: `matched the BROKE oracle (${has5xx ? 'server 5xx' : hasStack ? 'stack/exception' : 'console error'}) — "${step.expectBroke}". Observed: ${(consoleErrors[0] || observed).slice(0, 140)}`, reproduce };
  }
  // the app REJECTED the bad input (error message shown) → HELD, as the oracle predicted.
  if (validationShown && !successShown) {
    return { ...base, verdict: 'held', detail: `the app rejected the bad input as expected ("${step.expectHeld}") — held.`, reproduce };
  }
  // the app ACCEPTED the input (success, no rejection). Whether that's a BUG depends on the pre-declared oracle:
  //   acceptIsDefect=true  → acceptance is the validation gap SoA predicted → BROKE.
  //   acceptIsDefect=false → acceptance is a legitimate outcome (robustness probe); only a crash — already caught
  //                          above — would be a bug → HELD. This is what stops the false-positive flood where every
  //                          "does it tolerate weird-but-valid input" probe got scored as a break.
  if (successShown && !validationShown) {
    if (step.acceptIsDefect) {
      return { ...base, verdict: 'broke', detail: `the app ACCEPTED invalid input the oracle said it must reject (showed success, no rejection) — "${step.expectBroke}". Observed: ${finalText.slice(0, 130)}`, reproduce };
    }
    return { ...base, verdict: 'held', detail: `the app accepted the input and handled it without error, which the oracle permits ("${step.expectHeld}") — held.`, reproduce };
  }
  // ambiguous → needs-review (fail-safe: never 'broke' without a mechanical signal).
  return { ...base, verdict: 'needs-review', detail: `inconclusive — neither a clear rejection nor a clear accept/error. Human review: does "${step.expectBroke}" hold? Observed: ${finalText.slice(0, 130) || observed}`, reproduce };
}

/** Parse SoA's `value` string ("title='Invalid', start='2026-08-20', end='2026-08-15'") into [field,value] pairs
 * so each becomes a concrete fill. Tolerant of quotes/spacing; ignores prose that isn't field=value. */
function parseFields(value: string): [string, string][] {
  if (!value) return [];
  const out: [string, string][] = [];
  // match name = 'val' | "val" | val,  where name is a short identifier
  const re = /([A-Za-z_][\w ]{0,30}?)\s*[:=]\s*('([^']*)'|"([^"]*)"|([^,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const name = m[1].trim();
    const val = (m[3] ?? m[4] ?? m[5] ?? '').trim();
    if (name && name.length <= 24) out.push([name, val]);
  }
  return out.slice(0, 8);
}

function countByPhase(plan: BreakStep[]): string {
  const c: Record<string, number> = {};
  for (const s of plan) c[s.phase] = (c[s.phase] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');
}
