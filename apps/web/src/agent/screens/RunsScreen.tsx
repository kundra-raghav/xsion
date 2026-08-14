import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { Project } from '../Workspace';
import { useTestRun } from '../useTestRun';
import { RunPlayer } from '../RunPlayer';
import { Label } from '../kit';

const API = 'http://localhost:4000';

interface RunRow { id: string; kind: string; label: string; outcome?: string; status?: string; finishedAt?: string; startedAt?: string; frameCount?: number }

const KIND_META: Record<string, { label: string; cls: string }> = {
  'break-it': { label: 'ADVERSARIAL', cls: 'bg-[oklch(0.70_0.18_24_/_0.14)] text-realbug' },
  'bug-repro': { label: 'REPLICATE', cls: 'bg-[oklch(0.72_0.14_200_/_0.14)] text-[oklch(0.72_0.14_200)]' },
  mission: { label: 'MISSION', cls: 'bg-accent-soft text-accent' },
  'env-matrix': { label: 'CONDITIONS', cls: 'bg-[oklch(0.84_0.14_80_/_0.14)] text-amber' },
  'security-audit': { label: 'AUDIT', cls: 'bg-[oklch(0.66_0.14_300_/_0.14)] text-[oklch(0.72_0.14_300)]' },
  flow: { label: 'FLOW', cls: 'bg-[oklch(0.80_0.14_150_/_0.14)] text-expected' },
  run: { label: 'RUN', cls: 'bg-[oklch(1_0_0_/_0.06)] text-muted-2' },
};
const outcomeTone = (o?: string) => !o ? 'text-muted-2' : /broke|vulnerable|fail|reproduced/.test(o) ? 'text-realbug' : /held|clean|passed|not-reproduced|covered|all conditions/.test(o) ? 'text-expected' : 'text-muted-2';

/** The central RUNS HISTORY — every recorded run of every engine, newest first, filterable. Click any to open its
 * saved result + frame-by-frame playback. Lives OUTSIDE the crawl/validate pipeline gate, so a recorded run is
 * always viewable regardless of whether the project is fully mapped. */
