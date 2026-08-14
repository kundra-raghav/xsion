import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useCrawlMap } from '../useCrawlMap';
import { AccentBtn } from '../kit';
import type { Project } from '../Workspace';

const CAP_W = 1280, CAP_H = 800;

export function CrawlScreen({ project, oracle, onRunning, onDone, cfg, resumeMode }: {
  project: Project; oracle: 'code' | 'url'; onRunning: (b: boolean) => void; onDone: () => void;
  cfg?: { url: string; repo?: string }; resumeMode?: boolean;
}) {
  const { state, start, resume } = useCrawlMap();
  const [started, setStarted] = useState(false);
  const [choice, setChoice] = useState<'pending' | 'go'>('pending');   // pending = ask resume-or-fresh before crawling
  const [existingPages, setExistingPages] = useState<number | null>(null);
  const [credEmail, setCredEmail] = useState('');
  const [credPass, setCredPass] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  const running = !['idle', 'done'].includes(state.phase);
  const done = state.phase === 'done';

  useEffect(() => { onRunning(running); }, [running, onRunning]);
  useEffect(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' }); }, [state.thoughts.length]);

  const beginFresh = () => { setChoice('go'); start({ projectId: project.id, repo: oracle === 'code' ? cfg?.repo : undefined, baseUrl: cfg?.url || project.baseUrl }); };
  const beginResume = () => { setChoice('go'); resume(project.id); };

  // On mount: decide whether to auto-start, resume, or ASK. Never blindly re-crawl over an existing map (the bug
  // where clicking "Crawl & map" restarted the same login/flow loop the user just confirmed).
  useEffect(() => {
    if (started) return;
    setStarted(true);
    if (resumeMode) { beginResume(); return; }   // came from "continue exploring" → resume immediately
    // check whether a map already exists; if so, ASK resume-vs-fresh instead of auto-restarting.
    fetch(`http://localhost:4000/api/projects/${project.id}/map`).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (m?.pages?.length) { setExistingPages(m.pages.length); setChoice('pending'); }
      else beginFresh();   // no map yet → first crawl, just go
    }).catch(() => beginFresh());
  }, [started]); // eslint-disable-line

  const cur = state.cursor;
  const counts = { pages: state.pages.length, flows: state.flows.length, endpoints: state.api.length };
  const unknowns = state.bounded?.reachedLimit ? 2 : 0;

  return (
    <div className="flex h-full min-h-0">
      {/* the browser stage */}
      <div className="flex min-w-0 flex-1 flex-col p-[18px_20px]">
        <div className="flex items-center gap-3 pb-3.5">
          <span className="h-[5px] w-[5px] flex-none rounded-full bg-[oklch(0.70_0.18_24)] anim-pulse" />
          <span className="mono whitespace-nowrap text-[9.5px] tracking-label text-muted">SCREENSHOT STREAM · LIVE</span>
          <span className="h-[11px] w-px bg-line-strong" />
          <span className="mono truncate text-[9.5px] text-muted-2">Xsion's view of your app, not a live frame of it</span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="relative aspect-[16/10] max-h-full w-full overflow-hidden rounded-[9px] bg-white shadow-[0_28px_64px_oklch(0_0_0_/_0.45)]" style={{ containerType: 'size' as any }}>
            {/* sweep line */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[6] h-[1.5px]" style={{ background: 'linear-gradient(90deg, transparent, oklch(0.62 0.14 122 / 0.55), transparent)', animation: 'xs-sweep 6s linear infinite' }} />

            {/* the live frame */}
            <AnimatePresence mode="wait">
              {state.screenshot ? (
                <motion.img key={state.screenshot.slice(-20)} src={state.screenshot} alt="live"
                  initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }}
                  className="absolute inset-0 h-full w-full object-cover object-top" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-[oklch(0.985_0.002_264)]">
                  <div className="text-center">
                    <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-[oklch(0.86_0.19_122_/_0.3)] border-t-accent" style={{ animation: 'spin 1s linear infinite' }} />
                    <p className="mono text-[11px] text-[oklch(0.55_0.01_264)]">opening the app…</p>
                  </div>
                </div>
              )}
            </AnimatePresence>

            {/* synthetic cursor with ripple */}
            {cur && state.screenshot && (
              <motion.div className="pointer-events-none absolute z-10"
                animate={{ left: `${(cur.x / CAP_W) * 100}%`, top: `${(cur.y / CAP_H) * 100}%` }}
                transition={{ type: 'spring', stiffness: 210, damping: 22 }}>
                <div style={{ width: '1.5cqw', height: '1.5cqw' }} className="rounded-full bg-[oklch(0.62_0.16_122)] shadow-[0_0_0_0.55cqw_oklch(0.62_0.16_122_/_0.20)]" />
                {cur.label && <span className="mono absolute left-[1.6cqw] top-0 whitespace-nowrap rounded bg-accent px-[0.5cqw] py-[0.2cqw] text-[0.9cqw] font-medium text-accent-ink">{cur.label}</span>}
              </motion.div>
            )}

            {/* RESUME-OR-FRESH overlay — shown when a map already exists, instead of blindly re-crawling (the fix
                for "clicking Crawl & map restarts the same loop I just confirmed"). */}
            {choice === 'pending' && existingPages != null && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[oklch(0.18_0.01_264_/_0.6)] p-[4%] backdrop-blur-[3px]">
                <div className="anim-fade w-[74%] rounded-[0.7cqw] border border-line-strong bg-surface p-[3.2%] text-ink shadow-[0_24px_60px_oklch(0_0_0_/_0.5)]">
                  <div className="mb-[1.6%] flex items-center gap-[0.7cqw]">
                    <span className="h-[0.65cqw] w-[0.65cqw] rounded-full bg-accent" />
                    <span className="mono text-[0.95cqw] tracking-label text-accent">THIS APP IS ALREADY PARTLY MAPPED</span>
                  </div>
                  <div className="mb-[1%] text-[1.9cqw] font-medium tracking-[-0.02em]">{existingPages} pages already mapped. Continue, or start over?</div>
                  <div className="mb-[2.4%] text-[1.15cqw] leading-[1.6] text-muted text-pretty">Continuing picks up from where the last crawl stopped — the flows you already validated stay put and it explores further. Re-mapping discards the current map and crawls from scratch.</div>
                  <div className="mt-[2%] flex gap-[0.6cqw]">
                    <button onClick={beginResume} className="flex-1 rounded-[0.3cqw] bg-accent p-[0.95cqw] text-[1.2cqw] font-semibold text-accent-ink">Continue exploring →</button>
                    <button onClick={beginFresh} className="rounded-[0.3cqw] border border-line-strong bg-transparent px-[1.2cqw] py-[0.95cqw] text-[1.2cqw] text-muted">Re-map from scratch</button>
                  </div>
                </div>
              </div>
            )}

            {/* the ONE blocking overlay — credentials */}
            {state.needCreds && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[oklch(0.18_0.01_264_/_0.55)] p-[4%] backdrop-blur-[3px]">
                <div className="anim-fade w-[70%] rounded-[0.7cqw] border border-line-strong bg-surface p-[3%] text-ink shadow-[0_24px_60px_oklch(0_0_0_/_0.5)]">
                  <div className="mb-[1.6%] flex items-center gap-[0.7cqw]">
                    <span className="h-[0.65cqw] w-[0.65cqw] rounded-full bg-amber" />
                    <span className="mono text-[0.95cqw] tracking-label text-amber">CRAWL PAUSED · AUTH WALL</span>
                  </div>
                  <div className="mb-[1%] text-[1.95cqw] font-medium tracking-[-0.02em]">I need credentials to get past the login</div>
                  <div className="mb-[2.4%] text-[1.2cqw] leading-[1.6] text-muted text-pretty">Held in memory for this project only and reused so you don't re-enter them — never written to disk, the logs, the event stream, or your repo.</div>
                  <input value={credEmail} onChange={(e) => setCredEmail(e.target.value)} placeholder="email" className="mono mb-[0.6cqw] w-full rounded-[0.3cqw] border border-line-strong bg-surface-2 p-[0.9cqw] text-[1.2cqw] text-ink outline-none" />
                  <input value={credPass} onChange={(e) => setCredPass(e.target.value)} type="password" placeholder="password" className="mono w-full rounded-[0.3cqw] border border-line-strong bg-surface-2 p-[0.9cqw] text-[1.2cqw] text-ink outline-none" />
                  <div className="mt-[2.2%] flex gap-[0.6cqw]">
                    <button onClick={() => start({ projectId: project.id, repo: oracle === 'code' ? cfg?.repo : undefined, baseUrl: cfg?.url || project.baseUrl, email: credEmail, password: credPass })}
                      className="flex-1 rounded-[0.3cqw] bg-accent p-[0.9cqw] text-[1.2cqw] font-semibold text-accent-ink">Store and continue</button>
                    <button onClick={() => start({ projectId: project.id, repo: oracle === 'code' ? cfg?.repo : undefined, baseUrl: cfg?.url || project.baseUrl })}
                      className="rounded-[0.3cqw] border border-line-strong bg-transparent px-[1.2cqw] py-[0.9cqw] text-[1.2cqw] text-muted">Skip this area</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* stream rail */}
      <div className="flex w-[376px] flex-none flex-col border-l border-line bg-surface">
        {/* counts + budget */}
        <div className="border-b border-line px-[18px] py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[12.5px] font-medium">{state.phaseLabel || 'Ready'}</span>
            <span className="mono text-[9.5px] tracking-[0.1em] text-muted-2">{running ? 'crawling' : done ? 'complete' : 'idle'}</span>
          </div>
          <div className="mb-3.5 flex gap-0.5">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className={clsx('h-[3px] flex-1 rounded-full', i < counts.pages * 2 ? 'bg-accent' : 'bg-line-strong')} />
            ))}
          </div>
          <div className="flex">
            <Metric label="PAGES" value={counts.pages} />
            <Metric label="FLOWS" value={counts.flows} />
            <Metric label="ENDPOINTS" value={counts.endpoints} />
            <Metric label="UNKNOWNS" value={unknowns} amber flex={1.2} />
          </div>
        </div>

        {/* thinking stream */}
        <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] py-3.5">
          <AnimatePresence initial={false}>
            {state.thoughts.map((t, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 py-1.5">
                <span className="mono flex-none pt-0.5 text-[9.5px] tabular text-muted-3">{String(i + 1).padStart(2, '0')}</span>
                <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{t}</div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {done && (
          <div className="border-t border-line bg-surface px-[18px] py-4">
            <div className="mb-3 text-[12.5px] leading-[1.6] text-muted text-pretty">
              Budget spent. {counts.flows} flows mapped{unknowns ? `, ${unknowns} boundaries recorded as known-unknowns` : ''}. Nothing is saved until you validate.
            </div>
            <AccentBtn full onClick={onDone}>Validate the map →</AccentBtn>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, amber, flex }: { label: string; value: number; amber?: boolean; flex?: number }) {
  return (
    <div style={{ flex: flex || 1 }}>
      <div className={clsx('mono text-[19px] tabular tracking-[-0.03em]', amber ? 'text-amber' : 'text-ink')}>{value}</div>
      <div className="mono mt-0.5 text-[9px] tracking-label text-muted-2">{label}</div>
    </div>
  );
}
