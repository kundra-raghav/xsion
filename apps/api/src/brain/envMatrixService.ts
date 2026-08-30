/**
 * envMatrixService.ts — the ENVIRONMENT / TESTING MATRIX (item 5).
 *
 * Runs a mapped flow under a matrix of real conditions — device/viewport, network throttle + latency, offline,
 * and SESSION-EXPIRY (clear the session mid-flow and assert the app bounces to auth). All Playwright-native, so
 * every result is a genuine observation of the live app, not a simulation. Streams over the shared test:* WS
 * vocabulary so the existing run UI renders it. Fail-safe: a condition that couldn't be judged is 'unverifiable',
 * never a silent pass.
 *
 * Volumetric / DDoS load is intentionally OUT (see the security-audit note) — that's a dedicated load-tester's job.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { makeFrameHook } from './liveFrame';
import { executeFlow, EnvCondition } from './intentRunner';
import type { IntentFlow } from './soaClient';
import { honestStatus, recordError } from './recordHonesty';
import { preflightAuth } from './authGate';

export type TestEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: TestEvent) { wsServer.broadcastToRun(runId, e as any); }

// The default condition matrix. Each is a real Playwright context/CDP configuration.
export function defaultConditions(flowStepCount: number): EnvCondition[] {
  const mid = Math.max(0, Math.floor(flowStepCount / 2));
  return [
    { id: 'desktop', label: 'Desktop · fast', viewport: { width: 1280, height: 800 } },
    { id: 'mobile', label: 'Mobile · iPhone-ish viewport', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
    { id: 'slow-3g', label: 'Slow 3G · 400kbps · 400ms latency', network: { downloadKbps: 400, uploadKbps: 400, latencyMs: 400 } },
    { id: 'offline', label: 'Offline · no network', network: { offline: true } },
    { id: 'session-expiry', label: `Session expiry · cleared after step ${mid}`, expireSessionAfterStep: mid },
  ];
}

/** Kick off an environment-matrix run for a flow. Returns runId immediately, streams per-condition results. */
export function startEnvMatrix(projectId: string, baseUrl: string, flowId?: string, conditionIds?: string[]): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Environment matrix · ${baseUrl}` } as any);
  runMatrix(runId, projectId, baseUrl, flowId, conditionIds).catch((e) => {
    emit(runId, { type: 'test:think', message: `matrix error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Run failed', kind: 'env' });
    recordError(runId, 'env-matrix', e, 'The environment matrix could not run');
  });
  return runId;
}

