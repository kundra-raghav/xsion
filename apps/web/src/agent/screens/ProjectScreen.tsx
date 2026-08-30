import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { PrimaryBtn, ConfChip } from '../kit';
import type { Project } from '../Workspace';

const API = 'http://localhost:4000';
type Tab = 'map' | 'flows' | 'api' | 'roles';
const TABS: { key: Tab; label: string }[] = [{ key: 'map', label: 'Map' }, { key: 'flows', label: 'Flows' }, { key: 'api', label: 'API surface' }, { key: 'roles', label: 'Roles & coverage' }];

const M_COLOR: Record<string, string> = { GET: 'text-[oklch(0.72_0.14_200)]', POST: 'text-expected', PUT: 'text-amber', DELETE: 'text-realbug', PATCH: 'text-amber' };

export function ProjectScreen({ project, onTests }: { project: Project; onTests: () => void }) {
  const [map, setMap] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('map');

  useEffect(() => {
    fetch(`${API}/api/projects/${project.id}/map`).then((r) => (r.ok ? r.json() : null)).then(setMap).catch(() => setMap(null));
  }, [project]);

  const pages = map?.pages || [];
  const flows = [...(map?.flows || [])].sort((a: any, b: any) => order(a.confidence) - order(b.confidence));
  const api = map?.api || [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="border-b border-line px-8 pt-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="m-0 mb-2 text-[26px] font-medium tracking-tight2">{project.name}</h1>
            <div className="mono text-[10.5px] text-muted-2">
              {map ? `${map.mode} mode · ${pages.length} pages · ${flows.length} flows · ${api.length} endpoints · crawled ${new Date(map.crawledAt).toLocaleString()}` : 'no map yet'}
            </div>
          </div>
          <PrimaryBtn onClick={onTests}>Test menu →</PrimaryBtn>
        </div>
        <div className="mt-[22px] flex gap-5">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={clsx('border-b-2 pb-2.5 text-[13px] transition-colors', tab === t.key ? 'border-accent text-ink' : 'border-transparent text-muted-2 hover:text-muted')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {!map && <div className="mono text-[12px] text-muted-2">No map — run the crawl first.</div>}

        {map && tab === 'map' && (
          <>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))' }}>
              {pages.map((p: any) => (
                <div key={p.path} className="rounded-[6px] border border-line bg-surface p-3.5">
                  <div className="mb-2.5 flex items-center justify-between gap-2.5">
                    <span className="mono text-[10.5px] text-accent">{p.path}</span>
                    <span className="mono text-[9px] tracking-[0.1em] text-muted-2">MAPPED</span>
                  </div>
                  <div className="mb-3 text-[13.5px] font-medium">{p.title || p.path}</div>
                  <div className="flex flex-wrap gap-1">
                    <Chip>{p.interactives} interactive</Chip>
                    {p.requirements?.length ? <Chip>{p.requirements.length} field req</Chip> : null}
                  </div>
                  {p.requirements?.length ? (
                    <div className="mt-2.5 flex flex-col gap-1 border-t border-line pt-2.5">
                      {p.requirements.slice(0, 6).map((r: any, i: number) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <span className={clsx('mono mt-px flex-none rounded-[3px] px-1 py-0.5 text-[8px] tracking-[0.06em]', r.source === 'dom+code' ? 'bg-accent-soft text-accent' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{r.kind}{r.required ? '*' : ''}</span>
                          <span className="text-[10.5px] leading-[1.4] text-muted-2 text-pretty">
                            {r.prompt}
                            {r.codeNote ? <span className="mono block text-[9px] text-accent/80">code: {r.codeNote}</span> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {map.bounded?.reachedLimit && (
              <div className="mono mt-4 max-w-[720px] text-[10px] leading-[1.7] text-muted-2 text-pretty">
                Reachable high-value surface. The breadth budget stopped the crawl at {map.bounded.maxPages} pages — deeper routes are recorded as known-unknowns rather than omitted.
              </div>
            )}
          </>
        )}

        {map && tab === 'flows' && (
          <div className="overflow-hidden rounded-[6px] border border-line">
            {flows.map((f: any) => (
              <div key={f.id} className="flex items-center gap-3.5 border-b border-line px-4 py-3.5 last:border-b-0">
                <ConfChip confidence={f.confidence} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{f.name}</div>
                  <div className="mono mt-1 text-[10px] text-muted-2">{f.role} · {f.steps.length} steps{f.reasoning ? ` · ${f.reasoning.slice(0, 80)}` : ''}</div>
                </div>
                <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px] tracking-[0.1em]', f.confidence === 'low' ? 'bg-[oklch(0.66_0.012_264_/_0.12)] text-unverified' : 'bg-[oklch(1_0_0_/_0.05)] text-muted-2')}>
                  {f.confidence === 'low' ? 'REVIEW' : 'READY'}
                </span>
              </div>
            ))}
          </div>
        )}

        {map && tab === 'api' && (
          <div className="overflow-hidden rounded-[6px] border border-line">
            <div className="mono flex bg-[oklch(1_0_0_/_0.03)] px-4 py-2.5 text-[9px] tracking-label text-muted-2">
              <div className="flex-none basis-[80px]">TYPE</div><div className="flex-[2]">OPERATION / ENDPOINT</div><div className="flex-none basis-[54px]">STATUS</div><div className="flex-none basis-[50px] text-right">CALLS</div>
            </div>
            {api.length === 0 && <div className="mono px-4 py-3 text-[11px] text-muted-2">no API calls observed</div>}
            {api.map((e: any, i: number) => <ApiRow key={i} e={e} />)}
          </div>
        )}

        {map && tab === 'roles' && <RolesPanel project={project} map={map} />}
      </div>
    </div>
  );
}

// MULTI-ROLE (item 4): manage a credential set per role, crawl once per role, and see per-role coverage — which
// routes each role reaches, and which routes only ONE role sees (the "nothing is left per role" check).
function RolesPanel({ project, map }: { project: Project; map: any }) {
  const [roles, setRoles] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<any>(null);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [hasProjectCreds, setHasProjectCreds] = useState<boolean>(false);
  const [pEmail, setPEmail] = useState(''); const [pPw, setPPw] = useState(''); const [savingCreds, setSavingCreds] = useState(false);
  const load = () => {
    fetch(`${API}/api/projects/${project.id}/roles`).then((r) => r.json()).then((d) => setRoles(d.roles || [])).catch(() => {});
    fetch(`${API}/api/projects/${project.id}/coverage`).then((r) => (r.ok ? r.json() : null)).then(setCoverage).catch(() => setCoverage(null));
    fetch(`${API}/api/projects/${project.id}/has-credentials`).then((r) => r.json()).then((d) => setHasProjectCreds(!!d.hasCredentials)).catch(() => {});
  };
  useEffect(load, [project]);
  const addRole = async () => {
    if (!name.trim()) return;
    await fetch(`${API}/api/projects/${project.id}/roles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password: pw }) });
    setName(''); setEmail(''); setPw(''); load();
  };
  // SET THE PROJECT CREDENTIALS the ENGINES use (break-it / bug-repro / env-matrix read the project default, not a
  // role). This is the "save creds so they actually get used" control the user needs.
  const saveProjectCreds = async () => {
    if (!pEmail.trim() || !pPw) return;
    setSavingCreds(true);
    try {
      const r = await fetch(`${API}/api/projects/${project.id}/credentials`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: pEmail, password: pPw }) });
      const d = await r.json();
      setHasProjectCreds(!!d.hasCredentials); setPEmail(''); setPPw('');
    } finally { setSavingCreds(false); }
  };
  const clearProjectCreds = async () => {
    await fetch(`${API}/api/projects/${project.id}/credentials`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    setHasProjectCreds(false);
  };
  const crawlAs = async (roleId: string) => {
    await fetch(`${API}/api/projects/${project.id}/crawl-map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId }) });
  };
  const nameOf = (id: string) => (map.roles || []).find((r: any) => r.id === id)?.name || id.slice(0, 6);

  return (
    <div className="max-w-[720px]">
      {/* PROJECT CREDENTIALS — the ones the ENGINES (break-it / bug-repro / env-matrix) actually sign in with. */}
      <div className="mb-6 rounded-[7px] border border-line bg-surface p-4">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="text-[13.5px] font-medium">Project sign-in credentials</span>
          <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px]', hasProjectCreds ? 'bg-accent-soft text-accent' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{hasProjectCreds ? 'set · engines will sign in' : 'not set · engines can’t reach the app'}</span>
        </div>
        <p className="mono mb-3 text-[10.5px] leading-[1.7] text-muted-2 text-pretty">These are what Break-it, Replicate-a-bug, and the Environment matrix use to log in before testing. Without them, those features stop at the sign-in screen. Held in memory only, never written to disk, never echoed back.</p>
        {hasProjectCreds ? (
          <button onClick={clearProjectCreds} className="mono rounded-[5px] border border-line-strong px-3 py-1.5 text-[11px] hover:border-realbug hover:text-realbug">clear credentials</button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="email / username" value={pEmail} onChange={setPEmail} placeholder="admin@thedent.in" />
            <Field label="password" value={pPw} onChange={setPPw} placeholder="••••••" type="password" />
            <button onClick={saveProjectCreds} disabled={savingCreds || !pEmail.trim() || !pPw} className={clsx('mono rounded-[5px] px-3 py-1.5 text-[11px] font-medium', (savingCreds || !pEmail.trim() || !pPw) ? 'bg-[oklch(1_0_0_/_0.06)] text-muted-2' : 'bg-accent text-[oklch(0.2_0.02_264)]')}>{savingCreds ? 'saving…' : 'save credentials'}</button>
          </div>
        )}
      </div>

      <div className="mb-2 text-[13.5px] font-medium">Roles</div>
      <p className="mono mb-4 text-[10.5px] leading-[1.7] text-muted-2 text-pretty">One URL, many roles. Give each role a credential set; Xsion crawls once per role and tags every page, flow, and API with the roles that actually saw it — so “nothing is left” becomes checkable per role. Adding a role with credentials also sets them as the project sign-in credentials if none are set yet. Held in memory only, never written to disk.</p>

      <div className="mb-5 flex flex-col gap-1.5">
        {roles.map((r) => {
          const cov = coverage?.roles?.find((x: any) => x.id === r.id);
          return (
            <div key={r.id} className="flex items-center gap-3 rounded-[6px] border border-line bg-surface px-3.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="text-[13px] font-medium">{r.name}</span>
              <span className={clsx('mono rounded-[3px] px-1.5 py-0.5 text-[9px]', r.hasCredentials ? 'bg-accent-soft text-accent' : 'bg-[oklch(1_0_0_/_0.06)] text-muted-2')}>{r.hasCredentials ? 'creds set' : 'no creds'}</span>
              {cov && <span className="mono text-[10px] text-muted-2">{cov.pagesReached} pages{cov.crawledAt ? '' : ' · not crawled'}</span>}
              <button onClick={() => crawlAs(r.id)} className="mono ml-auto rounded-[4px] border border-line-strong px-2.5 py-1 text-[10px] hover:border-accent hover:text-accent">crawl as {r.name} →</button>
            </div>
          );
        })}
        {roles.length === 0 && <div className="mono text-[11px] text-muted-2">No roles yet — add one below to map role-specific flows.</div>}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-2 rounded-[6px] border border-dashed border-line-strong p-3.5">
        <Field label="role name" value={name} onChange={setName} placeholder="admin" />
        <Field label="email (optional)" value={email} onChange={setEmail} placeholder="admin@app.com" />
        <Field label="password (optional)" value={pw} onChange={setPw} placeholder="••••••" type="password" />
        <button onClick={addRole} className="mono rounded-[5px] bg-accent px-3 py-1.5 text-[11px] font-medium text-[oklch(0.2_0.02_264)]">+ add role</button>
      </div>

      {coverage && Object.keys(coverage.roleExclusivePages || {}).length > 0 && (
        <div className="rounded-[6px] border border-amber/40 bg-[oklch(0.84_0.14_80_/_0.05)] p-4">
          <div className="mb-2 text-[12.5px] font-medium text-amber">Role-exclusive surface</div>
          <div className="mono mb-2.5 text-[10px] text-muted-2">Routes only ONE role reaches — the flows a single-role crawl would miss.</div>
          <div className="flex flex-col gap-1">
            {Object.entries(coverage.roleExclusivePages).map(([path, rid]: any) => (
              <div key={path} className="mono flex items-center gap-2 text-[10.5px]"><span className="text-accent">{path}</span><span className="text-muted-3">only</span><span className="text-amber">{nameOf(rid)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="mono text-[9px] uppercase tracking-label text-muted-2">{label}</span>
      <input type={type || 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="mono w-[150px] rounded-[4px] border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink outline-none focus:border-accent" />
    </label>
  );
}

// A4: GraphQL-aware API row. A /graphql endpoint is ONE url → show the OPERATION (query/mutation name derived
// from the payload) as the identity, with the full payload expandable. REST shows method + url.
function ApiRow({ e }: { e: any }) {
  const [open, setOpen] = useState(false);
  const hasPayload = !!(e.samplePayload || e.sampleResponse);
  return (
    <div className="border-b border-line last:border-b-0">
      <button onClick={() => hasPayload && setOpen(!open)} className={clsx('mono flex w-full items-center px-4 py-2.5 text-left text-[11px]', hasPayload && 'hover:bg-[oklch(1_0_0_/_0.02)]')}>
        <div className="flex-none basis-[80px]">
          {e.graphql
            ? <span className={clsx('rounded-[3px] px-1.5 py-0.5 text-[9px] font-medium', e.gqlKind === 'mutation' ? 'bg-[oklch(0.84_0.14_80_/_0.15)] text-amber' : 'bg-[oklch(0.72_0.14_200_/_0.15)] text-[oklch(0.72_0.14_200)]')}>{e.gqlKind || 'gql'}</span>
            : <span className={clsx('font-medium', M_COLOR[e.method] || 'text-muted')}>{e.method}</span>}
        </div>
        <div className="min-w-0 flex-[2]">
          {e.graphql
            ? <span className="truncate font-medium text-ink">{e.gqlOperation}<span className="ml-2 text-muted-3">{e.url.replace(/^https?:\/\//, '').replace(/\/.*graphql.*/, '/graphql')}</span></span>
            : <span className="truncate text-ink">{e.url.replace(/^https?:\/\//, '')}</span>}
        </div>
        <div className="flex-none basis-[54px]"><span className={statusColor(e.statuses?.[0])}>{e.statuses?.join(',') || '—'}</span></div>
        <div className="flex-none basis-[50px] text-right tabular text-muted-2">{e.count || 1}{hasPayload && <span className="ml-1.5 text-muted-3">{open ? '▾' : '▸'}</span>}</div>
      </button>
      {open && hasPayload && (
        <div className="border-t border-line bg-surface-2/40 px-4 py-3">
          {e.samplePayload && <PayloadBlock label="request payload" body={e.samplePayload} />}
          {e.sampleResponse && <PayloadBlock label="response sample" body={e.sampleResponse} />}
        </div>
      )}
    </div>
  );
}
function PayloadBlock({ label, body }: { label: string; body: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mono mb-1 text-[9px] uppercase tracking-label text-muted-2">{label}</div>
      <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-[4px] border border-line bg-paper p-2.5 text-[10.5px] leading-relaxed text-muted">{prettyJson(body)}</pre>
    </div>
  );
}
function prettyJson(s: string) { try { return JSON.stringify(JSON.parse(s), null, 2).slice(0, 1200); } catch { return s.slice(0, 1200); } }

function order(c: string) { return c === 'low' ? 0 : c === 'medium' ? 1 : 2; }
function statusColor(s?: number) { if (!s) return 'text-muted-2'; if (s >= 500) return 'text-realbug'; if (s >= 400) return 'text-amber'; return 'text-expected'; }
function Chip({ children }: { children: React.ReactNode }) { return <span className="mono rounded-[3px] bg-[oklch(1_0_0_/_0.06)] px-[7px] py-[3px] text-[9.5px] text-muted">{children}</span>; }
