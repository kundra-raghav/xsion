import { useState } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { Label, PrimaryBtn } from '../kit';

const API = 'http://localhost:4000';

interface Proposal { type: string; title: string; why: string; priority: string; target: string; }

const TYPE_LABEL: Record<string, string> = {
  flow: 'Test one flow', api: 'API testing', 'fe-api': 'FE → API matching',
  generate: 'Generate cases', security: 'Security audit', 'env-matrix': 'Environment matrix',
};
const PRI: Record<string, string> = {
  P0: 'bg-[oklch(0.70_0.18_24_/_0.16)] text-realbug', P1: 'bg-[oklch(0.84_0.14_80_/_0.15)] text-amber', P2: 'bg-[oklch(1_0_0_/_0.06)] text-muted-2',
};

/** SOA-STEER: SoA reads the mapped app + code and proposes what's most worth testing; the operator approves each
 * proposal, which launches the matching test type. This is the "SoA decides, you steer" surface. */
export function SoaPlanView({ projectId, repo, onRun, onBack }: { projectId: string; repo: string; onRun: (type: string, target: string) => void; onBack: () => void }) {
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  async function ask() {
    setLoading(true); setError(null); setProposals(null);
    try {
      const res = await fetch(`${API}/api/projects/${projectId}/test-plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }),
      });
      const d = await res.json();
      if (d.error && !(d.proposals || []).length) setError(d.error);
      setProposals(d.proposals || []);
    } catch (e: any) { setError(String(e.message || e)); }
    setLoading(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-8 py-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="mono text-[11px] text-muted-2 hover:text-ink">← test menu</button>
          <span className="h-3 w-px bg-line-strong" />
          <span className="text-[14px] font-medium">What should we test?</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-9">
        {!proposals && !loading && (
          <div className="max-w-[560px]">
            <span className="mono inline-block rounded-[3px] bg-accent-soft px-2 py-0.5 text-[9px] tracking-[0.1em] text-accent">SOA-DRIVEN</span>
            <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2">Let SoA decide what to test.</h1>
            <p className="m-0 mb-7 text-[14px] leading-[1.65] text-muted text-pretty">
              SoA reads the mapped app and its code, thinks like a sharp QA lead, and proposes a prioritized plan — which flows are highest-risk, which fields could break, which security or environment conditions matter for <span className="mono">this</span> app. You approve each proposal; approved ones run.
            </p>
            <PrimaryBtn onClick={ask}>Ask SoA for a test plan →</PrimaryBtn>
            <div className="mono mt-4 text-[10px] text-muted-3">Reads the code + map (~1 minute). Nothing runs until you approve it.</div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-3 text-muted">
            <span className="h-2 w-2 rounded-full bg-accent anim-pulse" />
            <span className="mono text-[12px]">SoA is reading the app and its code, deciding what’s most worth testing…</span>
          </div>
        )}

        {error && <div className="mono max-w-[560px] rounded-[6px] border border-realbug/40 bg-[oklch(0.70_0.18_24_/_0.05)] p-4 text-[12px] text-realbug">{error}</div>}

        {proposals && proposals.length > 0 && (
          <>
            <Label className="mb-4">SoA’s plan — approve what to run</Label>
            <div className="flex max-w-[760px] flex-col gap-2.5">
              <AnimatePresence initial={false}>
                {proposals.map((p, i) => dismissed.has(i) ? null : (
                  <motion.div key={i} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                    className="rounded-[7px] border border-line bg-surface p-4">
                    <div className="mb-1.5 flex items-center gap-2.5">
                      <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px]', PRI[p.priority] || PRI.P2)}>{p.priority}</span>
                      <span className="text-[13.5px] font-medium">{p.title}</span>
                      <span className="mono ml-auto rounded-[3px] bg-[oklch(1_0_0_/_0.05)] px-1.5 py-0.5 text-[9px] text-muted-2">{TYPE_LABEL[p.type] || p.type}</span>
                    </div>
                    <div className="mb-3 text-[12px] leading-[1.55] text-muted-2 text-pretty">{p.why}</div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => onRun(p.type, p.target)} className="mono rounded-[5px] bg-accent px-3 py-1.5 text-[11px] font-medium text-[oklch(0.2_0.02_264)]">approve &amp; run →</button>
                      <button onClick={() => setDismissed((s) => new Set(s).add(i))} className="mono rounded-[5px] border border-line px-3 py-1.5 text-[11px] text-muted-2 hover:text-ink">dismiss</button>
                      {p.target && <span className="mono ml-1 text-[10px] text-muted-3">target: {p.target}</span>}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <button onClick={ask} className="mono mt-5 text-[11px] text-muted-2 hover:text-accent">↻ ask SoA again</button>
          </>
        )}

        {proposals && proposals.length === 0 && !error && (
          <div className="mono text-[12px] text-muted-2">SoA didn’t return proposals — the map may be too thin. Crawl more of the app first.</div>
        )}
      </div>
    </div>
  );
}
