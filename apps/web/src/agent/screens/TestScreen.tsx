import { useState } from 'react';
import { clsx } from 'clsx';
import { Label, PrimaryBtn } from '../kit';
import { MissionControl } from '../MissionControl';
import { TestRunView, type TestSpec } from './TestRunView';
import { AuditView } from './AuditView';
import { BreakItView } from './BreakItView';
import { BugReproView } from './BugReproView';
import { MissionView } from './MissionView';
import { SoaPlanView } from './SoaPlanView';
import type { Project } from '../Workspace';


const TESTS = [
  { id: 'regression', name: 'Complete regression', badge: 'ALL FLOWS', wired: true, mission: true, desc: 'Run every mapped flow against the live app and verify each step against the code. The fastest way to know the whole app still behaves as its source says it should.', facts: [['Scope', 'all high-confidence flows'], ['Oracle', 'the code'], ['Output', 'code-cited verdict per step']] },
  { id: 'flow', name: 'Test one flow', badge: 'DEEP', wired: true, mission: true, desc: 'Pick a single flow and watch Xsion drive it end-to-end on the live site, then triage each step: expected, flaky selector, or a real bug — with the code line that proves it.', facts: [['Scope', 'one flow'], ['Oracle', 'the code'], ['Output', 'live run + verdicts']] },
  { id: 'api', name: 'API testing', badge: 'CONTRACT', wired: true, path: 'test/api', desc: 'Replay the endpoints recorded during the crawl, assert status and response shape, and flag 4xx/5xx and drift. Mechanically checkable — no oracle needed. Mutating calls (POST/PUT/DELETE) are skipped by default so nothing on the live app changes.', facts: [['Scope', 'recorded endpoints'], ['Oracle', 'mechanical (status + shape)'], ['Output', 'per-endpoint result, recorded']] },
  { id: 'fe-api', name: 'FE → API matching', badge: 'WIRING', wired: true, path: 'test/fe-api', desc: 'Does a UI action fire the API the code says it should? Xsion reads the code, compares against what the crawl observed, and classifies each action: match, mismatch, or unverifiable.', facts: [['Scope', 'flow × observed API'], ['Oracle', 'the code'], ['Output', 'match / mismatch / unverifiable']] },
  { id: 'generate', name: 'Generate test cases', badge: 'AUTHOR', wired: true, path: 'test/generate', desc: 'Xsion reads a flow and writes runnable test cases from it — the happy path plus the edge cases the code implies. This produces an artifact (a saved spec), not a pass/fail run.', facts: [['Scope', 'one flow'], ['Oracle', 'the code'], ['Output', 'test-case spec, recorded']] },
  { id: 'security', name: 'Security audit', badge: 'AUDIT', wired: true, audit: true, desc: 'Xsion reads your security-relevant code — auth guards, session config, validators — and runs code-grounded checks against the live app: access-control holes, insecure cookies, injection-shape, CORS, secrets. Every finding is cited to the code line that proves it and recorded as a reproducible probe. Exploit tiers require your authorization.', facts: [['Scope', 'auth · session · input · CORS · secrets'], ['Oracle', 'the code'], ['Output', 'code-cited, reproducible finding']] },
  { id: 'env-matrix', name: 'Environment matrix', badge: 'CONDITIONS', wired: true, path: 'test/env-matrix', desc: 'Runs a mapped flow under real conditions — desktop & mobile viewports, slow-3G throttle + latency, offline, and SESSION EXPIRY (clears the session mid-flow and asserts the app bounces to auth). Each condition is a genuine Playwright run against the live app; a condition that can’t be judged is reported as needs-review, never a silent pass.', facts: [['Scope', 'device · network · offline · session'], ['Oracle', 'observed behavior'], ['Output', 'per-condition verdict']] },
  { id: 'break-it', name: 'Break it', badge: 'ADVERSARIAL', wired: true, breakit: true, desc: 'Not a replay — Xsion TRIES TO BREAK the feature like a real QA engineer. SoA plans happy-path → full CRUD lifecycle → adversarial attacks (empty/boundary/wrong-type inputs, out-of-order, duplicates, double-submit) → API probing, each attack with an oracle declared BEFORE it runs. A “broke” finding requires a mechanically-observed fact (a 500, a console exception, or the app accepting invalid data); a validation error shown is “held”. It only ever mutates its own tagged test data and cleans up after itself.', facts: [['Scope', 'happy · CRUD · adversarial · API'], ['Oracle', 'pre-declared (held vs broke)'], ['Output', 'oracle-matched, code-cited finding']] },
  { id: 'bug-repro', name: 'Replicate a bug', badge: 'REPLICATE', wired: true, bugrepro: true, desc: 'Paste a QA bug ticket — Xsion turns it into concrete steps, runs them on the live app, and tells you honestly: does it still reproduce, is it fixed, or could it not perform the interaction (a native drag-drop, a gesture). With the repo attached it cross-checks the code, and it never flattens the ticket’s own uncertainty into a false verdict.', facts: [['Input', 'a QA bug ticket'], ['Verdict', 'reproduced · fixed · can’t-perform'], ['Cross-check', 'the code (Mode 1)']] },
];

