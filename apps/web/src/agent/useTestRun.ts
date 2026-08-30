import { useCallback, useEffect, useRef, useState } from 'react';

const API = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';

export type ItemStatus = 'running' | 'pass' | 'fail' | 'skipped' | 'unverifiable';
export interface TestItem { index: number; title: string; status?: ItemStatus; detail?: string; evidence?: string; }
export interface TestCase { title: string; preconditions?: string; steps: string[]; expected?: string; priority?: string; codeRef?: string | null; }
export interface AuditFinding {
  cls: string; title: string; severity: string; codeRef: string; why: string;
  verdict: 'vulnerable' | 'safe' | 'needs-review' | 'skipped'; detail: string;
  reproduce?: { method: string; url: string; withAuth: boolean; status?: number; responseSample?: string; curl: string };
}
export interface BreakFinding {
  phase: string; title: string; verdict: 'held' | 'broke' | 'needs-review' | 'skipped' | 'passed'; detail: string;
  expectHeld?: string; expectBroke?: string; codeRef?: string | null;
  reproduce?: { intent: string; value?: string; observed: string };
}
export interface MissionStepView { index: number; engine: string; label: string; why?: string; subRunId?: string; outcome?: string; status: 'pending' | 'running' | 'done'; }
export interface MissionState { summary?: string; steps: MissionStepView[]; }
export interface BugReport {
  verdict: 'reproduced' | 'not-reproduced' | 'cant-perform' | 'inconclusive';
  expectedBehavior: string; actualBehavior: string; interaction: string;
  codeAssessment: string | null; codeRef: string | null; openQuestion: string | null; detail: string;
  stepsRun: { intent?: string; status: string; note?: string }[];
  /** the NEXT ACTION for a non-terminal verdict — the "approve button" that turns a dead-end into a step forward. */
  resolution?: { kind: 'file-ticket' | 'none' | 'credentials' | 'needs-input' | 'unreachable' | 'authorize'; question?: string; forStep?: string; candidates?: string[] };
}

export interface TestState {
  kind: string;
  phase: 'idle' | 'start' | 'run' | 'done';
  phaseLabel: string;
  thoughts: string[];
  items: TestItem[];
  cases: TestCase[];
  findings: AuditFinding[];
  breakFindings: BreakFinding[];
  bugReport?: BugReport;
  mission?: MissionState;
  /** the LIVE browser view — screenshot + URL + current action, streamed as the test drives the page. */
  live?: { screenshot?: string; url?: string; path?: string; label?: string };
  /** persisted frame pointers for PLAYBACK of a recorded run (empty on a live run). */
  frames?: { n: number; url: string; path?: string; label?: string; ts?: number; caseIndex?: number; caseTitle?: string }[];
  /** set when an engine PAUSED asking for login credentials (bug-repro/break-it hit a login wall with no creds). */
  needsCreds?: { forUrl: string; message: string };
  done?: { passed: number; failed: number; skipped: number; total: number };
}
const EMPTY: TestState = { kind: '', phase: 'idle', phaseLabel: '', thoughts: [], items: [], cases: [], findings: [], breakFindings: [] };

