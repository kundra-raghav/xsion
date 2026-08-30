/**
 * missionService.ts — THE PROMPT-AGENT. "The prompt is the product."
 *
 * You type a plain-English mission ("log in and test the create-event CRUD + calendar and the relevant APIs").
 * SoA parses your intent into an ORDERED PLAN of engine-calls, and this orchestrator runs each engine in
 * sequence — break-it, bug-repro, api, audit, env-matrix, flow — streaming a unified mission report. The
 * crawl/map is CONTEXT the router uses; the mission drives.
 *
 * Each step runs as a real sub-run (its own runId + recorded TestRun), so the mission can link to and aggregate
 * every engine's findings. The mission never invents outcomes — it reports what each engine actually recorded.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { missionPlan, MissionStep } from './soaClient';
import { startBreakIt } from './breakItService';
import { startBugRepro } from './bugReproService';
import { startApiTest } from './apiTestService';
import { startSecurityAudit } from './securityAuditService';
import { startEnvMatrix } from './envMatrixService';
import { startSoaRun } from './soaRunService';
import { observedChoices, chosenOption } from './reachState';   // deterministic tenant/scope extraction from the map

export type MissionEvent =
  | { type: 'mission:phase'; phase: 'plan' | 'run' | 'done'; label: string }
  | { type: 'mission:think'; message: string }
  | { type: 'mission:plan'; summary: string; steps: { engine: string; label: string; why: string }[] }
  | { type: 'mission:step-start'; index: number; engine: string; label: string; subRunId: string }
  | { type: 'mission:step-done'; index: number; engine: string; outcome: string; subRunId: string }
  | { type: 'mission:done'; report: any };

function emit(runId: string, e: MissionEvent) { wsServer.broadcastToRun(runId, e as any); }

export interface MissionOpts { repo: string; mission: string; }

export function startMission(projectId: string, baseUrl: string, opts: MissionOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Mission` } as any);
  runMission(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'mission:think', message: `mission error: ${String(e.message || e)}` });
    emit(runId, { type: 'mission:phase', phase: 'done', label: 'Failed' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

async function runMission(runId: string, projectId: string, baseUrl: string, opts: MissionOpts) {
  const map = store.getProjectMap(projectId);
  // DETERMINISTIC SCOPE (2026-08-23): if the mission names a multi-tenant target the map knows (a school/portal/
  // workspace), extract it here and hand it to break-it's DETERMINISTIC tenant-reach (buildTenantReachPrefix) — NOT
  // the SoA flow-planner reach step (which got "2/5 partial" on the user's mission). Reuses the same map-driven
  // matcher as bug-repro/reach (observedChoices + chosenOption: "NZ Curriculum" beats "NZ"). Empty on single-tenant.
  const missionScope = chosenOption(opts.mission, observedChoices(map)) || undefined;
  emit(runId, { type: 'mission:phase', phase: 'plan', label: 'Understanding the mission' });
  emit(runId, { type: 'mission:think', message: `Reading your mission and deciding which tests to run: “${opts.mission.slice(0, 120)}”` });

  const context = {
    baseUrl,
    flows: (map?.flows || []).map((f: any) => ({ name: f.name })).slice(0, 20),
    pages: (map?.pages || []).map((p: any) => p.path).slice(0, 25),
    api: (map?.api || []).map((e: any) => (e.graphql ? `${e.gqlKind} ${e.gqlOperation}` : `${e.method} ${e.url}`)).slice(0, 25),
  };
  const { mission, error } = await missionPlan(opts.repo, { mission: opts.mission, context });
  if (error) emit(runId, { type: 'mission:think', message: `Plan note: ${error}` });
  if (!mission || !mission.steps.length) {
    emit(runId, { type: 'mission:think', message: 'I couldn’t turn that mission into a plan — try naming a feature to test, or paste a bug ticket.' });
    emit(runId, { type: 'mission:phase', phase: 'done', label: 'No plan' });
    emit(runId, { type: 'mission:done', report: { summary: '', steps: [] } });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString() });
    return;
  }

  emit(runId, { type: 'mission:plan', summary: mission.summary, steps: mission.steps.map((s) => ({ engine: s.engine, label: stepLabel(s), why: s.why })) });
  emit(runId, { type: 'mission:think', message: `Understood: ${mission.summary}. Running ${mission.steps.length} step${mission.steps.length > 1 ? 's' : ''} in order.` });

  emit(runId, { type: 'mission:phase', phase: 'run', label: 'Running the mission' });
  const results: any[] = [];
  // if we have a deterministic scope AND a break-it/bug-repro step will reach it, a SoA 'flow' step whose only job is
  // to "reach <scope>" is redundant + weaker — drop it so the mission uses the reliable deterministic reach instead.
  const hasDrivingStep = mission.steps.some((s) => s.engine === 'break-it' || s.engine === 'bug-repro');
  const plannedSteps = mission.steps.filter((s) => !(missionScope && hasDrivingStep && s.engine === 'flow'
    && new RegExp(`reach|navigate|go to|${missionScope}`, 'i').test(`${stepLabel(s)} ${s.why || ''}`)));
  if (plannedSteps.length < mission.steps.length) emit(runId, { type: 'mission:think', message: `Using the deterministic tenant-reach for "${missionScope}" (from the map) instead of a separate navigation step — more reliable than re-planning the route.` });

  for (let i = 0; i < plannedSteps.length; i++) {
    const step = plannedSteps[i];
    const subRunId = launchEngine(projectId, baseUrl, step, opts.repo, missionScope);
    if (!subRunId) { emit(runId, { type: 'mission:think', message: `Skipped step ${i + 1} (${step.engine}) — missing what it needs.` }); results.push({ ...step, outcome: 'skipped' }); continue; }
    emit(runId, { type: 'mission:step-start', index: i, engine: step.engine, label: stepLabel(step), subRunId });
    emit(runId, { type: 'mission:think', message: `Step ${i + 1}/${plannedSteps.length}: ${stepLabel(step)} — ${step.why}` });
    const outcome = await waitForSubRun(subRunId);
    emit(runId, { type: 'mission:step-done', index: i, engine: step.engine, outcome: outcome.summary, subRunId });
    results.push({ ...step, subRunId, outcome: outcome.summary, findings: outcome.findings });
  }

  // ACTIONS ROLLUP (the entrepreneur-lens loop AT MISSION LEVEL): a mission must not end as a summary dead-end —
  // it surfaces WHAT THE USER DOES NEXT by aggregating the actionable resolutions from every sub-run's findings
  // (break-it findings + the bug-repro artifact both carry `resolution`). So "3 needs-review" becomes "3 things
  // to do: file 1 ticket, answer 2 questions". Pure rollup — reads what the engines recorded, invents nothing.
  const actions = rollupActions(results);
  const report = { summary: mission.summary, mission: opts.mission, steps: results, actions };
  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'mission', ...report } as any] } as any);
  if (actions.length) emit(runId, { type: 'mission:think', message: `Next actions: ${actions.map((a: any) => a.label).join(' · ')}` });
  emit(runId, { type: 'mission:phase', phase: 'done', label: 'Mission complete' });
  emit(runId, { type: 'mission:done', report });
  emit(runId, { type: 'mission:think', message: `Mission done — ${results.length} step${results.length > 1 ? 's' : ''} run. ${summarize(results)}` });
}

function launchEngine(projectId: string, baseUrl: string, step: MissionStep, repo: string, scope?: string): string | null {
  switch (step.engine) {
    // pass the deterministic scope → break-it enters the right tenant via buildTenantReachPrefix (no weak SoA reach).
    // quick:true — a mission is a "does this work + what happens" request, so run happy/CRUD only (a few min), NOT a
    // ~40min adversarial sweep. (A user wanting a full break-it uses the dedicated Break-it test, not a mission.)
    case 'break-it': return step.feature ? startBreakIt(projectId, baseUrl, { repo, feature: step.feature, scope, quick: true }) : null;
    case 'bug-repro': return step.ticket ? startBugRepro(projectId, baseUrl, { repo, ticket: step.ticket }) : null;
    case 'api': return startApiTest(projectId, baseUrl, {});
    case 'audit': return startSecurityAudit(projectId, baseUrl, { repo, tier: 1 });
    case 'env-matrix': return startEnvMatrix(projectId, baseUrl);
    case 'flow': return startSoaRun(projectId, { repo, baseUrl });
    default: return null;
  }
}

/** Poll the sub-run's recorded TestRun until it finishes, then summarize its outcome from what it recorded. */
// 240s was too short: a real break-it run (20 attacks × live navigation) legitimately takes 5-8 min, so the mission
// reported its own sub-run as "timed out" and rolled up ZERO actions even though the sub-run later finished fine.
// 600s covers a full break-it/bug-repro; the poll still returns the instant the sub-run flips to passed/failed.
async function waitForSubRun(subRunId: string, timeoutMs = 2_700_000): Promise<{ summary: string; findings: any }> {
  const t0 = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const partial = () => {   // read whatever the sub-run has PERSISTED so far (break-it persists findings incrementally)
    const run = store.getTestRun(subRunId) as any;
    const art = (run?.artifacts || [])[0] || {};
    return { run, art, findings: art.findings || art.results || null };
  };
  while (Date.now() - t0 < timeoutMs) {
    const run = store.getTestRun(subRunId) as any;
    if (run && (run.status === 'passed' || run.status === 'failed') && run.finishedAt) {
      const art = (run.artifacts || [])[0] || {};
      return { summary: summarizeArtifact(run, art), findings: art.findings || art.results || art };
    }
    await sleep(3000);
  }
  // TIMEOUT (2026-08-23 fix): the OLD code returned {summary:'timed out', findings:null} — discarding the findings
  // the sub-run HAD persisted (break-it writes them incrementally), so the mission reported "no report, no nothing"
  // even though real results existed. Raised the wait to 45min (a full break-it can take ~40) AND, on expiry, return
  // the PARTIAL persisted findings so the mission's rollup shows what actually happened instead of an empty timeout.
  const p = partial();
  const n = Array.isArray(p.findings) ? p.findings.length : 0;
  return n > 0
    ? { summary: `still running after ${Math.round(timeoutMs / 60000)}min — reporting ${n} finding(s) recorded so far (sub-run ${subRunId.slice(0, 8)})`, findings: p.findings }
    : { summary: 'timed out — no findings recorded yet', findings: null };
}

