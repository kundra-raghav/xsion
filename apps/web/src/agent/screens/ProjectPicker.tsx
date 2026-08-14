import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Label, PrimaryBtn, Input } from '../kit';
import type { Project } from '../Workspace';

const API = 'http://localhost:4000';

/** The landing: pick an existing project, or onboard a new URL as a project. */
export function ProjectPicker({ onPick }: { onPick: (p: Project, isNew: boolean) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [maps, setMaps] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  // Normalize what the user typed into a real URL: only prepend https:// when there's NO scheme yet (typing a full
  // http://localhost:… URL must NOT become https://http://… — the mangled-URL bug). Empty → empty.
  const normalizeUrl = (raw: string): string => {
    const s = raw.trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  };

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    const ps: Project[] = await fetch(`${API}/api/projects`).then((r) => r.json()).catch(() => []);
    setProjects(ps);
    const m: Record<string, boolean> = {};
    await Promise.all(ps.map(async (p) => { m[p.id] = (await fetch(`${API}/api/projects/${p.id}/map`)).ok; }));
    setMaps(m);
  }

  async function create() {
    const url = normalizeUrl(newUrl);
    if (!url) { setError('Enter a web app URL.'); return; }
    setError(''); setCreating(true);
    try {
      const name = newName || url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const res = await fetch(`${API}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseUrl: url }),
      });
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      const p: Project = await res.json();
      if (!p?.id) throw new Error('no project returned');
      onPick(p, true);
    } catch (e: any) {
      // surface the failure instead of hanging forever on "Creating…" (the invisible-error bug)
      setError(`Couldn't create the project — ${String(e?.message || e)}. Is the backend running on :4000?`);
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper text-ink" style={{ fontFamily: 'Archivo, sans-serif' }}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-grid opacity-40" />
      <div className="relative w-full max-w-[720px] px-8 py-16">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-accent"><span className="h-1.5 w-1.5 rounded-full bg-[oklch(0.20_0.02_122)]" /></span>
          <span className="mono text-[12px] font-medium tracking-[0.22em]">XSION</span>
        </div>
        <h1 className="mb-2 mt-4 text-[32px] font-medium tracking-tight2">Your projects</h1>
        <p className="mb-8 text-[14px] text-muted">Pick a project to open, or onboard a new web app.</p>

        {/* existing projects */}
        <Label className="mb-3">Projects ({projects.length})</Label>
        <div className="mb-8 flex flex-col gap-1.5">
          {projects.length === 0 && <div className="mono text-[12px] text-muted-2">no projects yet — onboard one below</div>}
          {projects.map((p) => (
            <button key={p.id} onClick={() => onPick(p, false)}
              className="group flex items-center gap-3 rounded-[6px] border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-accent-line hover:bg-accent-soft">
              <span className={clsx('h-2 w-2 rounded-full', maps[p.id] ? 'bg-expected' : 'bg-muted-3')} />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{p.name}</div>
                <div className="mono truncate text-[10.5px] text-muted-2">{p.baseUrl.replace(/^https?:\/\//, '')}</div>
              </div>
              <span className="mono text-[9.5px] tracking-[0.1em] text-muted-2">{maps[p.id] ? 'MAPPED' : 'NOT MAPPED'}</span>
              <span className="mono text-[12px] text-muted-2 opacity-0 transition-opacity group-hover:opacity-100">→</span>
            </button>
          ))}
        </div>

        {/* onboard new */}
        {!adding ? (
          <button onClick={() => setAdding(true)}
            className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-dashed border-line-strong py-3.5 text-[13px] text-muted transition-colors hover:border-accent-line hover:text-accent">
            + Onboard a new web app
          </button>
        ) : (
          <div className="rounded-[6px] border border-line bg-surface p-5">
            <Label className="mb-3">New project</Label>
            <label className="mb-1.5 block text-[11.5px] text-muted">Web app URL</label>
            <Input value={newUrl} onChange={(v) => { setNewUrl(v); if (error) setError(''); }} placeholder="example.com  ·  http://localhost:5188/app.html" mono />
            {newUrl.trim() && !/^https?:\/\//i.test(newUrl.trim()) && (
              <div className="mono mt-1 text-[10px] text-muted-3">→ {normalizeUrl(newUrl)}</div>
            )}
            <label className="mb-1.5 mt-3.5 block text-[11.5px] text-muted">Name (optional)</label>
            <Input value={newName} onChange={setNewName} placeholder="derived from the URL" />
            {error && <div className="mt-3 rounded-[5px] border border-[oklch(0.70_0.18_24_/_0.4)] bg-[oklch(0.70_0.18_24_/_0.07)] px-3 py-2 text-[11.5px] text-realbug">{error}</div>}
            <div className="mt-4 flex gap-2">
              <PrimaryBtn onClick={create} disabled={creating || !newUrl.trim()}>{creating ? 'Creating…' : 'Create & onboard →'}</PrimaryBtn>
              <button onClick={() => { setAdding(false); setError(''); }} className="rounded-[5px] border border-line px-3 py-3 text-[12.5px] text-muted hover:text-ink">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
