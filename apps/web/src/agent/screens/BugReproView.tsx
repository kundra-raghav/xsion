import { useState } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTestRun } from '../useTestRun';
import { Label, PrimaryBtn } from '../kit';
import { TestBrowserStage } from '../TestBrowserStage';

const V: Record<string, { label: string; cls: string; bg: string }> = {
  reproduced: { label: 'reproduced', cls: 'text-realbug', bg: 'border-[oklch(0.70_0.18_24_/_0.4)] bg-[oklch(0.70_0.18_24_/_0.06)]' },
  'not-reproduced': { label: 'not reproduced', cls: 'text-expected', bg: 'border-[oklch(0.80_0.14_150_/_0.4)] bg-[oklch(0.80_0.14_150_/_0.05)]' },
  'cant-perform': { label: "couldn't perform", cls: 'text-amber', bg: 'border-amber/40 bg-[oklch(0.84_0.14_80_/_0.05)]' },
  inconclusive: { label: 'inconclusive', cls: 'text-unverified', bg: 'border-[oklch(0.66_0.012_264_/_0.3)] bg-surface' },
};
const rel = (s?: string | null) => (s ? String(s).replace(/^.*\/(apps|src)\//, '$1/') : '');

/** Bug replication: paste a QA ticket → Xsion reproduces the steps → honest verdict + code cross-check. */
const API = 'http://localhost:4000';

export function BugReproView({ projectId, repo, onBack }: { projectId: string; repo: string; onBack: () => void }) {
  const { state, runId, start } = useTestRun();
  const [ticket, setTicket] = useState('');
  const [started, setStarted] = useState(false);
  const [creds, setCreds] = useState({ email: '', password: '' });
  const [savingCreds, setSavingCreds] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const running = started && !['idle', 'done'].includes(state.phase);

  function run() { if (ticket.trim().length < 10) return; setStarted(true); start('test/bug-repro', { projectId, ticket, repo }); }

  // AUTHORIZE-AND-RE-RUN (the "approve button" the verdict's resolution asks for): grant this project consent to run
  // mutating steps on tagged test data, then immediately re-run the reproduction so it reaches a real verdict instead
  // of stopping at the skipped-mutating-step wall. This is the loop the backend's resolution.kind:'authorize' expects.
  async function authorizeAndRerun() {
    setAuthorizing(true);
    try {
      await fetch(`${API}/api/projects/${projectId}/security`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true }),
      });
      run();   // re-run — mutating steps now execute
    } finally { setAuthorizing(false); }
  }

  // The cred prompt: store creds (in-memory, server strips them from disk) then RE-RUN the reproduction — this time
  // it logs in first and actually reaches the feature, instead of testing the sign-in page.
  async function submitCreds() {
    if (!creds.email.trim() || !creds.password) return;
    setSavingCreds(true);
    try {
      await fetch(`${API}/api/projects/${projectId}/credentials`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: creds.email.trim(), password: creds.password }),
      });
      setCreds({ email: '', password: '' });   // don't keep them in component state longer than needed
      run();   // re-run — bug-repro now finds _defaultCreds and logs in first
    } finally { setSavingCreds(false); }
  }

  if (!started) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header onBack={onBack} running={false} verdict={undefined} runId={null} />
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="max-w-[680px]">
            <span className="mono inline-block rounded-[3px] bg-[oklch(0.72_0.14_200_/_0.14)] px-2 py-0.5 text-[9px] tracking-[0.1em] text-[oklch(0.72_0.14_200)]">REPLICATE</span>
            <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2">Replicate a bug.</h1>
            <p className="m-0 mb-6 text-[14px] leading-[1.65] text-muted text-pretty">
              Paste a QA bug ticket. Xsion turns it into concrete steps, runs them on the live app, and tells you honestly: does it still <span className="text-realbug">reproduce</span>, is it <span className="text-expected">fixed</span>, or could it <span className="text-amber">not perform</span> the interaction. With the repo attached it also cross-checks the code — and it never flattens the ticket's own uncertainty into a false verdict.
            </p>
            <Label className="mb-2">The bug ticket</Label>
            <textarea value={ticket} onChange={(e) => setTicket(e.target.value)} rows={12}
              placeholder={"Paste the ticket: title, Steps to Reproduce, Expected Behavior, Actual Behavior…"}
              className="mono mb-5 w-full resize-y rounded-[6px] border border-line bg-paper p-3.5 text-[12px] leading-relaxed text-ink outline-none focus:border-accent" />
            <PrimaryBtn onClick={run} disabled={ticket.trim().length < 10}>Reproduce the bug →</PrimaryBtn>
            <div className="mono mt-4 text-[10px] leading-[1.7] text-muted-3 text-pretty">If the ticket needs an interaction Xsion can't perform (some custom drag-drop, a native gesture), it says so — an honest “couldn't perform”, not a fake pass. Reproduced requires actually observing the buggy behavior.</div>
          </div>
        </div>
      </div>
    );
  }

  const b = state.bugReport;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header onBack={onBack} running={running} verdict={b?.verdict} runId={runId} />

      {/* CRED PROMPT — bug-repro paused because the reproduction needs a login and the project has no creds. */}
      <AnimatePresence>
        {state.needsCreds && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[oklch(0.14_0.01_264_/_0.72)] backdrop-blur-sm">
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }}
              className="w-[420px] rounded-[10px] border border-line-strong bg-surface p-6 shadow-2xl">
              <div className="mono mb-1 text-[9px] uppercase tracking-[0.12em] text-amber">Login needed</div>
              <h2 className="m-0 mb-2 text-[17px] font-medium tracking-tight2">Sign in to reproduce this bug</h2>
              <p className="m-0 mb-4 text-[12.5px] leading-[1.6] text-muted text-pretty">{state.needsCreds.message}</p>
              <div className="flex flex-col gap-2.5">
                <input autoFocus type="email" value={creds.email} onChange={(e) => setCreds((c) => ({ ...c, email: e.target.value }))}
                  placeholder="email" autoComplete="off"
                  className="mono w-full rounded-[6px] border border-line bg-paper px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent" />
                <input type="password" value={creds.password} onChange={(e) => setCreds((c) => ({ ...c, password: e.target.value }))}
                  placeholder="password" autoComplete="off"
                  onKeyDown={(e) => { if (e.key === 'Enter') submitCreds(); }}
                  className="mono w-full rounded-[6px] border border-line bg-paper px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent" />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <PrimaryBtn onClick={submitCreds} disabled={!creds.email.trim() || !creds.password || savingCreds}>
                  {savingCreds ? 'signing in…' : 'Sign in & reproduce →'}
                </PrimaryBtn>
                <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">cancel</button>
              </div>
              <div className="mono mt-3.5 flex items-center gap-1.5 text-[9.5px] leading-[1.6] text-muted-3">
                <span className="h-1 w-1 rounded-full bg-expected" />in-memory only · stripped from logs & disk · project-scoped
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="min-h-0 overflow-y-auto p-[22px_28px]">
          {/* LIVE VIEW — watch Xsion drive the repro steps on the live app */}
          {(running || state.live?.screenshot) && (
            <div className="mb-5">
              <div className="mb-2.5 flex items-center justify-between">
                <Label>{running ? 'Live — reproducing on the app' : 'Last frame'}</Label>
                {state.live?.path && <span className="mono text-[10px] text-accent">{state.live.path}</span>}
              </div>
              <TestBrowserStage state={state} running={running} />
            </div>
          )}
          {/* the verdict */}
          {b && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={clsx('mb-6 rounded-[8px] border p-5', (V[b.verdict] || V.inconclusive).bg)}>
              <div className="mb-2 flex items-center gap-2.5">
                <span className={clsx('mono text-[13px] font-semibold tracking-[0.02em]', (V[b.verdict] || V.inconclusive).cls)}>{(V[b.verdict] || V.inconclusive).label.toUpperCase()}</span>
                {b.codeRef && <span className="mono text-[10px] text-accent">{rel(b.codeRef)}</span>}
              </div>
              <div className="text-[13.5px] leading-[1.6] text-ink text-pretty">{b.detail}</div>
              <div className="mt-3.5 grid grid-cols-2 gap-2.5">
                <div className="rounded-[5px] border border-line bg-paper p-2.5"><div className="mono mb-1 text-[8.5px] uppercase tracking-label text-expected">expected</div><div className="text-[11.5px] text-muted-2">{b.expectedBehavior}</div></div>
                <div className="rounded-[5px] border border-line bg-paper p-2.5"><div className="mono mb-1 text-[8.5px] uppercase tracking-label text-realbug">reported</div><div className="text-[11.5px] text-muted-2">{b.actualBehavior}</div></div>
              </div>
              {b.codeAssessment && <div className="mono mt-2.5 text-[11px] text-muted-2">code cross-check: <span className={b.codeAssessment === 'matches-code' ? 'text-realbug' : b.codeAssessment === 'contradicts-code' ? 'text-expected' : 'text-unverified'}>{b.codeAssessment}</span></div>}
              {b.openQuestion && <div className="mono mt-2.5 rounded-[5px] border border-amber/40 bg-[oklch(0.84_0.14_80_/_0.06)] p-2.5 text-[11px] leading-[1.55] text-amber text-pretty">open question (from the ticket, preserved): {b.openQuestion}</div>}
              {/* THE NEXT ACTION — a non-terminal verdict must never be a dead end. The backend derives a resolution
                  (authorize / credentials / needs-input); surface it as a real button so the user can act and re-run. */}
              {b.resolution && <ResolutionAction resolution={b.resolution} authorizing={authorizing} onAuthorize={authorizeAndRerun} />}
            </motion.div>
          )}
          {/* the steps run */}
          <Label className="mb-3">Steps run</Label>
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {state.items.map((it) => (
                <motion.div key={it.index} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2.5 rounded-[5px] border border-line bg-surface px-3 py-2">
                  <span className={clsx('h-1.5 w-1.5 flex-none rounded-full', it.status === 'pass' ? 'bg-expected' : it.status === 'fail' ? 'bg-realbug' : it.status === 'running' ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
                  <span className="mono flex-1 truncate text-[11.5px] text-muted">{it.title}</span>
                  {it.detail && <span className="mono truncate text-[10px] text-muted-3" style={{ maxWidth: 200 }}>{it.detail}</span>}
                </motion.div>
              ))}
            </AnimatePresence>
            {state.items.length === 0 && <div className="mono text-[12px] text-muted-2">{running ? 'parsing the ticket into steps…' : 'no steps'}</div>}
          </div>
        </div>
        <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
          <div className="min-h-0 flex-1 overflow-y-auto p-[16px_18px]">
            <Label className="mb-3">Thinking</Label>
            <div className="flex flex-col gap-2">
              {state.thoughts.map((t, i) => <p key={i} className="text-[12px] leading-relaxed text-muted"><span className="mr-1.5 text-accent/60">›</span>{t}</p>)}
            </div>
          </div>
          <div className="border-t border-line p-[14px_18px]"><div className="mono text-[9.5px] leading-[1.7] text-muted-2">“Reproduced” means the buggy behavior was actually observed. An interaction Xsion can't perform is an honest “couldn't perform”, never a fake pass.</div></div>
        </aside>
      </div>
    </div>
  );
}