const SPECS: Record<string, TestSpec> = {
  api: { id: 'api', name: 'API testing', path: 'test/api', body: (_pid, _repo) => ({}) },
  'fe-api': { id: 'fe-api', name: 'FE → API matching', path: 'test/fe-api', body: (_pid, repo) => ({ repo }) },
  generate: { id: 'generate', name: 'Generate test cases', path: 'test/generate', body: (_pid, repo) => ({ repo }) },
  'env-matrix': { id: 'env-matrix', name: 'Environment matrix', path: 'test/env-matrix', body: () => ({}) },
};

export function TestScreen({ project, repo, codeAvailable, onRunning }: { project: Project; repo: string; codeAvailable: boolean; onRunning: (b: boolean) => void }) {
  const [sel, setSel] = useState(TESTS[0]);
  const [showPromptAgent, setShowPromptAgent] = useState(false);
  const [showMission, setShowMission] = useState(false);
  const [runSpec, setRunSpec] = useState<TestSpec | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [showBreakIt, setShowBreakIt] = useState(false);
  const [showBugRepro, setShowBugRepro] = useState(false);
  const [showPlan, setShowPlan] = useState(false);

  // launch the test type an approved SoA proposal maps to
  const launchType = (type: string) => {
    onRunning(true); setShowPlan(false);
    if (type === 'flow') setShowMission(true);
    else if (type === 'security') setShowAudit(true);
    else if (SPECS[type]) setRunSpec(SPECS[type]);
    else setShowMission(true);
  };

  if (showPromptAgent) {
    return <MissionView projectId={project.id} repo={repo} onBack={() => { setShowPromptAgent(false); onRunning(false); }} />;
  }
  if (showMission) {
    return <div className="h-full overflow-y-auto"><MissionControl projectId={project.id} /></div>;
  }
  if (showPlan) {
    return <SoaPlanView projectId={project.id} repo={repo} onRun={launchType} onBack={() => { setShowPlan(false); onRunning(false); }} />;
  }
  if (showAudit) {
    return <AuditView projectId={project.id} repo={repo} baseUrl={project.baseUrl} onBack={() => { setShowAudit(false); onRunning(false); }} />;
  }
  if (showBreakIt) {
    return <BreakItView projectId={project.id} repo={repo} onBack={() => { setShowBreakIt(false); onRunning(false); }} />;
  }
  if (showBugRepro) {
    return <BugReproView projectId={project.id} repo={repo} onBack={() => { setShowBugRepro(false); onRunning(false); }} />;
  }
  if (runSpec) {
    return <TestRunView spec={runSpec} projectId={project.id} repo={repo} onBack={() => { setRunSpec(null); onRunning(false); }} />;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* the menu */}
      <div className="w-[400px] flex-none overflow-y-auto border-r border-line p-[22px_18px]">
        {/* THE PROMPT-AGENT — the flagship. Type a mission, SoA routes it to the engines. */}
        <button onClick={() => { onRunning(true); setShowPromptAgent(true); }}
          className="mb-3 w-full rounded-[7px] border border-accent-line bg-gradient-to-br from-accent-soft to-[oklch(0.86_0.19_122_/_0.05)] p-4 text-left transition-colors hover:from-[oklch(0.86_0.19_122_/_0.16)]">
          <div className="flex items-center gap-2">
            <span className="mono rounded-[3px] bg-accent px-1.5 py-0.5 text-[9px] tracking-[0.1em] text-paper">AGENT</span>
            <span className="text-[13.5px] font-medium text-ink">Just tell Xsion what to test</span>
            <span className="mono ml-auto text-[9px] tracking-[0.1em] text-accent">→</span>
          </div>
          <div className="mono mt-1.5 text-[9.5px] leading-[1.5] text-muted-2">Type the mission in plain English — SoA reads your intent and routes it to break-it, bug-repro, API, security, environment. The prompt is the product.</div>
        </button>

        {/* SOA-STEER entry — let the brain decide what to test, then approve per proposal */}
        <button onClick={() => { onRunning(true); setShowPlan(true); }}
          className="mb-4 w-full rounded-[6px] border border-accent-line bg-accent-soft p-3.5 text-left transition-colors hover:bg-[oklch(0.86_0.19_122_/_0.12)]">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">Ask SoA what to test</span>
            <span className="mono ml-auto text-[9px] tracking-[0.1em] text-accent">SOA-DRIVEN →</span>
          </div>
          <div className="mono mt-1 text-[9.5px] leading-[1.5] text-muted-2">SoA reads the app + code and proposes a prioritized plan you approve per item.</div>
        </button>
        <Label className="mb-3.5">Or pick a test yourself</Label>
        <div className="flex flex-col gap-1.5">
          {TESTS.map((t) => {
            // an engine whose ORACLE is "the code" can't run on a URL-only project — mark it, don't fail after a click.
            const needsCode = t.facts?.some(([k, v]) => k === 'Oracle' && /code/i.test(String(v)));
            const unavailable = needsCode && !codeAvailable;
            return (
              <button key={t.id} onClick={() => { if (!unavailable) setSel(t); }} disabled={unavailable}
                title={unavailable ? 'This test needs the codebase — this project was crawled URL-only.' : undefined}
                className={clsx('rounded-[5px] border px-3.5 py-3 text-left transition-colors',
                  unavailable ? 'border-line opacity-40 cursor-not-allowed' : sel.id === t.id ? 'border-accent-line bg-accent-soft' : 'border-line hover:border-line-strong')}>
                <div className="flex w-full items-center gap-2.5">
                  <span className="flex-1 text-[13px] font-medium">{t.name}</span>
                  <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px] tracking-[0.08em]', t.wired ? 'bg-accent-soft text-accent' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{t.badge}</span>
                </div>
                <div className="mono mt-1.5 w-full text-left text-[9.5px] text-muted-2">{unavailable ? 'needs the codebase — crawled URL-only' : t.wired ? 'ready to run' : 'not yet wired'}</div>
              </button>
            );
          })}
        </div>

        <Label className="mb-3.5 mt-[26px]">Out of scope</Label>
        <div className="rounded-[5px] border border-dashed border-line-strong p-3.5">
          <div className="mb-[7px] flex items-center gap-2.5">
            <span className="flex-1 text-[12.5px] text-muted-2">Volumetric / DDoS load-testing</span>
            <span className="mono rounded-[3px] bg-[oklch(1_0_0_/_0.06)] px-1.5 py-0.5 text-[9px] tracking-[0.1em] text-muted-2">USE A LOAD-TESTER</span>
          </div>
          <div className="text-[11.5px] leading-[1.6] text-muted-3 text-pretty">Flooding can’t be contained to a single target at the packet layer, so it stays out of the app-layer audit. To load-test your own infra, point a dedicated tool (k6, Locust) at your staging with rate controls you own.</div>
        </div>
      </div>

      {/* the detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-9">
        <div className="max-w-[560px]">
          <span className={clsx('mono inline-block rounded-[3px] px-2 py-0.5 text-[9px] tracking-[0.1em]', sel.wired ? 'bg-accent-soft text-accent' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{sel.badge}</span>
          <h1 className="m-0 mb-3 mt-3.5 text-[30px] font-medium tracking-tight2 text-balance">{sel.name}</h1>
          <p className="m-0 mb-[26px] text-[14px] leading-[1.65] text-muted text-pretty">{sel.desc}</p>
          <div className="mb-7 flex flex-col">
            {sel.facts.map(([k, v], i) => (
              <div key={k} className={clsx('flex justify-between gap-4 border-t border-line py-2.5 text-[12.5px]', i === sel.facts.length - 1 && 'border-b')}>
                <span className="text-muted-2">{k}</span><span className="mono text-[11px] text-ink">{v}</span>
              </div>
            ))}
          </div>
          <PrimaryBtn onClick={() => {
            onRunning(true);
            if ((sel as any).mission) setShowMission(true);
            else if ((sel as any).audit) setShowAudit(true);
            else if ((sel as any).breakit) setShowBreakIt(true);
            else if ((sel as any).bugrepro) setShowBugRepro(true);
            else setRunSpec(SPECS[sel.id]);
          }}>Run {sel.name.toLowerCase()} →</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}