/** Aggregate the actionable resolutions from every sub-run's findings into mission-level NEXT ACTIONS. Reads the
 *  `resolution` each engine attached (break-it findings; the bug-repro artifact) and counts them by kind, so the
 *  mission view shows "file 2 tickets · answer 1 question · add credentials" instead of a dead-end summary. Pure. */
export function rollupActions(steps: any[]): Array<{ kind: string; count: number; label: string }> {
  const counts: Record<string, number> = {};
  const bump = (k?: string) => { if (k && k !== 'none') counts[k] = (counts[k] || 0) + 1; };
  for (const s of (steps || [])) {
    const f = s?.findings;
    if (Array.isArray(f)) { for (const finding of f) bump(finding?.resolution?.kind); }        // break-it: array of findings
    else if (f && typeof f === 'object') bump(f?.resolution?.kind);                             // bug-repro: the artifact
  }
  const LABEL: Record<string, string> = {
    'file-ticket': 'file ticket', 'answer-oracle': 'answer a bug question', 'needs-input': 'tell it which control',
    'credentials': 'add credentials', 'authorize': 'authorize the target', 'unreachable': 'reachability blocked',
  };
  return Object.entries(counts).map(([kind, count]) => ({ kind, count, label: `${count}× ${LABEL[kind] || kind}` }));
}

