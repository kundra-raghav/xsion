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
    const { flow } = pickFlow(projectId, flowId);
    if (!flow) throw new Error('no flow to author cases for');
    emit(runId, { type: 'test:phase', phase: 'start', label: 'Authoring test cases', kind: 'generate' });
    emit(runId, { type: 'test:think', message: `Reading the code behind "${flow.name}" to author runnable test cases — the happy path plus the edge cases the code implies.` });
    const res = await callBridge(['gencases', repo, JSON.stringify(flow)]);
    const cases: any[] = res.cases || [];
    emit(runId, { type: 'test:phase', phase: 'run', label: 'Cases', kind: 'generate' });
    cases.forEach((c, i) => emit(runId, { type: 'test:case', index: i, case: c }));
    emit(runId, { type: 'test:phase', phase: 'done', label: `${cases.length} test cases authored`, kind: 'generate' });
    emit(runId, { type: 'test:done', passed: cases.length, failed: 0, skipped: 0, total: cases.length });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), summary: `${cases.length} test cases for ${flow.name}`, ...( { artifact: { kind: 'test-cases', flow: flow.name, cases } } as any) });
  })().catch((e) => { emit(runId, { type: 'test:think', message: `error: ${e.message}` }); emit(runId, { type: 'test:phase', phase: 'done', label: 'Failed', kind: 'generate' }); store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() }); });
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
    store.updateTestRun(runId, { status: mismatch ? 'failed' : 'passed', finishedAt: new Date().toISOString(), summary: `FE→API · ${match} match · ${mismatch} mismatch · ${unver} unverifiable`, stepResults: findings as any });
  })().catch((e) => { emit(runId, { type: 'test:think', message: `error: ${e.message}` }); emit(runId, { type: 'test:phase', phase: 'done', label: 'Failed', kind: 'feapi' }); store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() }); });
  return runId;
}
