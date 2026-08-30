/**
 * bugReproService.ts — BUG REPLICATION. Paste a QA bug ticket → Xsion turns it into concrete browser steps, runs
 * them on the live app, and answers the QA engineer's real question HONESTLY:
 *   • reproduced     — it did the steps and OBSERVED the reported (buggy) behavior. The bug is live.
 *   • not-reproduced — it did the steps and saw the EXPECTED behavior instead (maybe already fixed).
 *   • cant-perform   — the ticket needs an interaction the executor couldn't perform (an honest "I couldn't do
 *                      the gesture", NOT a fake verdict).
 * Mode 1: SoA also reads the handler code and cross-checks whether the reported behavior MATCHES the code — which
 * answers a ticket's open question ("cross-check with Jason"). And it PRESERVES the ticket's own uncertainty: if
 * the ticket says "unclear if a real defect", Xsion carries that forward instead of flattening it into confidence.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { isAuthorized } from './runtimeGuards';   // staging-autonomy authorization default
import { bugRepro, BugRepro } from './soaClient';
import { executeFlow } from './intentRunner';
import { liveDropPrecisionVerdict } from './dropOracle';
import { makeFrameHook } from './liveFrame';
import { recordObservation, recordContradiction, surfaceHints } from './projectKnowledge';
import { buildReachStatePrefix, pruneRedundantSteps } from './reachState';

export type ReproVerdict = 'reproduced' | 'not-reproduced' | 'cant-perform' | 'inconclusive';

export type BugEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'bugrepro:verdict'; verdict: ReproVerdict; report: any }
  | { type: 'bugrepro:need-creds'; forUrl: string; message: string }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: BugEvent) { wsServer.broadcastToRun(runId, e as any); }

// RESOLUTION for a bug-repro run — WHAT THE USER DOES NEXT (never a dead-end verdict). Mirrors break-it's
// resolution surface. The novel kind here is `needs-input`: the run reached the feature but a step's control
// didn't match any label on the page — the app's real UI differs from the ticket's assumed step. The user picks
// the right control from the candidate list (stored navigational → next run uses it); we NEVER guess (a wrong
// pick can touch data). Pure.
export type BugResolutionKind = 'file-ticket' | 'none' | 'credentials' | 'needs-input' | 'unreachable' | 'authorize';
export interface BugResolution { kind: BugResolutionKind; question?: string; forStep?: string; candidates?: string[]; }
export function deriveBugReproResolution(
  verdict: ReproVerdict,
  ctx: { needsCreds: boolean; loginWall: boolean; isSSO: boolean; stepResults: any[]; flowSteps: any[]; dropPrecision?: boolean; emptyCalendar?: boolean },
): BugResolution {
  if (verdict === 'reproduced') return { kind: 'file-ticket' };
  if (verdict === 'not-reproduced') return { kind: 'none' };
  if (ctx.needsCreds || ctx.loginWall) return { kind: 'credentials' };
  if (ctx.isSSO) return { kind: 'unreachable' };
  // EMPTY-CALENDAR (drop-precision, but the TARGET STATE the ticket needs doesn't exist): I reached the calendar and
  // the oracle is ready, but there aren't two events of differing lengths to drop between. That's a data-state gap,
  // not a capability gap — the honest next action names exactly what's missing so the user can supply it.
  if (ctx.emptyCalendar) return { kind: 'needs-input', question: 'I reached the calendar and my drop-precision test is ready — but this account has no day with two events of differing lengths, which the bug requires (it\'s about where a new event lands *between* two existing ones). Give me a date or tenant that has such a day, or authorize me to create the two events, and I\'ll run the real precision test to a reproduced/fixed verdict.' };
  // CAPABILITY-GAP (drop-precision): not a login/auth/reachability block and not answerable by picking a control —
  // it's a missing executor capability (coordinate-precise drop + position read-back). Surface as needs-input so the
  // UI offers "tell me what to do" rather than a dead "unreachable", but the honest question names the capability gap.
  if (ctx.dropPrecision) return { kind: 'needs-input', question: 'This drag-precision bug needs a coordinate-exact drop + a read-back of where the item landed — a capability I don\'t have yet. If you can confirm the buggy placement manually, tell me and I\'ll file it; otherwise this stays a known capability gap, not a false verdict.' };
  // AUTHORIZE (the approve-to-click button): the repro reached the feature but a step was SKIPPED because it mutates
  // and the project isn't security.authorized. That's not "unreachable" — it's one click of consent away. Surface the
  // authorize action so the user can approve and re-run to a real verdict (entrepreneur-lens: a button, not a dead end).
  const skippedForAuth = (ctx.stepResults || []).some((s) => /skipped mutating step \(not authorized\)/i.test(s.note || ''));
  if (skippedForAuth) return { kind: 'authorize', question: 'This reproduction needs to perform an action that changes data (a mutating step). Authorize Xsion to run mutating steps on its own tagged test data, then re-run to get a real reproduced/fixed verdict.' };
  // cant-perform / inconclusive: find the FIRST step that failed with "no match" ON A PAGE THAT HAD candidates
  // (= the feature was reached, the app's control just has a different label than the ticket assumed).
  for (const s of ctx.stepResults) {
    const err = s.note || s.attempts?.[0]?.error || '';
    const m = /no match for .*Candidates on page:\s*(.+)$/i.exec(err);
    if ((s.status === 'fail') && m) {
      let cands = m[1].split('|').map((c: string) => c.trim()).filter(Boolean).slice(0, 10);
      // drop degenerate candidates (the avatar-initials button `sc`, icon-only buttons) — "pick from a list of one
      // avatar button" isn't an answerable question. Need ≥2 REAL options for needs-input; else it's unreachable
      // (the page hadn't rendered / there's genuinely nothing to pick).
      const isReal = (c: string) => { const label = (c.split(':')[1] || c).replace(/["']/g, '').trim(); return label.length >= 3; };
      cands = cands.filter(isReal);
      if (cands.length >= 2) {
        const intent = ctx.flowSteps[s.stepIndex]?.intent || 'a step';
        return { kind: 'needs-input', forStep: intent, candidates: cands, question: `Your ticket says "${intent}", but this app's screen offers different controls. Which one does that step? (I won't guess — the wrong choice could touch data.)` };
      }
    }
  }
  return { kind: 'unreachable' };
}

export interface BugOpts { repo: string; ticket: string; }

export function startBugRepro(projectId: string, baseUrl: string, opts: BugOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Bug repro` } as any);
  runBugRepro(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'test:think', message: `bug-repro error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Run failed', kind: 'bugrepro' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

async function runBugRepro(runId: string, projectId: string, baseUrl: string, opts: BugOpts) {
  console.log(`[XSION][bug-repro] START run=${runId.slice(0,8)} project=${projectId} url=${baseUrl} ticketLen=${(opts.ticket||'').length}`);
  const map = store.getProjectMap(projectId);
  const project = store.getProject(projectId);
  // in-memory creds set via the cred prompt (PUT /credentials) — stripped on persist, never logged.
  const creds = (project as any)?._defaultCreds as { email?: string; password?: string } | undefined;
  console.log(`[XSION][bug-repro] project.hasCredentials=${!!creds} mapFlows=${(map?.flows||[]).length}`);
  emit(runId, { type: 'test:phase', phase: 'start', label: 'Reading the bug ticket', kind: 'bugrepro' });
  // PROGRESS: SoA reading the ticket + (mode 1) the code takes ~30-60s. Say so, so the panel is never a dead READY.
  emit(runId, { type: 'test:think', message: `Reading the ticket${opts.repo ? ' and cross-checking the code' : ''} and turning it into concrete steps… (this takes ~30–60s)` });

  // FEED SoA THE CRAWL KNOWLEDGE (not just bare paths). The crawl already learned this app — its page PATHS (whose
  // URL templates reveal gates like /:portal/Teacher/...), how many interactive controls each page had, and the
  // FLOWS it identified (which literally name gates, e.g. "Select Demo/Doon portal"). Without this SoA re-guesses
  // steps from the ticket words alone and face-plants on gates the crawl already mapped (schooltalk "Choose Portal").
  // PROJECT LEARNING: feed SoA what PRIOR runs learned about navigating this app (gates, working routes/selectors) —
  // so it starts smart instead of re-discovering. NAVIGATIONAL only; never oracle (projectKnowledge.ts safety line).
  const knowledgeNow = store.getProjectKnowledge(projectId);
  const priorKnowledge = surfaceHints(knowledgeNow);
  // HUMAN-CONFIRMED CORRECTIONS → the executor enforces them regardless of how SoA phrases the step (the teach-the-
  // app loop's last mile, made deterministic). Extract the control label from facts like:
  //   for "<step>", click the control "<Control>"   → "<Control>"
  const corrections = (knowledgeNow || [])
    .filter((e: any) => e.provenance === 'human-confirmed' && e.kind === 'selector')
    .map((e: any) => { const m = /click the control "([^"]+)"/i.exec(e.fact || ''); return m ? m[1] : ''; })
    .filter(Boolean);
  const surface = {
    baseUrl,
    pages: (map?.pages || []).map((p: any) => ({ path: p.path, interactives: p.interactives })).slice(0, 30),
    flows: (map?.flows || []).map((f: any) => ({ name: f.name, steps: (f.steps || []).map((s: any) => s.intent).slice(0, 6) })).slice(0, 8),
    // GATES the crawl found (portal/workspace/tenant pickers) — so SoA emits the gate-passing step FIRST + KNOWS the
    // real option labels (e.g. "NZ Curriculum" exists), instead of doubting/rediscovering the picker every run.
    gates: (map?.gates || []).map((g: any) => ({ path: g.path, kind: g.kind, options: (g.options || []).map((o: any) => o.label).slice(0, 12) })),
    learnedNavigation: priorKnowledge.map((h) => h.fact),   // "clicking 'Demo School' → /demo/Teacher/Dashboard", etc.
  };
  const authorized = isAuthorized(project);   // staging-autonomy: default ON unless the project explicitly sets it false
  // SURFACE a prior environment-state fact (perishable, NON-gating): if a past run saw this app's calendar empty, SAY
  // so up front — it explains what to expect and orders the check, but the live probe below still runs and can
  // invalidate it. This is the "runs compound" payoff for diagnostic state, kept safe (informs, never skips the look).
  const priorEnvState = surfaceHints(knowledgeNow).filter((h) => h.kind === 'environment-state');
  if (priorEnvState.length) emit(runId, { type: 'test:think', message: `Heads-up from a prior run: ${priorEnvState[0].fact}. I'll still check live (this may have changed) — not trusting it blindly.` });
  let repro: any = null, error: string | undefined, raw: string | undefined;
  try {
    const r = await bugRepro(opts.repo, { ticket: opts.ticket, surface });
    repro = r.repro; error = r.error; raw = r.raw;
  } catch (e: any) {
    // an SoA timeout / spawn failure must surface honestly — not a frozen panel.
    emit(runId, { type: 'test:think', message: `The reproduction planner didn't respond in time (${String(e?.message || e).slice(0, 120)}). This is an Xsion/SoA issue, not your ticket — try again.` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Planner timed out', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
    return;
  }
  if (!repro) {
    // DISTINGUISH: a parse failure (SoA's fault, retry) is NOT "your ticket is vague". Say which, and show the raw.
    const isParseFail = /not valid json|unparseable|parse failed/i.test(error || '');
    emit(runId, { type: 'test:think', message: isParseFail
      ? `SoA's reply wasn't valid JSON even after a retry — this is a transient planner glitch on our side, not a problem with your ticket. Please run it again.${raw ? ` (raw: ${String(raw).slice(0, 160)})` : ''}`
      : `The ticket didn't contain enough to build runnable steps — add Steps to Reproduce / Expected / Actual so I can turn it into actions.${error ? ` (${error})` : ''}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: isParseFail ? 'Planner glitch — retry' : 'Not enough in the ticket', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', verdict: 'cant-perform', parseError: isParseFail, detail: isParseFail ? 'SoA reply was not valid JSON (retry it).' : 'The ticket lacked enough detail to build steps.', raw: raw ? String(raw).slice(0, 400) : undefined } as any] } as any);
    return;
  }

  // PRE-CHECK — the cred prompt: if the repro requires a login (the ticket/steps say so) and this project has NO
  // credentials, stop and ASK rather than silently running the whole repro against the sign-in page (the schooltalk
  // false-positive). The frontend shows a cred overlay → PUT /credentials stores _defaultCreds → re-run picks them up.
  const needsLogin = reproNeedsLogin(repro.steps, opts.ticket);
  if (needsLogin && !(creds?.email && creds?.password)) {
    emit(runId, { type: 'test:think', message: 'This reproduction needs a logged-in session (the ticket starts by logging in), but this project has no credentials. I won\'t run the steps against the sign-in page and hand you a false verdict.' });
    emit(runId, { type: 'bugrepro:need-creds', forUrl: baseUrl, message: 'To reproduce this bug I need to sign in first. Enter credentials for this app and I\'ll run the full reproduction.' });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Credentials needed', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', verdict: 'cant-perform', needsCreds: true, expectedBehavior: repro.expectedBehavior, actualBehavior: repro.actualBehavior, openQuestion: repro.openQuestion, detail: 'Paused before running — this reproduction requires a login and the project has no credentials. Add credentials and re-run.' } as any] } as any);
    return;
  }

  emit(runId, { type: 'test:think', message: `The ticket needs: ${repro.interaction || 'standard UI actions'}. Expected: “${repro.expectedBehavior}”. Reported (buggy): “${repro.actualBehavior}”.` });
  if (repro.openQuestion) emit(runId, { type: 'test:think', message: `⚠ The ticket itself is uncertain — I'll carry this forward, not override it: ${repro.openQuestion}` });
  if (repro.codeAssessment) emit(runId, { type: 'test:think', message: `Code cross-check: the reported behavior ${repro.codeAssessment === 'matches-code' ? 'MATCHES the code (likely a real defect)' : repro.codeAssessment === 'contradicts-code' ? 'CONTRADICTS the code (may be already fixed / stale ticket)' : 'is unclear from the code'}${repro.codeRef ? ` (${repro.codeRef})` : ''}.` });

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Reproducing the steps', kind: 'bugrepro' });

  // REACH-THE-STATE PREPEND (the shared unblock): the app gates the feature behind a PORTAL/SCHOOL picker the
  // crawl already mapped (recorded as `/Teacher › <School>` pages with `clicks:['<School>']`). SoA's repro steps
  // often name the school ("Select the NZ Curriculum school") but the executor face-plants on it (target-mangling
  // + the picker must be present first). So: if the ticket/steps reference a school the CRAWL recorded as a picker
  // option, PREPEND the exact recorded click so we land inside that tenant BEFORE the repro steps run. Uses the
  // crawl's own observed navigation — no synthesis. General: any app whose feature sits behind a recorded chooser.
  const reachPrefix = buildReachStatePrefix(map, opts.ticket, repro.steps);
  const chosenOpt = reachPrefix.length ? reachPrefix[0].intent.replace(/^click "|"$/g, '') : null;
  // prune steps the login pre-step (creds present) + the reach prepend make redundant, so they don't fail on a page
  // where their target is gone (a mid-flow fail that used to poison the verdict → cant-perform).
  const prunedSteps = pruneRedundantSteps(repro.steps, chosenOpt, !!(creds?.email && creds?.password), baseUrl);
  if (reachPrefix.length) emit(runId, { type: 'test:think', message: `This feature sits behind a chooser the crawl mapped — I'll navigate through it first (${reachPrefix.map((s: any) => s.intent).join(' → ')}) so the reproduction starts in the right place.` });
  const droppedN = repro.steps.length - prunedSteps.length;
  if (droppedN > 0) emit(runId, { type: 'test:think', message: `Skipping ${droppedN} redundant step(s) (login/school-select the pre-steps already handle) so they don't fail on a page where they no longer apply.` });
  // MUTATION SAFETY (mirror break-it): bug-repro may CREATE real data on the app (a ticket's precondition, e.g.
  // "create a recurring event"). Tag every free-text value it fills into an IDENTITY field (title/name/subject)
  // with a run marker so the user can FIND + DELETE what this run created. Only when authorized (else no writes run).
  const marker = `XSION-BUGREPRO-${runId.slice(0, 8)}`;
  const taggedSteps = authorized ? prunedSteps.map((s: any) => {
    const intent = String(s.intent || '');
    const isIdentity = /\b(title|name|subject|label|event)\b/i.test(intent) && /\b(fill|enter|type|set)\b/i.test(intent);
    if (!isIdentity || /\bXSION-/.test(intent)) return s;
    const hasQuotedVal = /\bwith\s+["'][^"']+["']/i.test(intent);
    if (hasQuotedVal) {
      // append the marker INSIDE the existing quoted value → the created record carries it.
      return { ...s, intent: intent.replace(/(["'])([^"']+)(["'])(\s*)$/, `$1$2 ${marker}$3$4`) };
    }
    // NO explicit value (e.g. "fill event title") → the executor would use a generic default (test@example.com)
    // with NO marker, leaving an UNTAGGED record on the user's app. Give it a marked value so it's findable.
    return { ...s, intent: `${intent.replace(/\s+$/, '')} with "${marker}"` };
  }) : prunedSteps;
  if (authorized) emit(runId, { type: 'test:think', message: `Any data I create carries the marker "${marker}" so you can find + delete it afterward. I only mutate what I create.` });
  const flow = { name: 'bug-repro', role: 'tester', steps: [...reachPrefix, ...taggedSteps] };
  let stepResults: any[] = [];
  let authResult: any = null;   // the auth pre-step's own result (stepIndex -1) — DON'T discard it, it tells us if login worked
  let consoleErrors: string[] = [];
  let finalText = '';
  const frameHook = makeFrameHook(runId, emit as any);   // LIVE VIEW + PLAYBACK
  frameHook.caseIndex = 0; frameHook.caseTitle = 'Reproduction';   // one case: the repro sequence
  let learned = store.getProjectKnowledge(projectId);   // accumulate NAVIGATIONAL facts this run learns
  const learnNow = () => new Date().toISOString();
  // DROP-PRECISION ORACLE (the capability that turns the drag-precision capability-gap into a REAL verdict): only when
  // the ticket is a drop-position bug AND the project authorized mutations (the drag writes) do we run the two-aim
  // differential on the reached calendar. Its result overrides the default cant-perform ONLY if it produced a genuine
  // reproduced/not-reproduced from two positional observations — otherwise the honest capability-gap message stands.
  const runDropOracle = needsDropPrecision(repro) && authorized;
  console.log(`[XSION][drop-oracle] needsDropPrecision=${needsDropPrecision(repro)} authorized=${authorized} → runDropOracle=${runDropOracle}`);
  let dropOracleResult: { verdict: ReproVerdict; why: string } | null = null;
  let dropOracleDiag: { reachedCalendar: boolean; eventCount: number } | undefined;   // why an inconclusive happened
  try {
    if (creds?.email && creds?.password) emit(runId, { type: 'test:think', message: 'Signing in with the project credentials first, then running the reproduction from the authenticated app.' });
    if (runDropOracle) emit(runId, { type: 'test:think', message: 'This is a drop-POSITION bug — after reaching the calendar I\'ll run a two-aim precision test: drop the event at two different slots and read back where each landed. If both collapse to the same place, the app ignores the drop position (the bug); if they land differently, it honors it.' });
    const exec = await executeFlow(flow as any, baseUrl, {
      onStepStart: (i, intent) => emit(runId, { type: 'test:item-start', index: i, title: intent }),
      onStepResult: (sr) => emit(runId, { type: 'test:item-result', index: sr.stepIndex, status: sr.status === 'pass' ? 'pass' : 'fail', detail: sr.note || sr.attempts?.[0]?.error || '' }),
      onConsoleError: (m) => consoleErrors.push(m),
      onThink: (m) => emit(runId, { type: 'test:think', message: m }),   // SURFACE the on-stall recovery reasoning
      onLearn: (obs) => { learned = recordObservation(learned, obs, learnNow()); },   // ACCUMULATE navigational facts
      onFrame: frameHook,
      onReachedState: runDropOracle ? async (page) => {
        try {
          const dropTarget = pickDropSourceId(repro);   // the event the ticket describes dragging (or a sensible default)
          const columnHint = pickColumnHint(repro, opts.ticket);
          // NAVIGATE TO THE CALENDAR the crawl already mapped — SoA's generated "navigate to calendar" step lands on
          // the dashboard (/Teacher), where there are no events to read. Go straight to the recorded calendar URL so
          // the oracle probes the RIGHT page. (This is why the first live run read snapshotEvents=0.)
          const calUrl = pickCalendarUrl(map);
          if (!/\/calendar\b/i.test(page.url())) {
            // CLICK-THROUGH, don't deep-link (probe-proven): deep-linking a stored /Calendar?id=… URL BOUNCES to the
            // dashboard, AND the stored URL is a specific tenant (/demo, /qa) — goto'ing it LEAVES whatever tenant the
            // run actually reached (e.g. NZ Curriculum). So: click "My Calendar" from the CURRENT tenant. Only fall
            // back to goto when there's no such control, and NEVER across tenants (stored URL's tenant must match now).
            const curTenant = (() => { try { return new URL(page.url()).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
            let navd = false;
            for (const label of ['My Calendar', 'Calendar']) {
              try {
                const loc = page.getByText(label, { exact: true });
                if (await loc.count() >= 1) { await loc.first().click({ timeout: 5000 }); await page.waitForTimeout(2500); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); navd = true; emit(runId, { type: 'test:think', message: `Clicked "${label}" to open this tenant's calendar (staying in the school the run reached — not deep-linking a different tenant).` }); break; }
              } catch {}
            }
            if (!navd && calUrl) {
              const calTenant = (() => { try { return new URL(calUrl).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
              if (calTenant && calTenant === curTenant) { try { await page.goto(calUrl, { waitUntil: 'networkidle', timeout: 20000 }); await page.waitForTimeout(800); } catch (ne: any) { console.log(`[XSION][drop-oracle] calendar goto error: ${String(ne?.message||ne).slice(0,100)}`); } }
              else console.log(`[XSION][drop-oracle] no "My Calendar" control + stored URL tenant "${calTenant}" ≠ current "${curTenant}" → NOT cross-navigating (would leave the tenant)`);
            }
          }
          // DIAGNOSTIC: what page did we land on, and does snapshotColumn see any events? (this is the live-DOM
          // question the advisor flagged — logged so a cant-perform tells us WHY, not just that it happened.)
          try {
            const { snapshotColumn } = await import('./dropOracle');
            const probe = await snapshotColumn(page, columnHint);
            const reached = /\/calendar\b/i.test(page.url());
            dropOracleDiag = { reachedCalendar: reached, eventCount: probe.length };
            console.log(`[XSION][drop-oracle] onReachedState url=${page.url()} source="${dropTarget}" hint=${columnHint || '-'} snapshotEvents=${probe.length} ids=${JSON.stringify(probe.slice(0,6).map((e:any)=>e.id))}`);
            // ENVIRONMENT-STATE LEARNING (perishable, scoped, NON-gating — advisor): record what we OBSERVED about this
            // calendar window so a future run can EXPLAIN + order what to check first — it never skips this live probe.
            // A contradicting observation (events now present) invalidates a prior "empty" fact via recordContradiction.
            if (reached) {
              // ALWAYS record the observed count (advisor): an environment-state entry is a MEASUREMENT, not a claim —
              // recordObservation dedups by key and refreshes the fact text, so a later run overwrites the old count.
              // Recording PRESENCE too (not just absence) means "this calendar HAS events" is reusable positive
              // knowledge, and the fact self-heals when the count changes. No separate contradiction path needed.
              const key = calendarStateKey(page.url());
              const enough = probe.length >= 2;
              learned = recordObservation(learned, { kind: 'environment-state', key,
                fact: `calendar window ${key.replace('calendar-state:', '')} had ${probe.length} event(s)${enough ? ' — enough to attempt a drop-precision repro' : ' — a drop-precision repro needs a day with ≥2 events of differing lengths'}` }, learnNow());
            }
          } catch (pe: any) { console.log(`[XSION][drop-oracle] snapshot probe error: ${String(pe?.message||pe).slice(0,120)}`); }
          const reset = async () => { try { if (calUrl) { await page.goto(calUrl, { waitUntil: 'networkidle', timeout: 20000 }); } else { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); } await page.waitForTimeout(600); } catch {} };
          const r = await liveDropPrecisionVerdict(page, { sourceId: dropTarget, columnHint, resetToState: reset });
          console.log(`[XSION][drop-oracle] verdict=${r.verdict} why=${r.why.slice(0,140)}`);
          if (r.verdict === 'reproduced' || r.verdict === 'not-reproduced') {
            dropOracleResult = { verdict: r.verdict, why: r.why };
            emit(runId, { type: 'test:think', message: `Drop-precision test → ${r.verdict.toUpperCase()}. ${r.why}` });
          } else {
            emit(runId, { type: 'test:think', message: `Drop-precision test was inconclusive (${r.why}) — I won't guess a positional verdict, so the honest capability note stands.` });
          }
        } catch (e: any) { emit(runId, { type: 'test:think', message: `drop-precision probe error: ${String(e?.message || e).slice(0, 120)} — keeping the honest capability note.` }); }
      } : undefined,
    }, undefined, creds, { allowMutations: authorized, corrections });   // creds → login; corrections → executor enforces human-confirmed control labels
    stepResults = exec.stepResults.filter((s) => s.stepIndex >= 0);
    authResult = exec.stepResults.find((s) => s.stepIndex === -1) || null;   // the login pre-step's own outcome
    finalText = exec.finalText || '';
    // PERSIST what this run learned about navigating the app → next run starts smarter. Navigational only.
    if (learned.length) { store.setProjectKnowledge(projectId, learned); const n = surfaceHints(learned).length; if (n) emit(runId, { type: 'test:think', message: `Learned ${n} navigation fact(s) about this project — future runs will start smarter (how to reach pages, working selectors). This never affects bug verdicts, only navigation.` }); }
  } catch (e: any) {
    emit(runId, { type: 'test:think', message: `execution error: ${String(e?.message || e).slice(0, 100)}` });
  }

  // ── SSO DETECTION (the schooltalk case): the user gave correct creds, but the app signs in via Google/Microsoft
  // SSO — an identity-provider consent flow Xsion CANNOT (and must not) automate. The tells: the login pre-step
  // failed AND the console shows a 401 / Google-Sign-In (GSI_LOGGER) / FedCM / accounts.google.com abort. Reporting
  // this as `inconclusive` ("we tried and couldn't tell") is a false-neutral — the truth is "we never got in".
  const isSSO = detectSSO(!!(creds?.email && creds?.password), authResult, consoleErrors);
  // A failed PASSWORD login (form was present + filled, but sign-in didn't take) is DISTINCT from SSO — surface it
  // honestly so the user isn't told to "use a non-SSO account" for an app that has password login. authResult.note
  // is the self-diagnosing signal (persisted below): 'login did not persist' / 'form never appeared' / 'pre-step failed'.
  const passwordLoginFailed = !isSSO && creds?.email && creds?.password && authResult?.status === 'fail';
  if (passwordLoginFailed) {
    emit(runId, { type: 'test:think', message: `Sign-in didn't take — the app HAS an email/password login (not SSO-only), but this attempt stayed on the sign-in screen (${authResult?.note || 'reason unclear'}). It could be wrong credentials, a slow redirect, or the account being locked/rate-limited. Not an SSO problem.` });
  }

  // ── THE HONEST VERDICT ──
  let verdict = judgeRepro(repro, stepResults, consoleErrors, finalText);
  if (isSSO) verdict = 'cant-perform';   // never got in → not a bug verdict
  // GUARD-LIFT (drop-precision): judgeRepro returns cant-perform for a drop-position ticket by default (the safety
  // rule). If — and ONLY if — the oracle actually produced a real verdict from two positional observations, THAT
  // verdict wins. A null/inconclusive oracle result leaves the honest capability-gap message in place (no positional
  // verdict without a positional observation). This is the whole safety inversion the advisor specified.
  if (dropOracleResult) { verdict = (dropOracleResult as { verdict: ReproVerdict }).verdict; }

  // LOGIN-WALL DETECTION: if the repro never got past a sign-in page (every failed step's candidates were login
  // controls, or the final page is a sign-in screen), the honest reason is "I need credentials" — NOT a bug verdict,
  // and NOT a generic "couldn't do the interaction". This is what happened on schooltalk (no creds in the server env,
  // no prompt) → say so plainly so the operator knows to provide creds, mirroring the crawl's need-creds behavior.
  const failedCandidates = stepResults.filter((s) => s.status === 'fail').map((s) => String(s.attempts?.[0]?.error || '')).join(' ').toLowerCase();
  const loginWall = (/sign\s?in|log\s?in|google|microsoft/.test(failedCandidates) && /candidates|no match|no input/.test(failedCandidates))
    || /sign in to (access|continue)|email address\s+password/i.test(finalText);
  const ssoDetail = 'Your credentials are correct, but this app signs you in through Google / Microsoft SSO — a third-party consent flow Xsion can\'t (and won\'t) automate. So I never reached the feature. To run this repro, use a non-SSO test account (email + password login), or supply a logged-in session cookie / storageState.';
  // POST-LOGIN INTERSTITIAL: logged in fine, but PARKED on an unexpected gate (a portal/workspace/school picker) the
  // ticket's steps never mention. This is what actually happened on schooltalk: it authenticated, then sat on a
  // "Choose Portal" school-selection screen for all 16 steps. Name it + quote the options; force cant-perform.
  const interstitial = (!isSSO && !loginWall) ? detectInterstitial(stepResults, finalText) : null;
  if (interstitial) verdict = 'cant-perform';
  // Don't duplicate the options if the heading already lists them (e.g. "Choose Portal: Demo School Doon School…").
  const headingHasOpts = interstitial ? interstitial.options.some((o) => interstitial.heading.includes(o)) : false;
  const interstitialDetail = interstitial
    ? `I signed in fine, but got stopped on a screen${interstitial.heading ? ` — "${interstitial.heading}"` : ''} your ticket's steps don't mention${(!headingHasOpts && interstitial.options.length) ? ` (it's offering: ${interstitial.options.join(', ')})` : ''}. Your steps assume the app is already past this. Add the step to get through it, or tell me which option to pick — I won't guess, since the wrong choice touches real data.`
    : '';
  if (isSSO) {
    emit(runId, { type: 'test:think', message: `I couldn't sign in — the app uses Google/Microsoft SSO (saw a 401 + Google Sign-In abort in the console). ${ssoDetail}` });
  } else if (interstitial) {
    emit(runId, { type: 'test:think', message: interstitialDetail });
  } else if (loginWall && verdict === 'cant-perform') {
    emit(runId, { type: 'test:think', message: 'I never got past the LOGIN screen — every step matched only sign-in controls (Google / Microsoft / Sign In). I have no credentials for this project, so I can\'t reach the feature to reproduce the bug. Add credentials for this project and re-run.' });
  }

  const report = {
    verdict,
    expectedBehavior: repro.expectedBehavior,
    actualBehavior: repro.actualBehavior,
    interaction: repro.interaction,
    codeAssessment: repro.codeAssessment,
    codeRef: repro.codeRef,
    openQuestion: repro.openQuestion,
    loginWall: (loginWall && verdict === 'cant-perform') || isSSO,
    ssoBlocked: isSSO,
    authResult: authResult ? { status: authResult.status, note: authResult.note } : undefined,   // persist the login outcome (self-diagnosing, not lossy)
    passwordLoginFailed: !!passwordLoginFailed,
    interstitial: interstitial ? { heading: interstitial.heading, options: interstitial.options } : undefined,
    detail: dropOracleResult
      ? `${(dropOracleResult as { why: string }).why}${repro.openQuestion ? ` (Ticket's own open question, preserved: ${repro.openQuestion})` : ''}`
      : (dropOracleDiag && dropOracleDiag.reachedCalendar && dropOracleDiag.eventCount < 2)
      ? `I reached the calendar and my drop-precision test is ready — but this account's calendar has ${dropOracleDiag.eventCount === 0 ? 'no events' : 'only one event'} on the day I checked, and the bug needs a day with TWO events of different lengths to reproduce (that's the whole point — where a new event lands *between* them). I won't fabricate a verdict without that state. Tell me a date/tenant that has two events, or authorize me to create them, and I'll run the real two-aim precision test.`
      : isSSO
      ? ssoDetail
      : interstitial
      ? interstitialDetail
      : loginWall && verdict === 'cant-perform'
      ? `I couldn't reproduce this — I never got past the LOGIN screen (every step matched only sign-in controls, and I have no credentials for this project). This is NOT a verdict on the bug; add credentials and re-run to actually reach the feature.${repro.codeAssessment === 'contradicts-code' || repro.openQuestion ? ` Separately, the code cross-check couldn't find this feature in the repo${repro.openQuestion ? `: ${repro.openQuestion}` : '.'}` : ''}`
      : verdictDetail(verdict, repro, stepResults, finalText),
    stepsRun: stepResults.map((s) => ({ intent: (flow.steps as any)[s.stepIndex]?.intent, status: s.status, note: s.note || s.attempts?.[0]?.error })),
    consoleErrors: consoleErrors.slice(0, 20),   // persist the console signal so a verdict is auditable (not lossy)
    // RESOLUTION (the entrepreneur-lens "next action" — a cant-perform must NEVER be a dead end):
    resolution: deriveBugReproResolution(verdict, { needsCreds: false, loginWall: loginWall && verdict === 'cant-perform', isSSO, stepResults, flowSteps: flow.steps as any, dropPrecision: needsDropPrecision(repro), emptyCalendar: !!(dropOracleDiag && dropOracleDiag.reachedCalendar && dropOracleDiag.eventCount < 2) }),
  };

  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', ...report, frames: frameHook.frames } as any] } as any);
  emit(runId, { type: 'bugrepro:verdict', verdict, report });
  emit(runId, { type: 'test:phase', phase: 'done', label: 'Reproduction complete', kind: 'bugrepro' });
  emit(runId, { type: 'test:think', message: `Verdict: ${verdict.toUpperCase()}. ${report.detail}` });
  emit(runId, { type: 'test:done', passed: verdict === 'not-reproduced' ? 1 : 0, failed: verdict === 'reproduced' ? 1 : 0, skipped: verdict === 'reproduced' || verdict === 'not-reproduced' ? 0 : 1, total: 1 });
}

/** Judge: could we perform the interaction? if a hard-interaction step failed to even execute → cant-perform.
 * Else compare what we OBSERVED against the ticket's expected vs actual. */
