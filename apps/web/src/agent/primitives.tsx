import { clsx } from 'clsx';
import type { Verdict } from './useSoaRun';

// ── Verdict pill: the four states as first-class visual state. `unverified` gets dignified (slate) treatment —
// it is the fail-safe floor made visible, NOT a generic warning. ──
const VERDICT_META: Record<Verdict, { label: string; cls: string; dot: string }> = {
  expected: { label: 'Expected', cls: 'text-expected border-expected/30 bg-expected/10', dot: 'bg-expected' },
  flaky_selector: { label: 'Flaky selector', cls: 'text-flaky border-flaky/30 bg-flaky/10', dot: 'bg-flaky' },
  unverified: { label: 'Unverified', cls: 'text-unverified border-unverified/40 bg-unverified/10', dot: 'bg-unverified' },
  real_bug: { label: 'Real bug', cls: 'text-realbug border-realbug/40 bg-realbug/10', dot: 'bg-realbug' },
};

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const m = VERDICT_META[verdict];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide', m.cls)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

// ── Code citation: the hero. The code line that PROVES the verdict, rendered as a clickable mono chip. ──
export function CodeRef({ codeRef }: { codeRef?: string | null }) {
  if (!codeRef) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/60 px-2 py-0.5 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-accent">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="opacity-70"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      {codeRef.replace(/^.*\/apps\//, 'apps/')}
    </span>
  );
}

export function StatusDot({ status }: { status?: 'running' | 'pass' | 'fail' }) {
  if (status === 'running') return <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" /></span>;
  if (status === 'pass') return <span className="flex h-2.5 w-2.5 items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" className="text-expected"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
  if (status === 'fail') return <span className="flex h-2.5 w-2.5 items-center justify-center"><svg width="11" height="11" viewBox="0 0 24 24" className="text-realbug"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg></span>;
  return <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />;
}

export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2 py-0.5 text-[11px] text-muted', className)}>{children}</span>;
}
