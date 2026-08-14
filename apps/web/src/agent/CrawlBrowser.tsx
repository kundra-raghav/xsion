import { useState } from 'react';
import { clsx } from 'clsx';
import { AnimatePresence } from 'framer-motion';
import { useCrawlMap } from './useCrawlMap';
import { BrowserStage } from './BrowserStage';
import { ThinkingStream, MapPanel, CredPrompt } from './CrawlPanels';

const DEFAULTS = { repo: '/Users/raghavkundra/Desktop/Dev/dent/apps/admin-ui', baseUrl: 'https://admin.thedent.in' };

const PHASES = [
  { key: 'launch', label: 'Open' },
  { key: 'crawl', label: 'Explore' },
  { key: 'synthesize', label: 'Map' },
  { key: 'done', label: 'Ready' },
];
const ORDER = ['idle', 'launch', 'crawl', 'network', 'synthesize', 'await-creds', 'done'];

export function CrawlBrowser({ projectId }: { projectId: string }) {
  const { state, connected, start } = useCrawlMap();
  const [repo, setRepo] = useState(DEFAULTS.repo);
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.baseUrl);
  const [hasCode, setHasCode] = useState(true);
  const running = !['idle', 'done'].includes(state.phase);
  const curPhase = ORDER.indexOf(state.phase);

  async function launch(email?: string, password?: string) {
    await start({ projectId, repo: hasCode ? repo : undefined, baseUrl, email, password });
  }

  return (
    <div className="relative min-h-screen bg-paper text-ink">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-grid opacity-50" />
      <div className="relative mx-auto max-w-[1240px] px-6 py-7">
        {/* header */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white shadow-glow">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 6 6 .9-4.5 4.2L18 20l-6-3.2L6 20l1.5-6.9L3 8.9 9 8z" fill="currentColor"/></svg>
            </div>
            <span className="font-display text-lg font-semibold tracking-tight">Xsion</span>
            <span className="ml-1 rounded-full border border-line bg-surface-2/60 px-2 py-0.5 font-mono text-[10px] text-muted">onboard a web app</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-expected' : 'bg-muted-2')} />
            {connected ? 'live' : 'idle'}
          </div>
        </header>

        {/* onboarding bar */}
        <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl2 border border-line bg-surface p-4 shadow-panel">
          <label className="flex min-w-[240px] flex-[1.2] flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-2">Web app URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="ob-input" spellCheck={false} disabled={running} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-2">Codebase?</span>
            <div className="flex h-[38px] items-center gap-1 rounded-lg border border-line bg-paper p-0.5">
              {[true, false].map((v) => (
                <button key={String(v)} onClick={() => setHasCode(v)} disabled={running}
                  className={clsx('rounded-md px-3 py-1 text-[12px] font-medium transition-colors', hasCode === v ? 'bg-accent text-white' : 'text-muted hover:text-ink')}>
                  {v ? 'I have it' : 'URL only'}
                </button>
              ))}
            </div>
          </label>
          {hasCode && (
            <label className="flex min-w-[280px] flex-[1.4] flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-2">Repo path</span>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} className="ob-input font-mono text-[12px]" spellCheck={false} disabled={running} />
            </label>
          )}
          <button onClick={() => launch()} disabled={running}
            className={clsx('flex h-[38px] items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition-all',
              running ? 'cursor-not-allowed bg-surface-2 text-muted-2' : 'bg-accent text-white hover:brightness-110 active:scale-[.98] shadow-glow')}>
            {running ? <><span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-scan" /> Crawling…</> : <>◎ Map this app</>}
          </button>
        </div>

        {/* phase strip */}
        <div className="mb-5 flex items-center gap-2">
          {PHASES.map((p, i) => {
            const pIdx = ORDER.indexOf(p.key);
            const active = state.phase === p.key;
            const doneP = curPhase > pIdx;
            return (
              <div key={p.key} className="flex items-center gap-2">
                <span className={clsx('flex items-center gap-2 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-all',
                  active ? 'bg-accent-soft text-accent shadow-glow' : doneP ? 'text-expected' : 'text-muted-2')}>
                  <span className={clsx('flex h-4 w-4 items-center justify-center rounded text-[10px]', active ? 'bg-accent text-white animate-pulse-ring' : doneP ? 'bg-expected/15 text-expected' : 'border border-line')}>{doneP ? '✓' : i + 1}</span>
                  {p.label}
                </span>
                {i < PHASES.length - 1 && <span className={clsx('h-px w-5', doneP ? 'bg-expected/40' : 'bg-line')} />}
              </div>
            );
          })}
          {state.phaseLabel && <span className="ml-2 font-mono text-[11px] text-muted animate-fade-up">{state.phaseLabel}</span>}
        </div>

        {/* main: browser stage (big) + side panels */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_330px]">
          <BrowserStage state={state} running={running} />
          <aside className="flex flex-col gap-4">
            <ThinkingStream thoughts={state.thoughts} />
            <MapPanel state={state} />
          </aside>
        </div>

        {state.bounded?.reachedLimit && (
          <p className="mt-4 font-mono text-[11px] text-muted-2">↳ bounded crawl reached {state.bounded.maxPages} pages — resumable to map deeper.</p>
        )}
      </div>

      {/* the one blocking prompt — credentials */}
      <AnimatePresence>
        {state.needCreds && (
          <CredPrompt message={state.needCreds.message}
            onSubmit={(email, password) => launch(email, password)}
            onCancel={() => launch()} />
        )}
      </AnimatePresence>

      <style>{`.ob-input{width:100%;height:38px;border-radius:9px;border:1px solid var(--line);background:var(--paper);padding:0 11px;font-size:13px;color:var(--ink);outline:none;transition:border-color .15s}.ob-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}.ob-input:disabled{opacity:.6}`}</style>
    </div>
  );
}
