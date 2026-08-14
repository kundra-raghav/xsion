import { clsx } from 'clsx';
import type { Phase } from './useSoaRun';

const PHASES: { key: Phase; label: string; sub: string }[] = [
  { key: 'plan', label: 'Plan', sub: 'reads the code' },
  { key: 'execute', label: 'Execute', sub: 'drives the live UI' },
  { key: 'verify', label: 'Verify', sub: 'judges vs code' },
];
const ORDER: Phase[] = ['idle', 'plan', 'execute', 'verify', 'done'];

export function PhaseRail({ phase, label }: { phase: Phase; label: string }) {
  const cur = ORDER.indexOf(phase);
  return (
    <div className="flex items-center gap-1">
      {PHASES.map((p, i) => {
        const pIdx = ORDER.indexOf(p.key);
        const active = phase === p.key;
        const doneP = cur > pIdx;
        return (
          <div key={p.key} className="flex items-center gap-1">
            <div className={clsx('group relative flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-500',
              active && 'bg-accent-soft shadow-glow', doneP && 'opacity-90', !active && !doneP && 'opacity-45')}>
              <div className={clsx('flex h-6 w-6 items-center justify-center rounded-lg border text-[11px] font-semibold tabular',
                active ? 'border-accent bg-accent text-white animate-pulse-ring' : doneP ? 'border-expected/50 bg-expected/15 text-expected' : 'border-line text-muted-2')}>
                {doneP ? '✓' : i + 1}
              </div>
              <div className="leading-tight">
                <div className={clsx('text-[13px] font-semibold', active ? 'text-accent' : 'text-ink')}>{p.label}</div>
                <div className="font-mono text-[10px] text-muted-2">{p.sub}</div>
              </div>
            </div>
            {i < PHASES.length - 1 && (
              <div className={clsx('h-px w-8 transition-colors duration-500', cur > pIdx ? 'bg-expected/50' : 'bg-line')} />
            )}
          </div>
        );
      })}
      {phase !== 'idle' && (
        <div className="ml-3 flex items-center gap-2 font-mono text-[11px] text-muted animate-fade-up">
          <span className={clsx('h-1.5 w-1.5 rounded-full', phase === 'done' ? 'bg-expected' : 'bg-accent animate-scan')} />
          {label}
        </div>
      )}
    </div>
  );
}
