import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { MissionControl } from './MissionControl';
import { CrawlBrowser } from './CrawlBrowser';

const API = 'http://localhost:4000';
interface Project { id: string; name: string; baseUrl: string; }
type View = 'onboard' | 'test';

/** The agentic product shell: onboard (crawl+map a URL) or test (live run against a mapped project). */
export function AgentApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>('onboard');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('xsion-theme') as any) || 'dark');

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('xsion-theme', theme); }, [theme]);
  useEffect(() => {
    fetch(`${API}/api/projects`).then((r) => r.json()).then((ps: Project[]) => {
      setProjects(ps);
      const dent = ps.find((p) => /dent|admin\.thedent/i.test(p.name + p.baseUrl));
      setProjectId((dent || ps[0])?.id || null);
    }).catch(() => {});
  }, []);

  return (
    <div className="relative">
      {/* top-right controls */}
      <div className="fixed right-5 top-5 z-50 flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
          {(['onboard', 'test'] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={clsx('rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors', view === v ? 'bg-accent text-white' : 'text-muted hover:text-ink')}>
              {v === 'onboard' ? 'Onboard' : 'Test'}
            </button>
          ))}
        </div>
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-ink" aria-label="Toggle theme">
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>

      {projectId ? (
        view === 'onboard' ? <CrawlBrowser projectId={projectId} /> : <MissionControl projectId={projectId} />
      ) : (
        <div className="flex min-h-screen items-center justify-center bg-paper text-muted">Loading projects…</div>
      )}

      {projects.length > 1 && (
        <select value={projectId || ''} onChange={(e) => setProjectId(e.target.value)}
          className="fixed left-5 bottom-5 z-50 rounded-lg border border-line bg-surface px-2 py-1.5 text-[11px] text-muted">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  );
}
