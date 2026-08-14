import { useCallback, useEffect, useRef, useState } from 'react';

const API = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';

export type Verdict = 'expected' | 'flaky_selector' | 'unverified' | 'real_bug';
export type Phase = 'idle' | 'plan' | 'execute' | 'verify' | 'done';

export interface FlowSummary { index: number; name: string; role: string; steps: number; }
export interface Step {
  index: number;
  intent: string;
  status?: 'running' | 'pass' | 'fail';
  url?: string;
  detail?: string;
  kind?: string;
  verdict?: Verdict;
  reasoning?: string;
  codeRef?: string | null;
}
export interface RunState {
  phase: Phase;
  phaseLabel: string;
  logs: { level: string; message: string }[];
  flows: FlowSummary[];
  selectedFlow?: { name: string; role: string };
  steps: Step[];
  consoleErrors: string[];
  done?: { flowCovered: boolean; passed: number; total: number; verdicts: Record<string, number> };
}

const EMPTY: RunState = { phase: 'idle', phaseLabel: '', logs: [], flows: [], steps: [], consoleErrors: [] };

export function useSoaRun() {
  const [state, setState] = useState<RunState>(EMPTY);
  const [runId, setRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const upsertStep = useCallback((idx: number, patch: Partial<Step>, intent?: string) => {
    setState((s) => {
      const steps = [...s.steps];
      const at = steps.findIndex((x) => x.index === idx);
      if (at === -1) steps.push({ index: idx, intent: intent || '', ...patch });
      else steps[at] = { ...steps[at], ...patch, intent: steps[at].intent || intent || '' };
      steps.sort((a, b) => a.index - b.index);
      return { ...s, steps };
    });
  }, []);

  const handle = useCallback((e: any) => {
    switch (e.type) {
      case 'soa:phase': setState((s) => ({ ...s, phase: e.phase, phaseLabel: e.label })); break;
      case 'soa:log': setState((s) => ({ ...s, logs: [...s.logs, { level: e.level, message: e.message }] })); break;
      case 'soa:flow': setState((s) => ({ ...s, flows: [...s.flows.filter((f) => f.index !== e.index), { index: e.index, name: e.name, role: e.role, steps: e.steps }].sort((a, b) => a.index - b.index) })); break;
      case 'soa:flow-selected':
        setState((s) => ({ ...s, selectedFlow: { name: e.name, role: e.role }, steps: e.steps.map((st: any, i: number) => ({ index: i, intent: st.intent })) })); break;
      case 'soa:step-start': upsertStep(e.stepIndex, { status: 'running' }, e.intent); break;
      case 'soa:step-result': upsertStep(e.stepIndex, { status: e.status, url: e.url, detail: e.detail, kind: e.kind }); break;
      case 'soa:console-error': setState((s) => ({ ...s, consoleErrors: [...s.consoleErrors, e.message] })); break;
      case 'soa:verdict': upsertStep(e.stepIndex, { verdict: e.verdict, reasoning: e.reasoning, codeRef: e.codeRef }); break;
      case 'soa:done': setState((s) => ({ ...s, done: { flowCovered: e.flowCovered, passed: e.passed, total: e.total, verdicts: e.verdicts } })); break;
    }
  }, [upsertStep]);

  // subscribe to a run over WS
  useEffect(() => {
    if (!runId) return;
    const ws = new WebSocket(WS);
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: 'subscribe', runId })); };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (typeof e.type === 'string' && e.type.startsWith('soa:')) handle(e); } catch {} };
    return () => ws.close();
  }, [runId, handle]);

  const start = useCallback(async (opts: { projectId: string; repo: string; baseUrl: string; flowIndex?: number; flowFile?: string }) => {
    setState(EMPTY);
    const res = await fetch(`${API}/api/projects/${opts.projectId}/soa-run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: opts.repo, baseUrl: opts.baseUrl, flowIndex: opts.flowIndex ?? 0, flowFile: opts.flowFile }),
    });
    const data = await res.json();
    if (data.runId) setRunId(data.runId);
    return data.runId as string | undefined;
  }, []);

  return { state, runId, connected, start };
}
