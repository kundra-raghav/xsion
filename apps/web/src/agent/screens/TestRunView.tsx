import { useEffect } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTestRun } from '../useTestRun';
import { Label } from '../kit';
import { TestBrowserStage } from '../TestBrowserStage';

const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  pass: { label: 'pass', cls: 'text-expected', dot: 'bg-expected' },
  fail: { label: 'fail', cls: 'text-realbug', dot: 'bg-realbug' },
  skipped: { label: 'skipped', cls: 'text-muted-2', dot: 'bg-muted-3' },
  unverifiable: { label: 'unverifiable', cls: 'text-unverified', dot: 'bg-unverified' },
  running: { label: 'running', cls: 'text-accent', dot: 'bg-accent' },
};

export interface TestSpec { id: string; name: string; path: string; body: (projectId: string, repo: string) => any; }

/** Live view for any test type: streams items as they run + records for reference. */
export function TestRunView({ spec, projectId, repo, onBack }: { spec: TestSpec; projectId: string; repo: string; onBack: () => void }) {
  const { state, runId, start } = useTestRun();
  const running = !['idle', 'done'].includes(state.phase);
  const isGenerate = state.kind === 'generate' || spec.id === 'generate';

  useEffect(() => { start(spec.path, { projectId, ...spec.body(projectId, repo) }); }, []); // eslint-disable-line

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center justify-between border-b border-line px-8 py-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
          <span className="h-3 w-px bg-line-strong" />
          <span className="text-[14px] font-medium">{spec.name}</span>
          <span className={clsx('flex items-center gap-1.5 rounded-full border px-2 py-0.5 mono text-[9.5px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
            <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
            {running ? 'RUNNING' : state.phase === 'done' ? 'RECORDED' : 'IDLE'}
          </span>
        </div>
        {state.done && (
          <div className="mono flex items-center gap-3 text-[11px]">
            <span className="text-expected">{state.done.passed} pass</span>
            {state.done.failed > 0 && <span className="text-realbug">{state.done.failed} fail</span>}
            {state.done.skipped > 0 && <span className="text-muted-2">{state.done.skipped} {isGenerate ? '' : 'skipped'}</span>}
            <span className="text-muted-2">· recorded {runId?.slice(0, 8)}</span>
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        {/* items / cases */}
        <div className="min-h-0 overflow-y-auto p-[22px_28px]">
          {isGenerate ? (
            <>
              <Label className="mb-4">Test cases authored</Label>
              <div className="flex flex-col gap-2.5">
                <AnimatePresence initial={false}>
                  {state.cases.map((c, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      className="rounded-[6px] border border-line bg-surface p-4">
                      <div className="mb-2 flex items-center gap-2.5">
                        <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px]', c.priority === 'P0' ? 'bg-[oklch(0.70_0.18_24_/_0.15)] text-realbug' : c.priority === 'P1' ? 'bg-accent-soft text-amber' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{c.priority}</span>
                        <span className="text-[13.5px] font-medium">{c.title}</span>
                        {c.codeRef && <span className="mono ml-auto text-[10px] text-accent">{String(c.codeRef).replace(/^.*\/apps\//, 'apps/')}</span>}
                      </div>
                      {c.preconditions && <div className="mb-2 text-[11.5px] text-muted-2"><span className="mono text-muted-3">given </span>{c.preconditions}</div>}
                      <ol className="mb-2 flex list-none flex-col gap-1 p-0">
                        {c.steps.map((s, j) => <li key={j} className="mono flex gap-2 text-[11.5px] text-muted"><span className="text-muted-3">{j + 1}.</span>{s}</li>)}
                      </ol>
                      {c.expected && <div className="rounded-[4px] bg-[oklch(0.80_0.14_150_/_0.08)] px-2.5 py-1.5 text-[11.5px] text-expected"><span className="mono text-[10px]">expect </span>{c.expected}</div>}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {state.cases.length === 0 && <div className="mono text-[12px] text-muted-2">{running ? 'authoring cases…' : 'no cases'}</div>}
              </div>
            </>
          ) : (
            <>
              {/* LIVE VIEW — for browser-driving test types (flow / env-matrix), show the page as it runs */}
              {(running || state.live?.screenshot) && state.live && (
                <div className="mb-5">
                  <div className="mb-2.5 flex items-center justify-between">
                    <Label>{running ? 'Live — Xsion is driving the app' : 'Last frame'}</Label>
                    {state.live?.path && <span className="mono text-[10px] text-accent">{state.live.path}</span>}
                  </div>
                  <TestBrowserStage state={state} running={running} />
                </div>
              )}
              <Label className="mb-4">{state.kind === 'feapi' ? 'UI action → API' : 'Endpoint replay'}</Label>
              <div className="flex flex-col gap-1.5">
                <AnimatePresence initial={false}>
                  {state.items.map((it) => {
                    const st = STATUS[it.status || 'running'];
                    return (
                      <motion.div key={it.index} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        className={clsx('rounded-[6px] border px-3.5 py-3', it.status === 'running' ? 'border-accent-line bg-accent-soft/50' : 'border-line bg-surface')}>
                        <div className="flex items-center gap-2.5">
                          {it.status === 'running'
                            ? <span className="h-2 w-2 rounded-full bg-accent anim-pulse" />
                            : <span className={clsx('h-2 w-2 rounded-full', st.dot)} />}
                          <span className="mono flex-1 truncate text-[12px] text-ink">{it.title}</span>
                          <span className={clsx('mono text-[10px]', st.cls)}>{st.label}</span>
                        </div>
                        {it.detail && <div className="mono mt-1.5 pl-[18px] text-[10.5px] leading-relaxed text-muted-2">{it.detail}</div>}
                        {it.evidence && <div className="mono mt-1 pl-[18px] text-[10px] text-accent">{String(it.evidence).replace(/^.*\/apps\//, 'apps/').slice(0, 90)}</div>}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {state.items.length === 0 && <div className="mono text-[12px] text-muted-2">{running ? 'starting…' : 'no items'}</div>}
              </div>
            </>
          )}
        </div>

        {/* thinking + summary rail */}
        <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
          <div className="min-h-0 flex-1 overflow-y-auto p-[16px_18px]">
            <Label className="mb-3">Thinking</Label>
            <div className="flex flex-col gap-2">
              {state.thoughts.map((t, i) => <p key={i} className="text-[12px] leading-relaxed text-muted"><span className="mr-1.5 text-accent/60">›</span>{t}</p>)}
            </div>
          </div>
          <div className="border-t border-line p-[14px_18px]">
            <div className="mono text-[9.5px] leading-[1.7] text-muted-2">
              This run is recorded — its items, inputs and results are saved so you can reference or replay it later.
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
