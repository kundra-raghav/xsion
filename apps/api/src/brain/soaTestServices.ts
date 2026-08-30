/**
 * soaTestServices.ts — the SoA-brain test types that produce reasoned output (not per-item execution):
 *   • generate test cases → an ARTIFACT (SoA authors cases from the code; streams GENERATION, not a run).
 *   • FE→API matching     → a batch COMPARISON (match / mismatch / unverifiable per action).
 * Both stream over WS (test:* events) and RECORD to a TestRun for reference. Repo (Mode 1) required — these
 * are code-reading tasks; without code they'd be theater, so the route gates on repo.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { recordError } from './recordHonesty';

const SOA_DIR = process.env.SOA_DIR || path.resolve(process.env.HOME || '', 'Desktop/Dev/Son_Of_Antonov/soa_gemini');
const PYTHON = process.env.SOA_PYTHON || 'python3';
const BRIDGE = path.join(SOA_DIR, 'xsion_bridge.py');

function emit(runId: string, e: any) { wsServer.broadcastToRun(runId, e); }

function callBridge(args: string[], timeoutMs = 180000): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SOA_BACKEND: process.env.SOA_BACKEND || 'perplexity', SOA_PERPLEXITY: '1', SOA_V3_PROMOTE_ON_ANY_READ: '1', SOA_MAX_COST_USD: process.env.SOA_MAX_COST_USD || '0.60' };
    const proc = spawn(PYTHON, [BRIDGE, ...args], { cwd: SOA_DIR, env });
    let out = '', err = '';
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('bridge timeout')); }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('close', () => { clearTimeout(t); const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop(); if (!line) return reject(new Error(`no JSON. stderr: ${err.slice(-200)}`)); try { resolve(JSON.parse(line)); } catch (e: any) { reject(e); } });
  });
}

const CONF_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
function pickFlow(projectId: string, flowId?: string) {
  const map = store.getProjectMap(projectId);
  const flows: any[] = map?.flows || [];
  if (flowId) return { map, flow: flows.find((f) => f.id === flowId) };
  // pick the most substantive high-confidence flow (most steps) — not the alphabetically-first, which may be
  // a thin low-value flow that yields no useful cases.
  const best = [...flows].sort((a, b) =>
    (CONF_RANK[b.confidence] - CONF_RANK[a.confidence]) || ((b.steps?.length || 0) - (a.steps?.length || 0)))[0];
  return { map, flow: best };
}

// ── GENERATE TEST CASES (artifact — streams generation, then a saved spec) ──
export function startGenCases(projectId: string, repo: string, flowId?: string): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: 'Generate test cases' } as any);
  (async () => {
    const { map, flow } = pickFlow(projectId, flowId);
    if (!flow) throw new Error('no flow to author cases for');
    // TRANSPARENCY (the "it never asked what to test" fix): surface the full flow list + which one was chosen, so the
    // record shows the user their options and the FE can offer "regenerate for a different flow" instead of silently
    // deciding for them. `flowChosen` is explicit when the caller passed a flowId; otherwise it's Xsion's default pick.
    const allFlows = ((map?.flows || []) as any[]).map((f) => ({ id: f.id, name: f.name, steps: f.steps?.length || 0, confidence: f.confidence }));
    const wasAutoPicked = !flowId;
    emit(runId, { type: 'test:phase', phase: 'start', label: 'Authoring test cases', kind: 'generate' });
    if (wasAutoPicked && allFlows.length > 1) emit(runId, { type: 'test:think', message: `You didn't specify a flow, so I picked the most substantive one: "${flow.name}". ${allFlows.length} flows are available — you can regenerate for any of the others.` });
    emit(runId, { type: 'test:think', message: `Reading the code behind "${flow.name}" to author runnable test cases — the happy path plus the edge cases the code implies.` });
    const res = await callBridge(['gencases', repo, JSON.stringify(flow)]);
    const cases: any[] = res.cases || [];
    emit(runId, { type: 'test:phase', phase: 'run', label: 'Cases', kind: 'generate' });
    cases.forEach((c, i) => emit(runId, { type: 'test:case', index: i, case: c }));
    emit(runId, { type: 'test:phase', phase: 'done', label: `${cases.length} test cases authored`, kind: 'generate' });
    emit(runId, { type: 'test:done', passed: cases.length, failed: 0, skipped: 0, total: cases.length });
    // ★ the authored cases MUST live in artifacts[0] — every reader (UI runs-list, /record, mission rollup) reads
    //   artifacts[0]. The old `artifact:` (singular) key was written NOWHERE any reader looks → the record showed
    //   "12 cases" in the summary but a BLANK body. The cases ARE the deliverable → resolution is to save them.
    const detail = cases.length
      ? `${cases.length} runnable test cases authored for "${flow.name}" (happy path + the edge cases the code implies). Ready to save as specs.`
      : `No test cases could be authored for "${flow.name}" — the code behind it didn't imply concrete cases.`;
    store.updateTestRun(runId, {
      status: 'passed', finishedAt: new Date().toISOString(),
      summary: `${cases.length} test cases for ${flow.name}`,
      artifacts: [{ kind: 'test-cases', flow: flow.name, summary: `${cases.length} cases · ${flow.name}`, cases, total: cases.length, detail,
        // surface WHICH flow + ALL available flows so the user sees the choice (and the FE can offer a re-pick).
        flowChosen: flow.name, flowAutoPicked: wasAutoPicked, availableFlows: allFlows,
        // the cases ARE the deliverable — no bug to file, no oracle to teach. 'none' (not 'file-ticket', which is
        // the bug-filing bucket) so the mission rollup doesn't miscount authored cases as pending review actions.
        resolution: { kind: 'none' } } as any],
    } as any);
  })().catch((e) => { emit(runId, { type: 'test:think', message: `error: ${e.message}` }); emit(runId, { type: 'test:phase', phase: 'done', label: 'Failed', kind: 'generate' }); recordError(runId, 'test-cases', e, 'Case generation could not complete'); });
  return runId;
}

// ── FE→API MATCHING (batch comparison: match / mismatch / unverifiable) ──
export function startFeApi(projectId: string, repo: string, flowId?: string): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: 'FE → API matching' } as any);
  (async () => {
    const { map, flow } = pickFlow(projectId, flowId);
    if (!flow) throw new Error('no flow');
    emit(runId, { type: 'test:phase', phase: 'start', label: 'Matching UI actions to APIs', kind: 'feapi' });
    emit(runId, { type: 'test:think', message: `For "${flow.name}", checking whether each UI action fires the API the code says it should.` });
    const input = { flow, observedApi: (map?.api || []).slice(0, 30) };
    const res = await callBridge(['feapi', repo, JSON.stringify(input)]);
    const findings: any[] = res.findings || [];
    emit(runId, { type: 'test:phase', phase: 'run', label: 'Findings', kind: 'feapi' });
    let match = 0, mismatch = 0, unver = 0;
    findings.forEach((f, i) => {
      const v = f.verdict === 'match' ? 'pass' : f.verdict === 'mismatch' ? 'fail' : 'unverifiable';
      if (v === 'pass') match++; else if (v === 'fail') mismatch++; else unver++;
      emit(runId, { type: 'test:item-start', index: i, title: f.action || `action ${i + 1}` });
      emit(runId, { type: 'test:item-result', index: i, status: v, detail: f.reasoning || '', evidence: f.codeRef || f.expectedApi });
    });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'FE→API comparison complete', kind: 'feapi' });
    emit(runId, { type: 'test:done', passed: match, failed: mismatch, skipped: unver, total: findings.length });
    // ★ findings MUST live in artifacts[0], not only stepResults — readers key on artifacts[0] (the record showed
    //   blank otherwise). Entrepreneur-lens: a mismatch is a wiring bug (file a ticket); an unverifiable action
    //   needs a human to say what the correct API is (answer-oracle) — every row carries its next action.
    const rows = findings.map((f) => {
      const v = f.verdict === 'match' ? 'match' : f.verdict === 'mismatch' ? 'mismatch' : 'unverifiable';
      const resolution = v === 'mismatch'
        ? { kind: 'file-ticket', question: `UI action "${f.action || ''}" fires the wrong API — file a wiring bug?` }
        : v === 'unverifiable'
          ? { kind: 'answer-oracle', question: `Could not confirm which API "${f.action || ''}" should call — what's the expected endpoint?` }
          : { kind: 'none' };
      return { action: f.action, verdict: v, reasoning: f.reasoning, codeRef: f.codeRef, expectedApi: f.expectedApi, resolution };
    });
    const detail = `${match} matched · ${mismatch} mismatched · ${unver} unverifiable (of ${findings.length} UI actions checked against the code).`;
    store.updateTestRun(runId, {
      status: mismatch ? 'failed' : 'passed', finishedAt: new Date().toISOString(),
      summary: `FE→API · ${match} match · ${mismatch} mismatch · ${unver} unverifiable`,
      stepResults: findings as any,
      artifacts: [{ kind: 'fe-api', flow: flow.name, summary: `FE→API · ${flow.name}`, results: rows, match, mismatch, unverifiable: unver, total: findings.length, detail } as any],
    } as any);
  })().catch((e) => { emit(runId, { type: 'test:think', message: `error: ${e.message}` }); emit(runId, { type: 'test:phase', phase: 'done', label: 'Failed', kind: 'fe-api' }); recordError(runId, 'fe-api', e, 'FE→API matching could not complete'); });
  return runId;
}