export function RunsScreen({ project }: { project: Project }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { state, loadRecorded } = useTestRun();

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/api/projects/${project.id}/runs`).then((r) => r.json())
      .then((d) => setRuns((d.runs || []).filter((r: RunRow) => r.status === 'passed' || r.status === 'failed')))
      .catch(() => setRuns([])).finally(() => setLoading(false));
  }, [project.id]);

  async function open(r: RunRow) { setOpenId(r.id); await loadRecorded(project.id, r.id); }

  const kinds = Array.from(new Set(runs.map((r) => r.kind)));
  const shown = filter === 'all' ? runs : runs.filter((r) => r.kind === filter);
  const openRun = runs.find((r) => r.id === openId);

  // ── the open run's detail (playback + result) ──
  if (openId && openRun) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-8 py-4">
          <button onClick={() => setOpenId(null)} className="mono text-[11px] text-muted-2 hover:text-ink">← all runs</button>
          <span className="h-3 w-px bg-line-strong" />
          <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px] tracking-[0.08em]', (KIND_META[openRun.kind] || KIND_META.run).cls)}>{(KIND_META[openRun.kind] || KIND_META.run).label}</span>
          <span className="text-[14px] font-medium">{openRun.label}</span>
          {openRun.outcome && <span className={clsx('mono text-[11px]', outcomeTone(openRun.outcome))}>{openRun.outcome}</span>}
          <span className="mono ml-auto text-[10px] text-muted-3">{openRun.id.slice(0, 8)}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-[22px_28px]">
          {state.frames?.length ? (
            <div className="mb-6">
              <div className="mb-2.5 flex items-center justify-between">
                <Label>Playback — replay what Xsion did</Label>
                <span className="mono text-[10px] text-muted-2">{state.frames.length} frames</span>
              </div>
              <RunPlayer frames={state.frames} cases={state.breakFindings?.length ? state.breakFindings.map((f, i) => ({ caseIndex: i, title: `[${f.phase}] ${f.title}`, verdict: f.verdict })) : undefined} />
            </div>
          ) : (
            <div className="mb-6 rounded-[6px] border border-line bg-surface px-4 py-2.5">
              <span className="mono text-[10.5px] text-muted-2">📼 No playback frames saved for this run.</span>
            </div>
          )}
          <RunResult state={state} kind={openRun.kind} />
        </div>
      </div>
    );
  }

  // ── the history list ──
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-9">
        <div className="max-w-[860px]">
          <span className="mono inline-block rounded-[3px] bg-accent-soft px-2 py-0.5 text-[9px] tracking-[0.1em] text-accent">HISTORY</span>
          <h1 className="m-0 mb-2 mt-3.5 text-[30px] font-medium tracking-tight2">Runs</h1>
          <p className="m-0 mb-6 text-[14px] leading-[1.6] text-muted text-pretty">Every test Xsion has run on this project — open any one to see its result and replay frame-by-frame what it did.</p>

          {/* kind filter */}
          <div className="mb-5 flex flex-wrap gap-1.5">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All ({runs.length})</FilterChip>
            {kinds.map((k) => <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>{(KIND_META[k] || KIND_META.run).label} ({runs.filter((r) => r.kind === k).length})</FilterChip>)}
          </div>

          <div className="flex flex-col gap-1.5">
            {loading && <div className="mono text-[12px] text-muted-2">loading runs…</div>}
            {!loading && shown.length === 0 && <div className="mono text-[12px] text-muted-2">no recorded runs yet — run a test from the Test menu</div>}
            {shown.map((r) => {
              const meta = KIND_META[r.kind] || KIND_META.run;
              return (
                <button key={r.id} onClick={() => open(r)}
                  className="group flex items-center gap-3 rounded-[6px] border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-accent-line hover:bg-accent-soft">
                  <span className={clsx('mono shrink-0 rounded-[3px] px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]', meta.cls)}>{meta.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.label}</span>
                  {r.outcome && <span className={clsx('mono shrink-0 text-[10.5px]', outcomeTone(r.outcome))}>{r.outcome}</span>}
                  {!!r.frameCount && <span className="mono shrink-0 text-[10px] text-accent">▶ {r.frameCount}</span>}
                  <span className="mono shrink-0 text-[10px] text-muted-3 tabular-nums">{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ''}</span>
                  <span className="mono shrink-0 text-[11px] text-muted-2 opacity-0 transition-opacity group-hover:opacity-100">open →</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx('mono rounded-full border px-2.5 py-1 text-[10px] transition-colors',
      active ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2 hover:border-line-strong')}>{children}</button>
  );
}

/** compact result renderer per kind — the saved findings/verdict below the playback. */
function RunResult({ state, kind }: { state: any; kind: string }) {
  if (kind === 'break-it' && state.breakFindings?.length) {
    return (
      <>
        <Label className="mb-3">Findings</Label>
        <div className="flex flex-col gap-1.5">
          {state.breakFindings.map((f: any, i: number) => (
            <div key={i} className="flex items-center gap-2.5 rounded-[5px] border border-line bg-surface px-3.5 py-2.5">
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', f.verdict === 'broke' ? 'bg-realbug' : f.verdict === 'held' || f.verdict === 'passed' ? 'bg-expected' : 'bg-muted-3')} />
              <span className="flex-1 truncate text-[12.5px]">{f.title}</span>
              <span className={clsx('mono text-[10px]', f.verdict === 'broke' ? 'text-realbug' : f.verdict === 'held' ? 'text-expected' : 'text-muted-2')}>{f.verdict}</span>
              {f.codeRef && <span className="mono text-[9.5px] text-accent">{String(f.codeRef).replace(/^.*\/(apps|src)\//, '$1/')}</span>}
            </div>
          ))}
        </div>
      </>
    );
  }
  if (kind === 'bug-repro' && state.bugReport) {
    const b = state.bugReport;
    return (
      <div className="rounded-[7px] border border-line bg-surface p-4">
        <div className="mono mb-2 text-[13px] font-semibold uppercase tracking-[0.02em]">{b.verdict}</div>
        <div className="text-[12.5px] leading-[1.55] text-muted text-pretty">{b.detail}</div>
      </div>
    );
  }
  if ((kind === 'env-matrix' || kind === 'flow') && state.items?.length) {
    return (
      <>
        <Label className="mb-3">{kind === 'env-matrix' ? 'Conditions' : 'Steps'}</Label>
        <div className="flex flex-col gap-1.5">
          {state.items.map((it: any) => (
            <div key={it.index} className="flex items-center gap-2.5 rounded-[5px] border border-line bg-surface px-3.5 py-2.5">
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', it.status === 'pass' ? 'bg-expected' : it.status === 'fail' ? 'bg-realbug' : 'bg-muted-3')} />
              <span className="flex-1 truncate text-[12.5px]">{it.title}</span>
              {it.detail && <span className="mono truncate text-[10px] text-muted-3" style={{ maxWidth: 260 }}>{it.detail}</span>}
            </div>
          ))}
        </div>
      </>
    );
  }
  return null;
}
