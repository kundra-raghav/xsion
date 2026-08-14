import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import type { TestState } from './useTestRun';

/**
 * TestBrowserStage — the live "watch it work" view for a TEST run (break-it / bug-repro / mission). Renders the
 * page Xsion is driving, in real time: a browser chrome with the LIVE URL, the current screenshot, and a caption
 * of the action being performed. Fed by `state.live` (test:frame / test:navigate). The counterpart to the crawl's
 * BrowserStage — so a test run shows WHERE it is and WHAT it's doing, not just a scrolling list.
 */
export function TestBrowserStage({ state, running }: { state: TestState; running: boolean }) {
  const live = state.live;
  const url = live?.url || '';
  const label = live?.label;

  return (
    <div className="relative flex flex-col overflow-hidden rounded-[10px] border border-line bg-ink shadow-panel">
      {/* browser chrome — the live URL bar */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3.5 py-2.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-realbug/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-expected/70" />
        </div>
        <div className="ml-2 flex flex-1 items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px] text-muted">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="shrink-0 opacity-60"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" /></svg>
          <span className="truncate text-ink/80">{url || (running ? 'opening the app…' : 'idle')}</span>
          {running && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-scan" />}
        </div>
        <span className="mono shrink-0 rounded-md border border-line bg-surface-2/60 px-2 py-0.5 text-[10px] text-muted-2">Xsion's view</span>
      </div>

      {/* the live page */}
      <div className="relative aspect-[1280/800] w-full bg-[#0b0e14]">
        <AnimatePresence mode="wait">
          {live?.screenshot ? (
            <motion.img key={live.screenshot.slice(-24)} src={live.screenshot} alt="live page"
              initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
              className="absolute inset-0 h-full w-full object-cover object-top" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="max-w-[420px] text-center">
                {running
                  ? <div className="mx-auto mb-3 h-9 w-9 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
                  : <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-line-strong"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-muted-3"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M3 9h18" stroke="currentColor" strokeWidth="1.6" /></svg></div>}
                {/* When the run has ENDED with no streamed frame, NEVER keep a live spinner — say what happened honestly.
                    A run that stalls on login (e.g. SSO) captures no page, so the stage must explain, not spin forever. */}
                <p className="font-mono text-[12px] text-muted-2">
                  {running
                    ? 'opening the app…'
                    : state.needsCreds
                    ? 'paused — waiting for you to sign in'
                    : 'No page preview — the run ended before any page rendered (often a login it couldn\'t get past). See the verdict below.'}
                </p>
              </div>
            </div>
          )}
        </AnimatePresence>

        {/* running scan-tint */}
        {running && live?.screenshot && (
          <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-accent/[0.04] via-transparent to-accent/[0.04]" />
        )}
      </div>

      {/* action caption — WHAT it's doing right now */}
      <div className="flex min-h-[34px] items-center gap-2 border-t border-line bg-surface px-3.5 py-2">
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
        <AnimatePresence mode="wait">
          <motion.span key={label || 'idle'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mono truncate text-[11px] text-muted">
            {label || (running ? 'working…' : 'run finished')}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