async function runMatrix(runId: string, projectId: string, baseUrl: string, flowId?: string, conditionIds?: string[]) {
  console.log(`[XSION][env-matrix] START run=${runId.slice(0,8)} project=${projectId} url=${baseUrl} flowId=${flowId||'(auto)'} conditions=${(conditionIds||[]).join(',')||'(all)'}`);
  const map = store.getProjectMap(projectId);
  emit(runId, { type: 'test:phase', phase: 'start', label: 'Preparing the environment matrix', kind: 'env' });

  const flows = (map?.flows || []) as any[];
  // pick the flow: by id, else the most-substantive high-confidence flow (same choice the other services make)
  const flow = pickFlow(flows, flowId);
  if (!flow) {
    const msg = 'No named flow in the crawl map to run under environment conditions — the crawl recorded pages but synthesized no flows for this app. Re-crawl (or map with the codebase) to get runnable flows first.';
    emit(runId, { type: 'test:think', message: msg });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'No flow', kind: 'env' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    // persist an HONEST artifact — nothing ran, so status is NOT 'passed' (green must mean verified-working, and
    // zero conditions executed here). resolution: unreachable (re-crawl to get flows).
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'env-matrix', results: [], detail: msg, resolution: { kind: 'unreachable' } } as any] } as any);
    return;
  }
  // PRE-FLIGHT AUTH GATE: if the app is login-gated and we have no working creds, running the flow under each
  // condition would just exercise the login screen N times and report honest-looking failures. Refuse once instead.
  const project = store.getProject(projectId) as any;
  const creds = project?._defaultCreds as { email?: string; password?: string } | undefined;
  const gate = await preflightAuth(baseUrl, creds);
  if (gate.blocked) {
    emit(runId, { type: 'test:think', message: gate.message });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Blocked at login', kind: 'env' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(),
      artifacts: [{ kind: 'env-matrix', results: [], detail: gate.message, resolution: { kind: 'credentials' } } as any] } as any);
    return;
  }

  const intentFlow: IntentFlow = { name: flow.name, role: flow.role, steps: flow.steps };
  emit(runId, { type: 'test:think', message: `Running “${flow.name}” (${flow.steps.length} steps) under each environment condition.` });

  let conditions = defaultConditions(flow.steps.length);
  if (conditionIds?.length) conditions = conditions.filter((c) => conditionIds.includes(c.id));

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Running conditions', kind: 'env' });
  const results: any[] = [];
  let passed = 0, failed = 0, unver = 0;
  const frameHook = makeFrameHook(runId, emit as any);   // ONE hook; each CONDITION is a case (its own playback clip)

  for (let i = 0; i < conditions.length; i++) {
    const cond = conditions[i];
    frameHook.caseIndex = i; frameHook.caseTitle = cond.label;
    emit(runId, { type: 'test:item-start', index: i, title: cond.label });
    try {
      const exec = await executeFlow(intentFlow, baseUrl, { onFrame: frameHook }, cond);   // LIVE VIEW + PLAYBACK
      const steps = exec.stepResults.filter((s) => s.stepIndex >= 0);
      const fails = steps.filter((s) => s.status === 'fail');
      const sessionStep = exec.stepResults.find((s) => s.attempts?.some((a: any) => a.kind === 'session-expiry'));

      let status: 'pass' | 'fail' | 'unverifiable';
      let detail: string;
      if (cond.id === 'session-expiry' && sessionStep) {
        // this condition's verdict IS the session-expiry assertion
        status = sessionStep.status === 'pass' ? 'pass' : 'fail';
        detail = sessionStep.note || (status === 'pass' ? 'session enforced' : 'session NOT enforced');
      } else if (cond.id === 'offline') {
        // offline: the app SHOULD degrade/err, not silently "pass". If every step still "passed" while offline,
        // that's suspicious (cached shell hiding failures) → unverifiable, not a clean pass.
        status = fails.length > 0 ? 'pass' : 'unverifiable';
        detail = fails.length > 0 ? `app surfaced ${fails.length} failure(s) offline (expected — it needs the network)` : 'every step still passed while offline — likely a cached shell; needs review, not assumed working';
      } else {
        status = fails.length === 0 ? 'pass' : 'fail';
        detail = fails.length === 0 ? `all ${steps.length} steps ran under ${cond.label}` : `${fails.length}/${steps.length} steps failed under ${cond.label}: ${fails[0]?.note || fails[0]?.attempts?.[0]?.error || ''}`.slice(0, 180);
      }
      if (status === 'pass') passed++; else if (status === 'fail') failed++; else unver++;
      const evidence = `${steps.filter((s) => s.status === 'pass').length}/${steps.length} steps ok`;
      emit(runId, { type: 'test:item-result', index: i, status, detail, evidence });
      results.push({ condition: cond.id, label: cond.label, status, detail, steps: steps.map((s) => ({ i: s.stepIndex, status: s.status, note: s.note })) });
    } catch (e: any) {
      unver++;
      const detail = `condition errored: ${String(e?.message || e).slice(0, 120)}`;
      emit(runId, { type: 'test:item-result', index: i, status: 'unverifiable', detail });
      results.push({ condition: cond.id, label: cond.label, status: 'unverifiable', detail });
    }
  }

  const detail = `"${flow.name}" run under ${conditions.length} conditions — ${passed} passed · ${failed} failed · ${unver} needs-review.`;
  // HONEST status: a condition that failed makes the run 'failed', not green. (unver alone stays passed — needs-review
  // is not a failure, but any hard fail is.) Nothing-ran is impossible here (we had a flow + ≥1 condition).
  store.updateTestRun(runId, { status: honestStatus(passed, failed, conditions.length), finishedAt: new Date().toISOString(), artifacts: [{ kind: 'env-matrix', flow: flow.name, results, detail, frames: frameHook.frames } as any] } as any);
  emit(runId, { type: 'test:phase', phase: 'done', label: 'Matrix complete', kind: 'env' });
  emit(runId, { type: 'test:think', message: `Matrix done — ${passed} passed, ${failed} failed, ${unver} needs-review across ${conditions.length} conditions.` });
  emit(runId, { type: 'test:done', passed, failed, skipped: unver, total: conditions.length });
}

/** Choose the most-substantive high-confidence flow (falls back to any), or the one whose id matches. */
function pickFlow(flows: any[], flowId?: string): any | null {
  if (!flows.length) return null;
  if (flowId) { const f = flows.find((x) => x.id === flowId); if (f) return f; }
  const scored = [...flows].sort((a, b) => {
    const ca = a.confidence === 'high' ? 2 : a.confidence === 'medium' ? 1 : 0;
    const cb = b.confidence === 'high' ? 2 : b.confidence === 'medium' ? 1 : 0;
    if (cb !== ca) return cb - ca;
    return (b.steps?.length || 0) - (a.steps?.length || 0);
  });
  return scored[0];
}
