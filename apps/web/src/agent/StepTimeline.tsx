import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import type { Step } from './useSoaRun';
import { VerdictPill, CodeRef, StatusDot, Chip } from './primitives';

function shortUrl(u?: string) {
  if (!u) return '';
  try { const x = new URL(u); return x.pathname === '/' ? x.host : x.pathname; } catch { return u; }
}

export function StepTimeline({ steps }: { steps: Step[] }) {
  return (
    <div className="relative">
      {/* the spine */}
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-line" />
      <div className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {steps.map((s) => (
            <motion.div
              key={s.index}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className={clsx('relative rounded-xl2 border px-4 py-3 transition-colors',
                s.status === 'running' ? 'border-accent/40 bg-accent-soft/40 shadow-glow' : 'border-line bg-surface hover:border-line-strong')}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-paper">
                  <StatusDot status={s.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className={clsx('truncate text-[13.5px] font-medium', s.status === 'running' ? 'text-accent' : 'text-ink')}>
                      {s.index < 0 ? 'Sign in' : s.intent || `Step ${s.index + 1}`}
                    </p>
                    {s.verdict && <VerdictPill verdict={s.verdict} />}
                  </div>

                  {/* live meta: URL it ran on + resolver kind */}
                  {(s.url || s.kind) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {s.url && <Chip className="font-mono text-muted"><span className="opacity-60">↳</span>{shortUrl(s.url)}</Chip>}
                      {s.kind && s.status !== 'running' && <Chip>{s.kind}</Chip>}
                    </div>
                  )}

                  {/* SoA's reasoning + the code citation — the differentiator */}
                  {s.reasoning && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-2 overflow-hidden">
                      <p className="text-[12.5px] leading-relaxed text-muted">{s.reasoning}</p>
                      {s.codeRef && <div className="mt-1.5"><CodeRef codeRef={s.codeRef} /></div>}
                    </motion.div>
                  )}

                  {/* a failure detail (e.g. candidate list) when there's no reasoning yet */}
                  {!s.reasoning && s.detail && s.status === 'fail' && (
                    <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-2 line-clamp-2">{s.detail}</p>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
