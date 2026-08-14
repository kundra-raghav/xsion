import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import type { CrawlState, CrawlFlow } from './useCrawlMap';

// ── the thinking stream (Xsion reasoning as it crawls) ──
export function ThinkingStream({ thoughts }: { thoughts: string[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [thoughts.length]);
  return (
    <div className="rounded-xl2 border border-line bg-surface p-4 shadow-panel">
      <h3 className="mb-3 flex items-center gap-2 font-display text-[13px] font-semibold tracking-tight">
        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-scan" /> Thinking
      </h3>
      <div className="flex max-h-[210px] flex-col gap-2 overflow-auto pr-1">
        <AnimatePresence initial={false}>
          {thoughts.slice(-14).map((t, i) => (
            <motion.p key={thoughts.length - 14 + i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
              className="text-[12.5px] leading-relaxed text-muted">
              <span className="mr-1.5 text-accent/60">›</span>{t}
            </motion.p>
          ))}
        </AnimatePresence>
        <div ref={end} />
      </div>
    </div>
  );
}

// ── the map building up: pages / flows / API tallies (the thing being constructed) ──
const CONF: Record<string, string> = { high: 'text-expected border-expected/30', medium: 'text-flaky border-flaky/30', low: 'text-unverified border-unverified/40' };

export function MapPanel({ state }: { state: CrawlState }) {
  return (
    <div className="rounded-xl2 border border-line bg-surface p-4 shadow-panel">
      <h3 className="mb-3 font-display text-[13px] font-semibold tracking-tight">The map</h3>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Pages" value={state.pages.length} />
        <Stat label="Flows" value={state.flows.length} />
        <Stat label="API" value={state.api.length} />
      </div>

      {state.pages.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-2">Pages</p>
          <div className="flex flex-wrap gap-1">
            {state.pages.map((p) => (
              <span key={p.path} className="rounded-md border border-line bg-surface-2/50 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">{p.path}</span>
            ))}
          </div>
        </div>
      )}

      {state.flows.length > 0 && (
        <div>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-2">Flows found</p>
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {state.flows.map((f) => <FlowRow key={f.id} flow={f} />)}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}

function FlowRow({ flow }: { flow: CrawlFlow }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-line bg-paper/60 px-2.5 py-1.5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="truncate text-[12.5px] font-medium text-ink">{flow.name}</span>
        <span className={clsx('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', CONF[flow.confidence])}>{flow.confidence}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-t border-line pt-1.5">
          <p className="mb-1 font-mono text-[10px] text-muted-2">{flow.role} · {flow.steps.length} steps</p>
          {flow.reasoning && <p className="text-[11.5px] leading-relaxed text-muted">{flow.reasoning}</p>}
        </div>
      )}
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-paper/50 px-2.5 py-2 text-center">
      <div className="font-mono text-[19px] font-semibold tabular text-ink">{value}</div>
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-muted-2">{label}</div>
    </div>
  );
}

// ── the credential prompt (the ONE blocking overlay) ──
export function CredPrompt({ message, onSubmit, onCancel }: { message: string; onSubmit: (email: string, password: string) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }}
        className="w-[400px] rounded-xl2 border border-line bg-surface p-6 shadow-panel">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2"/></svg>
          </div>
          <h3 className="font-display text-[15px] font-semibold">Xsion needs to sign in</h3>
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-muted">{message}</p>
        <div className="flex flex-col gap-2.5">
          <input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="cred-input" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="cred-input" />
        </div>
        <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[10.5px] text-muted-2">
          <span className="text-expected">🔒</span> stored encrypted for this project · never logged
        </p>
        <div className="mt-4 flex gap-2">
          <button onClick={() => onSubmit(email, password)} disabled={!email || !password}
            className={clsx('flex-1 rounded-lg py-2 text-[13px] font-semibold', email && password ? 'bg-accent text-white hover:brightness-110' : 'bg-surface-2 text-muted-2')}>
            Sign in & continue
          </button>
          <button onClick={onCancel} className="rounded-lg border border-line px-3 py-2 text-[13px] text-muted hover:text-ink">Skip</button>
        </div>
        <style>{`.cred-input{height:38px;border-radius:9px;border:1px solid var(--line);background:var(--paper);padding:0 11px;font-size:13px;color:var(--ink);outline:none}.cred-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}`}</style>
      </motion.div>
    </motion.div>
  );
}