/** THE NEXT ACTION for a non-terminal bug-repro verdict — turns a dead-end verdict into a button the user can press.
 *  - authorize   → a real "Authorize & re-run" button (grants mutating consent, re-runs to a true verdict)
 *  - credentials → points to the sign-in prompt (which the cred modal already handles)
 *  - needs-input → surfaces the honest question (capability gap / which-control), no fake button
 *  - unreachable / none / file-ticket → informational (file-ticket = the bug reproduced; nothing to unblock) */
function ResolutionAction({ resolution, authorizing, onAuthorize }: {
  resolution: NonNullable<import('../useTestRun').BugReport['resolution']>;
  authorizing: boolean; onAuthorize: () => void;
}) {
  if (resolution.kind === 'file-ticket' || resolution.kind === 'none') return null;   // reproduced/fixed: no blocker
  if (resolution.kind === 'authorize') {
    return (
      <div className="mt-3.5 rounded-[6px] border border-amber/40 bg-[oklch(0.84_0.14_80_/_0.06)] p-3">
        <div className="mono mb-1.5 text-[9px] uppercase tracking-label text-amber">next: authorize</div>
        <div className="mb-2.5 text-[12px] leading-[1.55] text-muted text-pretty">{resolution.question}</div>
        <PrimaryBtn onClick={onAuthorize} disabled={authorizing}>{authorizing ? 'authorizing…' : 'Authorize & re-run →'}</PrimaryBtn>
        <div className="mono mt-2 text-[9.5px] leading-[1.6] text-muted-3">Runs mutating steps only on Xsion's own tagged test data. The safety gate still refuses hard-destructive controls (Delete/Send/Pay).</div>
      </div>
    );
  }
  // needs-input (incl. the drag-precision capability gap) + credentials + unreachable: surface the honest question.
  const label = resolution.kind === 'credentials' ? 'next: sign in' : resolution.kind === 'unreachable' ? 'blocked' : 'next: your input';
  return (
    <div className="mt-3.5 rounded-[6px] border border-line bg-paper p-3">
      <div className="mono mb-1.5 text-[9px] uppercase tracking-label text-muted-2">{label}</div>
      <div className="text-[12px] leading-[1.55] text-muted text-pretty">{resolution.question || (resolution.kind === 'credentials' ? 'Add credentials for this project and re-run.' : 'This one needs a human call before Xsion can go further.')}</div>
      {resolution.forStep && <div className="mono mt-1.5 text-[10.5px] text-muted-3">for the step: “{resolution.forStep}”</div>}
      {!!resolution.candidates?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {resolution.candidates.map((c, i) => <span key={i} className="mono rounded-[4px] border border-line bg-surface px-2 py-0.5 text-[10px] text-muted-2">{c}</span>)}
        </div>
      )}
    </div>
  );
}

function Header({ onBack, running, verdict, runId }: { onBack: () => void; running: boolean; verdict?: string; runId: string | null }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-8 py-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
        <span className="h-3 w-px bg-line-strong" />
        <span className="text-[14px] font-medium">Bug replication</span>
        <span className={clsx('flex items-center gap-1.5 rounded-full border px-2 py-0.5 mono text-[9.5px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
          {running ? 'REPRODUCING' : verdict ? (V[verdict] || V.inconclusive).label.toUpperCase() : 'READY'}
        </span>
      </div>
      {runId && <span className="mono text-[10px] text-muted-2">recorded {runId.slice(0, 8)}</span>}
    </div>
  );
}
