import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import { Label, PrimaryBtn, GhostBtn } from '../kit';
import type { Project } from '../Workspace';

const API = 'http://localhost:4000';

interface Flow {
  id: string; name: string; role: string; confidence: 'high' | 'medium' | 'low';
  steps: { intent: string }[]; reasoning?: string; userCorrected?: boolean; userNote?: string;
  description?: string; breaksIf?: string; businessValue?: 'critical' | 'important' | 'minor';
}

const CONF_PCT: Record<string, number> = { high: 92, medium: 64, low: 38 };
const CONF_COLOR: Record<string, string> = { high: 'text-expected', medium: 'text-amber', low: 'text-unverified' };
const CONF_BAR: Record<string, string> = { high: 'bg-expected', medium: 'bg-amber', low: 'bg-unverified' };

export function ValidateScreen({ project, onDone, onContinueExploring }: { project: Project; onDone: () => void; onContinueExploring: () => void }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [freeFix, setFreeFix] = useState('');
  const [saving, setSaving] = useState(false);
  const resuming = false;

  // "continue exploring" → hand control to the Workspace, which switches to the CRAWL screen in resume mode. The
  // crawl screen itself fires /continue-crawl and streams it live — so the user WATCHES it pick up where it left
  // off (the fix for "it took me to Project instead of continuing the map").
  function continueExploring() { onContinueExploring(); }

  useEffect(() => {
    fetch(`${API}/api/projects/${project.id}/map`).then((r) => (r.ok ? r.json() : null)).then((m) => {
      const fs: Flow[] = m?.flows || [];
      setFlows(fs);
      // pre-select the lowest-confidence flow — the one most in need of correction
      const sorted = [...fs].sort((a, b) => ord(a.confidence) - ord(b.confidence));
      setSelId(sorted[0]?.id || null);
    }).catch(() => {});
  }, [project]);

  const sorted = [...flows].sort((a, b) => ord(a.confidence) - ord(b.confidence));
  const sel = flows.find((f) => f.id === selId);
  const correctedCount = flows.filter((f) => f.userCorrected).length;
  const needReview = flows.filter((f) => f.confidence !== 'high' && !f.userCorrected).length;

  async function correct(patch: { note?: string; name?: string; confidence?: string }) {
    if (!sel) return;
    const res = await fetch(`${API}/api/projects/${project.id}/map/flow/${sel.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setFlows((fs) => fs.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)));
    }
    setFreeFix('');
  }

  // A3: save THIS flow's state then auto-advance to the next flow still needing review; when none remain,
  // the footer becomes "Save project" (onDone).
  function saveFlowAndContinue() {
    if (!sel) return;
    // mark handled if untouched (leaving a high-confidence flow as-is is a valid "accept")
    const next = sorted.find((f) => f.id !== sel.id && f.confidence !== 'high' && !f.userCorrected);
    if (next) setSelId(next.id);
  }
  const allHandled = flows.every((f) => f.confidence === 'high' || f.userCorrected);

  return (
    <div className="flex h-full min-h-0">
      {/* left rail — flows sorted by confidence */}
      <div className="flex w-[380px] flex-none flex-col border-r border-line">
        <div className="p-[16px_18px_12px]">
          <div className="mb-1 text-[13px] font-medium">{flows.length} flows mapped</div>
          <div className="text-[11.5px] leading-[1.5] text-muted-2 text-pretty">Sorted by confidence. Correct the ones below the floor; leave the rest.</div>
        </div>
        <div className="flex-1 overflow-y-auto pb-3">
          {sorted.map((f) => (
            <button key={f.id} onClick={() => setSelId(f.id)}
              className={clsx('block w-full border-l-2 px-[18px] py-3 text-left transition-colors',
                selId === f.id ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-[oklch(1_0_0_/_0.02)]')}>
              <div className="flex w-full items-center gap-2.5">
                <span className={clsx('mono text-[11px] tabular font-medium', CONF_COLOR[f.confidence])}>{CONF_PCT[f.confidence]}%</span>
                <span className="flex-1 text-left text-[12.5px] font-medium">{f.name}</span>
                <span className={clsx('h-1.5 w-1.5 rounded-full', f.userCorrected ? 'bg-expected' : f.confidence === 'high' ? 'bg-muted-3' : 'bg-amber')} />
              </div>
              <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-[oklch(1_0_0_/_0.08)]">
                <div className={clsx('h-full rounded-full', f.userCorrected ? 'bg-expected' : CONF_BAR[f.confidence])} style={{ width: `${f.userCorrected ? 100 : CONF_PCT[f.confidence]}%` }} />
              </div>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line p-[14px_18px]">
          <div className="mono flex-1 text-[9.5px] leading-[1.6] text-muted-2">
            {correctedCount} corrected · {needReview} still under the floor
          </div>
          <button onClick={continueExploring} disabled={resuming}
            className="mono whitespace-nowrap rounded-[5px] border border-line-strong px-3 py-2.5 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-50">
            {resuming ? 'resuming…' : '↻ continue exploring'}
          </button>
          {allHandled ? (
            <PrimaryBtn onClick={async () => { setSaving(true); await new Promise((r) => setTimeout(r, 300)); onDone(); }} className="whitespace-nowrap px-3.5 py-2.5 text-[12.5px]">
              {saving ? 'Saving…' : 'Save project →'}
            </PrimaryBtn>
          ) : (
            <button onClick={saveFlowAndContinue} className="whitespace-nowrap rounded-[5px] bg-accent px-3.5 py-2.5 text-[12.5px] font-semibold text-accent-ink hover:brightness-110">
              Save flow · next →
            </button>
          )}
        </div>
      </div>

      {/* right pane — the selected flow */}
      <div className="min-w-0 flex-1 overflow-y-auto p-[32px_36px]">
        {!sel ? (
          <div className="mono text-[12px] text-muted-2">No flows to validate — run the crawl first.</div>
        ) : (
          <div className="max-w-[640px]">
            <span className={clsx('mono inline-block rounded-[3px] px-2 py-0.5 text-[9px] tracking-[0.1em]',
              sel.userCorrected ? 'bg-[oklch(0.80_0.14_150_/_0.12)] text-expected' : sel.confidence === 'low' ? 'bg-[oklch(0.66_0.012_264_/_0.12)] text-unverified' : 'bg-accent-soft text-amber')}>
              {sel.userCorrected ? 'CORRECTED · YOU VOUCHED' : `${sel.confidence.toUpperCase()} CONFIDENCE`}
            </span>
            <h1 className="m-0 mb-2 mt-3.5 text-[27px] font-medium tracking-tight2">{sel.name}</h1>
            <div className="mono flex items-center gap-2 text-[11px] text-muted-2">
              <span>{sel.role} · {sel.steps.length} steps</span>
              {sel.businessValue && (
                <span className={clsx('rounded-[3px] px-1.5 py-0.5 text-[9px] tracking-[0.08em]',
                  sel.businessValue === 'critical' ? 'bg-[oklch(0.70_0.18_24_/_0.15)] text-realbug' : sel.businessValue === 'important' ? 'bg-[oklch(0.84_0.14_80_/_0.15)] text-amber' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>
                  {sel.businessValue.toUpperCase()}
                </span>
              )}
            </div>

            {/* WHAT THIS FLOW DOES — the rich, descriptive account of the feature (not a generic line) */}
            {sel.description && (
              <div className="mt-6 rounded-[6px] border border-accent-line bg-accent-soft p-[16px_18px]">
                <Label accent className="mb-2.5">What this flow does</Label>
                <div className="text-[14px] leading-[1.65] text-ink text-pretty">{sel.description}</div>
                {sel.breaksIf && (
                  <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
                    <span className="mono mt-0.5 flex-none rounded-[3px] bg-[oklch(0.70_0.18_24_/_0.12)] px-1.5 py-0.5 text-[9px] text-realbug">BREAKS IF</span>
                    <span className="text-[12.5px] leading-[1.55] text-muted text-pretty">{sel.breaksIf}</span>
                  </div>
                )}
              </div>
            )}

            {/* why unsure */}
            <div className="mt-7 rounded-[6px] border border-line bg-surface p-[16px_18px]">
              <Label className="mb-2.5">Why Xsion {sel.confidence === 'high' ? 'is confident' : 'is unsure'}</Label>
              <div className="text-[13.5px] leading-[1.6] text-ink text-pretty">
                {sel.reasoning || (sel.confidence === 'high'
                  ? 'The observed pages and the code both confirm this flow directly.'
                  : 'Inferred from the observed surface — the code did not fully confirm every step, so Xsion held the confidence down rather than overclaim.')}
              </div>
            </div>

            {/* observed evidence — the flow's steps as what Xsion saw */}
            <div className="mt-6">
              <Label className="mb-3">Observed evidence</Label>
              <div className="flex flex-col">
                {sel.steps.slice(0, 6).map((s, i) => (
                  <div key={i} className="flex items-baseline gap-3 border-t border-line py-2.5">
                    <span className="mono rounded-[3px] bg-[oklch(1_0_0_/_0.06)] px-1.5 py-0.5 text-[9px] text-muted-2">STEP {i + 1}</span>
                    <span className="mono flex-1 text-[11.5px] text-muted text-pretty">{s.intent}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* correct it — REAL, persists to the map */}
            {!sel.userCorrected ? (
              <div className="mt-7">
                <Label accent className="mb-3">Correct it</Label>
                <div className="flex flex-col gap-1.5">
                  <FixBtn onClick={() => correct({ confidence: 'high', note: 'Confirmed correct by user' })}>This flow is right — vouch for it (→ high confidence)</FixBtn>
                  <FixBtn onClick={() => correct({ confidence: 'low', note: 'User flagged: not a real flow' })}>This isn't a real flow — drop its confidence</FixBtn>
                </div>
                <div className="mt-3.5 flex gap-2">
                  <input value={freeFix} onChange={(e) => setFreeFix(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && freeFix.trim()) correct({ note: freeFix.trim(), confidence: 'high' }); }}
                    placeholder="or describe the real flow…"
                    className="flex-1 rounded-[5px] border border-line bg-surface-2 px-3 py-[11px] text-[12.5px] text-ink outline-none placeholder:text-muted-2 focus:border-accent-line" />
                  <GhostBtn onClick={() => freeFix.trim() && correct({ note: freeFix.trim(), confidence: 'high' })}>Apply</GhostBtn>
                </div>
              </div>
            ) : (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                className="mt-7 rounded-[6px] border border-[oklch(0.80_0.14_150_/_0.30)] bg-[oklch(0.80_0.14_150_/_0.10)] p-[16px_18px]">
                <Label className="mb-2 text-expected">Correction saved</Label>
                <div className="text-[13px] leading-[1.6] text-ink">
                  {sel.userNote ? `"${sel.userNote}" — ` : ''}saved to the map and confidence set to high. In a full re-map, Xsion re-crawls this flow only, not the app.
                </div>
              </motion.div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ord(c: string) { return c === 'low' ? 0 : c === 'medium' ? 1 : 2; }
function FixBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="rounded-[5px] border border-line bg-transparent px-3.5 py-3 text-left text-[12.5px] text-ink transition-colors hover:border-accent-line hover:bg-accent-soft">
      {children}
    </button>
  );
}
