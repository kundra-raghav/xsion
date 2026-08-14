import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Label, Dot } from './kit';
import { ProjectPicker } from './screens/ProjectPicker';
import { OnboardScreen } from './screens/OnboardScreen';
import { CrawlScreen } from './screens/CrawlScreen';
import { ValidateScreen } from './screens/ValidateScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { TestScreen } from './screens/TestScreen';
import { RunsScreen } from './screens/RunsScreen';

const API = 'http://localhost:4000';
export type Screen = 'onboard' | 'crawl' | 'validate' | 'project' | 'tests' | 'runs';
export interface Project { id: string; name: string; baseUrl: string; }

const NAV: { key: Screen; label: string; num: string }[] = [
  { key: 'onboard', label: 'Onboard', num: '01' },
  { key: 'crawl', label: 'Crawl & map', num: '02' },
  { key: 'validate', label: 'Validate', num: '03' },
  { key: 'project', label: 'Project', num: '04' },
  { key: 'tests', label: 'Test menu', num: '05' },
  { key: 'runs', label: 'Runs', num: '06' },
];

export function Workspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [screen, setScreen] = useState<Screen>('onboard');
  const [oracle, setOracle] = useState<'code' | 'url'>('code');
  const [hasMap, setHasMap] = useState(false);
  const [running, setRunning] = useState(false);
  const [crawlCfg, setCrawlCfg] = useState<{ url: string; repo?: string } | undefined>(undefined);
  const [resumeMode, setResumeMode] = useState(false);   // set when entering Crawl via "continue exploring"
  // THE PROJECT'S OWN repo/mode, from its crawl map — NOT a hardcoded default. A blackbox (URL-only) crawl has no
  // repo, so engines must NOT cross-check code (they were leaking a stale dent path → a schooltalk ticket "checked"
  // against dent's admin-ui → a manufactured "feature doesn't exist" open-question). `mapRepo` drives the engines.
  const [mapRepo, setMapRepo] = useState<string>('');
  const [mapMode, setMapMode] = useState<'code' | 'blackbox' | undefined>(undefined);

  useEffect(() => {
    if (!project) return;
    fetch(`${API}/api/projects/${project.id}/map`).then((r) => (r.ok ? r.json() : null)).then((m) => {
      setHasMap(!!m);
      const repo = (m && typeof m.repo === 'string') ? m.repo : '';
      setMapRepo(repo);
      setMapMode(m?.mode);
      // DERIVE the oracle from what the crawl actually captured: a URL-only (blackbox) map or no repo ⇒ 'url' only —
      // never claim a code oracle Xsion can't honor. A code-mode map with a repo keeps whatever the user picked.
      if (m && (m.mode === 'blackbox' || !repo)) setOracle('url');
    }).catch(() => { setHasMap(false); setMapRepo(''); setMapMode(undefined); });
  }, [project, screen]);
  const codeAvailable = mapMode === 'code' && !!mapRepo;   // is a real codebase attached? gates the 'code + url' oracle

  // no project selected → the ProjectPicker landing (list existing + onboard new). Hooks run first (rules-of-hooks).
  if (!project) {
    return <ProjectPicker onPick={(p, isNew) => { setProject(p); setScreen('onboard'); setHasMap(false); if (isNew) setOracle('code'); }} />;
  }

  const urlShort = project?.baseUrl.replace(/^https?:\/\//, '') || '';

  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink" style={{ fontFamily: 'Archivo, sans-serif' }}>
      {/* ── SIDEBAR ── */}
      <aside className="flex w-[214px] min-w-[176px] flex-col border-r border-line bg-surface">
        <div className="border-b border-line px-[18px] pb-4 pt-[18px]">
          <div className="mb-3.5 flex items-center gap-2">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-accent"><span className="h-1 w-1 rounded-full bg-[oklch(0.20_0.02_122)]" /></span>
            <span className="mono text-[11px] font-medium tracking-[0.22em]">XSION</span>
          </div>
          <div className="text-[14px] font-medium tracking-[-0.01em]">{project?.name || '—'}</div>
          <div className="mono mt-[3px] truncate text-[10.5px] text-muted-2">{urlShort}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 py-3.5">
          <Label className="px-2 pb-2.5">Pipeline</Label>
          <div className="flex flex-col gap-px">
            {NAV.map((n) => {
              const active = screen === n.key;
              const locked = (n.key === 'validate' || n.key === 'project' || n.key === 'tests') && !hasMap;
              return (
                <button key={n.key} onClick={() => { if (locked) return; if (n.key === 'crawl') setResumeMode(false); setScreen(n.key); }} disabled={locked}
                  className={clsx('flex items-center gap-2 rounded-[5px] px-2 py-[7px] text-left transition-colors',
                    active ? 'bg-accent-soft' : locked ? 'opacity-35' : 'hover:bg-[oklch(1_0_0_/_0.03)]')}>
                  <span className={clsx('h-[5px] w-[5px] rounded-full', active ? 'bg-accent' : 'bg-muted-3')} />
                  <span className="mono w-3 text-[9.5px] text-muted-2">{n.num}</span>
                  <span className={clsx('flex-1 text-[12.5px]', active ? 'text-ink' : 'text-muted')}>{n.label}</span>
                  {locked && <span className="mono text-[8.5px] text-muted-3">lock</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-line px-[18px] py-3.5">
          <Label className="mb-2.5">Credential</Label>
          <div className="flex items-center gap-[7px]">
            <Dot color="var(--v-expected)" />
            <span className="mono text-[10.5px] text-muted">{project ? 'keychain · scoped' : 'none'}</span>
          </div>
          <div className="mono mt-1.5 text-[9.5px] leading-[1.5] text-muted-2">keychain · project-scoped<br />redacted in logs</div>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* topbar */}
        <div className="flex h-[50px] flex-none items-center gap-4 border-b border-line bg-surface px-5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="whitespace-nowrap text-[13.5px] font-medium tracking-[-0.01em]">{NAV.find((n) => n.key === screen)?.label}</span>
            <span className="mono whitespace-nowrap text-[10.5px] text-muted-2">{urlShort}</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-[9px]">
            <span className="mono text-[9px] tracking-label text-muted-2">ORACLE</span>
            <div className="flex rounded-[5px] border border-line bg-surface-2 p-0.5">
              {(['code', 'url'] as const).map((m) => {
                // 'code + url' is only selectable when a real codebase is attached (a code-mode crawl with a repo).
                // On a URL-only project it's DISABLED — never let the user claim a code oracle Xsion can't honor.
                const disabled = m === 'code' && !codeAvailable;
                return (
                  <button key={m} onClick={() => { if (!disabled) setOracle(m); }} disabled={disabled}
                    title={disabled ? 'This project was crawled URL-only (no codebase attached) — code cross-check is unavailable.' : undefined}
                    className={clsx('rounded-[4px] px-2.5 py-1 text-[11px] transition-colors', oracle === m ? 'bg-accent-soft text-accent' : disabled ? 'text-muted-3 opacity-35 cursor-not-allowed' : 'text-muted-2 hover:text-muted')}>
                    {m === 'code' ? 'code + url' : 'url only'}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 mono text-[10px]', running ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-muted-2')}>
            <span className={clsx('h-1.5 w-1.5 rounded-full', running ? 'bg-accent anim-pulse' : 'bg-muted-3')} />
            {running ? 'RUNNING' : 'IDLE'}
          </div>
        </div>

        {/* screen */}
        <div className="min-h-0 flex-1">
          {project && screen === 'onboard' && <OnboardScreen project={project} oracle={oracle} setOracle={setOracle} onBegin={(cfg) => { setCrawlCfg(cfg); setScreen('crawl'); }} />}
          {project && screen === 'crawl' && <CrawlScreen project={project} oracle={oracle} cfg={crawlCfg} resumeMode={resumeMode} onRunning={setRunning} onDone={() => { setHasMap(true); setResumeMode(false); setScreen('validate'); }} />}
          {project && screen === 'validate' && <ValidateScreen project={project} onDone={() => setScreen('project')} onContinueExploring={() => { setResumeMode(true); setScreen('crawl'); }} />}
          {project && screen === 'project' && <ProjectScreen project={project} onTests={() => setScreen('tests')} />}
          {project && screen === 'tests' && <TestScreen project={project} repo={mapRepo} codeAvailable={codeAvailable} onRunning={setRunning} />}
          {project && screen === 'runs' && <RunsScreen project={project} />}
          {!project && <div className="flex h-full items-center justify-center text-muted">Loading projects…</div>}
        </div>
      </main>

      {/* back to the project list */}
      <button onClick={() => setProject(null)}
        className="mono fixed bottom-3 left-3 z-50 rounded-[5px] border border-line bg-surface px-2.5 py-1.5 text-[10px] text-muted transition-colors hover:border-accent-line hover:text-accent">
        ← projects
      </button>
    </div>
  );
}
