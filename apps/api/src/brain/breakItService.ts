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
import { scaffoldMissing, ObservedField } from './attackScaffold';
import { executeFlow } from './intentRunner';
import { withDeadline, reapStaleBrowsers } from './runtimeGuards';   // outer per-attack cap + stale-browser reaper (launch-under-load wedge)
import { makeFrameHook, FrameHook } from './liveFrame';
import { preflightAuth } from './authGate';   // shared pre-flight auth gate (login-gated + no creds → refuse honestly)
import { buildTenantReachPrefix } from './reachState';   // general multi-tenant picker → deterministic "click <tenant>" reach step
import { deriveComprehension, prioritizeAttacks } from './comprehension';   // L2 world-model → firewall-clean targeting hints (informs WHAT/ORDER to probe, NEVER a verdict)
import { scopeOfPath } from './graphFlows';               // first-path-segment tenant scope (used by the picker detector)

export type BreakVerdict = 'held' | 'broke' | 'needs-review' | 'skipped' | 'passed';

// RESOLUTION (the "where's the approve button" answer): every finding carries WHAT THE USER DOES NEXT, so the UI
// can render the RIGHT control instead of a dead "needs review". Each needs-review now has a DISTINGUISHABLE cause:
//   authorize     → the target isn't authorized for mutation → a "I own/authorize this target" toggle.
//   credentials   → the run hit a login wall with no creds → a "add credentials" prompt.
//   answer-oracle → the app did something ambiguous; SoA has ONE yes/no question whose answer re-verdicts it
//                   (wired to acceptIsDefect) → a "was this a bug? yes/no" control. THIS is the teach-the-oracle loop.
//   unreachable   → the feature/form was never reached (wrong state, click-to-reveal, endpoint not observed) →
//                   nothing to click yet; shows why + (later) a "help it reach this" affordance.
//   file-ticket   → a real BROKE → the action is "create ticket + failing spec" (durable artifact).
//   none          → a clean HELD/PASS; the action is "keep the passing spec".
export type ResolutionKind = 'authorize' | 'credentials' | 'answer-oracle' | 'unreachable' | 'file-ticket' | 'none';
export interface Resolution { kind: ResolutionKind; question?: string; }
// each verdict branch sets its OWN cause (not derived from prose — that's the cue-regex mistake). deriveResolution
// reads `cause` first; the string-matching is only a fallback for older/unlabeled findings.
type Cause = ResolutionKind;

export interface BreakFinding {
  phase: string;
  title: string;
  verdict: BreakVerdict;
  detail: string;
  expectHeld?: string;
  expectBroke?: string;
  codeRef?: string | null;
  reproduce?: { intent: string; value?: string; observed: string };
  resolution?: Resolution;   // what the user does next with THIS finding
  cause?: ResolutionKind;    // set by the verdict branch (authoritative; deriveResolution reads this first)
}

export type BreakEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'breakit:finding'; index: number; finding: BreakFinding }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: BreakEvent) { wsServer.broadcastToRun(runId, e as any); }