/** Does this reproduction require a logged-in session? (the ticket/steps say "log in", "sign in", "as a Teacher",
 * etc.) — used to PROMPT for credentials before running, instead of silently testing the sign-in page. Pure. */
export function reproNeedsLogin(steps: Array<{ intent?: string }> | undefined, ticket?: string): boolean {
  const text = ((steps || []).map((s) => s.intent || '').join(' ') + ' ' + (ticket || '')).toLowerCase();
  return /\blog ?in\b|\bsign ?in\b|\bas an? (teacher|admin|user|owner|member|manager|staff)\b|\bauthenticated?\b|\blogged.?in\b/.test(text);
}

/** Did an authenticated repro get BLOCKED by SSO? True when the login pre-step failed AND the console shows a
 * third-party identity-provider signal (Google Sign-In / FedCM / MS login / OAuth / 401). Pure + exported so the
 * schooltalk case ("correct creds, but the app uses Google/Microsoft SSO") is locked by a test. */
export function detectSSO(hadCreds: boolean, authResult: { status?: string; attempts?: any[] } | null, consoleErrors: string[]): boolean {
  const authFailed = hadCreds && (!authResult || authResult.status === 'fail');
  // CRITICAL: if a PASSWORD FORM was present + filled, this is a FAILED PASSWORD LOGIN ("sign-in didn't take"), NOT
  // SSO — even though the page's background Google call logs a 401/FedCM. Only call it SSO when there was NO usable
  // email/password path. (Without this, schooltalk — which offers BOTH SSO and password — got a WRONG "use a non-SSO
  // account" verdict telling the user to get the thing they already have.)
  const hadPasswordForm = !!authResult?.attempts?.some((a: any) => a?.hadPasswordForm);
  if (hadPasswordForm) return false;
  const ssoSignal = /gsi_logger|fedcm|accounts\.google|login\.microsoftonline|oauth|\b401\b/i.test((consoleErrors || []).join(' '));
  return !!(authFailed && ssoSignal);
}

