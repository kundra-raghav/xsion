/**
 * mapDiff.ts — THE SPINE of Xsion v2: "what CHANGED since the last crawl?" (NO git, crawl-over-crawl).
 *
 * The unit of value is the DIFF, not the whole app. Xsion records a full semantic ProjectMap every crawl; this
 * module compares the CURRENT map against the LAST saved one for the same project → a delta the CLI/engines act on:
 * only the changed/added states get re-tested, and a page that started 5xx-ing surfaces as a statusRegression.
 *
 * DESIGN (grounded, not invented):
 *  • Reuses the #208 state-signature SPIRIT — coarse, structural, order-independent, entity-identity stripped — so a
 *    page whose CONTENT changed at the SAME route is a `changedState`, while cosmetic churn (one more row, a
 *    different order/user name) does NOT register. A stored MappedPage has no live PageShape, so pageSig() builds
 *    the coarse signature from the fields the map DOES persist (path + interactives band + typed field-requirement
 *    set). Same banding philosophy as stateSignature.band(): N vs N±1 never splits a state.
 *  • Pages keyed by PATH (route template): same path + different signature = changed; new path = added; gone = removed.
 *  • Flows keyed by NAME (SoA's stable label): added/removed by name; changed = same name, different step intents.
 *  • Endpoints keyed by method+url (already normalized ids→:id in the crawl): added by key; a statusRegression is an
 *    endpoint that was all-healthy (<400) last time and now shows a 4xx/5xx — the single highest-signal delta.
 *  • PURE. No Playwright, no I/O — given two ProjectMap-shaped objects it returns a plain delta. Unit-testable.
 *
 * The output's `retestPaths` / `retestFlows` are the "what to re-test" set the CLI feeds to the engines: don't run
 * everything, run what moved.
 */

// Loose shapes — the store's maps are `any`-typed at the boundary, so we accept the fields we read and nothing more.
interface DiffPage { path?: string; title?: string; interactives?: number; requirements?: Array<{ name?: string; required?: boolean; type?: string }>; }
interface DiffFlow { id?: string; name?: string; steps?: Array<{ intent?: string; expectedOutcome?: string }>; }
interface DiffApi { method?: string; url?: string; statuses?: number[]; gqlOperation?: string; graphql?: boolean; }
interface DiffMap { pages?: DiffPage[]; flows?: DiffFlow[]; api?: DiffApi[]; baseUrl?: string; crawledAt?: string; }

export interface StatusRegression { method: string; url: string; before: number[]; after: number[]; worstAfter: number; }
export interface ChangedState { path: string; beforeSig: string; afterSig: string; reason: string; }
export interface ChangedFlow { name: string; addedSteps: string[]; removedSteps: string[]; }

export interface MapDiff {
  addedPages: string[];
  removedPages: string[];
  changedStates: ChangedState[];
  addedFlows: string[];
  removedFlows: string[];
  changedFlows: ChangedFlow[];
  addedEndpoints: string[];
  removedEndpoints: string[];
  statusRegressions: StatusRegression[];
  /** convenience roll-ups for the CLI / engine-selection: the paths + flows worth re-testing (added ∪ changed). */
  retestPaths: string[];
  retestFlows: string[];
  /** true when NOTHING moved — the CLI reports "clean, no drift" and stays silent (the beloved-tool law). */
  clean: boolean;
  /** carried through for the report header. */
  prevCrawledAt?: string;
  curCrawledAt?: string;
}

/** Coarse band, same philosophy as stateSignature.band(): 0 / 1 / few(2-4) / many(5+). N vs N±1 never splits. */
function band(n: number): 0 | 1 | 2 | 3 { const v = Number(n) || 0; return v <= 0 ? 0 : v === 1 ? 1 : v <= 4 ? 2 : 3; }

function norm(s: unknown): string { return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[0-9]+/g, '#').trim(); }

