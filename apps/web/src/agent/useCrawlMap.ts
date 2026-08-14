import { useCallback, useEffect, useRef, useState } from 'react';

const API = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';

export type CrawlPhase = 'idle' | 'launch' | 'crawl' | 'network' | 'synthesize' | 'await-creds' | 'done';
export type FlowConfidence = 'high' | 'medium' | 'low';

export interface CrawlPage { id: string; url: string; path: string; title?: string; interactives: number; }
export interface CrawlApi { method: string; url: string; statuses: number[]; count?: number; }
export interface CrawlFlow { id: string; name: string; role: string; steps: { intent: string }[]; confidence: FlowConfidence; reasoning?: string; }
export interface Cursor { x: number; y: number; label?: string; }

export interface CrawlState {
  phase: CrawlPhase;
  phaseLabel: string;
  thoughts: string[];
  screenshot?: string;      // data URL — the current frame ("Xsion's view")
  currentPath?: string;
  cursor?: Cursor;
  pages: CrawlPage[];
  api: CrawlApi[];
  flows: CrawlFlow[];
  needCreds?: { forUrl: string; message: string };
  bounded?: { maxPages: number; reachedLimit: boolean };
}

const EMPTY: CrawlState = { phase: 'idle', phaseLabel: '', thoughts: [], pages: [], api: [], flows: [] };

export function useCrawlMap() {
  const [state, setState] = useState<CrawlState>(EMPTY);
  const [runId, setRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const handle = useCallback((e: any) => {
    switch (e.type) {
      case 'crawl:phase': setState((s) => ({ ...s, phase: e.phase, phaseLabel: e.label, needCreds: e.phase === 'await-creds' ? s.needCreds : undefined })); break;
      case 'crawl:think': setState((s) => ({ ...s, thoughts: [...s.thoughts, e.message] })); break;
      case 'crawl:screenshot': setState((s) => ({ ...s, screenshot: e.dataUrl, currentPath: e.path })); break;
      case 'crawl:navigate': setState((s) => ({ ...s, currentPath: e.path })); break;
      case 'crawl:cursor': setState((s) => ({ ...s, cursor: { x: e.x, y: e.y, label: e.label } })); break;
      case 'crawl:page-found': setState((s) => ({ ...s, pages: [...s.pages.filter((p) => p.path !== e.page.path), e.page] })); break;
      case 'crawl:api': setState((s) => ({ ...s, api: [...s.api.filter((a) => a.url !== e.endpoint.url || a.method !== e.endpoint.method), e.endpoint] })); break;
      case 'crawl:need-creds': setState((s) => ({ ...s, needCreds: { forUrl: e.forUrl, message: e.message } })); break;
      case 'crawl:flow': setState((s) => ({ ...s, flows: [...s.flows.filter((f) => f.id !== e.flow.id), e.flow] })); break;
      case 'crawl:done': setState((s) => ({ ...s, bounded: e.map?.bounded })); break;
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    const ws = new WebSocket(WS);
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: 'subscribe', runId })); };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (typeof e.type === 'string' && e.type.startsWith('crawl:')) handle(e); } catch {} };
    return () => ws.close();
  }, [runId, handle]);

  const start = useCallback(async (opts: { projectId: string; repo?: string; baseUrl: string; email?: string; password?: string }) => {
    setState(EMPTY);
    const res = await fetch(`${API}/api/projects/${opts.projectId}/crawl-map`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: opts.repo, baseUrl: opts.baseUrl, email: opts.email, password: opts.password }),
    });
    const data = await res.json();
    if (data.runId) setRunId(data.runId);
    return data.runId as string | undefined;
  }, []);

  // RESUME: continue an existing crawl from where it left off (persisted frontier + budget-clipped routes). Seeds
  // the view with the pages/flows already mapped so the user sees progress carry over, not a reset to zero.
  const resume = useCallback(async (projectId: string) => {
    // seed from the existing map so the counts don't flash back to 0
    try {
      const m = await fetch(`${API}/api/projects/${projectId}/map`).then((r) => (r.ok ? r.json() : null));
      if (m) setState({ ...EMPTY, phase: 'crawl', phaseLabel: 'Continuing where it left off', pages: m.pages || [], api: m.api || [], flows: m.flows || [], bounded: m.bounded });
      else setState(EMPTY);
    } catch { setState(EMPTY); }
    const res = await fetch(`${API}/api/projects/${projectId}/continue-crawl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await res.json();
    if (data.runId) setRunId(data.runId);
    return data.runId as string | undefined;
  }, []);

  return { state, runId, connected, start, resume };
}