export function useTestRun() {
  const [state, setState] = useState<TestState>(EMPTY);
  const [runId, setRunId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const upsert = useCallback((idx: number, patch: Partial<TestItem>, title?: string) => {
    setState((s) => {
      const items = [...s.items];
      const at = items.findIndex((x) => x.index === idx);
      if (at === -1) items.push({ index: idx, title: title || '', ...patch });
      else items[at] = { ...items[at], ...patch, title: items[at].title || title || '' };
      items.sort((a, b) => a.index - b.index);
      return { ...s, items };
    });
  }, []);

  const handle = useCallback((e: any) => {
    switch (e.type) {
      case 'test:phase': setState((s) => ({ ...s, phase: e.phase, phaseLabel: e.label, kind: e.kind || s.kind })); break;
      case 'test:think': setState((s) => ({ ...s, thoughts: [...s.thoughts, e.message] })); break;
      case 'test:item-start': upsert(e.index, { status: 'running' }, e.title); break;
      case 'test:item-result': upsert(e.index, { status: e.status, detail: e.detail, evidence: e.evidence }); break;
      case 'test:case': setState((s) => ({ ...s, cases: [...s.cases, e.case] })); break;
      case 'audit:finding': setState((s) => { const f = [...s.findings]; const at = f.findIndex((x) => x.title === e.finding.title && x.codeRef === e.finding.codeRef); if (at === -1) f.push(e.finding); else f[at] = e.finding; return { ...s, findings: f }; }); break;
      case 'breakit:finding': setState((s) => ({ ...s, breakFindings: [...s.breakFindings, e.finding] })); break;
      case 'bugrepro:verdict': setState((s) => ({ ...s, bugReport: e.report })); break;
      case 'bugrepro:need-creds': setState((s) => ({ ...s, needsCreds: { forUrl: e.forUrl, message: e.message } })); break;
      case 'mission:phase': setState((s) => ({ ...s, phase: e.phase === 'plan' ? 'start' : e.phase, phaseLabel: e.label, kind: 'mission' })); break;
      case 'mission:think': setState((s) => ({ ...s, thoughts: [...s.thoughts, e.message] })); break;
      case 'mission:plan': setState((s) => ({ ...s, mission: { summary: e.summary, steps: e.steps.map((st: any, i: number) => ({ index: i, engine: st.engine, label: st.label, why: st.why, status: 'pending' })) } })); break;
      case 'mission:step-start': setState((s) => ({ ...s, mission: s.mission ? { ...s.mission, steps: s.mission.steps.map((st) => st.index === e.index ? { ...st, status: 'running', subRunId: e.subRunId } : st) } : s.mission })); break;
      case 'mission:step-done': setState((s) => ({ ...s, mission: s.mission ? { ...s.mission, steps: s.mission.steps.map((st) => st.index === e.index ? { ...st, status: 'done', outcome: e.outcome } : st) } : s.mission })); break;
      case 'mission:done': setState((s) => ({ ...s, phase: 'done' })); break;
      case 'test:navigate': setState((s) => ({ ...s, live: { ...s.live, url: e.url, path: e.path, label: e.label } })); break;
      case 'test:frame': setState((s) => ({ ...s, live: { screenshot: e.screenshot, url: e.url, path: e.path, label: e.label } })); break;
      case 'test:done': setState((s) => ({ ...s, done: { passed: e.passed, failed: e.failed, skipped: e.skipped, total: e.total } })); break;
    }
  }, [upsert]);

  useEffect(() => {
    if (!runId) return;
    const ws = new WebSocket(WS); wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', runId }));
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (typeof e.type === 'string' && /^(test:|audit:|breakit:|bugrepro:|mission:)/.test(e.type)) handle(e); } catch {} };
    return () => ws.close();
  }, [runId, handle]);

  // WATCH an EXISTING run (e.g. a mission's sub-run) — subscribe to its live frames + events without starting one.
  // The WS effect above re-subscribes on runId change; this just points us at the sub-run so its test:frame stream
  // (screenshot/url/label) flows into state.live and TestBrowserStage can render the live browser inline.
  const watch = useCallback((rid: string | null) => { setState({ ...EMPTY }); setRunId(rid); }, []);

  const start = useCallback(async (path: string, body: any) => {
    setState({ ...EMPTY });
    const res = await fetch(`${API}/api/projects/${body.projectId}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.runId) setRunId(data.runId);
    return data;
  }, []);

  /** REHYDRATE a finished run from its recorded artifact — so re-entering a view (or the Runs history) shows the
   * SAVED result + playback instead of re-running. Handles EVERY kind by artifact.kind. Returns the kind if usable. */
  const loadRecorded = useCallback(async (projectId: string, rid: string): Promise<string | null> => {
    try {
      const run = await fetch(`${API}/api/projects/${projectId}/runs/${rid}/record`).then((r) => (r.ok ? r.json() : null));
      const art = run?.artifacts?.[0];
      if (!art) return null;
      const frames = art.frames || [];
      if (art.kind === 'break-it' && Array.isArray(art.findings)) {
        const done = art.findings.reduce((a: any, f: BreakFinding) => {
          if (f.verdict === 'held' || f.verdict === 'passed') a.passed++;
          else if (f.verdict === 'broke') a.failed++; else a.skipped++;
          a.total++; return a;
        }, { passed: 0, failed: 0, skipped: 0, total: 0 });
        setState({ ...EMPTY, kind: 'breakit', phase: 'done', breakFindings: art.findings, frames, done });
        setRunId(rid); return 'break-it';
      }
      if (art.kind === 'bug-repro') {
        setState({ ...EMPTY, kind: 'bugrepro', phase: 'done', bugReport: art as BugReport, frames,
          items: (art.stepsRun || []).map((s: any, i: number) => ({ index: i, title: s.intent || `step ${i + 1}`, status: s.status === 'pass' ? 'pass' as const : 'fail' as const, detail: s.note })) });
        setRunId(rid); return 'bug-repro';
      }
      if (art.kind === 'env-matrix') {
        setState({ ...EMPTY, kind: 'env-matrix', phase: 'done', frames,
          items: (art.results || []).map((r: any, i: number) => ({ index: i, title: r.label, status: r.status, detail: r.detail })) });
        setRunId(rid); return 'env-matrix';
      }
      if (art.kind === 'flow') {
        setState({ ...EMPTY, kind: 'flow', phase: 'done', frames });
        setRunId(rid); return 'flow';
      }
      // API test + FE→API matching: replay-able as items (label/status/detail per row). Both store `results[]`.
      if (art.kind === 'api' || art.kind === 'fe-api') {
        setState({ ...EMPTY, kind: art.kind, phase: 'done', frames,
          items: (art.results || []).map((r: any, i: number) => ({ index: i, title: r.title || r.action || `item ${i + 1}`, status: r.status || (r.verdict === 'match' ? 'pass' : r.verdict === 'mismatch' ? 'fail' : r.verdict === 'unverifiable' ? 'unverifiable' : r.verdict), detail: r.detail || r.reasoning })) });
        setRunId(rid); return art.kind;
      }
      // Generate test cases: the authored cases are the record.
      if (art.kind === 'test-cases') {
        setState({ ...EMPTY, kind: 'generate', phase: 'done', frames, cases: art.cases || [] });
        setRunId(rid); return 'test-cases';
      }
      // Security audit: findings list.
      if (art.kind === 'security-audit') {
        setState({ ...EMPTY, kind: 'security-audit', phase: 'done', frames, findings: art.findings || [] });
        setRunId(rid); return 'security-audit';
      }
      // any other kind with frames → at least show the playback
      if (frames.length) { setState({ ...EMPTY, kind: art.kind || 'run', phase: 'done', frames }); setRunId(rid); return art.kind || 'run'; }
      return null;
    } catch { return null; }
  }, []);

  return { state, runId, start, watch, loadRecorded };
}