/** Detect an UNEXPECTED INTERSTITIAL (a tenant/workspace/portal/school picker, a consent gate, an onboarding wall)
 * that the ticket's steps never accounted for — the repro logged in but got PARKED on a screen it can't get past.
 * GENERALIZABLE signal (not a schooltalk-specific rule): ≥3 actionable steps all failed to match (matched:0) AND
 * the page never changed across them (same candidates each time). Returns the interstitial's heading + a few of its
 * options, quoted from the step errors, so the verdict names the real blocker. null when it's not an interstitial. */
export function detectInterstitial(steps: any[], finalText: string): { heading: string; options: string[] } | null {
  const actionFails = steps.filter((s) => s.status === 'fail' && /click|fill|select|type/i.test(s.attempts?.[0]?.kind || ''));
  if (actionFails.length < 3) return null;
  // pull the "Candidates on page: ..." lists from the failed steps; if they're stable across steps, we're parked.
  const candLines = actionFails.map((s) => {
    const m = String(s.attempts?.[0]?.error || '').match(/candidates on page:\s*(.+)$/i);
    return m ? m[1].trim() : '';
  }).filter(Boolean);
  if (candLines.length < 3) return null;
  const uniqueCandSets = new Set(candLines);
  if (uniqueCandSets.size > 2) return null;   // the page CHANGED across steps → not a single stuck interstitial
  // a heading, if the finalText carries one (e.g. "Choose Portal:", "Select a workspace"). Grab a longer tail so the
  // options that follow the picker prompt are captured (e.g. "Choose Portal: Demo School Doon School …").
  const headMatch = (finalText || '').match(/\b(choose|select|pick)\b[^.\n]{0,20}(portal|workspace|organi[sz]ation|school|tenant|account|team)\b[^.\n]{0,120}/i);
  const heading = headMatch ? headMatch[0].replace(/\s+/g, ' ').trim() : '';
  // OPTIONS: the candidate buttons are noisy (they include the avatar "sc"), so prefer the picker options carried in
  // the heading tail; fall back to candidate labels only when the heading has none. Drop 1-2 char noise like "sc".
  const fromHeading = heading.split(/:|\bportal\b|\bworkspace\b|\bschool\b/i).pop() || '';
  const headingOpts = (fromHeading.match(/[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*/g) || []).filter((o) => o.length > 3);
  const candOpts = Array.from(new Set((candLines[0].match(/"([^"]+)"/g) || []).map((q) => q.replace(/"/g, '')))).filter((o) => o && o.length > 2);
  const options = (headingOpts.length ? headingOpts : candOpts).slice(0, 6);
  return { heading, options };
}

