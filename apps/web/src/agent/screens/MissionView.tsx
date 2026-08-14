import { useState } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTestRun } from '../useTestRun';
import { Label, PrimaryBtn } from '../kit';

const ENGINE_ICON: Record<string, string> = { 'break-it': 'ADVERSARIAL', 'bug-repro': 'REPLICATE', api: 'API', audit: 'SECURITY', 'env-matrix': 'CONDITIONS', flow: 'FLOW' };
const outcomeTone = (o?: string) => !o ? 'text-muted-2' : /broke|vulnerable|fail|reproduced/.test(o) ? 'text-realbug' : /held|clean|passed|not-reproduced|all conditions/.test(o) ? 'text-expected' : /can.?t|review|timed/.test(o) ? 'text-amber' : 'text-muted';

/** The prompt-agent: type a mission → SoA routes it to the right engines → runs them in order → unified report. */
export function MissionView({ projectId, repo, onBack }: { projectId: string; repo: string; onBack: () => void }) {
  const { state, runId, start } = useTestRun();
  const [mission, setMission] = useState('');
  const [started, setStarted] = useState(false);
  const running = started && state.phase !== 'done';

  function run() { if (mission.trim().length < 4) return; setStarted(true); start('mission', { projectId, mission, repo }); }

  if (!started) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header onBack={onBack} running={false} runId={null} />
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="max-w-[680px]">
            <span className="mono inline-block rounded-[3px] bg-accent-soft px-2 py-0.5 text-[9px] tracking-[0.1em] text-accent">AGENT</span>
            <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2">Just tell Xsion what to test.</h1>
            <p className="m-0 mb-6 text-[14px] leading-[1.65] text-muted text-pretty">
              Describe the mission in plain English. Xsion reads your intent, decides which tests to run — break-it, bug-replication, API, security, environment — and runs them in order, streaming a single report.
            </p>
            <Label className="mb-2">The mission</Label>
            <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={4}
              placeholder={'e.g. Log in, test the create-event flow and its full CRUD + calendar view, and API-test the relevant endpoints.'}
              className="mono mb-4 w-full resize-y rounded-[6px] border border-line bg-paper p-3.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent" />
            <div className="mb-5 flex flex-wrap gap-1.5">
              {['Test the create-event flow and its CRUD', 'Security-audit the app', 'Test the notification feature on mobile and slow network'].map((ex) => (
                <button key={ex} onClick={() => setMission(ex)} className="mono rounded-full border border-line px-2.5 py-1 text-[10px] text-muted-2 hover:border-accent hover:text-accent">{ex}</button>
              ))}
            </div>
            <PrimaryBtn onClick={run} disabled={mission.trim().length < 4}>Run the mission →</PrimaryBtn>
            <div className="mono mt-4 text-[10px] leading-[1.7] text-muted-3 text-pretty">SoA routes your words to the engines and runs each in sequence — it reports what each engine actually observed, never an invented outcome.</div>
          </div>
        </div>
      </div>
    );
  }

  const m = state.mission;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header onBack={onBack} running={running} runId={runId} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="min-h-0 overflow-y-auto p-[22px_28px]">
          {m?.summary && (
            <div className="mb-5 rounded-[7px] border border-accent-line bg-accent-soft p-4">
              <Label accent className="mb-1.5">Understood</Label>
              <div className="text-[13.5px] leading-[1.55] text-ink text-pretty">{m.summary}</div>
            </div>
          )}
          <Label className="mb-3">Plan</Label>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {(m?.steps || []).map((s) => (
                <motion.div key={s.index} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className={clsx('rounded-[7px] border p-3.5', s.status === 'running' ? 'border-accent-line bg-accent-soft/40' : 'border-line bg-surface')}>
                  <div className="flex items-center gap-2.5">
                    {s.status === 'running' ? <span className="h-2 w-2 rounded-full bg-accent anim-pulse" /> : s.status === 'done' ? <span className={clsx('h-2 w-2 rounded-full', /broke|vulnerable|fail|reproduced/.test(s.outcome || '') ? 'bg-realbug' : 'bg-expected')} /> : <span className="h-2 w-2 rounded-full bg-muted-3" />}
                    <span className="mono rounded-[3px] bg-[oklch(1_0_0_/_0.05)] px-1.5 py-0.5 text-[8.5px] tracking-[0.08em] text-muted-2">{ENGINE_ICON[s.engine] || s.engine}</span>
                    <span className="flex-1 text-[13px] font-medium">{s.label}</span>
                    {s.status === 'done' && <span className={clsx('mono text-[10.5px]', outcomeTone(s.outcome))}>{s.outcome}</span>}
                    {s.status === 'running' && <span className="mono text-[10px] text-accent">running…</span>}
                  </div>
                  {s.why && <div className="mono mt-1.5 pl-[26px] text-[10px] leading-[1.5] text-muted-2 text-pretty">{s.why}</div>}
                </motion.div>
              ))}
            </AnimatePresence>
            {(!m || m.steps.length === 0) && <div className="mono text-[12px] text-muted-2">{running ? 'SoA is reading your mission and planning…' : 'no plan'}</div>}
          </div>
        </div>
        <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
          <div className="min-h-0 flex-1 overflow-y-auto p-[16px_18px]">
            <Label className="mb-3">Agent</Label>
            <div className="flex flex-col gap-2">
              {state.thoughts.map((t, i) => <p key={i} className="text-[12px] leading-relaxed text-muted"><span className="mr-1.5 text-accent/60">›</span>{t}</p>)}
            </div>
          </div>
          <div className="border-t border-line p-[14px_18px]"><div className="mono text-[9.5px] leading-[1.7] text-muted-2">Each step runs a real engine and is recorded on its own — the report reflects what each engine actually observed.</div></div>
        </aside>
      </div>
    </div>
  );
}

function Header({ onBack, running, runId }: { onBack: () => void; running: boolean; runId: string | null }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-8 py-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
        <span className="h-3 w-px bg-line-strong" />
        <span className="text-[14px] font-medium">Mission</span>
        <span className={clsx('flex items-center gap-1.5 rounded-full border px-2 py-0.5 mono text-[9.5px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
          {running ? 'RUNNING' : 'READY'}
        </span>
      </div>
      {runId && <span className="mono text-[10px] text-muted-2">{runId.slice(0, 8)}</span>}
    </div>
  );
}
