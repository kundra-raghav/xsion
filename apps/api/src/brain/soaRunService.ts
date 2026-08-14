/**
 * soaRunService.ts — runs the SoA closed loop IN-PROCESS and broadcasts every seam over WebSocket.
 * This event stream IS the product's live surface: PLAN → EXECUTE (real clicks) → VERIFY (code-cited verdicts).
 * The UI subscribes by runId and renders these events in real time.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { plan, verify, IntentFlow } from './soaClient';
import { executeFlow } from './intentRunner';
import { makeFrameHook } from './liveFrame';

// ── SoA-run event vocabulary (broadcast to the UI) ──
export type SoaEvent =
  | { type: 'soa:phase'; phase: 'plan' | 'execute' | 'verify' | 'done'; label: string }
  | { type: 'soa:log'; level: 'info' | 'muted'; message: string }
  | { type: 'soa:flow'; index: number; name: string; role: string; steps: number }
  | { type: 'soa:flow-selected'; name: string; role: string; steps: { intent: string; expectedOutcome?: string }[] }
  | { type: 'soa:step-start'; stepIndex: number; intent: string }
  | { type: 'soa:step-result'; stepIndex: number; status: 'pass' | 'fail'; url?: string; detail?: string; kind?: string }
  | { type: 'soa:console-error'; message: string }
  | { type: 'soa:verdict'; stepIndex: number; verdict: 'expected' | 'flaky_selector' | 'unverified' | 'real_bug'; reasoning: string; codeRef?: string | null }
  | { type: 'soa:done'; flowCovered: boolean; passed: number; total: number; verdicts: Record<string, number> };

function emit(runId: string, e: SoaEvent) {
  wsServer.broadcastToRun(runId, e as any);
}

export interface SoaRunOpts { repo: string; baseUrl: string; flowIndex?: number; flowFile?: string; }

/** Kick off a SoA run: create a TestRun, return its id immediately, then drive the loop async and broadcast. */
export function startSoaRun(projectId: string, opts: SoaRunOpts): string {
  const runId = uuid();
  const now = new Date().toISOString();
  store.createTestRun({
    id: runId, projectId, status: 'running', startedAt: now, artifacts: [], stepResults: [],
    summary: `SoA run against ${opts.baseUrl}`,
  } as any);
  // fire-and-forget; the UI follows via WS
  driveLoop(runId, projectId, opts).catch((e) => {
    emit(runId, { type: 'soa:log', level: 'info', message: `run error: ${String(e.message || e)}` });
    emit(runId, { type: 'soa:phase', phase: 'done', label: 'Run failed' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: String(e.message || e) });
  });
  return runId;
}

const VERDICT_MAP: Record<string, SoaEvent extends { verdict: infer V } ? V : never> = {} as any;

async function driveLoop(runId: string, projectId: string, opts: SoaRunOpts) {
  const { repo, baseUrl } = opts;

  // ── PLAN ──
  emit(runId, { type: 'soa:phase', phase: 'plan', label: 'Reading the codebase' });
  emit(runId, { type: 'soa:log', level: 'muted', message: `SoA is reading ${repo} to map the real user flows…` });
  let flows: IntentFlow[];
  const fs = await import('fs');
  if (opts.flowFile && fs.existsSync(opts.flowFile)) {
    flows = JSON.parse(fs.readFileSync(opts.flowFile, 'utf8')).flows;
    emit(runId, { type: 'soa:log', level: 'muted', message: `Using cached plan (${flows.length} flows)` });
  } else {
    const planned = await plan(repo, baseUrl);
    flows = planned.flows;
    if (opts.flowFile) fs.writeFileSync(opts.flowFile, JSON.stringify({ flows }, null, 1));
  }
  flows.forEach((f, i) => emit(runId, { type: 'soa:flow', index: i, name: f.name, role: f.role, steps: f.steps.length }));
  if (!flows.length) { emit(runId, { type: 'soa:log', level: 'info', message: 'No flows generated.' }); emit(runId, { type: 'soa:phase', phase: 'done', label: 'No flows' }); store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() }); return; }

  const flow = flows[Math.min(opts.flowIndex ?? 0, flows.length - 1)];
  emit(runId, { type: 'soa:flow-selected', name: flow.name, role: flow.role, steps: flow.steps });

  // ── EXECUTE (real browser; step events stream as it clicks) ──
  emit(runId, { type: 'soa:phase', phase: 'execute', label: `Driving "${flow.name}" on the live site` });
  // frame hook for PLAYBACK — one case: the flow. (This view uses soa: events, but the frames land on the record so
  // the run appears in the Runs history with a scrubbable recording like every other engine.)
  const frameHook = makeFrameHook(runId, emit as any);
  frameHook.caseIndex = 0; frameHook.caseTitle = flow.name;
  // wrap executeFlow so each step broadcasts as it happens
  const result = await executeFlow(flow, baseUrl, {
    onStepStart: (stepIndex, intent) => emit(runId, { type: 'soa:step-start', stepIndex, intent }),
    onStepResult: (sr) => emit(runId, { type: 'soa:step-result', stepIndex: sr.stepIndex, status: sr.status === 'pass' ? 'pass' : 'fail', url: sr.url, detail: sr.note, kind: sr.attempts?.[0]?.kind }),
    onConsoleError: (message) => emit(runId, { type: 'soa:console-error', message }),
    onFrame: frameHook,
  });
  store.updateTestRun(runId, { stepResults: result.stepResults as any, status: result.status === 'passed' ? 'passed' : 'failed' });

  // ── VERIFY (SoA triages each step vs code) ──
  emit(runId, { type: 'soa:phase', phase: 'verify', label: 'Judging findings against the code' });
  const verification = await verify(repo, flow, result);
  const counts: Record<string, number> = {};
  for (const f of verification.findings || []) {
    const v = (f.verdict as any) || 'unverified';
    counts[v] = (counts[v] || 0) + 1;
    emit(runId, { type: 'soa:verdict', stepIndex: f.stepIndex, verdict: v, reasoning: f.reasoning || '', codeRef: (f as any).codeRef });
  }

  const passed = result.stepResults.filter((s) => s.status === 'pass').length;
  emit(runId, { type: 'soa:phase', phase: 'done', label: 'Run complete' });
  emit(runId, { type: 'soa:done', flowCovered: !!verification.flowCovered, passed, total: result.stepResults.length, verdicts: counts });
  store.updateTestRun(runId, { status: result.status === 'passed' ? 'passed' : 'failed', finishedAt: new Date().toISOString(), summary: `${passed}/${result.stepResults.length} steps · flow ${verification.flowCovered ? 'covered' : 'partial'}`, artifacts: [{ kind: 'flow', flow: flow.name, findings: verification.findings, frames: frameHook.frames } as any] } as any);
}