/** CAPABILITY-GAP DETECTOR: is this ticket about WHERE inside a container a drag lands — "between events", "below the
 * second item", "at position N", reorder to a specific slot? Our drag executor drops at the target element's CENTER
 * and reads back NOTHING about the resulting position. So for a drop-PRECISION bug we cannot honestly assert the
 * outcome: a center-drop that happens to land below the long event would fabricate a "reproduced". The only honest
 * verdict is a capability-gap (cant-perform) that names the missing capability — NEVER a hard-signal reproduced.
 * Pure + exported so a test locks it. This is the moat rule: one false hard-signal finding burns trust permanently. */
export function needsDropPrecision(repro: BugRepro): boolean {
  const isDrag = /drag|drop|reorder|re-?position/i.test(repro.interaction || '') ||
    /drag|drop/i.test((repro.expectedBehavior || '') + ' ' + (repro.actualBehavior || ''));
  if (!isDrag) return false;
  const text = `${repro.expectedBehavior || ''} ${repro.actualBehavior || ''}`.toLowerCase();
  // position-precision language: the bug is about the SLOT/OFFSET the drop lands at, not merely that a drop happened.
  return /\bbetween\b|\bbeneath\b|\bbelow\b|\babove\b|\bposition\b|\bbetween the\b|\border\b|\breorder|\bslot\b|\bwhere it (is|was) dropped\b|\bsecond (event|item|row)\b|\bplacement\b/.test(text);
}