/**
 * A coarse, structural signature for a STORED page (not a live PageShape). Built from the fields the map persists:
 *  • path (route template — the spine of identity),
 *  • the BAND of interactive-affordance count (so one added button doesn't churn the diff, but list→form does),
 *  • the SET of typed field-requirement names (item 3) — a form gaining/losing a required field IS a real change.
 * Entity identity is stripped (norm() collapses digits) so "Order #1041" ≡ "Order #2277". Same route + same
 * signature ⇒ unchanged. Same route + different signature ⇒ a changedState worth re-testing.
 */
export function pageSig(p: DiffPage): string {
  const reqSet = Array.from(new Set((p.requirements || []).map((r) => norm(r?.name) + (r?.required ? '!' : '')).filter(Boolean))).sort();
  return [
    'p:' + norm(p.path),
    'i:' + band(p.interactives ?? 0),
    'q:' + reqSet.join('|'),
  ].join('\n');
}

/** why two same-path signatures differ — a human-readable reason for the report. */
function sigReason(prev: DiffPage, cur: DiffPage): string {
  const bits: string[] = [];
  if (band(prev.interactives ?? 0) !== band(cur.interactives ?? 0)) bits.push(`affordances ${prev.interactives ?? 0}→${cur.interactives ?? 0}`);
  const pReq = new Set((prev.requirements || []).map((r) => norm(r?.name)));
  const cReq = new Set((cur.requirements || []).map((r) => norm(r?.name)));
  const added = [...cReq].filter((x) => x && !pReq.has(x));
  const removed = [...pReq].filter((x) => x && !cReq.has(x));
  if (added.length) bits.push(`+fields ${added.join(',')}`);
  if (removed.length) bits.push(`-fields ${removed.join(',')}`);
  return bits.join('; ') || 'structure changed';
}

function apiKey(e: DiffApi): string {
  // GraphQL: one /graphql url is meaningless — the OPERATION identifies the call (crawlTypes parseGraphql).
  const op = e.graphql && e.gqlOperation ? `#${e.gqlOperation}` : '';
  return `${String(e.method || 'GET').toUpperCase()} ${e.url || ''}${op}`;
}
function worst(statuses: number[]): number { return (statuses || []).reduce((m, s) => Math.max(m, Number(s) || 0), 0); }
function healthy(statuses: number[]): boolean { const w = worst(statuses); return w > 0 && w < 400; }

/**
 * Compare a PREVIOUS ProjectMap against the CURRENT one → the delta. Both args are `any`-typed at the store boundary;
 * a missing `prev` (first crawl ever) yields an all-added diff but `clean:false` only if the current map has content.
 */
