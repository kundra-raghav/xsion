import { useState } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTestRun, type AuditFinding } from '../useTestRun';
import { Label, PrimaryBtn } from '../kit';

const API = 'http://localhost:4000';

const VERDICT: Record<string, { label: string; cls: string; dot: string; bg: string }> = {
  vulnerable: { label: 'vulnerable', cls: 'text-realbug', dot: 'bg-realbug', bg: 'border-[oklch(0.70_0.18_24_/_0.4)] bg-[oklch(0.70_0.18_24_/_0.06)]' },
  safe: { label: 'safe', cls: 'text-expected', dot: 'bg-expected', bg: 'border-line bg-surface' },
  'needs-review': { label: 'needs review', cls: 'text-unverified', dot: 'bg-unverified', bg: 'border-[oklch(0.66_0.012_264_/_0.3)] bg-surface' },
  skipped: { label: 'skipped', cls: 'text-muted-2', dot: 'bg-muted-3', bg: 'border-line bg-surface' },
};
const SEV: Record<string, string> = {
  critical: 'bg-[oklch(0.70_0.18_24_/_0.18)] text-realbug', high: 'bg-[oklch(0.72_0.16_40_/_0.15)] text-amber',
  medium: 'bg-[oklch(1_0_0_/_0.06)] text-muted', low: 'bg-[oklch(1_0_0_/_0.05)] text-muted-2',
};
const rel = (s?: string) => (s ? String(s).replace(/^.*\/(apps|src)\//, '$1/') : '');

/** The security-audit run view: consent gate → tier → live code-cited, reproducible findings. */
export function AuditView({ projectId, repo, baseUrl, onBack }: { projectId: string; repo: string; baseUrl: string; onBack: () => void }) {
  const { state, runId, start } = useTestRun();
  const [authorized, setAuthorized] = useState(false);
  const [tier, setTier] = useState<1 | 2 | 3>(1);
  const [destructiveAck, setDestructiveAck] = useState(false);
  const [started, setStarted] = useState(false);
  const running = started && !['idle', 'done'].includes(state.phase);

  async function run() {
    // record the per-project consent attestation before any probe fires
    if (tier >= 2 && authorized) {
      await fetch(`${API}/api/projects/${projectId}/security`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, allowDestructive: tier >= 3 }),
      }).catch(() => {});
    }
    setStarted(true);
    start('audit', { projectId, repo, baseUrl, tier, destructiveAck });
  }

  if (!started) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header onBack={onBack} running={false} phase="idle" done={undefined} runId={null} />
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="max-w-[620px]">
            <span className="mono inline-block rounded-[3px] bg-accent-soft px-2 py-0.5 text-[9px] tracking-[0.1em] text-accent">CODE-GROUNDED · MODE 1</span>
            <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2">Security audit</h1>
            <p className="m-0 mb-7 text-[14px] leading-[1.65] text-muted text-pretty">
              Xsion reads your security-relevant code — auth guards, session config, validators — and runs code-grounded checks against the live app. Every finding is cited to the code line that proves it and recorded as a reproducible probe you can replay to confirm a fix.
            </p>

            {/* the tiers */}
            <Label className="mb-3">Depth</Label>
            <div className="mb-6 flex flex-col gap-2">
              {[
                { t: 1 as const, name: 'Read + probe', desc: 'Safe, read-only observations. No exploit fired. Always available.' },
                { t: 2 as const, name: 'Proof of vulnerability', desc: 'Fires non-destructive, reproducible exploits (auth-bypass, IDOR, injection-shape). Needs your authorization.' },
                { t: 3 as const, name: 'Destructive', desc: 'Includes mutating probes. Needs authorization + a per-run acknowledgment.' },
              ].map((o) => (
                <button key={o.t} onClick={() => setTier(o.t)}
                  className={clsx('rounded-[6px] border px-4 py-3 text-left transition-colors', tier === o.t ? 'border-accent-line bg-accent-soft' : 'border-line hover:border-line-strong')}>
                  <div className="flex items-center gap-2.5">
                    <span className={clsx('flex h-4 w-4 items-center justify-center rounded-full border', tier === o.t ? 'border-accent' : 'border-line-strong')}>
                      {tier === o.t && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </span>
                    <span className="text-[13.5px] font-medium">{o.name}</span>
                    <span className="mono ml-auto text-[9px] tracking-[0.1em] text-muted-2">T{o.t}</span>
                  </div>
                  <div className="mt-1.5 pl-[26px] text-[11.5px] leading-[1.55] text-muted-2 text-pretty">{o.desc}</div>
                </button>
              ))}
            </div>

            {/* the consent gate — required for tier 2+ */}
            {tier >= 2 && (
              <div className="mb-6 rounded-[6px] border border-amber/40 bg-[oklch(0.84_0.14_80_/_0.05)] p-4">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5" />
                  <span className="text-[12.5px] leading-[1.55] text-ink text-pretty">
                    I own, or am explicitly authorized to security-test, <span className="mono text-amber">{baseUrl}</span>. I understand real probes will be fired against it.
                  </span>
                </label>
                {tier >= 3 && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 border-t border-line pt-3">
                    <input type="checkbox" checked={destructiveAck} onChange={(e) => setDestructiveAck(e.target.checked)} className="mt-0.5" />
                    <span className="text-[12.5px] leading-[1.55] text-realbug text-pretty">
                      I acknowledge this run may fire <b>destructive / mutating</b> probes that can change or delete data on the target.
                    </span>
                  </label>
                )}
              </div>
            )}

            <PrimaryBtn onClick={run} disabled={(tier >= 2 && !authorized) || (tier >= 3 && !destructiveAck)}>
              Run audit {tier > 1 ? `· tier ${tier}` : ''} →
            </PrimaryBtn>
            <div className="mono mt-4 text-[10px] leading-[1.7] text-muted-3 text-pretty">
              Volumetric / DDoS load-testing is out of scope by design — use a dedicated load-tester against your own staging. This is an application-layer audit; findings are code-cited and never reported as safe when inconclusive.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const counts = state.findings.reduce((a, f) => { a[f.verdict] = (a[f.verdict] || 0) + 1; return a; }, {} as Record<string, number>);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header onBack={onBack} running={running} phase={state.phase} done={state.done} runId={runId} counts={counts} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="min-h-0 overflow-y-auto p-[22px_28px]">
          <Label className="mb-4">Findings — code-cited &amp; reproducible</Label>
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {state.findings.map((f, i) => <FindingCard key={i} f={f} />)}
            </AnimatePresence>
            {state.findings.length === 0 && <div className="mono text-[12px] text-muted-2">{running ? 'reading the code…' : 'no findings'}</div>}
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
            <div className="mono text-[9.5px] leading-[1.7] text-muted-2">Every finding carries the code line that proves it and a curl you can replay. Inconclusive is never reported as safe.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function FindingCard({ f }: { f: AuditFinding }) {
  const [open, setOpen] = useState(f.verdict === 'vulnerable');
  const v = VERDICT[f.verdict] || VERDICT['needs-review'];
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={clsx('rounded-[7px] border', v.bg)}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className={clsx('mt-1 h-2 w-2 flex-none rounded-full', v.dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium">{f.title}</span>
            <span className={clsx('mono flex-none rounded-[3px] px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]', SEV[f.severity] || SEV.medium)}>{f.severity}</span>
          </div>
          <div className="mono mt-1 text-[10px] text-muted-2">{f.cls} · <span className={v.cls}>{v.label}</span> · <span className="text-accent">{rel(f.codeRef)}</span></div>
        </div>
        <span className="mono flex-none text-[10px] text-muted-3">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-4 py-3">
          <div className="mb-2.5 text-[12px] leading-[1.6] text-muted text-pretty">{f.detail}</div>
          {f.why && <div className="mb-2.5 text-[11.5px] leading-[1.55] text-muted-2 text-pretty"><span className="mono text-muted-3">why: </span>{f.why}</div>}
          {f.reproduce && (
            <div className="rounded-[5px] border border-line bg-paper p-2.5">
              <div className="mono mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-label text-muted-2">
                reproduce {f.reproduce.status !== undefined && <span className={clsx('rounded-[3px] px-1 py-0.5', f.reproduce.status >= 500 ? 'text-realbug' : f.reproduce.status >= 400 ? 'text-amber' : 'text-expected')}>HTTP {f.reproduce.status}</span>}
              </div>
              <pre className="mono overflow-x-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink">{f.reproduce.curl}</pre>
              {f.reproduce.responseSample && <pre className="mono mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap border-t border-line pt-1.5 text-[10px] leading-relaxed text-muted-2">{f.reproduce.responseSample}</pre>}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Header({ onBack, running, phase, done, runId, counts }: { onBack: () => void; running: boolean; phase: string; done: any; runId: string | null; counts?: Record<string, number> }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-8 py-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
        <span className="h-3 w-px bg-line-strong" />
        <span className="text-[14px] font-medium">Security audit</span>
        <span className={clsx('flex items-center gap-1.5 rounded-full border px-2 py-0.5 mono text-[9.5px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
          {running ? 'RUNNING' : phase === 'done' ? 'RECORDED' : 'READY'}
        </span>
      </div>
      {counts && (done || running) && (
        <div className="mono flex items-center gap-3 text-[11px]">
          {counts.vulnerable > 0 && <span className="text-realbug">{counts.vulnerable} vulnerable</span>}
          {counts.safe > 0 && <span className="text-expected">{counts.safe} safe</span>}
          {counts['needs-review'] > 0 && <span className="text-unverified">{counts['needs-review']} needs-review</span>}
          {runId && <span className="text-muted-2">· recorded {runId.slice(0, 8)}</span>}
        </div>
      )}
    </div>
  );
}
