import { useState } from 'react';
import { clsx } from 'clsx';
import { useSoaRun } from './useSoaRun';
import { PhaseRail } from './PhaseRail';
import { StepTimeline } from './StepTimeline';

const DEFAULTS = {
  projectId: '', // filled by picker
  repo: '/Users/raghavkundra/Desktop/Dev/dent/apps/admin-ui',
  baseUrl: 'https://admin.thedent.in',
  flowFile: '/tmp/dent_cached_plan.json',
};

const VERDICT_COLORS: Record<string, string> = { expected: 'text-expected', flaky_selector: 'text-flaky', unverified: 'text-unverified', real_bug: 'text-realbug' };
const VERDICT_LABELS: Record<string, string> = { expected: 'Expected', flaky_selector: 'Flaky', unverified: 'Unverified', real_bug: 'Real bug' };

export function MissionControl({ projectId }: { projectId: string }) {
  const { state, connected, start } = useSoaRun();
  const [repo, setRepo] = useState(DEFAULTS.repo);
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.baseUrl);
  const [flowIndex, setFlowIndex] = useState(1);
  const [launching, setLaunching] = useState(false);

  const running = state.phase !== 'idle' && state.phase !== 'done';
  const passed = state.steps.filter((s) => s.status === 'pass').length;
  const total = state.steps.length;

  async function launch() {
    setLaunching(true);
    await start({ projectId, repo, baseUrl, flowIndex, flowFile: DEFAULTS.flowFile });
    setLaunching(false);
  }

  return (
    <div className="relative min-h-screen bg-paper text-ink">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-grid opacity-60" />

      <div className="relative mx-auto max-w-[1180px] px-6 py-8">
        {/* ── header ── */}
        <header className="mb-7 flex items-start justify-between gap-6">
          <div>
            <div className="mb-2 flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white shadow-glow">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 6 6 .9-4.5 4.2L18 20l-6-3.2L6 20l1.5-6.9L3 8.9 9 8z" fill="currentColor"/></svg>
              </div>
              <span className="font-display text-lg font-semibold tracking-tight">Xsion</span>
              <span className="ml-1 rounded-full border border-line bg-surface-2/60 px-2 py-0.5 font-mono text-[10px] text-muted">AI QA agent</span>
            </div>
            <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Watch the agent test your app.
            </h1>
            <p className="mt-1 max-w-[54ch] text-[13.5px] leading-relaxed text-muted">
              Xsion reads your code, drives the live UI like a user, and judges every finding against the
              source — telling a real bug from a flaky test, with the code line that proves it.
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-expected' : 'bg-muted-2')} />
            {connected ? 'live' : 'idle'}
          </div>
        </header>

        {/* ── launch bar ── */}
        <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl2 border border-line bg-surface p-4 shadow-panel">
          <Field label="Deployed URL" className="min-w-[220px] flex-1">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="input" spellCheck={false} />
          </Field>
          <Field label="Code (repo path)" className="min-w-[280px] flex-[1.4]">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} className="input font-mono text-[12px]" spellCheck={false} />
          </Field>
          <Field label="Flow #" className="w-[74px]">
            <input type="number" value={flowIndex} onChange={(e) => setFlowIndex(+e.target.value)} className="input tabular" />
          </Field>
          <button onClick={launch} disabled={running || launching}
            className={clsx('flex h-[38px] items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition-all',
              running || launching ? 'cursor-not-allowed bg-surface-2 text-muted-2' : 'bg-accent text-white hover:brightness-110 active:scale-[.98] shadow-glow')}>
            {running ? <><span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-scan" /> Running…</> : <>▸ Run agent</>}
          </button>
        </div>

        {/* ── phase rail ── */}
        <div className="mb-6 rounded-xl2 border border-line bg-surface px-4 py-3 shadow-panel">
          <PhaseRail phase={state.phase} label={state.phaseLabel} />
        </div>

        {/* ── main grid: live timeline + right rail ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_310px]">
          {/* timeline */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">
                {state.selectedFlow ? state.selectedFlow.name : 'Live run'}
                {state.selectedFlow && <span className="ml-2 font-sans text-[12px] font-normal text-muted-2">as {state.selectedFlow.role}</span>}
              </h2>
              {total > 0 && <span className="font-mono text-[12px] text-muted tabular">{passed}/{total} steps landed</span>}
            </div>
            {state.steps.length === 0 ? (
              <EmptyState running={running} logs={state.logs} />
            ) : (
              <StepTimeline steps={state.steps} />
            )}
          </div>

          {/* right rail */}
          <aside className="flex flex-col gap-4">
            <VerdictSummary done={state.done} steps={state.steps} />
            {state.flows.length > 0 && <FlowList flows={state.flows} activeIdx={flowIndex} />}
            {state.consoleErrors.length > 0 && <ConsolePanel errors={state.consoleErrors} />}
          </aside>
        </div>
      </div>

      <style>{`.input{width:100%;height:38px;border-radius:9px;border:1px solid var(--line);background:var(--paper);padding:0 11px;font-size:13px;color:var(--ink);outline:none;transition:border-color .15s}.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}`}</style>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({ running, logs }: { running: boolean; logs: { message: string }[] }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl2 border border-dashed border-line bg-surface/50 text-center">
      {running ? (
        <>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft"><span className="h-2.5 w-2.5 rounded-full bg-accent animate-ping" /></div>
          <p className="text-[13px] font-medium text-ink">The agent is thinking…</p>
          <p className="mt-1 max-w-[36ch] font-mono text-[11px] text-muted-2">{logs[logs.length - 1]?.message || 'reading the codebase to map the real user flows'}</p>
        </>
      ) : (
        <>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface"><span className="text-lg">▸</span></div>
          <p className="text-[13px] font-medium text-ink">Ready to run</p>
          <p className="mt-1 max-w-[38ch] text-[12px] text-muted">Point Xsion at your deployed URL and its code. It plans the flows, drives them live, and verifies every step.</p>
        </>
      )}
    </div>
  );
}

function VerdictSummary({ done, steps }: { done?: any; steps: any[] }) {
  const counts: Record<string, number> = done?.verdicts || steps.reduce((a, s) => { if (s.verdict) a[s.verdict] = (a[s.verdict] || 0) + 1; return a; }, {} as Record<string, number>);
  const order = ['real_bug', 'flaky_selector', 'unverified', 'expected'];
  const has = order.some((k) => counts[k]);
  return (
    <div className="rounded-xl2 border border-line bg-surface p-4 shadow-panel">
      <h3 className="mb-3 font-display text-[13px] font-semibold tracking-tight">Findings</h3>
      {!has ? (
        <p className="font-mono text-[11px] text-muted-2">verdicts appear here as the agent judges each step</p>
      ) : (
        <div className="flex flex-col gap-2">
          {order.filter((k) => counts[k]).map((k) => (
            <div key={k} className="flex items-center justify-between">
              <span className={clsx('flex items-center gap-2 text-[12.5px]', VERDICT_COLORS[k])}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} /> {VERDICT_LABELS[k]}
              </span>
              <span className="font-mono text-[13px] tabular text-ink">{counts[k]}</span>
            </div>
          ))}
          {done && (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-3 text-[12px]">
              <span className={clsx('h-1.5 w-1.5 rounded-full', done.flowCovered ? 'bg-expected' : 'bg-flaky')} />
              <span className="text-muted">Flow {done.flowCovered ? 'covered' : 'partial'} · {done.passed}/{done.total} landed</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FlowList({ flows, activeIdx }: { flows: any[]; activeIdx: number }) {
  return (
    <div className="rounded-xl2 border border-line bg-surface p-4 shadow-panel">
      <h3 className="mb-3 font-display text-[13px] font-semibold tracking-tight">Flows found in code</h3>
      <div className="flex flex-col gap-1">
        {flows.map((f) => (
          <div key={f.index} className={clsx('flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[12.5px]', f.index === activeIdx ? 'bg-accent-soft text-accent' : 'text-muted')}>
            <span className="truncate">{f.name}</span>
            <span className="ml-2 shrink-0 font-mono text-[10px] text-muted-2 tabular">{f.steps}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConsolePanel({ errors }: { errors: string[] }) {
  return (
    <div className="rounded-xl2 border border-realbug/30 bg-realbug/5 p-4">
      <h3 className="mb-2 flex items-center gap-2 font-display text-[13px] font-semibold text-realbug">
        <span className="h-1.5 w-1.5 rounded-full bg-realbug" /> Console errors ({errors.length})
      </h3>
      <div className="flex max-h-32 flex-col gap-1 overflow-auto">
        {errors.slice(-6).map((e, i) => <p key={i} className="font-mono text-[10.5px] leading-relaxed text-realbug/80">{e}</p>)}
      </div>
    </div>
  );
}