export function mapDiff(prev: DiffMap | null | undefined, cur: DiffMap): MapDiff {
  const prevPages = (prev?.pages || []);
  const curPages = (cur?.pages || []);
  const prevByPath = new Map(prevPages.map((p) => [norm(p.path), p] as const));
  const curByPath = new Map(curPages.map((p) => [norm(p.path), p] as const));

  const addedPages: string[] = [];
  const changedStates: ChangedState[] = [];
  for (const [key, cp] of curByPath) {
    const pp = prevByPath.get(key);
    if (!pp) { addedPages.push(cp.path || key); continue; }
    const a = pageSig(cp), b = pageSig(pp);
    if (a !== b) changedStates.push({ path: cp.path || key, beforeSig: b.replace(/\n/g, ' '), afterSig: a.replace(/\n/g, ' '), reason: sigReason(pp, cp) });
  }
  const removedPages = [...prevByPath.keys()].filter((k) => !curByPath.has(k)).map((k) => prevByPath.get(k)!.path || k);

  // ── flows: by name; changed = step-intent set differs ──
  const prevFlows = new Map((prev?.flows || []).map((f) => [norm(f.name), f] as const));
  const curFlows = new Map((cur?.flows || []).map((f) => [norm(f.name), f] as const));
  const addedFlows: string[] = [];
  const changedFlows: ChangedFlow[] = [];
  for (const [key, cf] of curFlows) {
    const pf = prevFlows.get(key);
    if (!pf) { addedFlows.push(cf.name || key); continue; }
    const pSteps = new Set((pf.steps || []).map((s) => norm(s?.intent)).filter(Boolean));
    const cSteps = new Set((cf.steps || []).map((s) => norm(s?.intent)).filter(Boolean));
    const addedSteps = [...cSteps].filter((s) => !pSteps.has(s));
    const removedSteps = [...pSteps].filter((s) => !cSteps.has(s));
    if (addedSteps.length || removedSteps.length) changedFlows.push({ name: cf.name || key, addedSteps, removedSteps });
  }
  const removedFlows = [...prevFlows.keys()].filter((k) => !curFlows.has(k)).map((k) => prevFlows.get(k)!.name || k);

  // ── endpoints: by method+url(+op); statusRegression = was healthy, now 4xx/5xx ──
  const prevApi = new Map((prev?.api || []).map((e) => [apiKey(e), e] as const));
  const curApi = new Map((cur?.api || []).map((e) => [apiKey(e), e] as const));
  const addedEndpoints = [...curApi.keys()].filter((k) => !prevApi.has(k));
  const removedEndpoints = [...prevApi.keys()].filter((k) => !curApi.has(k));
  const statusRegressions: StatusRegression[] = [];
  for (const [key, ce] of curApi) {
    const pe = prevApi.get(key);
    if (!pe) continue;
    const wAfter = worst(ce.statuses || []);
    // regression = previously observed healthy (all <400) AND now shows a 4xx/5xx.
    if (healthy(pe.statuses || []) && wAfter >= 400) {
      const [method, ...rest] = key.split(' ');
      statusRegressions.push({ method, url: rest.join(' '), before: pe.statuses || [], after: ce.statuses || [], worstAfter: wAfter });
    }
  }

  const retestPaths = Array.from(new Set([...addedPages, ...changedStates.map((c) => c.path)]));
  const retestFlows = Array.from(new Set([...addedFlows, ...changedFlows.map((c) => c.name)]));
  const clean = addedPages.length === 0 && removedPages.length === 0 && changedStates.length === 0 &&
    addedFlows.length === 0 && removedFlows.length === 0 && changedFlows.length === 0 &&
    addedEndpoints.length === 0 && removedEndpoints.length === 0 && statusRegressions.length === 0;

  return {
    addedPages, removedPages, changedStates, addedFlows, removedFlows, changedFlows,
    addedEndpoints, removedEndpoints, statusRegressions, retestPaths, retestFlows, clean,
    prevCrawledAt: prev?.crawledAt, curCrawledAt: cur?.crawledAt,
  };
}

/** A terminal-friendly one-block summary of a diff (used by the CLI report + logs). Pure string, no color codes. */
export function summarizeDiff(d: MapDiff): string {
  if (d.clean) return 'No drift since last crawl — map is unchanged.';
  const L: string[] = [];
  if (d.statusRegressions.length) L.push(`⚠ ${d.statusRegressions.length} status regression(s): ` + d.statusRegressions.map((r) => `${r.method} ${r.url} → ${r.worstAfter}`).join(', '));
  if (d.addedPages.length) L.push(`+${d.addedPages.length} page(s): ${d.addedPages.join(', ')}`);
  if (d.removedPages.length) L.push(`-${d.removedPages.length} page(s): ${d.removedPages.join(', ')}`);
  if (d.changedStates.length) L.push(`~${d.changedStates.length} changed: ` + d.changedStates.map((c) => `${c.path} (${c.reason})`).join(', '));
  if (d.addedFlows.length) L.push(`+${d.addedFlows.length} flow(s): ${d.addedFlows.join(', ')}`);
  if (d.removedFlows.length) L.push(`-${d.removedFlows.length} flow(s): ${d.removedFlows.join(', ')}`);
  if (d.changedFlows.length) L.push(`~${d.changedFlows.length} flow(s) changed: ${d.changedFlows.map((c) => c.name).join(', ')}`);
  if (d.addedEndpoints.length) L.push(`+${d.addedEndpoints.length} endpoint(s)`);
  return L.join('\n');
}