function summarizeArtifact(run: any, art: any): string {
  if (art.kind === 'break-it') {
    const fs = art.findings || [];
    const broke = fs.filter((f: any) => f.verdict === 'broke').length;
    const nr = fs.filter((f: any) => f.verdict === 'needs-review').length;
    return broke ? `${broke} broke, ${nr} needs-review` : `held (${nr} needs-review)`;
  }
  if (art.kind === 'bug-repro') return art.verdict || 'done';
  if (art.kind === 'security-audit') { const v = (art.findings || []).filter((f: any) => f.verdict === 'vulnerable').length; return v ? `${v} vulnerable` : 'clean'; }
  if (art.kind === 'env-matrix') { const f = (art.results || []).filter((r: any) => r.status === 'fail').length; return f ? `${f} conditions failed` : 'all conditions passed'; }
  // api: report the per-probe tally (findings, NOT the run status) so the mission summary matches the runs-list
  // "N pass · N fail" — a fail is a finding, not a failed run (mirrors the status=executed reframe in apiTestService).
  if (art.kind === 'api') { const f = (art.results || []).filter((r: any) => r.status === 'fail').length; const p = (art.results || []).filter((r: any) => r.status === 'pass').length; return f ? `${f} of ${p + f} endpoints flagged` : `${p} endpoints OK`; }
  return run.summary || 'done';
}

function stepLabel(s: MissionStep): string {
  if (s.engine === 'break-it') return `Break it: ${s.feature}`;
  if (s.engine === 'bug-repro') return `Reproduce a bug`;
  if (s.engine === 'flow') return `Run flow: ${s.flowName}`;
  if (s.engine === 'api') return 'API testing';
  if (s.engine === 'audit') return 'Security audit';
  if (s.engine === 'env-matrix') return 'Environment matrix';
  return s.engine;
}
function summarize(results: any[]): string {
  const broke = results.filter((r) => /broke/.test(r.outcome || '')).reduce((a, r) => a + (parseInt(r.outcome) || 1), 0);
  return broke ? `Found issues in ${results.filter((r) => /broke|vulnerable|fail|reproduced/.test(r.outcome || '')).length} area(s).` : 'No blocking issues surfaced.';
}