/** Which event does the ticket describe DRAGGING? Prefer a quoted/proper-noun event name in the actual/expected
 *  behavior; fall back to a generic "new event" label the calendar likely renders. Used to seed the drop oracle. */
export function pickDropSourceId(repro: BugRepro): string {
  const text = `${repro.actualBehavior || ''} ${repro.expectedBehavior || ''}`;
  const quoted = text.match(/["']([^"']{2,40})["']/);
  if (quoted) return quoted[1].trim();
  // "a new event", "the dropped event" → the calendar usually labels a just-added event "New event" / "New Event".
  if (/\bnew event\b/i.test(text)) return 'New event';
  if (/\bevent\b/i.test(text)) return 'New event';
  return 'New event';
}

/** A day/date hint to disambiguate which calendar column to read (the ticket may name a day). Optional — the oracle
 *  falls back to the densest column when no hint matches. */
export function pickColumnHint(repro: BugRepro, ticket?: string): string | undefined {
  const text = `${repro.actualBehavior || ''} ${repro.expectedBehavior || ''} ${ticket || ''}`;
  const day = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*day?\b/i);
  if (day) return day[0];
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (date) return date[0];
  return undefined;
}

/** A tenant+route+date-window key for an environment-state fact about a calendar. "The calendar is empty" is FALSE the
 *  moment you check a different tenant or week, so the fact must be scoped, not project-wide (advisor). Extracts the
 *  tenant segment (/demo/, /qa/) + the /Calendar route + a coarse date window (the ?date= month, so a single day's
 *  emptiness isn't over-claimed for the whole calendar). Pure. */
