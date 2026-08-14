import { useState, useEffect, useRef, useMemo } from 'react';
import { clsx } from 'clsx';

export interface FramePointer { n: number; url: string; path?: string; label?: string; ts?: number; caseIndex?: number; caseTitle?: string }
export interface CaseVerdict { caseIndex: number; title: string; verdict?: string }

const VERDICT_TONE: Record<string, string> = {
  broke: 'text-realbug', held: 'text-expected', passed: 'text-expected',
  'needs-review': 'text-unverified', reproduced: 'text-realbug', 'not-reproduced': 'text-expected',
};

/**
 * RunPlayer — replay the frame-by-frame browser recording of a finished run, PER CASE. Frames carry a caseIndex so
 * the run splits into clips (one per attack/step); a case picker on the left lets you play just that case's clip,
 * with its verdict. Each frame has a baked-in CURSOR + highlight showing WHERE Xsion acted, plus the action label.
 * Play auto-advances the clip; the slider scrubs. Tolerant of missing frames (evicted playback).
 */
export function RunPlayer({ frames, cases }: { frames: FramePointer[]; cases?: CaseVerdict[] }) {
  // group frames into ordered clips by caseIndex (frames with no caseIndex → a leading "setup" clip = index -1).
  const clips = useMemo(() => {
    const byCase = new Map<number, FramePointer[]>();
    for (const f of frames) { const c = f.caseIndex ?? -1; if (!byCase.has(c)) byCase.set(c, []); byCase.get(c)!.push(f); }
    return Array.from(byCase.entries()).sort((a, b) => a[0] - b[0]).map(([caseIndex, fr]) => ({
      caseIndex, frames: fr,
      title: caseIndex === -1 ? 'Setup' : (fr[0]?.caseTitle || cases?.find((c) => c.caseIndex === caseIndex)?.title || `Case ${caseIndex + 1}`),
      verdict: cases?.find((c) => c.caseIndex === caseIndex)?.verdict,
    }));
  }, [frames, cases]);

  const [clipIdx, setClipIdx] = useState(0);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const timer = useRef<number | null>(null);

  const clip = clips[clipIdx] || clips[0];
  const clipFrames = clip?.frames || [];
  const cur = clipFrames[i];
  const clamp = (n: number) => Math.max(0, Math.min(clipFrames.length - 1, n));

  // when the selected clip changes, reset to its first frame.
  useEffect(() => { setI(0); setPlaying(false); }, [clipIdx]);

  useEffect(() => {
    if (!playing) { if (timer.current) window.clearInterval(timer.current); return; }
    timer.current = window.setInterval(() => {
      setI((p) => { if (p >= clipFrames.length - 1) { setPlaying(false); return p; } return p + 1; });
    }, 900);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [playing, clipFrames.length]);

  if (!frames.length) return null;
  const fkey = `${clipIdx}:${i}`;

  return (
    <div className="grid grid-cols-[248px_1fr] gap-0 overflow-hidden rounded-[10px] border border-line bg-ink shadow-panel">
      {/* CASE PICKER — one clip per attack/case, with its verdict; click to play just that case */}
      <div className="flex max-h-[560px] flex-col overflow-y-auto border-r border-line bg-surface/60">
        <div className="mono sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-[9px] uppercase tracking-label text-muted-2">Cases ({clips.length})</div>
        {clips.map((c, idx) => {
          // split "[phase] Title" → a phase chip + the readable title
          const m = /^\[(\w+)\]\s*(.*)$/.exec(c.title || '');
          const phase = m?.[1]; const title = m?.[2] || c.title;
          return (
            <button key={c.caseIndex} onClick={() => setClipIdx(idx)}
              className={clsx('flex flex-col gap-1 border-b border-line/60 px-3 py-2.5 text-left transition-colors', idx === clipIdx ? 'bg-accent-soft' : 'hover:bg-surface-2/50')}>
              <div className="flex items-center gap-1.5">
                {phase && <span className="mono rounded-[3px] bg-[oklch(1_0_0_/_0.06)] px-1 py-0.5 text-[8px] uppercase tracking-[0.06em] text-muted-2">{phase}</span>}
                {c.verdict && <span className={clsx('mono ml-auto text-[9px]', VERDICT_TONE[c.verdict] || 'text-muted-2')}>{c.verdict}</span>}
                <span className="mono text-[9px] text-muted-3">▶{c.frames.length}</span>
              </div>
              <span className="text-[11px] leading-[1.3] text-ink text-pretty">{title}</span>
            </button>
          );
        })}
      </div>

      {/* PLAYER — the selected case's clip */}
      <div className="flex min-w-0 flex-col">
        {/* browser chrome — the URL bar for the CURRENT frame */}
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3.5 py-2.5">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-realbug/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-expected/70" />
          </div>
          <div className="ml-2 flex flex-1 items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px] text-muted">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="shrink-0 opacity-60"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" /></svg>
            <span className="truncate text-ink/80">{cur?.path || 'recorded run'}</span>
          </div>
          <span className="mono shrink-0 rounded-md border border-line bg-surface-2/60 px-2 py-0.5 text-[10px] text-muted-2">{clip?.title?.slice(0, 22) || 'playback'}</span>
        </div>

        {/* the frame — cursor + highlight are baked into the saved image */}
        <div className="relative aspect-[1280/800] w-full bg-[#0b0e14]">
          {cur && !broken[fkey] ? (
            <img src={cur.url} alt={`frame ${cur.n}`} onError={() => setBroken((b) => ({ ...b, [fkey]: true }))}
              className="absolute inset-0 h-full w-full object-cover object-top" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="font-mono text-[12px] text-muted-2">{cur ? 'this frame is no longer available (playback expired)' : 'no frames for this case'}</p>
            </div>
          )}
        </div>

        {/* transport — play/pause + scrub + frame counter (within the current clip) */}
        <div className="flex items-center gap-3 border-t border-line bg-surface px-3.5 py-2.5">
          <button onClick={() => setPlaying((p) => !p)} disabled={clipFrames.length < 2}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40">
            {playing
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>}
          </button>
          <input type="range" min={0} max={Math.max(0, clipFrames.length - 1)} value={i}
            onChange={(e) => { setPlaying(false); setI(clamp(Number(e.target.value))); }}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong accent-[var(--accent)]" />
          <span className="mono shrink-0 text-[10px] text-muted-2 tabular-nums">{i + 1} / {clipFrames.length}</span>
        </div>

        {/* the action caption for this frame */}
        <div className="flex min-h-[32px] items-center gap-2 border-t border-line/60 bg-surface px-3.5 py-2">
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', playing ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
          <span className="mono truncate text-[11px] text-muted">{cur?.label || (cur ? `frame ${cur.n}` : '—')}</span>
        </div>
      </div>
    </div>
  );
}