// Derive the NEXT ACTION for a finding from its verdict + the (already-distinguishable) cause in its detail. This
// is the single place that turns a verdict into something a user can act on — the "approve button" data. Pure.
export function deriveResolution(f: BreakFinding): Resolution {
  // verdict-level defaults first (authoritative, no ambiguity).
  if (f.verdict === 'broke') return { kind: 'file-ticket' };
  if (f.verdict === 'held' || f.verdict === 'passed') return { kind: 'none' };
  if (f.verdict === 'skipped') return { kind: 'unreachable' };
  // needs-review: use the AUTHORITATIVE cause the branch set (NOT prose-matching — a message reword must never
  // flip the resolution). The `answer-oracle` kind carries the one yes/no question that re-verdicts it.
  const oracleQ = () => ({ kind: 'answer-oracle' as const, question: f.expectBroke ? `Did the app do this? "${f.expectBroke}" — if yes it's a bug; if no, it's fine.` : 'Was the app’s behavior here a defect?' });
  if (f.cause === 'answer-oracle') return oracleQ();
  if (f.cause) return { kind: f.cause };
  // FALLBACK for older/unlabeled findings only (prose-match) — kept so historic runs still resolve.
  const d = (f.detail || '').toLowerCase();
  if (/attestation|authorize this target|not authorized/.test(d)) return { kind: 'authorize' };
  if (/sign-?in screen|login wall|isn'?t authenticated|requires a login|add credentials/.test(d)) return { kind: 'credentials' };
  if (/not probed|endpoint not observed|no crawl-observed|no method\+path|assumed by the planner|no step executed|couldn'?t (run|drive)|wasn'?t reached|test-harness limit/.test(d)) return { kind: 'unreachable' };
  return oracleQ();
}

export interface BreakOpts { repo: string; feature: string; flowId?: string; destructiveAck?: boolean; creds?: { email?: string; password?: string }; scope?: string; quick?: boolean; }
// quick = happy/crud phases ONLY (skip the ~20 adversarial+api attacks). For a mission "create X and verify" request
// the user wants "does creating work + what happens after", NOT a full adversarial sweep — quick gets it from ~40min
// to a few. The full sweep stays the default for a direct "break-it" test.

export function startBreakIt(projectId: string, baseUrl: string, opts: BreakOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Break-it · ${opts.feature}` } as any);
  // RUN-LEVEL DEADLINE (honesty hole fix, 2026-08-22): before this, if runBreakIt HUNG (never settled — the SoA
  // explore stack did exactly that for 16+ min), the .catch below never fired and the run sat status:"running"
  // FOREVER with no terminal verdict. "It hung and told no one" is worse than a needs-review — it breaks the
  // always-reaches-a-terminal-status invariant. This outer cap forces a terminal `failed` + honest reason. Generous
  // (default 8 min) so a legitimately long real run isn't cut short; overridable via env.
  // Default raised 8→20min (2026-08-22): a real multi-tenant form drive now navigates INTO the tenant + opens a
  // multi-tab form per attack (schooltalk ~15s hydration each), which legitimately exceeds 8min across ~26 attacks.
  // The cap is a HANG backstop, not a coverage limiter — with partial-artifact preservation a timeout still yields
  // data, so err generous. Override via env for quick/narrow runs.
  const RUN_CAP_MS = Number(process.env.XSION_BREAKIT_RUN_CAP_MS) || 40 * 60_000;
  withDeadline(RUN_CAP_MS, `break-it run "${opts.feature}"`, runBreakIt(runId, projectId, baseUrl, opts)).catch((e) => {
    const timedOut = /timed out|deadline/i.test(String(e?.message || e));
    const msg = timedOut
      ? `break-it run exceeded ${Math.round(RUN_CAP_MS / 1000)}s and was stopped — this is a harness/run-time limit, NOT a verdict about the app. (No reliable pass/fail could be produced.)`
      : `break-it error: ${String(e?.message || e)}`;
    emit(runId, { type: 'test:think', message: msg });
    emit(runId, { type: 'test:phase', phase: 'done', label: timedOut ? 'Run stopped (time limit)' : 'Run failed', kind: 'breakit' });
    // PRESERVE PARTIAL RESULTS (advisor, 2026-08-22): the old handler REPLACED artifacts[] with a single synthetic
    // note — deleting every finding + frame runBreakIt had already accumulated (that's why a timed-out run showed
    // record.frames=0 while 46 frames sat on disk). A partial result + an honest "stopped early" IS the fail-safe
    // property we defend. So MERGE: keep the existing artifacts, APPEND the timeout note. Partial findings survive.
    const prior = (store.getTestRun(runId) as any)?.artifacts || [];
    store.updateTestRun(runId, {
      status: 'failed', finishedAt: new Date().toISOString(),
      artifacts: [...prior, { kind: 'break-it', feature: opts.feature, findings: [], detail: msg, resolution: { kind: timedOut ? 'timeout' : 'error' } } as any],
    } as any);
  }).finally(() => {
    // TERMINAL-STATUS WATCHDOG (the always-reaches-a-terminal-status invariant, enforced by CONSTRUCTION): whether
    // runBreakIt resolved, threw, or timed out, once the promise settles the run MUST be terminal. Every known path
    // already writes one — but this net guarantees it independent of any future path forgetting, so a run can NEVER
    // sit status='running' forever (the honesty hole the torture suite surfaced). Partial artifacts are preserved.
    const r = store.getTestRun(runId) as any;
    if (r && r.status === 'running') {
      store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(),
        artifacts: [...(r.artifacts || []), { kind: 'break-it', feature: opts.feature, findings: [], detail: 'break-it settled without writing a terminal status — forced terminal by the run watchdog (partial results preserved). This is a harness safeguard, not a verdict about the app.', resolution: { kind: 'error' } } as any] } as any);
    }
  });
  return runId;
}

async function runBreakIt(runId: string, projectId: string, baseUrl: string, opts: BreakOpts) {
  console.log(`[XSION][break-it] START run=${runId.slice(0,8)} project=${projectId} feature="${opts.feature}" url=${baseUrl}`);
  const project = store.getProject(projectId);
  const map = store.getProjectMap(projectId);
  console.log(`[XSION][break-it] project.hasCredentials=${!!(project as any)?._defaultCreds} authorized=${!!(project as any)?.security?.authorized} mapPages=${(map?.pages||[]).length}`);
  const marker = `XSION-TEST-${runId.slice(0, 8)}`;   // every value we CREATE carries this → only mutate our own

  emit(runId, { type: 'test:phase', phase: 'start', label: 'Planning the attacks', kind: 'breakit' });

  // SURFACE THE SILENT-DEGRADATION (advisor): if the project was never crawled, break-it can only plan from the
  // feature NAME (no observed fields/pages/api) → weaker, non-deterministic coverage. Tell the user to crawl first
  // (the "where's the button" surface — this is an actionable next step, not an invisible failure).
  if (!(map?.pages || []).length) {
    emit(runId, { type: 'test:think', message: '⚠ This project has no crawl map yet — break-it can only plan from the feature name (no observed form fields, so coverage is weaker + varies). Crawl this project first for reliable, repeatable attacks.' });
  }

  // ── CONSENT GATE: the break-it engine MUTATES the live app (create/update/delete). Same attestation the audit
  // needs. Without it, we run the READ-ONLY phases only (happy-path checks + adversarial that don't submit).
  const authorized = !!(project as any)?.security?.authorized;
  // LOGIN PRE-STEP (the reach-the-state fix): break-it used to run executeFlow with NO creds, so on any auth-gated
  // app it only ever saw the login wall → every attack landed on the sign-in page (false verdicts). Pass the
  // project's in-memory creds so the executor authenticates FIRST, then attacks the real feature — same as bug-repro.
  opts.creds = opts.creds || (project as any)?._defaultCreds;
  if (opts.creds?.email && opts.creds?.password) emit(runId, { type: 'test:think', message: 'Signing in with the project credentials first, so attacks run against the authenticated feature (not the login wall).' });
  if (!authorized) {
    emit(runId, { type: 'test:think', message: 'Break-it mutates the live app (creates/edits/deletes test data). It needs the per-project "I own/authorize this target" attestation. Running the NON-MUTATING checks only.' });
  }

  // ── PRE-FLIGHT AUTH GATE (the "51 attacks against /login" fix): before planning ANY attack, probe the live app.
  // If it's login-gated and we can't get past the login screen (no creds, or the creds don't sign in), DO NOT run
  // 51 attacks against the sign-in page and dress up login-screen failures as code-cited "findings" (the exact
  // dishonesty the user caught). Emit ONE honest credentials record and stop. bug-repro already does this; break-it
  // must too. (Only gates when login genuinely blocks us — an app with no login, or one we sign into, proceeds.)
  const gate = await preflightAuth(baseUrl, opts.creds);
  console.log(`[XSION][break-it] gate.blocked=${gate.blocked}`);
  if (gate.blocked) {
    emit(runId, { type: 'test:think', message: gate.message });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Blocked at login', kind: 'breakit' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(),
      artifacts: [{ kind: 'break-it', findings: [], detail: gate.message, resolution: { kind: 'credentials' } } as any] } as any);
    return;
  }

  // ── COMPREHENSION LAYER (L2 world-model): derive entity/capability/effect facets from the map and hand the planner
  // its FIREWALL-CLEAN targeting hints. THE RULE (design §1): these inform WHAT to probe and in what ORDER — never a
  // verdict. `promptSurface` is pure addressing (target/action/order/entity/scope/kind, neutral vocab); every
  // Evidence-typed field (`why`, statuses, deltas) is structurally stripped by the one serializer BEFORE it can reach
  // this prompt. Pure + fast + non-blocking: if it throws, the planner proceeds on the raw surface (never a hard dep).
  let comprehensionTargets: any[] = [];
  let comprehensionSurface: Array<{ order: number; target: string; entity?: string }> = [];   // hoisted: used to PRIORITISE the scaffold below
  try {
    if ((map?.pages || []).length) {
      const comp = deriveComprehension(map as any, { now: new Date().toISOString() });
      comprehensionTargets = comp.promptSurface.slice(0, 20);
      comprehensionSurface = comp.promptSurface as any;
      if (comprehensionTargets.length) emit(runId, { type: 'test:think', message: `World-model derived ${comp.capability.capabilities.length} capabilities across ${comp.capability.roleCoverage.rolesCrawled.length} role(s); ${comprehensionTargets.length} differential targets to prioritise (targeting only — verdicts stay observation-driven).` });
    }
  } catch (e) { console.log(`[XSION][break-it] comprehension derive skipped: ${String((e as Error)?.message || e)}`); }

  // SoA plans the attacks (code-grounded in Mode 1)
  const surface = {
    baseUrl,
    pages: (map?.pages || []).map((p: any) => ({ path: p.path })).slice(0, 30),
    api: (map?.api || []).map((e: any) => (e.graphql ? `${e.gqlKind} ${e.gqlOperation}` : `${e.method} ${e.url}`)).slice(0, 30),
    flows: (map?.flows || []).map((f: any) => ({ name: f.name, steps: f.steps?.length })),
    // firewall-clean L2 targeting hints (addressing only — no verdict, no evidence prose). Absent if uncrawled/errored.
    comprehensionTargets,
  };
  // PLAN SOURCE (2026-08-30): SoA's LLM plan is non-deterministic AND — measured across 6 runs — contributes ZERO real
  // verdicts on the UI path (40 SoA + 7 api findings = 47, ALL needs-review; every held/passed came from the
  // deterministic scaffold / ground-truth regen / modal-click). So SoA is pure noise here: it drives the 7→25→27 plan
  // drift, most of the harness-fail needs-reviews, and the LLM latency. Default to 'scaffold' (deterministic only):
  // constant plan size, near-zero harness-fail, no LLM plan call. 'both' restores SoA for A/B or a code-grounded probe.
  const planSource = (process.env.XSION_PLAN_SOURCE || 'scaffold').toLowerCase();
  let plannedSteps: BreakStep[] = [], error: string | undefined;
  if (planSource === 'both') {
    ({ plan: plannedSteps, error } = await breakItPlan(opts.repo, { feature: opts.feature, surface }));
  } else {
    emit(runId, { type: 'test:think', message: 'Plan source: deterministic scaffold + live-page ground truth (SoA plan skipped — it drifts run-to-run and lands no real verdicts on the UI path). Set XSION_PLAN_SOURCE=both to include it.' });
  }
  let plan = plannedSteps;   // mutable: quick mode filters it to happy/crud below
  if (error) emit(runId, { type: 'test:think', message: `Plan note: ${error}` });

  // ── DETERMINISTIC ATTACK-CLASS SCAFFOLD (the plan-variance fix): SoA's plan is non-deterministic (which
  // invariant it probes drifts run-to-run — the planted bug was found 1/3 runs). So we ENFORCE coverage in code:
  // gather the feature's OBSERVED fields from the crawl (requirements[]), and for every invariant class (empty /
  // long / type-mismatch / ordering) SoA didn't cover, synthesize the step locally with a mechanical oracle. Same
  // app → same classes EVERY run, at any temperature. Runs even when SoA returns nothing (RUN-1 zero-findings case).
  const observedFields: ObservedField[] = [];
  const seenLabel = new Set<string>();
  // login-gate fields are NOT the feature under test — attacking username/password wastes slow attack slots on the
  // login box (the "Overflow username" timeout on every no-learned-form feature). Exclude them from observedFields.
  const isLoginField = (label: string, kind: string) => kind === 'password' || /\b(username|user ?name|password|user id|login|email address)\b/i.test(label);
  const pushField = (r: any) => {
    const label = (r.label || r.kind || '').toLowerCase();
    if (!label || seenLabel.has(label)) return;
    if (isLoginField(label, (r.kind || '').toLowerCase())) return;   // skip login-gate fields
    seenLabel.add(label);
    observedFields.push({ kind: r.kind || 'text', label: r.label || r.kind, required: !!r.required, maxLength: r.maxLength });
  };
  // ── OPEN-TO-LEARN-THE-FORM WIRING: a feature's REAL form fields live behind a click (e.g. "Create Event" → title/
  // time/teacher/group), captured by the crawler into affordanceInventory[].revealedRequirements. Prefer the form
  // whose OPENER control matches the requested feature — those are the fields we should actually attack. This is the
  // connector that turns "the crawler learned the form" into "break-it tests it". Falls back to page.requirements[]
  // (surface fields) so behaviour is unchanged when no form was learned.
  const featWords = opts.feature.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const matchesFeature = (label: string) => { const l = label.toLowerCase(); return featWords.some((w) => l.includes(w)); };
  let learnedFromForm = 0;
  let revealOpener = '';   // the control that OPENS the learned form (e.g. "Create Event") — used as a deterministic reveal step
  let fieldSourcePath = '';   // path of the page whose learned form supplied the attack fields → picks the matching tenant
  for (const p of (map?.pages || [])) {
    for (const a of ((p as any).affordanceInventory || [])) {
      if (!(a.revealedRequirements || []).length) continue;
      // the opener control matches the feature (e.g. "Create Event" for feature "create event") → attack ITS form first
      if (matchesFeature(a.label)) { if (!revealOpener) { revealOpener = a.label; fieldSourcePath = String((p as any).path || (p as any).url || ''); } for (const r of a.revealedRequirements) { const before = seenLabel.size; pushField(r); if (seenLabel.size > before) learnedFromForm++; } }
    }
  }
  // then the surface requirements[] (and any non-feature-matched learned forms, lower priority) — but ONLY when the
  // feature-matched learned form gave us NOTHING. When we DID learn the feature's real form (e.g. Flag → "1-5"), the
  // page's generic requirements[] (login username/password, header search) are NOISE that dilutes the attack + wastes
  // slow attack slots on fields that aren't part of the feature. Gate the fallback on learnedFromForm===0.
  // NAV-TO-FEATURE for ROW-ACTION features (2026-08-30, "make it land"): a feature like "Approve"/"Allocate"/"Purge"
  // has NO learned form (it's a row button / direct action), so the block above never set fieldSourcePath → no
  // navigation step → the attack ran on the landing page (wrong view) = the "not-reached" class. Fix: if we don't yet
  // have a source path, find ANY page whose affordanceInventory carries the feature's control and use THAT page's path.
  // Same one-line nav-label derivation, wider input — so row-action features get their nav-to-page step too.
  if (!fieldSourcePath) {
    for (const p of (map?.pages || [])) {
      const hit = ((p as any).affordanceInventory || []).find((a: any) => matchesFeature(a.label));
      // set only the PAGE path (for the nav step) — NOT revealOpener: a row action like "Approve" is a direct commit,
      // clicking it as a "reveal" would fire the mutation prematurely. The nav-to-page + the attack's own steps suffice.
      if (hit) { fieldSourcePath = String((p as any).path || (p as any).url || ''); break; }
    }
  }
  if (learnedFromForm === 0) {
    for (const p of (map?.pages || [])) {
      for (const r of ((p as any).requirements || [])) pushField(r);
      for (const a of ((p as any).affordanceInventory || [])) { if ((a.revealedRequirements || []).length && !matchesFeature(a.label)) for (const r of a.revealedRequirements) pushField(r); }
    }
  }
  if (learnedFromForm) emit(runId, { type: 'test:think', message: `Using ${learnedFromForm} field(s) the crawler learned by opening the "${opts.feature}" form (title/date/etc.) — attacking the REAL create form, not just surface inputs.` });
  const scaffold = observedFields.length ? scaffoldMissing(observedFields, plan) : [];
  if (scaffold.length) emit(runId, { type: 'test:think', message: `Enforcing coverage: added ${scaffold.length} invariant attack(s) the plan didn't include (empty/overflow/type/ordering per observed field) — so coverage is the SAME every run, not left to chance.` });
  // SCAFFOLD-FIRST WITHIN EACH PHASE: the scaffold's attacks carry VERIFIED acceptIsDefect semantics + crawler-LEARNED
  // field labels (e.g. the empty-required "1-5"); SoA's steps are speculative and often name fields that don't exist on
  // this app. Appending scaffold AFTER SoA's ~19 steps meant the real targeted attack ran LAST and a slow run never
  // reached it (the "planted bug never caught" root cause). Tag scaffold steps + stable-sort them first inside their
  // phase, so they execute early regardless of run speed. Phase grouping preserved; SoA steps keep their relative order.
  for (const s of scaffold) (s as any)._scaffold = true;
  plan.push(...scaffold);
  {
    const PHASE_ORDER: Record<string, number> = { happy: 0, crud: 1, adversarial: 2, api: 3 };
    plan = plan.map((s, i) => ({ s, i })).sort((a, b) =>
      (PHASE_ORDER[a.s.phase] ?? 9) - (PHASE_ORDER[b.s.phase] ?? 9)          // keep phase grouping
      || (((b.s as any)._scaffold ? 1 : 0) - ((a.s as any)._scaffold ? 1 : 0))  // scaffold first within phase
      || a.i - b.i                                                          // else stable (original order)
    ).map((x) => x.s);
  }

  // ── COMPREHENSION-PRIORITISED ORDER (firewall §1: order only, never a verdict): reshuffle the plan so attacks on
  // fields belonging to high-ranked world-model targets (destructive-latent, cross-role differentials) run FIRST —
  // WITHIN phase groups, so an adversarial step never jumps the happy baseline. This has teeth only if a run hits its
  // RUN_CAP_MS deadline mid-sweep (nothing caps executed step count), where running the high-value attacks first turns
  // a useless partial into a useful one. Never touches a step's oracle — a wrong guess costs at most mis-ordering.
  if (comprehensionSurface.length && plan.length > 1) {
    const before = plan.map((s) => s.title).join('|');
    plan = prioritizeAttacks(plan, comprehensionSurface, (s) => (s.fields || []).map((f: any) => f.name).filter(Boolean), (s) => s.phase);
    if (plan.map((s) => s.title).join('|') !== before) emit(runId, { type: 'test:think', message: `World-model reordered the attacks so high-priority targets run first (order only — verdicts unchanged); phase grouping preserved.` });
  }

  // QUICK MODE (2026-08-23): a mission "create X and verify" wants the happy/crud path, not a 20-attack adversarial
  // sweep. Filter to happy/crud so the run is a few minutes, not ~40 — with the post-submit API oracle + auto-open
  // check, that fully answers "does creating work + what happens after". Full sweep stays default for direct break-it.
  if (opts.quick) {
    const before = plan.length;
    plan = plan.filter((s) => s.phase === 'happy' || s.phase === 'crud');
    emit(runId, { type: 'test:think', message: `Quick mode: running the ${plan.length} happy/CRUD check(s) (create + verify), skipping ${before - plan.length} adversarial/API attacks — this is a "does it work" mission, not a full break-it sweep.` });
  }

  if (!plan.length) {
    emit(runId, { type: 'test:think', message: 'No attack plan and no observed form fields to derive attacks from (the feature may be too thin, or the crawl recorded no typed fields).' });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'No plan', kind: 'breakit' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString() });
    return;
  }
  emit(runId, { type: 'test:think', message: `${plan.length} checks (${plan.length - scaffold.length} from SoA + ${scaffold.length} scaffold-enforced): ${countByPhase(plan)}. Every attack has a pre-declared oracle, so a "broke" is mechanically checkable.` });

  // NOTE: a crawl-derived reach-the-feature PREFIX was tried here (buildFeatureReachPrefix, kept below + hermetic-
  // covered) to position each attack on the feature's page. Live-measured a REGRESSION on saucedemo (5 executed → 0;
  // a failed reach step short-circuited the runner so the slice-accounting zeroed anyPass → all needs-review). Reverted
  // to break-it's honest ceiling (attacks run from the post-login landing; the executed-something gate keeps verdicts
  // honest). The helper stays unwired for a future, safer positioning attempt.
  // DETERMINISTIC REVEAL (2026-08-22): the learned form's fields live BEHIND a click on its opener (e.g. "Create
  // Event" → the modal with title/time/teacher/group). Break-it previously reached that modal ONLY via SoA-recovery
  // (when a fill missed, SoA looked at the page and clicked the opener) — so disabling SoA-recovery (the hang fix)
  // left every attack on the dashboard with 0 inputs ("no reveal control matched"). Fix: emit a REAL click on the
  // opener as a leading step, derived from the crawler's affordanceInventory — no SoA, fully deterministic. It is
  // NON-FATAL: executeFlow sets failed=true but does NOT break on a missed step (verified), and the slice-guard
  // (srAll.length > reachStepCount) keeps accounting honest if the opener isn't found. This is the safe re-enable the
  // reverted reach-prefix note anticipated (a single reliable opener-click, not a multi-step navigation guess).
  // MULTI-TENANT PICKER (2026-08-22, ROOT-CAUSE fix): many apps land post-login on a portal/school/workspace PICKER
  // (schooltalk: "Choose Portal:" → Demo School / NZ Curriculum / …); the feature's dashboard + form exist ONLY
  // after picking a tenant. Detected purely from the crawler's map (cue-gated gates[] + scoped-path fan-out) — a
  // strict no-op on single-tenant apps. Target = opts.scope (what the user named, e.g. "NZ Curriculum") → the tenant
  // whose form supplied the fields → most-crawled → first. Prepended BEFORE the reveal-opener so the click sequence
  // is: enter the tenant → open the form → attack. Non-fatal (a missed tenant click doesn't short-circuit the fills).
  const tenant = buildTenantReachPrefix(map, scopeOfPath, fieldSourcePath, opts.scope);
  if (tenant.note) emit(runId, { type: 'test:think', message: tenant.note });
  // NAV-TO-FEATURE-PAGE (the reach fix): the learned form may live on a VIEW that isn't where login lands (e.g. the
  // Flag modal opens from a row on the Orders page, but auth lands on the Dashboard). fieldSourcePath is the crawler's
  // path to that view — its last "›" segment is the nav LABEL to click to get there (a hash-write-only SPA renders via
  // the click, never a goto). Prepend that nav click before the reveal opener so the opener + fields are actually
  // present. Skip if the source is the bare landing (no "›" segment) or equals the reveal opener already.
  const navToFeature = (() => {
    if (!fieldSourcePath.includes('›')) return [] as Array<{ intent: string }>;
    const navLabel = fieldSourcePath.split('›').pop()!.trim();
    if (!navLabel || navLabel === revealOpener) return [];
    return [{ intent: `click "${navLabel}"` }];
  })();
  if (navToFeature.length) emit(runId, { type: 'test:think', message: `Navigating to "${navToFeature[0].intent.replace(/^click\s*"|"$/g, '')}" first — the "${opts.feature}" control lives there (from the crawler's map), not where login lands.` });
  const reachPrefix: Array<{ intent: string; expectedOutcome?: string }> = [
    ...tenant.steps,
    ...navToFeature,
    ...(revealOpener ? [{ intent: `click "${revealOpener}"` }] : []),
  ];
  if (revealOpener) emit(runId, { type: 'test:think', message: `Opening the "${revealOpener}" form first (deterministic reveal from the crawler's map) so attacks run against the real form fields, not the dashboard.` });

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Attacking the feature', kind: 'breakit' });
  const findings: BreakFinding[] = [];
  let held = 0, broke = 0, review = 0, skipped = 0;
  // collector: WRITE calls break-it observed across all attacks (merged into map.api at run end — the write surface the crawl can't see).
  const writeSink: Array<{ call: import('./intentRunner').ObservedCall; feature: string }> = [];
  // ONE shared frame hook for the whole run — every attack's frames accumulate into a single ordered manifest
  // (frameHook.frames) we attach to the record for playback. Live streaming stays throttled; disk gets every frame.
  const frameHook = makeFrameHook(runId, emit as any);
  // RUN-SCOPED REACH CACHE (real-time fix): the nav path to the feature's view, discovered ONCE by the first attack's
  // AI reach, then replayed by every later attack (no repeat AI calls). Shared across all attacks in this run.
  const reachNavCache = { labels: [] as string[] };
  (opts as any)._reachNavCache = reachNavCache;
  let regenDone = false;   // regenerate the plan from the live page ONCE (after attack 1) — not per-attack (repeatability)

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    // tag every frame this attack produces with its case index + title → per-case playback clips (frame ↔ finding[i]).
    frameHook.caseIndex = i; frameHook.caseTitle = `[${step.phase}] ${step.title}`;
    emit(runId, { type: 'test:item-start', index: i, title: `[${step.phase}] ${step.title}` });
    // A regenerated MODAL-CLICK attack (a fieldless _scaffold whose intent clicks a control INSIDE the feature's modal)
    // must NOT get the navToFeature prefix: intentRunner's own reach + opener-click already opens the modal, and a
    // leading `click "Orders"` nav would navigate AWAY and CLOSE it → the modal button is gone → "no step executed".
    // Detect it structurally: a scaffold step with no fields whose intent is a bare click. Those rely on reachFeature.
    const isModalClick = (step as any)._scaffold && !(step.fields || []).length && /^click\s/i.test(String(step.intent || ''));
    const stepReachPrefix = isModalClick ? [] : reachPrefix;
    const finding = await runStep(runId, baseUrl, step, marker, authorized, opts, frameHook, (map?.api || []) as any, stepReachPrefix, writeSink);
    finding.resolution = deriveResolution(finding);   // attach the NEXT ACTION so the UI can render a real control
    findings.push(finding);

    // ── REGENERATE FROM GROUND TRUTH (the fundamental fix): after the FIRST attack, the executor reported the fields +
    // action controls ACTUALLY on the feature's page (post-reach). Rebuild the remaining plan from THOSE — so phantom
    // map fields stop producing failing attacks and conditional-rendered controls (never crawled) become attackable.
    // ONCE only (regenerating per-attack would churn the plan + hurt repeatability). Deterministic; no LLM.
    if (!regenDone) {
      regenDone = true;
      const live = (opts as any)._liveFieldsSeen as ObservedField[] | undefined;   // UNION — discovery
      const cohort = (opts as any)._liveCohortSeen as ObservedField[] | undefined;   // best co-present snapshot — construction
      const liveActs = (opts as any)._liveActionsSeen as string[] | undefined;
      if (live && live.length) {
        // DISCOVERY set = the full union (does a field exist ANYWHERE on the surface). Drives the drop-gate below.
        const liveScoped = live.filter((f: any) => !isLoginField((f.label || '').toLowerCase(), (f.kind || '').toLowerCase()));
        // CONSTRUCTION set = ONE co-present cohort (fields that actually co-exist in the DOM). Filling the union stalls
        // the submit (cross-wizard-step fields never co-exist) → this is what the attacks/precondition fill from.
        const cohortScoped = (cohort && cohort.length ? cohort : live).filter((f: any) => !isLoginField((f.label || '').toLowerCase(), (f.kind || '').toLowerCase()));
        const liveLabels = new Set(liveScoped.map((f: any) => String(f.label || '').toLowerCase().trim()));
        const norm = (s: string) => String(s || '').toLowerCase().trim();
        // an attack step FILLS a field iff that field's label is live. A stale SoA/scaffold attack whose target field
        // isn't on the page can NEVER land → DROP it. Keep non-fill attacks (click-action, api, pure-intent) as-is.
        const targetsLiveField = (s: any) => { const fills = (s.fields || []).map((f: any) => norm(f.name)); return fills.length === 0 || fills.every((fn: string) => [...liveLabels].some((ll) => ll.includes(fn) || fn.includes(ll))); };
        // FIX 1 — DROP STALE PHANTOM-FIELD ATTACKS, BUT ONLY WHEN THE CAPTURE IS TRUSTWORTHY (2026-08-30). Dropping is
        // SUBTRACTIVE — it removes coverage — so it's safe ONLY when liveFields is a COMPLETE surface. That's true when
        // a capture landed inside the feature's own modal/dialog (liveScope==='modal': a bounded form). If we only saw
        // ambient PAGE inputs (liveScope==='page', e.g. reach never opened the modal and we grabbed a dashboard search
        // box), the union is partial → dropping would delete legitimate attacks on fields that genuinely exist (it once
        // dropped 10 real attacks on wizard-validate). In that case KEEP the whole tail — additive regeneration below
        // still can't hurt, but we never subtract on an incomplete picture. ADDITIVE is always safe; SUBTRACTIVE gates.
        const liveScope = (opts as any)._liveScopeSeen as ('modal' | 'page' | undefined);
        const trustworthy = liveScope === 'modal';
        const remaining = trustworthy ? plan.slice(i + 1).filter((s: any) => targetsLiveField(s)) : plan.slice(i + 1);
        const dropped = plan.slice(i + 1).length - remaining.length;
        // regenerate field attacks from the CO-PRESENT COHORT (not the union — filling cross-step fields stalls submit).
        const regenerated = cohortScoped.length ? scaffoldMissing(cohortScoped, plan.slice(0, i + 1)) : [];
        for (const s of regenerated) (s as any)._scaffold = true;
        // CLICK-ACTION attacks (the shape for form-LESS features): a control present but with no form → click it + read
        // the state-delta. acceptIsDefect=false (accepting a click isn't a defect; only a 5xx/exception/wrong-persist is).
        const mkClick = (a: string) => ({
          phase: 'adversarial' as const, title: `Click action "${a}" and verify effect`, intent: `click "${a}"`, fields: [] as any[], acceptIsDefect: false, value: a,
          apiHint: '', expectHeld: 'the action completes without a crash/5xx', expectBroke: 'the action throws / 5xx / corrupts state', codeRef: null, _scaffold: true,
        });
        // PAGE-LEVEL actions need the feature-name filter (a page has many unrelated buttons). MODAL actions do NOT —
        // once inside the feature's own modal, every button is part of the feature (Flag's manual-review/priority/hold).
        const notClose = (a: string) => !/^(sign in|logout|@|notifications|✕|cancel|close|back)/i.test(a);
        const modalActs = (opts as any)._liveModalActionsSeen as string[] | undefined;
        const pageClicks = (liveActs || []).filter((a) => matchesFeature(a) && notClose(a)).slice(0, 3).map(mkClick);
        const modalClicks = (modalActs || []).filter(notClose).slice(0, 6).map(mkClick);   // unfiltered: modal membership scopes them
        const clickAttacks = [...modalClicks, ...pageClicks].filter((s, idx, arr) => arr.findIndex((x) => x.title === s.title) === idx);
        const addition = [...regenerated, ...clickAttacks].filter((s) => !remaining.some((r) => r.title === s.title));
        // FIX 2 — CHAIN CREATE→READ/DELETE: a state-dependent attack (read/verify/update/delete an item) can only run if
        // an item EXISTS. Prepend a deterministic "create a valid item" step before the first such attack so it has a
        // subject. General: keyed on the intent verb, not app words. The create reuses the live create form we found.
        const stateDependent = (s: any) => /\b(read|verify|update|delete|retrieve|view)\b.*\b(created|item|record|it|entry|the)\b/i.test(String(s.title || s.intent || ''));
        const hasCreate = liveScoped.length > 0 || (liveActs || []).some((a) => /create|add|new|submit|save/i.test(a));
        let chained = 0;
        const newPlan = [...plan.slice(0, i + 1), ...addition, ...remaining];
        if (hasCreate) {
          const out: any[] = []; let seededFor = false;
          for (const s of newPlan) {
            if (!seededFor && stateDependent(s)) {
              // a happy create so the state-dependent attack has a subject (valid fills on the CO-PRESENT cohort + submit).
              out.push({ phase: 'crud', title: 'Precondition: create a valid item', intent: 'create a valid item', fields: cohortScoped.map((f: any) => ({ name: f.label, mode: 'literal', value: 'valid' })), acceptIsDefect: false, value: 'precondition-create', apiHint: '', expectHeld: 'item created', expectBroke: 'create failed', codeRef: null, _scaffold: true, _precondition: true } as any);
              chained++; seededFor = true;
            }
            out.push(s);
          }
          plan = out;
        } else { plan = newPlan; }
        if (addition.length || dropped || chained) emit(runId, { type: 'test:think', message: `Live-page regeneration [scope=${liveScope || '?'}, fields=${liveScoped.length}]: +${addition.length} ground-truth attack(s), dropped ${dropped} phantom-field attack(s)${trustworthy ? '' : ' (drop SKIPPED — capture was ambient/partial, not modal-scoped)'}, chained ${chained} create-precondition(s). Deterministic — same app, same plan.` });
      }
    }
    if (finding.verdict === 'broke') broke++;
    else if (finding.verdict === 'held' || finding.verdict === 'passed') held++;
    else if (finding.verdict === 'skipped') skipped++;
    else review++;

    const status = finding.verdict === 'broke' ? 'fail' : (finding.verdict === 'held' || finding.verdict === 'passed') ? 'pass' : finding.verdict === 'skipped' ? 'skipped' : 'unverifiable';
    emit(runId, { type: 'test:item-result', index: i, status, detail: `${finding.verdict.toUpperCase()} — ${finding.detail}`, evidence: finding.codeRef || undefined });
    emit(runId, { type: 'breakit:finding', index: i, finding });
    // INCREMENTAL PERSIST (2026-08-22): write the accumulated findings+frames to the run AFTER EACH attack (keep
    // status:'running'). Before this, findings lived only in a local array saved once at the end — so a run that hit
    // the run-level deadline (schooltalk multi-tenant wizard runs DO, at 40min) was overwritten by the timeout
    // handler with an EMPTY artifact: every partial finding + frame lost (record.findings=0 despite 83 frames on
    // disk). Persisting each step makes the deadline's merge (prior artifacts + timeout note) actually preserve data.
    store.updateTestRun(runId, { artifacts: [{ kind: 'break-it', feature: opts.feature, marker, findings: [...findings], frames: frameHook.frames } as any] } as any);
  }

  // ── MERGE BREAK-IT WRITES INTO THE MAP (2026-08-23): the crawler maps the READ surface (never clicks writes);
  // break-it drives real writes under consent. Fold the observed write calls into map.api so the write surface
  // PERSISTS into the cumulative cross-engine map (a mission/next-crawl consumer then knows "this app can POST /event",
  // its fields, and which feature triggers it). Store write, not new observation. Guarded on an existing map + writes.
  if (writeSink.length && map) {
    try {
      const api: any[] = ((map as any).api = (map as any).api || []);
      const norm = (u: string) => { try { const x = new URL(u); return x.pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, '/:id'); } catch { return u.split('?')[0]; } };
      const entityOf = (u: string): string | undefined => { try { const s = new URL(u).pathname.split('/').filter(Boolean).filter((p) => !/^\d+$/.test(p) && !/^[0-9a-f-]{16,}$/i.test(p) && !/^(api|v\d+|graphql)$/i.test(p)); const l = s[s.length - 1] || ''; return l ? l.replace(/[-_]/g, ' ').toLowerCase().replace(/s$/, '') : undefined; } catch { return undefined; } };
      let added = 0, linked = 0;
      for (const { call, feature } of writeSink) {
        const path = norm(call.url);
        const key = `${call.method} ${path}`;
        let ep = api.find((e) => `${e.method} ${norm(e.url)}` === key);
        if (!ep) { ep = { method: call.method, url: path, statuses: [], count: 0, writes: true, entity: entityOf(call.url), firedBy: [], source: 'break-it' }; api.push(ep); added++; }
        ep.writes = true;
        if (!ep.statuses.includes(call.status)) ep.statuses.push(call.status);
        ep.count = (ep.count || 0) + 1;
        ep.firedBy = ep.firedBy || [];
        if (feature && !ep.firedBy.includes(feature) && ep.firedBy.length < 8) { ep.firedBy.push(feature); linked++; }   // the feature IS the UI action → firedBy
      }
      (store as any).saveProjectMap?.(projectId, map);
      emit(runId, { type: 'test:think', message: `Learned ${added} new write endpoint(s) + linked ${linked} to their feature — merged into the app map (the crawler can't see writes; break-it just taught the map what this app can mutate).` });
    } catch { /* map merge is best-effort — never fail the run over it */ }
  }

  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'break-it', feature: opts.feature, marker, findings, frames: frameHook.frames } as any] } as any);
  emit(runId, { type: 'test:phase', phase: 'done', label: 'Attack complete', kind: 'breakit' });
  emit(runId, { type: 'test:think', message: `Done — ${broke} broke, ${held} held, ${review} needs-review, ${skipped} skipped. Findings are oracle-matched${opts.repo ? ' and code-cited' : ''}.` });
  emit(runId, { type: 'test:done', passed: held, failed: broke, skipped: skipped + review, total: plan.length });
}

