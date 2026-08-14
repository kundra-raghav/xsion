import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTestRun, type BreakFinding } from '../useTestRun';
import { Label, PrimaryBtn } from '../kit';
import { TestBrowserStage } from '../TestBrowserStage';
import { RunPlayer } from '../RunPlayer';

const V: Record<string, { label: string; cls: string; dot: string; bg: string }> = {
  broke: { label: 'broke', cls: 'text-realbug', dot: 'bg-realbug', bg: 'border-[oklch(0.70_0.18_24_/_0.4)] bg-[oklch(0.70_0.18_24_/_0.06)]' },
  held: { label: 'held', cls: 'text-expected', dot: 'bg-expected', bg: 'border-line bg-surface' },
  passed: { label: 'passed', cls: 'text-expected', dot: 'bg-expected', bg: 'border-line bg-surface' },
  'needs-review': { label: 'needs review', cls: 'text-unverified', dot: 'bg-unverified', bg: 'border-[oklch(0.66_0.012_264_/_0.3)] bg-surface' },
  skipped: { label: 'skipped', cls: 'text-muted-2', dot: 'bg-muted-3', bg: 'border-line bg-surface' },
};
const PHASE: Record<string, string> = { happy: 'bg-[oklch(0.80_0.14_150_/_0.14)] text-expected', crud: 'bg-[oklch(0.72_0.14_200_/_0.14)] text-[oklch(0.72_0.14_200)]', adversarial: 'bg-[oklch(0.70_0.18_24_/_0.14)] text-realbug', api: 'bg-[oklch(0.84_0.14_80_/_0.14)] text-amber' };
const rel = (s?: string | null) => (s ? String(s).replace(/^.*\/(apps|src)\//, '$1/') : '');

/** The break-it run view: name a feature → Xsion tries to break it → oracle-matched, code-cited findings. */
interface PastRun { id: string; feature?: string; status?: string; finishedAt?: string }

export function BreakItView({ projectId, repo, onBack }: { projectId: string; repo: string; onBack: () => void }) {
  const { state, runId, start, loadRecorded } = useTestRun();
  const [feature, setFeature] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [started, setStarted] = useState(false);
  const [pastRuns, setPastRuns] = useState<PastRun[]>([]);
  const [viewingRecorded, setViewingRecorded] = useState(false);
  const running = started && !viewingRecorded && !['idle', 'done'].includes(state.phase);

  // load PAST break-it runs so the user can OPEN one instead of always re-running (the "re-runs from scratch" fix).
  useEffect(() => {
    fetch(`http://localhost:4000/api/projects/${projectId}/runs?kind=break-it`)
      .then((r) => r.json()).then((d) => setPastRuns((d.runs || []).filter((r: PastRun) => r.status === 'passed'))).catch(() => {});
  }, [projectId]);

  async function run() {
    if (!feature.trim()) return;
    if (authorized) await fetch(`http://localhost:4000/api/projects/${projectId}/security`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authorized: true }) }).catch(() => {});
    setViewingRecorded(false); setStarted(true);
    start('test/break-it', { projectId, feature, repo });
  }

  async function openRecorded(rid: string, feat?: string) {
    setFeature(feat || 'recorded run'); setViewingRecorded(true); setStarted(true);
    await loadRecorded(projectId, rid);
  }

  if (!started) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header onBack={onBack} running={false} phase="idle" counts={undefined} runId={null} />
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="max-w-[620px]">
            <span className="mono inline-block rounded-[3px] bg-[oklch(0.70_0.18_24_/_0.14)] px-2 py-0.5 text-[9px] tracking-[0.1em] text-realbug">ADVERSARIAL</span>
            <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2">Break a feature.</h1>
            <p className="m-0 mb-7 text-[14px] leading-[1.65] text-muted text-pretty">
              Not a replay. Xsion tries to <span className="text-realbug">break</span> the feature like a real QA engineer — happy path → full CRUD lifecycle → adversarial attacks (empty, boundary, wrong-type, out-of-order, double-submit) → API probing. Each attack has an oracle declared <em>before</em> it runs, so a “broke” is a mechanically-observed fact, not a guess. It only ever mutates its own tagged test data.
            </p>
            <Label className="mb-2">Which feature?</Label>
            <input value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="e.g. Create Event · Bulk Notification · User Profile edit"
              className="mono mb-5 w-full rounded-[5px] border border-line bg-paper px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent" />
            <div className="mb-6 rounded-[6px] border border-amber/40 bg-[oklch(0.84_0.14_80_/_0.05)] p-4">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5" />
                <span className="text-[12.5px] leading-[1.55] text-ink text-pretty">
                  I own / am authorized to test this app. The CRUD & attack phases create, edit and delete <b>test data</b> (tagged, self-cleaning). Without this, only the non-mutating checks run.
                </span>
              </label>
            </div>
            <PrimaryBtn onClick={run} disabled={!feature.trim()}>Break “{feature || 'the feature'}” →</PrimaryBtn>
            <div className="mono mt-4 text-[10px] leading-[1.7] text-muted-3 text-pretty">SoA plans the attacks (code-grounded when the repo is attached). A finding requires a 500, a console exception, or the app accepting invalid data — a validation error shown is “held”. Inconclusive is “needs-review”, never a false bug.</div>

            {/* PAST RUNS — open a recorded result instead of re-running from scratch */}
            {pastRuns.length > 0 && (
              <div className="mt-8 border-t border-line pt-6">
                <Label className="mb-3">Recorded runs — open one, don't re-run</Label>
                <div className="flex flex-col gap-1.5">
                  {pastRuns.slice(0, 6).map((r) => (
                    <button key={r.id} onClick={() => openRecorded(r.id, r.feature)}
                      className="group flex items-center gap-3 rounded-[5px] border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-accent-line hover:bg-accent-soft">
                      <span className="h-1.5 w-1.5 flex-none rounded-full bg-expected" />
                      <span className="flex-1 truncate text-[12.5px]">{r.feature || 'break-it run'}</span>
                      <span className="mono text-[9.5px] text-muted-3">{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ''}</span>
                      <span className="mono flex-none text-[11px] text-muted-2 opacity-0 transition-opacity group-hover:opacity-100">open →</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const counts = state.breakFindings.reduce((a, f) => { a[f.verdict] = (a[f.verdict] || 0) + 1; return a; }, {} as Record<string, number>);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header onBack={onBack} running={running} phase={state.phase} counts={counts} runId={runId} feature={feature} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="min-h-0 overflow-y-auto p-[22px_28px]">
          {/* LIVE VIEW — watch Xsion drive the app: URL bar + screenshot + the action. Shown while running OR when a
              live frame exists; hidden for a recorded run (frames aren't persisted, so there's nothing to show). */}
          {(running || state.live?.screenshot) && (
            <div className="mb-5">
              <div className="mb-2.5 flex items-center justify-between">
                <Label>{running ? 'Live — Xsion is driving the app' : 'Last frame'}</Label>
                {state.live?.path && <span className="mono text-[10px] text-accent">{state.live.path}</span>}
              </div>
              <TestBrowserStage state={state} running={running} />
            </div>
          )}
          {viewingRecorded && (state.frames?.length ? (
            <div className="mb-5">
              <div className="mb-2.5 flex items-center justify-between">
                <Label>Playback — replay what Xsion did</Label>
                <span className="mono text-[10px] text-muted-2">{state.frames.length} frames</span>
              </div>
              <RunPlayer frames={state.frames} cases={state.breakFindings.map((f, idx) => ({ caseIndex: idx, title: `[${f.phase}] ${f.title}`, verdict: f.verdict }))} />
            </div>
          ) : (
            <div className="mb-5 rounded-[6px] border border-line bg-surface px-4 py-2.5">
              <span className="mono text-[10.5px] text-muted-2">📼 Viewing a recorded run — findings below. No playback saved for this run.</span>
            </div>
          ))}
          <Label className="mb-3">Attacks — oracle-matched{repo ? ' & code-cited' : ''}</Label>
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {state.breakFindings.map((f, i) => <FindingCard key={i} f={f} />)}
            </AnimatePresence>
            {state.breakFindings.length === 0 && <div className="mono text-[12px] text-muted-2">{running ? 'SoA is planning the attacks…' : 'no findings'}</div>}
          </div>
        </div>
        <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
          <div className="min-h-0 flex-1 overflow-y-auto p-[16px_18px]">
            <Label className="mb-3">Thinking</Label>
            <div className="flex flex-col gap-2">
              {state.thoughts.map((t, i) => <p key={i} className="text-[12px] leading-relaxed text-muted"><span className="mr-1.5 text-accent/60">›</span>{t}</p>)}
            </div>
          </div>
          <div className="border-t border-line p-[14px_18px]">
            <div className="mono text-[9.5px] leading-[1.7] text-muted-2">Only its own tagged test data is mutated, and it cleans up. “Broke” = an observed failure (500 / exception / accepts-invalid). Inconclusive is never a bug.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function FindingCard({ f }: { f: BreakFinding }) {
  const [open, setOpen] = useState(f.verdict === 'broke');
  const v = V[f.verdict] || V['needs-review'];
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={clsx('rounded-[7px] border', v.bg)}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className={clsx('mt-1 h-2 w-2 flex-none rounded-full', v.dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="mono flex-none rounded-[3px] px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]" style={{}}><span className={clsx('rounded-[3px] px-1.5 py-0.5', PHASE[f.phase] || 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{f.phase}</span></span>
            <span className="text-[13.5px] font-medium">{f.title}</span>
          </div>
          <div className="mono mt-1 text-[10px] text-muted-2"><span className={v.cls}>{v.label}</span>{f.codeRef ? <> · <span className="text-accent">{rel(f.codeRef)}</span></> : null}</div>
        </div>
        <span className="mono flex-none text-[10px] text-muted-3">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-4 py-3">
          <div className="mb-2.5 text-[12px] leading-[1.6] text-muted text-pretty">{f.detail}</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            {f.expectHeld && <div className="rounded-[5px] border border-line bg-paper p-2"><div className="mono mb-1 text-[8.5px] uppercase tracking-label text-expected">held if</div><div className="text-muted-2">{f.expectHeld}</div></div>}
            {f.expectBroke && <div className="rounded-[5px] border border-line bg-paper p-2"><div className="mono mb-1 text-[8.5px] uppercase tracking-label text-realbug">broke if</div><div className="text-muted-2">{f.expectBroke}</div></div>}
          </div>
          {f.reproduce && (
            <div className="mt-2.5 rounded-[5px] border border-line bg-paper p-2.5">
              <div className="mono mb-1 text-[8.5px] uppercase tracking-label text-muted-2">reproduce</div>
              <div className="mono text-[10.5px] leading-relaxed text-muted"><span className="text-muted-3">do: </span>{f.reproduce.intent}{f.reproduce.value ? ` (${f.reproduce.value})` : ''}</div>
              <div className="mono mt-1 text-[10.5px] leading-relaxed text-ink"><span className="text-muted-3">saw: </span>{f.reproduce.observed}</div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Header({ onBack, running, phase, counts, runId, feature }: { onBack: () => void; running: boolean; phase: string; counts?: Record<string, number>; runId: string | null; feature?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-8 py-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
        <span className="h-3 w-px bg-line-strong" />
        <span className="text-[14px] font-medium">Break it{feature ? `: ${feature}` : ''}</span>
        <span className={clsx('flex items-center gap-1.5 rounded-full border px-2 py-0.5 mono text-[9.5px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
          {running ? 'ATTACKING' : phase === 'done' ? 'RECORDED' : 'READY'}
        </span>
      </div>
      {counts && (
        <div className="mono flex items-center gap-3 text-[11px]">
          {counts.broke > 0 && <span className="text-realbug">{counts.broke} broke</span>}
          {(counts.held || counts.passed) && <span className="text-expected">{(counts.held || 0) + (counts.passed || 0)} held</span>}
          {counts['needs-review'] > 0 && <span className="text-unverified">{counts['needs-review']} review</span>}
          {runId && <span className="text-muted-2">· {runId.slice(0, 8)}</span>}
        </div>
      )}
    </div>
  );
}
