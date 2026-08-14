import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/** Uppercase mono micro-label — the design's signature (TARGET, PIPELINE, ONBOARD, WHY XSION IS UNSURE…). */
export function Label({ children, className, accent, amber }: { children: ReactNode; className?: string; accent?: boolean; amber?: boolean }) {
  return (
    <div className={clsx('mono text-[9.5px] uppercase tracking-label',
      accent ? 'text-accent' : amber ? 'text-amber' : 'text-muted-2', className)}>
      {children}
    </div>
  );
}

/** Solid light button (primary CTA in the design — light bg, dark ink, hover→accent). */
export function PrimaryBtn({ children, onClick, disabled, full, className }: { children: ReactNode; onClick?: () => void; disabled?: boolean; full?: boolean; className?: string }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={clsx('rounded-[5px] px-4 py-3 text-[13px] font-semibold tracking-[0.01em] transition-colors',
        disabled ? 'cursor-not-allowed bg-surface-2 text-muted-2' : 'bg-[oklch(0.95_0.005_264)] text-[oklch(0.18_0.01_264)] hover:bg-accent hover:text-accent-ink cursor-pointer',
        full && 'w-full', className)}>
      {children}
    </button>
  );
}

/** Accent (acid-green) button — used for "Validate the map", "Store and continue". */
export function AccentBtn({ children, onClick, disabled, full, className }: { children: ReactNode; onClick?: () => void; disabled?: boolean; full?: boolean; className?: string }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={clsx('rounded-[5px] px-4 py-2.5 text-[12.5px] font-semibold transition-all',
        disabled ? 'cursor-not-allowed bg-surface-2 text-muted-2' : 'bg-accent text-accent-ink hover:brightness-110 active:scale-[.98] cursor-pointer',
        full && 'w-full', className)}>
      {children}
    </button>
  );
}

/** Ghost/outline button. */
export function GhostBtn({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button onClick={onClick}
      className={clsx('rounded-[5px] border border-line px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-accent-line hover:text-ink', className)}>
      {children}
    </button>
  );
}

export function Input({ value, onChange, placeholder, mono, type, className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; className?: string; autoFocus?: boolean }) {
  return (
    <input value={value} type={type} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={clsx('w-full rounded-[5px] border border-line-strong bg-surface-2 px-3 py-[11px] text-[12.5px] text-ink outline-none transition-all placeholder:text-muted-2',
        'focus:border-accent-line focus:shadow-[0_0_0_3px_var(--accent-soft)]', mono && 'mono', className)} />
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('rounded-[6px] border border-line bg-surface', className)}>{children}</div>;
}

/** Confidence chip (high/medium/low) — green/amber/slate percentage. */
const CONF_COLOR: Record<string, string> = { high: 'text-expected', medium: 'text-amber', low: 'text-unverified' };
export function ConfChip({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const pct = { high: '92%', medium: '64%', low: '38%' }[confidence];
  return <span className={clsx('mono text-[11px] tabular font-medium', CONF_COLOR[confidence])}>{pct}</span>;
}

export function Dot({ color = 'var(--accent)', pulse }: { color?: string; pulse?: boolean }) {
  return <span className={clsx('inline-block h-[5px] w-[5px] shrink-0 rounded-full', pulse && 'anim-pulse')} style={{ background: color }} />;
}