export function calendarStateKey(url: string): string {
  let tenant = '', month = '';
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    tenant = seg[0] || '';                                  // /demo/Teacher/Calendar → "demo"
    const date = u.searchParams.get('date') || '';
    month = (date.match(/^\d{4}-\d{2}/) || [''])[0];        // coarse: year-month window, not the exact day
  } catch { /* non-URL — fall through */ }
  return `calendar-state:${tenant}:${month || 'unknown-window'}`;
}

/** Find the CALENDAR page URL the crawl already recorded, so the drop-oracle can navigate straight to it instead of
 *  relying on SoA's generated "navigate to calendar" step (which lands on the dashboard). Prefers a day/week view URL
 *  (has a ?date= or /Calendar path). Returns null if the crawl never mapped a calendar page. */
export function pickCalendarUrl(map: any): string | null {
  const pages: any[] = (map?.pages || []);
  const cals = pages.map((p) => p.url || p.path || '').filter((u: string) => /\/calendar\b/i.test(u));
  if (!cals.length) return null;
  // prefer a URL that carries a concrete date (a day/week view already scoped to a day with events).
  const dated = cals.find((u: string) => /[?&]date=/.test(u));
  return dated || cals[0];
}

export function judgeRepro(repro: BugRepro, steps: any[], consoleErrors: string[], finalText: string): ReproVerdict {
  // MOAT GUARD (capability-gap): a drop-PRECISION bug can't be judged by our center-drop-no-readback executor, so it
  // must never manufacture a 'reproduced'. Return cant-perform BEFORE any signal branch can guess. (Detected from the
  // ticket, independent of whether the drag step happened to "execute" — a center-drop executing proves nothing here.)
  if (needsDropPrecision(repro)) return 'cant-perform';
  // ORDERED-SEQUENCE INTEGRITY (the schooltalk false-positive fix): a repro is a SEQUENCE — if ANY actionable step
  // (click/fill/select/navigate/type — not just the hard drag/hover ones) matched NOTHING, everything after it ran
  // against the wrong page, so we did NOT actually perform the reproduction → cant-perform. This is what caught the
  // real bug: every step reported `matched:0` with candidates "Google | Microsoft | Sign In" (the LOGIN PAGE, no
  // creds), yet the old gate — scoped to drag/hover/press only — let ordinary click/fill failures through and the
  // verdict became a false 'reproduced'. A bug is only reproduced if the STEPS THAT SHOW IT actually executed.
  const actionableUnmatched = steps.some((s) =>
    s.status === 'fail' &&
    /click|fill|type|select|navigate|check|press|drag|hover|rightclick|doubleclick/i.test(s.attempts?.[0]?.kind || '') &&
    s.attempts?.[0]?.matched === 0);
  const interactionIsHard = /drag|drop|hover|keyboard|right[- ]?click|double[- ]?click|gesture/i.test(repro.interaction || '');
  if (actionableUnmatched || (interactionIsHard && steps.some((s) => s.status === 'fail'))) return 'cant-perform';
  // did the repro actually EXECUTE? (≥1 actionable step landed with status 'pass' — NOT 'unverifiable', which is a
  // no-op observe/verify). A verdict of reproduced/not-reproduced requires this — otherwise a console error, a
  // polarity guess, or stray word-overlap on an un-reached page can manufacture a false verdict. This gates ALL the
  // signal branches below (polarity + word-overlap + console), so an all-observe / never-acted run is inconclusive.
  const anyStepExecuted = steps.some((s) => s.status === 'pass' && /click|fill|type|select|navigate|check|press|drag|hover/i.test(s.attempts?.[0]?.kind || ''));
  if (!anyStepExecuted) return 'inconclusive';   // nothing was actually done → we can't judge the bug, honestly

  const hay = (finalText + ' ' + consoleErrors.join(' ')).toLowerCase();
  const actualWords = contentSig(repro.actualBehavior);
  const expectedWords = contentSig(repro.expectedBehavior);
  // overlap: how many distinctive words of each behavior appear in what we saw. A behavior "matches" if ≥2
  // distinctive words hit (tolerant of phrasing differences), taking the stronger of the two.
  const actualHits = actualWords.filter((w) => hay.includes(w)).length;
  const expectedHits = expectedWords.filter((w) => hay.includes(w)).length;
  // POLARITY signal: many bugs are "shows an error / rejects" vs "no error / saves silently / accepts". Classify
  // each behavior's expected page-state, NEGATION-AWARE ("no error" / "without error" = SILENT, not error).
  const polarity = (txt: string): 'error' | 'silent' | 'neutral' => {
    const t = txt.toLowerCase();
    if (/\bsilent|\bno\s+error|\bwithout\b[^.]*\berror|\baccept|\bsaves?\b|\bstored?\b|\ballows?\b/.test(t) && !/\bshows?\b[^.]*\berror|\bvalidation error|\breject/.test(t)) return 'silent';
    if (/\bshows?\b[^.]*\berror|\bvalidation|\brequired\b|\breject|\berror message|\bnot\s+save/.test(t)) return 'error';
    return 'neutral';
  };
  const pageHasError = /\berror\b|\binvalid\b|\brequired\b|\bcannot\b|\bnot allowed\b|\bfailed\b/i.test(finalText) || consoleErrors.length > 0;
  const expPol = polarity(repro.expectedBehavior);
  const actPol = polarity(repro.actualBehavior);

  // decide by polarity when the two behaviors DIFFER on error-ness (the common, decisive case)
  if (expPol !== 'neutral' && actPol !== 'neutral' && expPol !== actPol) {
    const pageState: 'error' | 'silent' = pageHasError ? 'error' : 'silent';
    if (pageState === actPol) return 'reproduced';       // page matches the REPORTED (buggy) behavior
    if (pageState === expPol) return 'not-reproduced';   // page matches the EXPECTED behavior → not a bug (fixed?)
  }
  // else fall back to word-overlap, taking the clearly-stronger match
  if (actualHits >= 2 && actualHits > expectedHits) return 'reproduced';
  if (expectedHits >= 2 && expectedHits > actualHits) return 'not-reproduced';
  // a console error only supports 'reproduced' when the repro STEPS ACTUALLY RAN — an unhandled error DURING the
  // reproduction is itself the bug. Standalone (no actionable step executed) it's just page noise (an SPA login page
  // reliably emits 401s) and must NOT manufacture a verdict — that was half of the schooltalk false positive.
  if (consoleErrors.length > 0 && anyStepExecuted) return 'reproduced';
  return 'inconclusive';                                // couldn't observe either signal — honest, not a false verdict
}