/** Execute one attack step and judge it against its PRE-DECLARED oracle. */
// exported for hermetic testing (the api-phase + consent guards return before any browser/network I/O)
/** Build the LEAD-IN navigation to reach the feature under attack, from the crawl's recorded flows. Picks the flow
 *  whose name best matches the feature, and returns all-but-its-last step (the last step is the mutating action the
 *  attack itself performs). Generic — derived from the crawl map, never hardcoded per app. Returns [] if no match. */
export function buildFeatureReachPrefix(map: any, feature: string): Array<{ intent: string; expectedOutcome?: string }> {
  const flows: any[] = map?.flows || [];
  if (!flows.length || !feature) return [];
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const fWords = new Set(norm(feature).split(' ').filter((w) => w.length > 2));
  // score each flow by word-overlap of its name with the feature; also weight flows that mention the feature's verb.
  let best: any = null, bestScore = 0;
  for (const fl of flows) {
    const nameWords = norm(fl.name).split(' ');
    const overlap = nameWords.filter((w) => fWords.has(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = fl; }
  }
  if (!best || bestScore === 0 || !(best.steps?.length > 1)) return [];
  // all steps EXCEPT the last (the final step is the mutating action the attack replaces). Keep only navigation-ish
  // steps (click/open/select/go) — a lead-in that fills a field would collide with the attack's own fills.
  const lead = best.steps.slice(0, -1)
    .map((s: any) => ({ intent: s.intent || s.action || '', expectedOutcome: s.expectedOutcome }))
    .filter((s: any) => s.intent && /\b(click|open|select|go to|navigate|choose|view|tap)\b/i.test(s.intent) && !/\b(fill|type|enter|submit)\b/i.test(s.intent));
  return lead.slice(0, 4);   // cap the lead-in so a long flow can't dominate the attack budget
}

export async function runStep(runId: string, baseUrl: string, step: BreakStep, marker: string, authorized: boolean, opts: BreakOpts, frameHook?: FrameHook, observedApi: import('./apiProber').ObservedEndpoint[] = [], reachPrefix: Array<{ intent: string; expectedOutcome?: string }> = [], writeSink?: Array<{ call: import('./intentRunner').ObservedCall; feature: string }>): Promise<BreakFinding> {
  const base: BreakFinding = { phase: step.phase, title: step.title, verdict: 'needs-review', detail: '', expectHeld: step.expectHeld, expectBroke: step.expectBroke, codeRef: step.codeRef };
  // NOTE: 'api' is NOT unconditionally mutating anymore — its HTTP verb decides (the prober gates GET vs POST/…).
  const mutating = step.phase === 'crud' || /submit|create|send|save|delete|update|broadcast|post/i.test(step.intent + ' ' + step.title);

  // SAFETY: a mutating UI step only runs with authorization. Without it, record the step + SoA's oracle as
  // needs-review (the reasoning stands; it just wasn't executed live).
  if (mutating && step.phase !== 'api' && !authorized) {
    return { ...base, verdict: 'needs-review', cause: 'authorize', detail: `mutating step — needs the "I own/authorize this target" attestation to run live. SoA's oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".` };
  }

  // ── API PROBE (#207): issue a REAL HTTP request — but only against an endpoint the CRAWL OBSERVED, same-origin,
  // never an auth endpoint, GET-anywhere / writes-only-if-authorized. Fabricated ("assumed") endpoints are NOT
  // probed. Verdict from status+body vs the oracle, with the fail-safe floor. See apiProber.ts.
  if (step.phase === 'api') {
    const { matchObserved, probeEndpoint } = await import('./apiProber');
    let baseOrigin: string; try { baseOrigin = new URL(baseUrl).origin; } catch { baseOrigin = baseUrl; }
    const match = matchObserved(step.apiHint, observedApi, baseOrigin);
    if (!match.endpoint) {
      return { ...base, verdict: 'needs-review', cause: 'unreachable', detail: `API attack not probed — ${match.reason}. SoA's oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".${step.apiHint ? ` (hint: ${step.apiHint})` : ''}` };
    }
    // fresh browser context so cookies/auth headers ride along without us handling credentials.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      // prime cookies/session by loading the app first (auth cookies attach to the context).
      const pg = await ctx.newPage();
      await pg.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await pg.waitForTimeout(1500);
      const pr = await probeEndpoint(ctx.request, match.endpoint, authorized, step.expectHeld, step.expectBroke);
      return { ...base, verdict: pr.verdict, detail: pr.detail };
    } finally { await browser.close().catch(() => {}); }
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
  // reachPrefix is currently always [] (the reach-the-feature positioning was reverted — measured a regression). Kept
  // as a param + no-op seed so the accounting stays correct if it's re-enabled with a safer, short-circuit-proof impl.
  const steps: any[] = reachPrefix.map((s) => ({ intent: s.intent, expectedOutcome: s.expectedOutcome }));
  const reachStepCount = steps.length;
  const fillable = fields.filter((f) => f.mode === 'literal' || f.mode === 'long');
  // SKIP-PREFILLED-DEFAULTS (2026-08-23): a happy-path / CRUD step fills VALID data purely to make the form
  // submittable — but many real forms pre-fill valid defaults (schooltalk: date "Aug 17-21", start/end time, the
  // owner teacher). Overwriting a valid default is at best redundant and at worst BREAKS the field (typing into a
  // masked time input mangled it → Create stayed disabled → the whole create failed). So on a NON-ADVERSARIAL step
  // (no 'long'/'empty' attack field), each valid fill may KEEP an existing non-empty value. On an adversarial step we
  // fill everything as before — an overflow/empty attack MUST overwrite its target even if it holds a default.
  const isAdversarial = fields.some((f) => f.mode === 'long' || f.mode === 'empty');
  for (const f of fillable) {
    let val = f.value;
    // OVERFLOW SIZE (2026-08-30, "make it land"): a 200-char value tests the SAME length-validation boundary as 5000
    // (the oracle only checks whether the app ACCEPTED it, not the magnitude) — but a 5000-char fill on a laggy field
    // alone blew the attack cap (24 timeouts on clean torture). Default to a few hundred; env-overridable for a true
    // buffer-overflow probe. This is the single biggest "attacks that never ran" fix.
    if (f.mode === 'long') { const cap = Number(process.env.XSION_OVERFLOW_LEN || 300); const n = Math.min(parseInt(f.value, 10) || cap, cap); val = 'A'.repeat(n); }
    // Tag free-text identity fields with the run marker so we only ever touch our OWN test data — but ONLY when the
    // value is already NON-BLANK (guard on val.trim(), not val: '   ' is truthy, so tagging a whitespace-only title
    // would append the marker and make it non-empty, DEFEATING the whitespace attack and producing a false 'broke').
    // Inherent tension: an attack whose point is a blank/whitespace field can't carry the marker without defeating
    // itself, so if the app wrongly accepts it an untagged row lands — an unavoidable, non-blocking mutation cost
    // (the step is EXPECTED to be rejected; acceptance is precisely the finding).
    const tagged = f.mode === 'literal' && /title|name|body|message|note|subject/i.test(f.name) && val.trim() ? `${val} ${marker}`.slice(0, 200) : val;
    // skipIfFilled: only for a valid ('literal') fill on a non-adversarial step → keep an existing default instead of
    // overwriting it. An overflow ('long') fill, or ANY fill on an adversarial step, always applies (never skipped).
    // ATTACK-TARGET FLAG (runtime field-scoping, 2026-08-30, future-proof): the attack's TARGET is the field carrying
    // the invalid value (empty/omit/long, or — for a type-mismatch — the literal 'abc' the scaffold set on a typed
    // field). The OTHER literal fills are just "make the form submittable" valid-fillers. On the reached page, an absent
    // VALID-FILLER (a sibling that belongs to a different feature/page) must NOT tank the attack — only an absent TARGET
    // means the feature isn't here. Tag it so the accounting can tell them apart (general: no app knowledge, just mode).
    const isAttackTarget = f.mode === 'empty' || f.mode === 'omit' || f.mode === 'long' || (isAdversarial && f.mode === 'literal' && /^(abc|[0-9.+-]*[a-z]+)/i.test(String(f.value)));
    steps.push({ intent: `fill the "${f.name}" field with "${tagged}"`, skipIfFilled: !isAdversarial && f.mode === 'literal', isAttackTarget } as any);
  }
  if (fields.length) {
    // SUBMIT via the FORM'S OWN affordance (derived from the DOM), not a hardcoded "Save" button — most apps
    // (search, login, add-to-cart) have no button literally named Save; the old string made every such attack
    // fail with `no match for "Save"`. The intent runner's `submit` verb finds submit-button / Enter / none.
    steps.push({ intent: 'submit the form', expectedOutcome: step.expectHeld });
  } else {
    // no structured fields → run the raw intent (e.g. a pure click/out-of-order attack)
    steps.push({ intent: step.intent, expectedOutcome: step.expectHeld });
  }
  const flow = { name: step.title, role: 'tester', steps };
  // CONCRETE UI-TASK GOAL for the AI executor (firewall-safe: pure mechanical instruction, no verdict/attack framing).
  // If the deterministic driver fails, the AI is told exactly what to DO on the page: open the opener (if any), set/
  // leave each field, click the final submit — NOT the attack-speak intent (which reads as a test, not a UI task).
  const opener = reachPrefix.length ? String(reachPrefix[reachPrefix.length - 1].intent).replace(/^click\s*/i, '').replace(/^"|"$/g, '') : '';
  const fieldInstr = fields.map((f) => f.mode === 'empty' || f.mode === 'omit' ? `leave the "${f.name}" field EMPTY` : `set the "${f.name}" field to a valid value`).join('; ');
  const aiGoal = `${opener ? `Open the "${opener}" dialog/form for the first row, then ` : ''}${fieldInstr || 'fill the form'}, then click the final save/submit button.`;



  let consoleErrors: string[] = [];
  let observed = '';
  let finalText = '';
  let observedCalls: import('./intentRunner').ObservedCall[] = [];   // API calls fired during the attack (post-submit oracle)
  let stateDelta: import('./intentRunner').StateDelta | undefined;   // STATE-DELTA ORACLE: observed effect of the mutating action (+ reload-persistence)
  // the flow = one fill per fillable field + a final click. "drove" = the fill steps mostly passed AND the click
  // landed, so the attack actually reached the app (a submit happened). Judged by step PASS, not by kind string.
  const fillSteps = fillable.length;
  const drovePass = { fills: 0, clicked: false };
  let absentFillers = 0;     // valid-filler fields not on the reached page (cross-page pollution) — skipped, not a failure
  let fieldAbsent = false;   // the ATTACK'S TARGET field isn't on the page → the feature isn't here → not attackable
  let anyPass = false;       // did ANY step actually land? if nothing executed, no verdict about the app is possible
  let srForReport: any[] = [];   // the attack's step results, hoisted so the post-try verdict messages can inspect them
  try {
    // ★ RESILIENCE (evidence: 3/3 dent break-it runs wedged after gate.blocked=false, before executeFlow logged —
    // a chromium.launch()/CDP stall under a loaded server, UPSTREAM of executeFlow's inner login+step caps). Reap
    // stale browsers before launching (reclaims the handle-less wedged process the caps can't), and put an OUTER
    // deadline on the WHOLE executeFlow (backstop for the launch itself). On deadline → throw → the catch below marks
    // the attack timed-out (harness, not app) and the loop continues; no run-wide freeze.
    reapStaleBrowsers();
    const exec = await withDeadline(Number(process.env.XSION_ATTACK_CAP_MS) || 120000, `break-it attack "${step.title}"`, executeFlow(flow as any, baseUrl, {
      onConsoleError: (m) => { consoleErrors.push(m); },
      onFrame: frameHook,   // LIVE VIEW + PLAYBACK: shared hook streams live + persists frames for this run
    }, undefined, opts.creds, { allowMutations: authorized, noSoaRecovery: process.env.XSION_NO_SOA_RECOVERY !== '0', marker, aiGoal, reachFeature: opts.feature, reachNavCache: (opts as any)._reachNavCache } as any));   // reachFeature + reachNavCache: AI navigates to the feature's page once, then replays the cached nav path (real-time). creds → login pre-step; mutations only if authorized. noSoaRecovery (default ON): break-it drives a KNOWN learned form, so keep SoA-explore off the critical path (was the ~16-min hang). Set XSION_NO_SOA_RECOVERY=0 to A/B whether recovery was also revealing the form. Fix #1 (45s cap) already kills the hang regardless: 2×45s < the 120s attack cap.
    const srAll = exec.stepResults.filter((s) => s.stepIndex >= 0);
    // drop the leading reach-navigation steps from attack-accounting. GUARD (the short-circuit bug): if the runner
    // stopped early (srAll shorter than the prefix, e.g. a reach step failed), DON'T slice past the end — that would
    // zero out `sr` and force a false needs-review. Only slice when the full prefix actually executed. (reachStepCount
    // is 0 today, so this is a no-op; the guard protects a future re-enable.)
    const sr = srAll.length > reachStepCount ? srAll.slice(reachStepCount) : srAll;
    srForReport = sr;
    // PER-STEP TIMEOUT (resilience): if any step hit the wall-clock cap, this attack was ABANDONED mid-flight — a
    // harness/network stall, NOT a verdict about the app. Surface it honestly (not buried in ordinary needs-review)
    // so the run keeps going and the finding names the harness. The browser was already closed by executeFlow's
    // teardown, so no context leaked — the whole point of the per-step cap living inside executeFlow.
    const to = exec.stepResults.find((s: any) => s.timedOut);
    if (to) {
      // SELF-DIAGNOSING TIMEOUT (2026-08-22): name WHICH step stalled + how far the attack got, so a timeout is
      // actionable instead of opaque ("empty observed" told us nothing about login-vs-nav-vs-fill). stepIndex -1 =
      // the login pre-step; 0..n = attack steps. The intent (if recorded) says exactly what was running.
      const which = (to as any).stepIndex;
      const whatIntent = (to as any).attempts?.[0]?.selector || (to as any).note || (which < 0 ? 'login/auth pre-step' : `attack step ${which}`);
      const reached = exec.stepResults.filter((s: any) => s.status === 'pass').length;
      return { ...base, verdict: 'needs-review', cause: 'unreachable', timedOut: true,
        detail: `this attack was abandoned — a step exceeded the 60s harness cap (a latency stall on this app, not a defect). STALLED AT: ${whatIntent} (step ${which}); ${reached} step(s) had passed before the stall. SoA's oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".` } as any;
    }
    // within the ATTACK steps: the first `fillSteps` are fills; the last is the submit. `attackSteps` = the fill flow
    // steps (aligned by index to sr) so we can read each fill's isAttackTarget flag.
    const attackFillSteps = flow.steps.slice(reachStepCount, reachStepCount + fillSteps);
    sr.forEach((s, i) => {
      const err = s.note || s.attempts?.[0]?.error || '';
      if (s.status === 'pass') anyPass = true;
      if (i < fillSteps) {
        if (s.status === 'pass') drovePass.fills++;
        // FIELD-SCOPING (future-proof): an absent field tanks the attack ONLY if it's the ATTACK'S TARGET. An absent
        // valid-FILLER (a sibling from another feature/page — the cross-page pollution) is silently skipped: the target
        // can still be attacked. This is runtime-derived (the live page said "no input"), so it works on ANY app.
        else if (/no input for/i.test(err)) { if ((attackFillSteps[i] as any)?.isAttackTarget) fieldAbsent = true; else absentFillers++; }
      } else if (s.status === 'pass') drovePass.clicked = true;
    });
    // INSTANT-SEARCH accounting fix (advisor): a live/debounced search has NO submit — the query fires on typing, so
    // resolveSubmit legitimately returns none/Enter-no-op (matched:0, "nothing to submit"/"page did not change").
    // That is NOT "submit not reached" — if every fill landed, the attack DID reach the app (the debounced query ran).
    // Count the attack as driven when all fills passed AND the submit was a genuine no-op (not a real failure).
    if (!drovePass.clicked && fillSteps > 0 && drovePass.fills === fillSteps) {
      const submitStep = sr[fillSteps];
      const serr = String(submitStep?.note || submitStep?.attempts?.[0]?.error || '');
      // DURABLE ROOT of the teardown-abort FP (2026-08-23): the old `.startsWith('submit')` disjunct treated ANY
      // submit-kind attempt as a no-op — INCLUDING a TIMED-OUT click (serr="locator.click: Timeout 6000ms"). That
      // promoted clicked→drove→true, skipped the !drove needs-review gate, and let the in-flight abort reach a verdict.
      // Match ONLY the genuine no-op shapes (the 3 instant-search returns all match these), so a timed-out click stays
      // undriven → needs-review (harness limit), never a verdict about the app.
      const submitWasNoop = /nothing to submit|did not change|no submit/i.test(serr);
      if (submitWasNoop) drovePass.clicked = true;   // instant-search: filling the field IS the action
    }
    observed = sr.map((s) => `${s.status}:${s.note || s.attempts?.[0]?.error || ''}`).join(' | ').slice(0, 300);
    finalText = exec.finalText || '';
    observedCalls = exec.observedCalls || [];
    stateDelta = exec.stateDelta;
    if (exec.liveFields) (opts as any)._liveFieldsSeen = exec.liveFields;   // UNION — DISCOVERY only (does a field exist anywhere)
    if (exec.liveActions) (opts as any)._liveActionsSeen = exec.liveActions;
    if ((exec as any).liveScope) (opts as any)._liveScopeSeen = (exec as any).liveScope;   // 'modal' (trustworthy, complete) | 'page' (ambient, partial)
    if ((exec as any).liveCohort) (opts as any)._liveCohortSeen = (exec as any).liveCohort;   // best CO-PRESENT snapshot — CONSTRUCTION fills from this
    if ((exec as any).liveModalActions) (opts as any)._liveModalActionsSeen = (exec as any).liveModalActions;   // feature-modal's own buttons — click-attacked unfiltered
    // CROSS-ENGINE MAP GROWTH (2026-08-23): break-it drives WRITES the crawler never clicks (create/update/delete).
    // Feed the observed write calls back to the run so they merge into map.api — the write surface the crawl can't see.
    // The FEATURE under test IS the UI action that triggered them (→ firedBy). Only on an AUTHORIZED run (real mutations).
    if (writeSink && authorized) for (const c of observedCalls) if (c.write) writeSink.push({ call: c, feature: opts.feature });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const isDeadline = /XSION_DEADLINE|XSION_STEP_TIMEOUT/.test(msg);
    return { ...base, verdict: 'needs-review', cause: 'unreachable', timedOut: isDeadline || undefined,
      detail: isDeadline
        ? `this attack was abandoned after exceeding the 120s harness cap (a browser-launch/network stall under load — NOT a defect in the app). Stale browsers were reaped; re-run to retry. Oracle stands: HELD if "${step.expectHeld}", BROKE if "${step.expectBroke}".`
        : `could not execute the step: ${msg.slice(0, 100)}` } as any;
  }

  // ── THE VERDICT FLOOR (match OBSERVATION vs the pre-declared oracle) ──
  // Signals come from: console errors, the step outcomes, AND the RESULT PAGE TEXT (the "Error…"/"Saved…" message).
  // FILTER AMBIENT CONSOLE NOISE before it becomes a "bug signal". A failed resource fetch (a 401/404 on an asset,
  // analytics, favicon, a websocket hiccup) is present on ANY partly-authenticated page and is IDENTICAL across
  // unrelated attacks — it is NOT evidence that THIS attack broke the app. Hard signal = an uncaught JS exception or
  // a rendered stack, NOT a network warning. (This was the 6-false-positive flood: all 6 cited the same
  // "Failed to load resource".)
  // Ambient = console noise present on ANY page, NOT evidence THIS attack broke the app. Includes failed asset
  // fetches (401/403/404), analytics, websocket hiccups — AND third-party auth/identity SDK chatter (Google Sign-In,
  // FedCM, OAuth provider libs), which a live real-run confirmed produces non-error-looking-but-benign lines like
  // "Provider's accounts list is empty." and "[GSI_LOGGER]: FedCM get() rejects with AbortError". Those two triggered
  // TWO FALSE 'broke' verdicts on the schooltalk create-event form (matched hasException, unrelated to the oracle).
  // A broke MUST come from the app's OWN uncaught exception / 5xx / rendered stack — not a 3rd-party SDK's log line.
  // AMBIENT (2026-08-23, narrowed to 4xx + teardown noise): console lines that are NOT an app crash. Narrowed the
  // asset-fetch/status wrappers to 4xx ONLY so a real 5xx STAYS in realErrors (a server crash arrives as "failed to
  // load resource … status of 500" — the old filter ate it, blinding has5xx). ADDED teardown noise: a click TIMEOUT
  // tears down the browser context mid-request, so the in-flight request logs an abort — a HARNESS artifact, never an
  // app crash (this was 3 of 4 false brokes on schooltalk). 3rd-party auth/identity SDK chatter stays filtered too.
  const AMBIENT = /(favicon|analytics|gtag|google-analytics|websocket|ws:\/\/|net::err|gsi_logger|fedcm|provider'?s accounts|accounts\.google|oauth|identity-credential|third-party cookie|deprecat|status of 40\d|the server responded with a status of 4\d\d|failed to load resource[^]*status of 4\d\d|the request has been aborted|request (?:was|has been) aborted|failed to fetch|networkerror when attempting to fetch|err_aborted|the operation was aborted|signal is aborted|aborterror|target (?:page )?closed|(?:execution )?context (?:was )?(?:destroyed|disposed|closed)|browser has been closed)/i;
  const realErrors = consoleErrors.filter((m) => !AMBIENT.test(m));
  // A real JS-THROW shape ALWAYS wins over a rejection keyword (so "TypeError: invalid state" is a crash, not a defense).
  const JS_THROW = /\b(uncaught|unhandled (?:promise )?rejection|(?:type|range|reference|syntax|eval|aggregate|internal)error)\b|\bat [\w$.<>]+ \(|cannot read propert|(?:undefined|null) is not|is not a function|is not defined|maximum call stack/i;
  // REJECTION-SHAPED: the app DEFENDING itself (a validation/rejection body). Must route to HELD, never the exception
  // branch. NARROWED (advisor): rejection PROSE only — NO bare status-code tokens (40\d/422 belong to the 5xx/4xx
  // logic, not to "the app rendered a rejection"), and NO bare "invalid" ("TypeError: invalid state" is a crash).
  const REJECTION_SHAPED = /\b(potentially dangerous|request validation|validation failed|not allowed|forbidden|unauthorized|bad request|too long|cannot be empty|is required|must be|rejected)\b/i;
  // hasException = a NON-ambient, NON-rejection app console error (a rejection body is routed to HELD below, unless
  // it's actually a JS throw).
  const appErrors = realErrors.filter((m) => JS_THROW.test(m) || !REJECTION_SHAPED.test(m));
  const hasException = appErrors.length > 0;
  const obsLower = (observed + ' ' + realErrors.join(' ') + ' ' + finalText).toLowerCase();
  // 5xx / stack from EXECUTION EVIDENCE (5xx now stays in realErrors via the 4xx-only AMBIENT → evidence is honest).
  const evidence = (observed + ' ' + appErrors.join(' ')).toLowerCase();
  const has5xx = /(status(?: code)? of |status |http )5\d\d|internal server error/i.test(evidence);
  const hasStack = /\b(stack|traceback|unhandled|uncaught|(?:type|range|reference|syntax|eval|aggregate)error|maximum call stack)\b|cannot read propert|(?:undefined|null) is not|is not a function|is not defined|\bat [\w$.<>]+ \(/i.test(evidence);
  // HELD signal: the app rendered a REJECTION (rendered text OR a console rejection body) — but a JS-throw overrides.
  const validationShown = /\b(invalid|required|too long|cannot be empty|not allowed|must be|please (enter|fill|provide)|is required|rejected|error:)/i.test((finalText + ' ' + observed).toLowerCase())
    || realErrors.some((m) => REJECTION_SHAPED.test(m) && !JS_THROW.test(m));
  // ACCEPTED-INVALID signal: the app rendered a SUCCESS ("saved/created/added") after we fed it invalid data.
  const successShown = /\b(saved|created|added|success|posted|updated|sent|scheduled)\b/i.test(finalText.toLowerCase());
  // could we even drive the form? the SUBMIT must have happened (click landed), and fills mostly succeeded. For an
  // empty-value attack (fillSteps=0) the click alone submitting the blank form IS the attack — drove=clicked.
  // a fill failed because the FIELD ISN'T ON THE PAGE → the form we're attacking isn't here (wrong state / not
  // reached). A partially-present form is NOT the attack's target, so this can never be a verdict on the app.
  // effective fills = the fillable steps MINUS the absent valid-fillers (cross-page pollution we correctly skipped). A
  // run that filled its target + every filler THAT EXISTS on the page has driven, even if pollution added phantom ones.
  const effFillSteps = Math.max(0, fillSteps - absentFillers);
  const drove = fieldAbsent ? false
    : fields.length === 0 ? true
    : (drovePass.clicked && (effFillSteps === 0 || drovePass.fills >= Math.ceil(effFillSteps / 2)));

  const reproduce = { intent: step.intent, value: step.value || undefined, observed: (observed + (finalText ? ` | page: ${finalText.slice(0, 120)}` : '')) };

  // LOGIN-WALL GUARD (wrong-page cascade fix): if the result page is a SIGN-IN screen, the executor never reached
  // the feature under test (break-it's session didn't authenticate). EVERY verdict from here would be about the
  // login page, not the feature — so a happy/crud step "failing" here is NOT an app bug. Return needs-review
  // BEFORE any broke logic. General signal: sign-in prose + a password field cue in the final page text.
  // Broadened (2026-08-30): catch "sign in to continue" / "invalid credentials" too — torture-erp's in-memory session
  // drops on a stray reload → the flow lands on the login screen, and its "Invalid credentials" text was being
  // mis-read as the app's VALIDATION rejection → a FALSE 'held'. A login wall = the tester lost its session; ANY
  // verdict from here (held OR broke) is about the login page, not the feature. Also scan `observed` (step notes),
  // not just finalText, so a mid-flow bounce that a later step partially re-rendered is still caught.
  const loginText = (finalText + ' ' + observed).toLowerCase();
  const onLoginWall = /\b(sign in with|sign ?in to continue|log ?in to continue|invalid credentials|email address\s*\*|password\s*\*|forgot your password|not registered|sign in to your account)\b/i.test(loginText)
    && /\b(password|username)\b/i.test(loginText);
  if (onLoginWall) {
    return { ...base, verdict: 'needs-review', cause: 'credentials', detail: `couldn't run this attack — the app showed a SIGN-IN screen (session lost / not authenticated), so the feature under test was never reached. Not a verdict on the feature — its "Invalid credentials" is the LOGIN's message, not the form's validation. Oracle stands: HELD "${step.expectHeld}", BROKE "${step.expectBroke}".`, reproduce };
  }

  // ── THE EXECUTED-SOMETHING GATE (the general fix that subsumes every "wrong state" false-positive class):
  // a verdict ABOUT THE APP requires the attack to have ACTUALLY RUN against it. If NO step landed (all fills
  // missing / all clicks skipped-destructive / stuck on a picker / unverifiable-only), nothing executed, so nothing
  // can be concluded — needs-review, before any broke/held logic. (Replaces the per-symptom guards that kept
  // whack-a-mole'ing: form-absent, login-wall, skipped-destructive were all THIS.) An empty-value attack legitimately
  // has 0 fills but its SUBMIT click must still land — so "nothing passed" is the honest floor either way.
  if (!anyPass) {
    // HONEST MESSAGE (2026-08-30): "no step executed" is only true when NOTHING was attempted. If steps WERE attempted
    // but none landed (a click that couldn't resolve its target, a transient failure), say THAT — the step ran, it just
    // didn't take. Report the actual attempted step + its error so the verdict is actionable, not a blanket excuse.
    const attempted = srForReport.filter((s: any) => s.status !== 'pass');
    const lastErr = attempted.length ? String(attempted[attempted.length - 1]?.note || attempted[attempted.length - 1]?.attempts?.[0]?.error || '').slice(0, 120) : '';
    const ranButFailed = attempted.length > 0 && attempted.some((s: any) => (s.attempts || []).length);
    const detail = ranButFailed
      ? `the attack ran but its action didn't land — ${lastErr || 'the control was attempted but the click/fill did not take'}. This is a harness/timing miss (the target may render transiently, or a transient app failure), not a confirmed defect. Observed: ${observed.slice(0, 120)}`
      : `couldn't run this attack — the feature/form wasn't reached (no step could address the app). Not a verdict on the app. Observed: ${observed.slice(0, 140)}`;
    return { ...base, verdict: 'needs-review', cause: 'unreachable', detail, reproduce };
  }

  // couldn't drive the form → the attack didn't actually reach the app; not a verdict on the app itself.
  if (!drove) {
    return { ...base, verdict: 'needs-review', cause: 'unreachable', detail: `couldn't drive the form to run this attack (${drovePass.fills}/${fillSteps} fields filled, submit ${drovePass.clicked ? 'ok' : 'not reached'}) — a test-harness limit, not necessarily an app bug. Observed: ${observed}`, reproduce };
  }

  // POST-SUBMIT ORACLE (2026-08-23): the STRONGEST create/update confirmation is the app's OWN API response — a 2xx
  // WRITE call (POST/PUT/PATCH) whose body is NOT an error shape, fired during this attack. It confirms the mutation
  // happened even when the UI shows NO success toast (schooltalk: the create fired POST .../event 2xx but rendered no
  // message → the finding was stuck at needs-review). Passive — reads calls the real submit already triggered.
  const confirmingWrite = observedCalls.find((c) => c.write && c.status >= 200 && c.status < 300 && c.okBody);
  const failingWrite = observedCalls.find((c) => c.write && (c.status >= 400 || !c.okBody));

  // happy-path AND crud: these SHOULD succeed (they use valid data). An error is a finding; success is a pass.
  // Uses the cleaned signals (has5xx/hasStack = true crash; hasException = real app console error, teardown-noise +
  // rejection-bodies already filtered out) — so a click-timeout abort no longer false-brokes a happy-path step.
  if (step.phase === 'happy' || step.phase === 'crud') {
    if (has5xx || hasStack || hasException) return { ...base, verdict: 'broke', detail: `${step.phase} step threw an error — "${step.expectBroke || 'should have worked'}". Triggering signal: ${String(has5xx || hasStack ? evidence.slice(0, 100) : appErrors[0] || '').slice(0, 120)}. Observed: ${observed.slice(0, 120)}`, reproduce };
    // API-primary confirmation (strongest, immediate), then the rendered-UI signal, else reload/needs-review.
    if (confirmingWrite) {
      // AUTO-OPEN CHECK (2026-08-23): after a confirmed create, did the app navigate to a view SHOWING the created
      // item? Structural, honest: the created record carries the unique run marker — if the post-submit page text
      // shows it, the app auto-opened a detail/list view of it; if not, it returned to a generic dashboard/list.
      // (Answers a mission like "...then see if the event auto opens or not" from break-it's own step — no re-run.)
      const markerVisible = !!marker && finalText.includes(marker);
      const autoOpen = markerVisible ? ' The created item is shown on the landed page → it AUTO-OPENED (detail/list view).'
        : ' The created item is NOT shown on the landed page → it did NOT auto-open (returned to a generic view).';
      return { ...base, verdict: 'passed', detail: `${step.phase} step confirmed by the app's API — ${confirmingWrite.method} → ${confirmingWrite.status} (write succeeded). ${successShown ? 'UI also showed success.' : 'No UI toast, but the create/update landed on the server.'}${autoOpen}`, reproduce };
    }
    if (failingWrite) return { ...base, verdict: 'broke', detail: `${step.phase} step FAILED at the API — ${failingWrite.method} → ${failingWrite.status}${failingWrite.okBody ? '' : ' with an error body'}. A valid input should have succeeded.`, cause: 'file-ticket', reproduce };
    if (successShown) return { ...base, verdict: 'passed', detail: `${step.phase} step completed as expected — the app confirmed success (UI).`, reproduce };
    // STATE-DELTA ORACLE (happy/crud): no toast + no HTTP API — but did the write LAND in observable state? A change
    // that PERSISTED across a reload = the create/update really happened (held/passed, earned by inspection, no toast
    // needed). A change that REVERTED = optimistic/apply-then-fail (torture's 500-that-still-applied) → still uncertain.
    // NO change at all after a valid create = the write was silently dropped → a real, honest problem to surface.
    if (stateDelta?.persisted && drovePass.clicked) return { ...base, verdict: 'passed', detail: `${step.phase} step confirmed BY OBSERVED EFFECT — the mutating action wrote to localStorage and it PERSISTED across a reload (storage ${stateDelta.before.storageHash.slice(0,6)}→${stateDelta.afterReload?.storageHash.slice(0,6)}, ${stateDelta.before.storageBytes}→${stateDelta.afterReload?.storageBytes ?? stateDelta.after.storageBytes} bytes). No UI toast, but the write is real.`, reproduce };
    if (stateDelta && stateDelta.changed && stateDelta.reverted) return { ...base, verdict: 'needs-review', cause: 'answer-oracle', detail: `${step.phase} step changed state momentarily but it did NOT survive a reload (optimistic update or apply-then-fail). Not a confirmed write. Observed: ${finalText.slice(0, 100)}`, reproduce };
    // no state change: honest needs-review (we can't be SURE the action fully drove vs the write dropped — don't
    // manufacture a broke; that's the false-positive that burns the moat). Name the state-check so it's actionable.
    return { ...base, verdict: 'needs-review', cause: 'answer-oracle', detail: `${step.phase} step ran but no confirming signal — no API write, no UI toast, and no observable state change (checked rows/storage/DOM before+after). ${stateDelta ? 'The create may not have driven, or the write is silently dropped.' : ''} Observed: ${finalText.slice(0, 110)}`, reproduce };
  }

  // adversarial / api / crud: match against the pre-declared oracle. ORDER MATTERS (2026-08-23 FP fix):
  // 1) a TRUE mechanical crash (5xx / rendered stack) wins UNCONDITIONALLY — a crash is a crash even if validation
  //    text is also present. 2) then a REJECTION → HELD (the app defended itself — the correct adversarial outcome;
  //    this runs BEFORE the soft-exception branch, which is what fixes the "Potentially dangerous" rejection being
  //    mis-scored broke). 3) then a NON-ambient NON-rejection app console exception → broke. 4) accepts-invalid.
  if (has5xx || hasStack) {
    const trigger = has5xx ? (evidence.match(/(status(?: code)? of |status |http )5\d\d|internal server error/i)?.[0] || 'server 5xx')
      : (evidence.match(/uncaught|unhandled|traceback|(?:type|range|reference|syntax|eval|aggregate)error|cannot read propert|(?:undefined|null) is not|is not a function|is not defined|maximum call stack|\bat [\w$.<>]+ \(/i)?.[0] || 'stack/exception');
    return { ...base, verdict: 'broke', detail: `matched the BROKE oracle (${has5xx ? 'server 5xx' : 'stack/exception'}) — "${step.expectBroke}". Triggering signal: ${String(trigger).slice(0, 140)}. Observed: ${observed.slice(0, 120)}`, reproduce };
  }
  // the app REJECTED the bad input (rendered message OR a console rejection body) → HELD, as the oracle predicted.
  // BEFORE the soft-exception branch: a rejection that arrived as a console error must NOT be read as a crash.
  if (validationShown && !successShown) {
    return { ...base, verdict: 'held', detail: `the app rejected the bad input as expected ("${step.expectHeld}") — held.`, reproduce };
  }
  // a NON-ambient, NON-rejection app console exception (a real uncaught throw / error not otherwise a crash) → broke.
  if (hasException) {
    return { ...base, verdict: 'broke', detail: `matched the BROKE oracle (console exception) — "${step.expectBroke}". Triggering signal: ${String(appErrors[0] || 'uncaught console exception').slice(0, 140)}. Observed: ${observed.slice(0, 120)}`, reproduce };
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
  // ── STATE-DELTA ORACLE (adversarial): no toast, no HTTP — but did the bad input LAND in state and PERSIST? A change
  // that survived a reload is MECHANICAL PROOF the app accepted+committed the input (the same "acceptance" successShown
  // detects, but by observed effect instead of a word on screen). GUARDED against torture's false-positive class: only
  // a PERSISTED change counts — a reverted one (optimistic / 500-that-still-applied-then-reverted) does NOT, so a
  // random-failure blip never manufactures a broke.
  if (stateDelta?.persisted && drovePass.clicked) {   // gate on the submit ACTUALLY firing — a no-op click + a reload diff must never reach a verdict
    const ev = `localStorage changed and PERSISTED across a reload (storage ${stateDelta.before.storageHash.slice(0,6)}→${stateDelta.afterReload?.storageHash.slice(0,6)}, ${stateDelta.before.storageBytes}→${stateDelta.afterReload?.storageBytes ?? stateDelta.after.storageBytes} bytes)`;
    if (step.acceptIsDefect) {
      return { ...base, verdict: 'broke', cause: 'file-ticket', detail: `the app ACCEPTED+COMMITTED input the oracle said it must reject — proven BY OBSERVED EFFECT (no toast needed): ${ev}. "${step.expectBroke}".`, reproduce };
    }
    return { ...base, verdict: 'held', detail: `the app accepted the input and committed it without error, which the oracle permits ("${step.expectHeld}") — held (confirmed by observed effect: ${ev}).`, reproduce };
  }
  // a reverted change: the app took it optimistically then rolled back → it did NOT commit the bad input → HELD if the
  // oracle expected rejection (the rollback IS the rejection), else inconclusive.
  if (stateDelta && stateDelta.changed && stateDelta.reverted && step.acceptIsDefect) {
    return { ...base, verdict: 'held', detail: `the app applied the input then REVERTED it on reload (it did not commit the bad input) — the oracle's rejection expectation holds ("${step.expectHeld}").`, reproduce };
  }
  // ambiguous → needs-review (fail-safe: never 'broke' without a mechanical signal). Now names the state check so the
  // needs-review is honest about what was inspected, not a shrug.
  return { ...base, verdict: 'needs-review', cause: 'answer-oracle', detail: `inconclusive — no rejection, no accept signal, and no persisted state change (checked rows/storage/DOM before+after, +reload). Human review: does "${step.expectBroke}" hold? Observed: ${finalText.slice(0, 120) || observed}`, reproduce };
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
