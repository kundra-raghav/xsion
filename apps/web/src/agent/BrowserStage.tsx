import { motion, AnimatePresence } from 'framer-motion';
import type { CrawlState } from './useCrawlMap';

// The screenshot is captured at 1280×800 (crawlMapService viewport). We render it responsively and map the
// synthetic cursor coordinates into the displayed box via a scale factor.
const CAP_W = 1280, CAP_H = 800;

export function BrowserStage({ state, running }: { state: CrawlState; running: boolean }) {
  const cur = state.cursor;
  return (
    <div className="relative overflow-hidden rounded-xl2 border border-line bg-ink shadow-panel">
      {/* fake browser chrome */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3.5 py-2.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-realbug/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-flaky/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-expected/70" />
        </div>
        <div className="ml-2 flex flex-1 items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px] text-muted">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="opacity-60"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2"/></svg>
          <span className="truncate">{state.currentPath || 'loading…'}</span>
          {running && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent animate-scan" />}
        </div>
        <span className="rounded-md border border-line bg-surface-2/60 px-2 py-0.5 font-mono text-[10px] text-muted-2">Xsion's view</span>
      </div>

      {/* the page frame with the synthetic cursor */}
      <div className="relative aspect-[1280/800] w-full bg-[#0b0e14]">
        <AnimatePresence mode="wait">
          {state.screenshot ? (
            <motion.img key={state.screenshot.slice(-24)} src={state.screenshot} alt="live page"
              initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
              className="absolute inset-0 h-full w-full object-cover object-top" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-3 h-9 w-9 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
                <p className="font-mono text-[12px] text-muted-2">{running ? 'opening the app…' : 'the live page will appear here'}</p>
              </div>
            </div>
          )}
        </AnimatePresence>

        {/* synthetic cursor — the "watch it work" moment */}
        {cur && state.screenshot && (
          <motion.div
            className="pointer-events-none absolute z-20"
            animate={{ left: `${(cur.x / CAP_W) * 100}%`, top: `${(cur.y / CAP_H) * 100}%` }}
            transition={{ type: 'spring', stiffness: 220, damping: 22 }}
            style={{ translateX: '-2px', translateY: '-2px' }}
          >
            <div className="relative">
              <svg width="22" height="22" viewBox="0 0 24 24" className="drop-shadow-lg"><path d="M4 2l6 16 2.5-6.5L19 9z" fill="var(--accent)" stroke="#fff" strokeWidth="1.2"/></svg>
              <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-accent/40" style={{ width: 22, height: 22 }} />
              {cur.label && <span className="absolute left-6 top-3 whitespace-nowrap rounded-md bg-accent px-2 py-0.5 text-[10px] font-medium text-white shadow-glow">{cur.label}</span>}
            </div>
          </motion.div>
        )}

        {/* scan-line vibe while crawling */}
        {running && state.screenshot && (
          <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-accent/[0.04] via-transparent to-accent/[0.04]" />
        )}
      </div>
    </div>
  );
}