function verdictDetail(v: ReproVerdict, repro: BugRepro, steps: any[], finalText: string): string {
  if (v === 'cant-perform') {
    // DISTINGUISH the two very different reasons for cant-perform, so the message is TRUE:
    //  (1) the mutating steps were SKIPPED because the project isn't security.authorized — we never *tried* the
    //      interaction. Saying "couldn't perform the interaction, attach the repo" is a double lie (we didn't attempt
    //      it; the repo wouldn't help). The honest message is "blocked on authorization — approve and re-run".
    //  (2) we genuinely attempted a hard interaction (drag/hover/gesture) and it failed to execute on the live app.
    const skippedForAuth = (steps || []).some((s) => /skipped mutating step \(not authorized\)/i.test(s.note || s.attempts?.[0]?.error || ''));
    if (skippedForAuth) return `I reached the feature but stopped before the data-changing step — this project hasn't authorized Xsion to run mutating actions, so I didn't perform them (I won't touch real data without your say-so). This is NOT a verdict on the bug. Click Authorize to let me run mutating steps on tagged test data, then re-run for a real reproduced/fixed answer.`;
    // CAPABILITY-GAP: a drop-PRECISION bug (where between/below the drop lands). My drag executor drops at the target's
    // center and can't yet read back the resulting slot — so I refuse to guess a verdict rather than fabricate one.
    if (needsDropPrecision(repro)) return `This bug is about WHERE the drop lands (${(repro.expectedBehavior || '').slice(0, 80)}…). I can drive a drag, but I can't yet aim at a between/below-item offset or read back which slot the event landed in — so asserting "reproduced" would be a guess, and I won't do that on a hard-signal finding. What I need to judge this honestly: a coordinate-precise drop + a read-back of the event's resulting position (a capability gap on my side, not a login/auth block).`;
    return `Couldn't perform the “${repro.interaction}” interaction the ticket requires, so I can't confirm the bug live. ${repro.codeAssessment ? `But the code cross-check says the reported behavior ${repro.codeAssessment}.` : 'Attach the repo so I can cross-check against the code.'}${repro.openQuestion ? ` (Ticket's own open question stands: ${repro.openQuestion})` : ''}`;
  }
  if (v === 'reproduced') return `I ran the steps and observed the reported buggy behavior. The bug reproduces on the live app.${repro.openQuestion ? ` NOTE — the ticket flags this as unconfirmed: ${repro.openQuestion}` : ''}`;
  if (v === 'not-reproduced') return `I ran the steps and saw the EXPECTED behavior — the reported bug did not reproduce (it may be fixed, or environment-specific).`;
  return `Ran the steps but couldn't clearly observe either the expected or the buggy behavior — needs human review.${repro.codeAssessment ? ` Code cross-check: ${repro.codeAssessment}.` : ''}`;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'of', 'on', 'in', 'at', 'and', 'or', 'be', 'was', 'get', 'gets', 'event', 'events', 'should', 'always', 'just', 'below', 'where', 'that', 'this', 'user']);
function contentSig(s: string): string[] { return [...new Set((s.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 10); }
