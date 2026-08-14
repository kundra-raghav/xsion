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
  for (let i = 0; i < mission.steps.length; i++) {
    const step = mission.steps[i];
    const subRunId = launchEngine(projectId, baseUrl, step, opts.repo);
    if (!subRunId) { emit(runId, { type: 'mission:think', message: `Skipped step ${i + 1} (${step.engine}) — missing what it needs.` }); results.push({ ...step, outcome: 'skipped' }); continue; }
    emit(runId, { type: 'mission:step-start', index: i, engine: step.engine, label: stepLabel(step), subRunId });
    emit(runId, { type: 'mission:think', message: `Step ${i + 1}/${mission.steps.length}: ${stepLabel(step)} — ${step.why}` });
    const outcome = await waitForSubRun(subRunId);
    emit(runId, { type: 'mission:step-done', index: i, engine: step.engine, outcome: outcome.summary, subRunId });
    results.push({ ...step, subRunId, outcome: outcome.summary, findings: outcome.findings });
  }

  const report = { summary: mission.summary, mission: opts.mission, steps: results };
  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'mission', ...report } as any] } as any);
  emit(runId, { type: 'mission:phase', phase: 'done', label: 'Mission complete' });
  emit(runId, { type: 'mission:done', report });
  emit(runId, { type: 'mission:think', message: `Mission done — ${results.length} step${results.length > 1 ? 's' : ''} run. ${summarize(results)}` });
}

function launchEngine(projectId: string, baseUrl: string, step: MissionStep, repo: string): string | null {
  switch (step.engine) {
    case 'break-it': return step.feature ? startBreakIt(projectId, baseUrl, { repo, feature: step.feature }) : null;
    case 'bug-repro': return step.ticket ? startBugRepro(projectId, baseUrl, { repo, ticket: step.ticket }) : null;
    case 'api': return startApiTest(projectId, baseUrl, {});
    case 'audit': return startSecurityAudit(projectId, baseUrl, { repo, tier: 1 });
    case 'env-matrix': return startEnvMatrix(projectId, baseUrl);
    case 'flow': return startSoaRun(projectId, { repo, baseUrl });
    default: return null;
  }
}

/** Poll the sub-run's recorded TestRun until it finishes, then summarize its outcome from what it recorded. */
async function waitForSubRun(subRunId: string, timeoutMs = 240_000): Promise<{ summary: string; findings: any }> {
  const t0 = Date.now();
  // small helper: sleep via a real timer (no busy loop)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() - t0 < timeoutMs) {
    const run = store.getTestRun(subRunId) as any;
    if (run && (run.status === 'passed' || run.status === 'failed') && run.finishedAt) {
      const art = (run.artifacts || [])[0] || {};
      return { summary: summarizeArtifact(run, art), findings: art.findings || art.results || art };
    }
    await sleep(3000);
  }
  return { summary: 'timed out', findings: null };
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
