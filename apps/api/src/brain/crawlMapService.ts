/**
 * crawlMapService.ts — the onboarding + crawl-map SPINE. A URL → a mapped project.
 * Launches a headless browser, captures the API surface, does a BOUNDED breadth-first crawl (reusing Xsion's
 * candidate scorer), streams every frame + click + thought live, blocks ONLY on a credential gate, then hands
 * the observed surface to SoA to synthesize named flows with per-flow confidence. Resumable, never exhaustive.
 */
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page, Browser } from 'playwright';
import { wsServer } from '../ws';
import { store } from '../store';
import { getCandidateActions } from '../runners/candidates';
import { synthesizeFlows } from './flowSynth';
import { routeManifest, fieldReqs, explorePage } from './soaClient';
import { pageClickableInventory } from './pageInventory';
import { parseGraphql } from './crawlTypes';
import { captureShape, sigFromShape, collapseDecision } from './stateSignature';
import { ExploreTracker, ArmName, decideSoa } from './exploreStrategy';
import { installEvalShim } from './evalShim';
import type { CrawlEvent, MappedPage, ApiEndpoint, ProjectMap, FieldRequirement, GraphEdge } from './crawlTypes';
import { edgeKey, edgeBaseKey, DERIVE_AND_VERIFY } from './elementSelector';
import type { SelectorTier } from './elementSelector';
import { classifyElement } from './safetyGate';
import { buildSiteModel, warmStart } from './siteModel';   // CRAWL-g: persisted per-app learned model + warm-start   // CRAWL-e: safe-to-click vs map-but-never-click classifier

const BASE_MAX_PAGES = Number(process.env.XSION_CRAWL_MAX_PAGES || 14);   // the floor for a fresh/black-box crawl (raised 8→14, 2026-08-29: a role-scoped SPA console commonly has 9-12 views — admin's 9 nav views hit the old 8-page wall before the last was mapped)
const MAX_PAGES_CAP = Number(process.env.XSION_CRAWL_MAX_PAGES_CAP || 40); // hard ceiling even if a manifest is huge
const MAX_ACTIONS = Number(process.env.XSION_CRAWL_MAX_ACTIONS || 10);  // per page — FALLBACK only (used when the
// honest affordance count is unavailable); the live cap is self-calibrated to affordancesPresent (CRAWL-d).
const ACTION_CEILING = Number(process.env.XSION_CRAWL_ACTION_CEILING || 150);  // generous safety ceiling — capture
// everything a normal page has; only a pathological page (100s of controls) is clipped, and the remainder is recorded.
const NAV_TIMEOUT = 25000;
const HYDRATE_TIMEOUT = 20000;   // how long to wait for a JS SPA to render+STABILIZE after nav. Raised 12→20s: the
// schooltalk /nzcurriculum dashboard renders its real content only at ~15s (52-node shell → 438 nodes). The stabilize
// loop in waitForHydration exits early once the DOM settles, so this only extends genuinely-slow pages, not every one.

function emit(runId: string, e: CrawlEvent) { wsServer.broadcastToRun(runId, e as any); }

// A frontier entry: a URL to load PLUS an ordered ACTION-PATH to replay (for in-place SPA views + multi-step
// unlocks). Each step is either a click label (string) or a {fill,value} typed input. clicks=[] is a plain URL.
type NavStep = string | { fill: string; value: string };
interface Nav { url: string; clicks?: NavStep[]; }
const stepLabel = (s: NavStep): string => (typeof s === 'string' ? s : `${s.fill}=${s.value}`);

/** THE SPA FIX: after a nav, `networkidle` can fire on an empty shell while React/Vue is still hydrating — so the
 * crawl harvested 0 links from client-rendered apps (sloxt, schooltalk render their whole UI via JS). Wait until
 * the page actually has INTERACTIVE content (a link, button, input, or a populated app root) before harvesting.
 * Polls up to HYDRATE_TIMEOUT; returns even if nothing appears (a genuinely empty page is a real result). */
/** GATE DETECTION (general, structural — names nothing app-specific): a page is a decision-gate when it presents a
 * SET of similar clickable ROWS/OPTIONS and little else, especially with a "choose/select/pick" cue. The options are
 * read FROM THE PAGE. Returns the gate (path + kind + option labels) or null. The `kind` is guessed from the option
 * text (portal/workspace/tenant/school/menu) so the label is human-meaningful, not from a hardcoded list. */
async function detectGate(page: Page): Promise<import('./crawlTypes').GateInfo | null> {
  try {
    const info = await page.evaluate((DERIVE_SRC: string) => {
      const d: any = (globalThis as any).document;
      const win: any = (globalThis as any);
      const deriveAndVerify = new Function('return (' + DERIVE_SRC + ')')();   // SAME shared deriver+verifier as click-explore
      const bodyText = ((d.body && d.body.innerText) || '').replace(/\s+/g, ' ');
      // candidate option rows: list items / clickable rows with short text labels — each now carries its RESOLVABLE
      // identity (derived+verified in-page by the shared primitive), so a gate-seeded edge is identity-bearing.
      const rows: Array<{ label: string; tier: string; css: string | null; name: string | null; verified: boolean; ambiguity: number }> = [];
      const nodes = Array.prototype.slice.call(d.querySelectorAll('li, [role="listitem"], [role="option"], [class*="ListItem" i], [class*="option" i], [class*="portal" i], [class*="tile" i]'));
      const seen: any = {};
      for (const el of nodes) {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length < 2 || t.length > 40) continue;
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
        if (!(r.width > 0 || r.height > 0)) continue;
        if (seen[t]) continue; seen[t] = 1;
        const id = deriveAndVerify(el, t, d, win);
        rows.push({ label: t, tier: id.tier, css: id.css, name: id.name, verified: id.verifiedAtCapture, ambiguity: id.ambiguityCount });
      }
      const otherControls = d.querySelectorAll('input, textarea, table, form').length;
      const cue = /\b(choose|select|pick)\b[^.]{0,30}\b(portal|workspace|organi[sz]ation|school|tenant|account|team|company|environment)\b/i.exec(bodyText);
      return { rows: rows.slice(0, 20), otherControls, cue: cue ? cue[0] : '', bodyLen: bodyText.length };
    }, DERIVE_AND_VERIFY);
    // GATE test: a REAL gate BLOCKS progress — it has an explicit picker CUE ("Choose Portal:", "Select a
    // workspace"). A sidebar MENU (Add/Analyse, Export as PDF, Hide menu) on a content-rich page is NOT a gate; the
    // old cue-less fallback mis-flagged every dashboard as a gate (6 gates where 1 exists → misleads SoA as much as
    // 0 did). REQUIRE the cue. (A content-poor page with rows but no cue is recorded as a page, not a gate.)
    if (!info.cue || info.rows.length < 3) return null;
    const blob = (info.cue + ' ' + info.rows.map((r: any) => r.label).join(' ')).toLowerCase();
    const kind: import('./crawlTypes').GateInfo['kind'] =
      /portal/.test(blob) ? 'portal' : /workspace/.test(blob) ? 'workspace' : /school|tenant|organi|company/.test(blob) ? 'tenant' : /consent|terms|agree/.test(blob) ? 'consent' : 'menu';
    // FILTER the cue/heading out of the options (the scraped "Choose Portal :" heading is not a clickable option).
    const cueNorm = info.cue.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const options = info.rows.filter((r: any) => { const n = r.label.toLowerCase().replace(/[^a-z ]/g, '').trim(); return n && n !== cueNorm && !/^choose |^select |^pick /.test(n); });
    if (options.length < 3) return null;
    // options carry their resolvable identity (shared deriver+verifier) so a gate-seeded click-path edge is
    // identity-bearing, same as a click-explore edge — ONE deriver, every discovery path.
    return { path: safePath(page.url()), kind, options: options.map((r: any) => ({ label: r.label, elementId: { tier: r.tier, css: r.css, name: r.name, verifiedAtCapture: r.verified, ambiguityCount: r.ambiguity } })), reason: `picker cue: "${info.cue}"` };
  } catch { return null; }
}

async function waitForHydration(page: Page): Promise<void> {
  try {
    // PHASE 1: wait for the FIRST content to appear (root filled OR an interactive control).
    await page.waitForFunction(() => {
      const d: any = (globalThis as any).document;
      const interactive = d.querySelectorAll('a[href], button, [role="button"], [role="link"], input, select, [onclick]').length;
      const root = d.querySelector('#root, #app, [data-reactroot], main');
      const rootFilled = root && root.children && root.children.length > 0;
      return interactive > 0 || rootFilled;
    }, { timeout: HYDRATE_TIMEOUT, polling: 250 });
    // PHASE 2 — STABILIZE (the blank-dashboard fix, MEASURED on schooltalk: /nzcurriculum dashboard shows a 52-node
    // shell at 3-6s then jumps to 438 nodes / real content at ~15s). Returning on FIRST content captured that blank
    // shell → every school dashboard mapped shallow, calendar/events never found. So after first content, POLL the
    // node count until it stops growing (2 consecutive stable reads) — the true "finished hydrating" signal — capped.
    let prev = -1, stableStreak = 0;
    const cap = Date.now() + HYDRATE_TIMEOUT;
    while (Date.now() < cap) {
      const n = await page.evaluate(() => (globalThis as any).document.querySelectorAll('*').length).catch(() => -1);
      if (n > 0 && Math.abs(n - prev) <= 2) { if (++stableStreak >= 2) break; }   // node count settled
      else stableStreak = 0;
      prev = n;
      await page.waitForTimeout(700).catch(() => {});
    }
  } catch { /* nothing rendered in time — a real (empty/blocked) page; caller handles it honestly */ }
  await page.waitForTimeout(400).catch(() => {});   // final settle for late-mounting menus
}

/** goto + networkidle + hydration wait, with an HONEST error classification (DNS failure vs timeout vs blocked)
 * so an unreachable host is reported clearly instead of "struggling silently". Returns {ok, error?}. */
async function gotoRendered(page: Page, url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await waitForHydration(page);
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/ERR_NAME_NOT_RESOLVED|getaddrinfo|ENOTFOUND/i.test(msg)) return { ok: false, error: `“${safeHost(url)}” does not resolve (DNS) — the domain or subdomain doesn't exist. Check the exact URL.` };
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(msg)) return { ok: false, error: `connection refused at ${safeHost(url)} — the server isn't accepting connections.` };
    if (/ERR_CERT|SSL|certificate/i.test(msg)) return { ok: false, error: `TLS/certificate error at ${safeHost(url)}.` };
    if (/Timeout|timeout/i.test(msg)) return { ok: false, error: `${safeHost(url)} timed out after ${NAV_TIMEOUT / 1000}s — the page never became ready.` };
    return { ok: false, error: msg.slice(0, 160) };
  }
}
function safeHost(u: string): string { try { return new URL(u).host; } catch { return u; } }

// normalize a url so /users/123 and /users/456 collapse to one endpoint. NOTE (bug fix): the hex-id rule REQUIRES
// at least one DIGIT in the run — real opaque ids (uuids/hashes) always contain digits, but English words made of
// a–f letters ('/feedback', '/facade', '/decade') don't. Without this guard those words collapsed to '/:id' and,
// since normUrl is now the PAGE identity (routeKey), two distinct routes could share a key → one silently skipped.
export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname
      // a long hex segment that CONTAINS a digit = an id (uuid/hash); a pure a–f word is left alone
      .replace(/\/(?=[0-9a-f]{6,}(?:[/.]|$))(?=[a-f]*\d)[0-9a-f]{6,}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');
    // HASH-ROUTER SUPPORT: many SPAs route by hash (#/users, #settings, #!/plan) — the hash IS the route, and two
    // hashes are DIFFERENT states at the same pathname. Preserve a ROUTE-LIKE hash so `#settings` ≠ `#checkout` get
    // distinct routeKeys (else they all collapse to one and only the first is ever visited — the fixture Checkout gap).
    // A route-like hash is `#/foo`, `#!/foo`, or `#word(/word…)`; NOT a bare line/element anchor (`#L120`, `#top`,
    // `#`), which is same-page scroll, not a route. Normalize ids inside the hash the same way as the path.
    let hash = '';
    const h = (x.hash || '').replace(/^#!?\/?/, '');   // strip leading #, #!, #/
    if (h && /^[A-Za-z]/.test(h) && !/^L\d+$/.test(h) && h.toLowerCase() !== 'top') {
      const normH = h.replace(/\/(?=[0-9a-f]{6,}(?:[/.]|$))(?=[a-f]*\d)[0-9a-f]{6,}/gi, '/:id').replace(/\/\d+/g, '/:id');
      hash = '#' + normH;
    }
    return x.origin + path + hash;
  } catch { return u; }
}
// strip secret VALUES from a string (passwords/tokens/etc). Used for both the replayable payload and the response
// preview. Does NOT truncate — truncation is applied separately, ONLY to display-only strings.
function redactSecrets(s?: string): string | undefined {
  if (!s) return s;
  return s.replace(/("?(?:password|token|secret|authorization|apikey|api_key)"?\s*[:=]\s*)"?[^",}\s]+/gi, '$1"***"');
}
// DISPLAY-ONLY redaction: redact secrets AND cap length for a compact preview. NEVER use for a payload that will be
// REPLAYED — the .slice() corrupts JSON mid-string ("Unterminated string in JSON at position 400") → a replay of the
// truncated body 400s → Xsion fabricates "your API is broken" out of its OWN recording bug. (Confirmed root cause of
// the dent API-test false failures: every GraphQL query with a >400-char payload "failed" at exactly position 400.)
function redact(s?: string): string | undefined {
  if (!s) return s;
  return redactSecrets(s)!.slice(0, 400);
}

export interface CrawlOpts {
  baseUrl: string; repo?: string; email?: string; password?: string;
  // MULTI-ROLE (item 4): crawl AS this role. Its id tags every entity found; merges into the existing map so
  // crawling role B adds to role A's map rather than overwriting it. Omitted = the default single-role crawl.
  role?: { id: string; name: string };
  // CONTINUE-EXPLORING (BUG 2 fix): resume from the persisted frontier + known-unknowns even on a 'done' map, so
  // "continue where it left off" works after the user validates flows. Requeues everything not yet visited.
  resume?: boolean;
}

/** Kick off a crawl-map run: returns runId immediately, streams over WS, persists the map to the project. */
export function startCrawlMap(projectId: string, opts: CrawlOpts): string {
  const runId = uuid();
  runCrawl(runId, projectId, opts).catch((e) => {
    emit(runId, { type: 'crawl:think', message: `crawl error: ${String(e.message || e)}` });
    emit(runId, { type: 'crawl:phase', phase: 'done', label: 'Crawl failed' });
  });
  return runId;
}

async function runCrawl(runId: string, projectId: string, opts: CrawlOpts) {
  const { baseUrl, repo } = opts;
  const roleId = opts.role?.id;   // when set, every entity found is tagged with this role id (item 4)
  emit(runId, { type: 'crawl:phase', phase: 'launch', label: 'Opening a browser' });
  emit(runId, { type: 'crawl:think', message: `Starting to explore ${baseUrl}. I'll map the pages, the flows, and the API calls each action fires.` });

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installEvalShim(context);   // define __name in the page context (tsx/esbuild keepNames bug — see evalShim.ts)
  const page = await context.newPage();
  // AUTO-DISMISS DIALOGS: a click that triggers alert()/confirm()/prompt() BLOCKS every subsequent Playwright
  // action → the crawl hangs forever (this is exactly what stopped it after the first portal). Always dismiss so
  // the crawl keeps moving. (We already denylist destructive verbs; this catches the rest.)
  page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  // ── API-inventory capture (the BE surface) ──
  const apiMap = new Map<string, ApiEndpoint>();
  // PASSIVE-OBSERVATION current-action stamp: the UI action in flight when a call fires (set before each click). The
  // response handler reads it → action→API edges ("Create Event" → POST /event) + the post-submit oracle signal.
  let currentAction: string | undefined;
  // entity from a REST path: the last non-id, non-verb path segment (…/teacher/event → "event"). Structural, no vocab.
  const entityOf = (u: string): string | undefined => {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean)
        .filter((s) => !/^\d+$/.test(s) && !/^[0-9a-f-]{16,}$/i.test(s) && !/^(api|v\d+|graphql)$/i.test(s));
      const last = segs[segs.length - 1] || '';
      return last ? last.replace(/[-_]/g, ' ').toLowerCase().replace(/s$/, '') : undefined;   // singularize lightly
    } catch { return undefined; }
  };
  // JSON KEY names only (shapes, never values) from a payload/response body. Flat top-level keys (+ keys of the first
  // object in a top-level array), capped. Safe on non-JSON (returns []).
  const jsonKeys = (body?: string): string[] => {
    if (!body) return [];
    try {
      const o = JSON.parse(body);
      const src = Array.isArray(o) ? (o[0] || {}) : (o && o.data && typeof o.data === 'object' ? o.data : o);
      return (src && typeof src === 'object') ? Object.keys(src).slice(0, 40) : [];
    } catch { return []; }
  };
  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const url = req.url();
      if (!/\/(api|graphql|v\d)\b|\.(json)$/i.test(url) && req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      const payload = req.postData() || undefined;
      const gql = parseGraphql(payload);
      // KEY: a GraphQL endpoint is ONE url — key by OPERATION so distinct operations don't collapse into
      // "POST /graphql". REST keys by method+url as before.
      const key = gql.graphql ? `GQL ${gql.gqlKind}:${gql.gqlOperation}` : `${req.method()} ${normUrl(url)}`;
      const status = resp.status();
      const isWrite = /^(POST|PUT|PATCH|DELETE)$/i.test(req.method()) || gql.gqlKind === 'mutation';
      let ep = apiMap.get(key);
      if (!ep) {
        ep = { method: req.method(), url: normUrl(url), statuses: [], count: 0, firstSeenOnPath: safePath(page.url()) };
        ep.samplePayload = redactSecrets(payload);   // REPLAYABLE — redact secrets but do NOT truncate (kept valid JSON)
        let respBody = '';
        try { respBody = await resp.text(); ep.sampleResponse = redact(respBody); } catch {}   // display-only → truncation ok
        if (gql.graphql) { ep.graphql = true; ep.gqlKind = gql.gqlKind; ep.gqlOperation = gql.gqlOperation; }
        if (roleId) ep.roles = [roleId];
        // GROWTH: capability (writes), entity (from url), and shape-only field names (never values).
        if (isWrite) ep.writes = true;
        const ent = entityOf(url); if (ent) ep.entity = ent;
        const rf = jsonKeys(payload); if (rf.length) ep.reqFields = rf;
        const sf = jsonKeys(respBody); if (sf.length) ep.respFields = sf;
        apiMap.set(key, ep);
        emit(runId, { type: 'crawl:api', endpoint: ep });
      }
      if (roleId && ep.roles && !ep.roles.includes(roleId)) ep.roles.push(roleId);
      // stamp the triggering UI action (action→API edge) — accumulate distinct labels, capped.
      if (currentAction) { ep.firedBy = ep.firedBy || []; if (!ep.firedBy.includes(currentAction) && ep.firedBy.length < 8) ep.firedBy.push(currentAction); }
      ep.count++;
      if (!ep.statuses.includes(status)) ep.statuses.push(status);
    } catch {}
  });
  // expose the action-stamp setter so the click loop can mark "what am I clicking right now" before each interaction.
  (page as any).__xsionSetAction = (label?: string) => { currentAction = label; };

  const pages: MappedPage[] = [];
  // THE INTERACTION GRAPH (CRAWL-b): every transition (fromSig, action, toSig) the crawl walks, deduped by
  // from+action+to. Previously computed via _parentSig→currentSig then DISCARDED; now persisted as the state-flow
  // graph so a consumer can answer "what does clicking X do / what connects to what."
  const edgeMap = new Map<string, GraphEdge>();
  const visitedPaths = new Set<string>();     // keyed by ROUTE TEMPLATE (normUrl) so /users/1 & /users/2 collapse
  // the page budget is SIZED OFF THE MANIFEST (fix): a fresh crawl starts at the floor, but when SoA returns N
  // navigable routes we raise it to fit them (up to a hard cap) so a perfect manifest isn't clipped below its own
  // route count. Anchor-harvested links spend whatever budget is left after the manifest routes.
  let maxPages = BASE_MAX_PAGES;
  let reachedLimit = false;
  // TWO SEPARATE SoA budgets (#211): the STALL path (mechanical added===0) and the PLATEAU path (novelty stalled but
  // the mechanical pass still queued something) each get their OWN allowance. Before this they shared one cap, so the
  // stall path always exhausted it first and the plateau trigger could NEVER fire (plateauFires=0 across every run).
  let stallSoaCalls = 0;
  let plateauSoaCalls = 0;
  const MAX_SOA_EXPLORE = Number(process.env.XSION_MAX_SOA_EXPLORE || 3);         // stall-path cap
  const MAX_PLATEAU_SOA = Number(process.env.XSION_MAX_PLATEAU_SOA || 4);         // plateau-path cap (separate)
  const soaExploreCalls = () => stallSoaCalls + plateauSoaCalls;                   // total, for the cost metric
  let routeManifestOut: { path: string; requiresAuth: boolean; role: string }[] | undefined;
  let flowsSoFar: any[] = [];
  // BFS frontier — the still-unvisited queue. Persisted so a killed/refreshed crawl RESUMES from it (the
  // resume-never-continues bug fix: without this, a resume re-seeds visited with the root and the queue empties
  // on the first iteration). knownUnknowns = routes we saw but the budget/cap kept us from visiting.
  // THE FRONTIER IS A CLICK-PATH, NOT A URL (the Choose-Portal fix). Many SPA navigations (a MUI <li> portal, a
  // tab) swap content IN PLACE with NO url change — so a URL frontier can't address them (they all collapse to
  // '/'). A Nav = a url PLUS an ordered list of click labels to replay from that url. That makes the portal's
  // inner view a first-class, addressable frontier entry the crawl can enter and resume into.
  const queue: Nav[] = [];
  // ── EXPLORATION ARM (the A/B matrix) — 'bfs' (default = control, byte-identical to before) | 'curiosity' |
  // 'soa-semantic' | 'code-seeded' | 'hybrid'. The tracker owns the state-model + metrics + the pick-next policy.
  // When the arm is 'bfs' the tracker's pickNext is FIFO shift, so the loop behaves exactly as it always did; the
  // ONLY added work is a cheap captureShape() per page (for metrics), which is harmless to the control.
  const exploreArm = ((process.env.XSION_EXPLORE_ARM || 'bfs') as ArmName);
  const tracker = new ExploreTracker<Nav>(exploreArm, 0);   // budget set after maxPages is finalized (below)
  let currentSig: string | undefined;                        // signature of the state we're currently on (parent for enqueues)
  // COLLAPSE (crawl-budget fix): shapes we've entered, so a structural DUPLICATE (same sig + similar content) is
  // recorded-not-deep-crawled — freeing budget for unseen surface. Content-divergent variants still enter (data).
  const seenShapes: Array<{ sig: string; contentVolume?: number; pageIndex: number; routeKey?: string }> = [];
  const gates: import('./crawlTypes').GateInfo[] = [];       // decision-hubs (portal/workspace/tenant pickers)
  // rolling novelty window for the plateau trigger (soa/hybrid): novel states found in the last WINDOW visits.
  const NOVELTY_WINDOW = Number(process.env.XSION_NOVELTY_WINDOW || 8);
  const recentNovel: boolean[] = [];
  const knownUnknowns = new Set<string>();
  // OPEN-TO-LEARN-THE-FORM: forms already harvested this run, keyed by control label → skip re-opening the SAME
  // control on every state (e.g. "Create Group" is identical across all 6 schools — harvest once, reuse). Big cost win.
  const learnedForms = new Map<string, Array<{ label: string; kind: string; required: boolean; placeholder?: string }>>();
  const seenTabLabels = new Set<string>();   // (route-template, tab-label) pairs already queued — kills tab-permutation explosion (csc-2)
  // CRAWL-WIDE PROBED-NAV set (2026-08-29 perf fix): a PERSISTENT nav menu (sidebar/topbar present on every page) must
  // be PROBED ONCE per crawl, not re-probed on every page. Before this, the BFS reached each of admin's 9 views by
  // click-path, re-ran safeClickExplore on each, and re-probed the SAME 9-item nav each time — 9 pages × ~10 nav
  // probes × 1 reload-restore = the reload STORM that looked like a stall. A nav label whose view is already mapped
  // (in visitedPaths) never needs re-probing. Keyed on the bare label (a persistent nav label is identical everywhere).
  const probedNavLabels = new Set<string>();
  const KU_CAP = 200;   // knownUnknowns is written to db.json every autosave — cap it so a link-dense app can't bloat
  let kuDropped = 0;
  const noteUnknown = (u: string) => { if (knownUnknowns.size < KU_CAP) knownUnknowns.add(u); else kuDropped++; };
  // routeKey: the completeness identity of a URL — origin + normalized path (ids → :id).
  const routeKey = (u: string): string => { try { return normUrl(u); } catch { return u; } };
  // navKey: the identity of a NAV (url template + the click-path). '/ ::Demo School' ≠ '/ ::Doon School' ≠ '/'.
  const navKey = (n: Nav): string => routeKey(n.url) + '::' + (n.clicks || []).map(stepLabel).join('>');
  const navPath = (n: Nav): string => safePath(n.url) + (n.clicks?.length ? ' › ' + n.clicks.map(stepLabel).join(' › ') : '');

  // INCREMENTAL PERSISTENCE (the beast-plan bug fix): write the partial map to the DB at EVERY discovery point,
  // so a refresh resumes from what's found so far and a killed/timed-out crawl keeps its progress. status tracks
  // whether the crawl is still running vs done; frontier + knownUnknowns make coverage checkable.
  const save = (status: 'crawling' | 'done') => {
    let outPages = pages;
    let outApi = [...apiMap.values()];
    let outFlows = flowsSoFar;
    let roles: any[] | undefined;

    // MULTI-ROLE MERGE (item 4): when crawling AS a role, fold this role's findings INTO the existing map
    // (union by identity, union the roles[] tag) so role B adds to role A's map instead of clobbering it.
    if (roleId) {
      const prev = (store as any).getProjectMap?.(projectId) as ProjectMap | undefined;
      roles = mergeRoleRoster(prev?.roles, opts.role!, !!(opts.email && opts.password), status === 'done');
      if (prev) {
        outPages = mergeByKey(prev.pages, pages, (p) => routeKey(p.url || p.path), roleId);
        outApi = mergeByKey(prev.api, [...apiMap.values()], apiKey, roleId);
        // flows are only synthesized at 'done'; until then keep the previous role's flows, then union at the end
        outFlows = flowsSoFar.length ? mergeByKey(prev.flows || [], flowsSoFar, (f) => `${f.role}:${f.name}`, roleId) : (prev.flows || []);
      }
    }

    // EDGES (CRAWL-b): union this crawl's edges with a prior role's edges (dedup by from+action+to) when crawling
    // as a role, so the graph accumulates across roles like pages/api do; else just this crawl's edges.
    let outEdges = [...edgeMap.values()];
    if (roleId) {
      const prev = (store as any).getProjectMap?.(projectId) as ProjectMap | undefined;
      if (prev?.edges?.length) {
        // UPGRADE-AWARE union: dedup on the BASE key (fromSig|kind:label|toSig) so a prior-crawl edge that lacks a
        // selector and a new edge that has one for the SAME transition are recognized as the same edge (the richer,
        // selector-bearing one already in outEdges wins) — otherwise every post-upgrade crawl would double every edge
        // and mapDiff would report phantom churn. edgeKey (full) governs WITHIN-crawl splitting; the cross-crawl merge
        // uses the base so identity upgrades don't fork history.
        const seen = new Set(outEdges.map(edgeBaseKey));
        for (const e of prev.edges) { const k = edgeBaseKey(e); if (!seen.has(k)) { outEdges.push(e); seen.add(k); } }
      }
    }

    const map: ProjectMap = {
      baseUrl, mode: repo ? 'code' : 'blackbox', repo, pages: outPages, flows: outFlows, api: outApi,
      edges: outEdges.length ? outEdges : undefined,
      crawledAt: new Date().toISOString(),
      bounded: { maxPages, maxActionsPerPage: MAX_ACTIONS, reachedLimit },
      status,
      frontier: [...queue],
      knownUnknowns: [...knownUnknowns],
      gates: gates.length ? [...gates] : undefined,
      routeManifest: routeManifestOut,
      roles,
    };
    (store as any).saveProjectMap?.(projectId, map);
    return map;
  };
  // enqueue a candidate NAV (a same-origin URL, optionally + a click-path) iff its navKey is un-visited and not
  // already queued. A bare URL string is accepted for convenience. Returns true if enqueued.
  let enqueueSeq = 0;
  const enqueue = (cand: string | Nav): boolean => {
    const nav: Nav = typeof cand === 'string' ? { url: cand } : cand;
    let abs: URL;
    try { abs = new URL(nav.url); } catch { return false; }
    if (abs.origin !== new URL(baseUrl).origin) return false;
    nav.url = abs.href;
    const k = navKey(nav);
    if (visitedPaths.has(k)) return false;                        // already mapped this url+click-path
    if (queue.some((q) => navKey(q) === k)) return false;         // already frontier
    // stamp the discovering state (parent) + a monotonic seq so the curiosity arm can rank this entry by parent-
    // novelty and tie-break stably to FIFO. Inert for the bfs arm. (Nav is already an extensible object.)
    (nav as any)._parentSig = currentSig;
    (nav as any)._seq = enqueueSeq++;
    queue.push(nav);
    return true;
  };

  // resume: restore FRONTIER + visited from a partial 'crawling' map so a re-run CONTINUES instead of terminating.
  // ROLE-AWARE: a NEW role must RE-CRAWL every route to record ITS OWN coverage (it may see different access), so
  // for a new-role crawl we DON'T seed visited from another role's pages — only resume the SAME role's own
  // interrupted crawl (its pages already carry this roleId). The route manifest is reused regardless (it's the
  // declared surface, role-independent).
  const existing = (store as any).getProjectMap?.(projectId);
  if (existing?.routeManifest) routeManifestOut = existing.routeManifest;   // manifest is role-independent, always reuse
  const resumingSameRole = !roleId || (existing?.pages || []).some((p: any) => (p.roles || []).includes(roleId));
  // resume when the crawl was interrupted (status 'crawling') OR the user EXPLICITLY asked to continue exploring
  // a completed map (opts.resume) — in which case the known-unknowns become fresh frontier to work through.
  // HONEST login-gated resume: if the user asked to CONTINUE but the previous crawl never got past the login
  // (0 pages mapped) and we STILL have no working creds, do NOT silently re-crawl into the same wall — say so.
  if (opts.resume && !(existing?.pages?.length) && !(opts.email && opts.password)) {
    emit(runId, { type: 'crawl:think', message: 'There\'s nothing to continue yet — the last crawl never got past the login, so there are no mapped pages behind it. I need working credentials to go further.' });
    emit(runId, { type: 'crawl:phase', phase: 'await-creds', label: 'Login needed to continue' });
    emit(runId, { type: 'crawl:need-creds', forUrl: baseUrl, message: 'To continue, I need credentials that actually sign in — the previous attempt stayed on the login screen.' });
    save('crawling');
    await browser.close();
    return;
  }

  const shouldResume = existing?.pages?.length && resumingSameRole && (existing.status === 'crawling' || opts.resume);
  if (shouldResume) {
    for (const pg of existing.pages) {
      if (!roleId || (pg.roles || []).includes(roleId)) {
        pages.push(pg);
        // mark this page's NAV as visited so resume doesn't re-crawl it. Use the stored navKey if present, else
        // reconstruct from url (legacy pages have no click-path).
        visitedPaths.add(pg.navKey || navKey({ url: pg.url || pg.path, clicks: pg.clicks }));
      }
    }
    for (const f of (existing.frontier || [])) queue.push(typeof f === 'string' ? { url: f } : f);   // coerce legacy string frontier
    // on an explicit continue, promote the known-unknowns (budget-clipped routes) back into the frontier to explore
    if (opts.resume) {
      // promote budget-clipped known-unknowns back to frontier — but ONLY the ones that are real URLs (legacy/
      // anchor routes). Click-path unknowns are stored as display strings ("/x › Label") which aren't URLs; those
      // are already preserved in the frontier Navs above, so skip un-parseable ones (don't create broken URLs).
      for (const u of (existing.knownUnknowns || [])) { if (/›/.test(u)) continue; try { enqueue(new URL(u, baseUrl).href); } catch {} }
      maxPages = Math.min(MAX_PAGES_CAP, (existing.bounded?.maxPages || BASE_MAX_PAGES) + BASE_MAX_PAGES);  // grow the budget so it actually goes further
    } else {
      // restore prior known-unknowns — but DROP stale 'choice:' entries. A previous run's over-broad choice capture
      // (calendar day-cells, colour chips, digit fragments) would otherwise be inherited forever and evict real
      // unknowns under KU_CAP. Fresh choices are re-recorded this run (now gated on real choosers), so nothing true
      // is lost; only the accumulated junk is dropped. URL/route unknowns still restore.
      for (const u of (existing.knownUnknowns || [])) { if (String(u).startsWith('choice:')) continue; noteUnknown(u); }
      if (typeof existing.bounded?.maxPages === 'number') maxPages = existing.bounded.maxPages;
    }
    emit(runId, { type: 'crawl:think', message: `${opts.resume ? 'Continuing exploration' : 'Resuming'} — ${pages.length} pages already mapped, ${queue.length} routes queued. Going further than before.` });
  } else if (roleId) {
    emit(runId, { type: 'crawl:think', message: `Crawling as role “${opts.role!.name}” — mapping this role's own view of the app.` });
  }
  // autosave every 3s — catches the ASYNC api-capture stream (which fires outside the crawl loop), so recorded
  // endpoints persist even if the crawl is killed between page discoveries.
  const autosave = setInterval(() => save('crawling'), 3000);

  // ── CONTINUOUS SCREENSHOT STREAM (FPS fix): frames were only captured once per navigation (~2 FPS). Drive a
  // TIMER that streams a frame every ~220ms (~4.5 FPS) independent of the crawl, fire-and-forget so it never
  // blocks navigation. A guard prevents overlapping captures (a screenshot can take >220ms on a heavy page).
  let capturing = false;
  const frameTimer = setInterval(async () => {
    if (capturing) return;   // skip if the previous capture hasn't finished (heavy pages take >interval)
    capturing = true;
    try { await streamFrame(runId, page); } catch {} finally { capturing = false; }
  }, 120);   // aim ~8 FPS; real rate is bounded by encode time (~3-5 FPS on live SPAs), but always continuous

  try {
    // ── initial nav (with hydration wait + honest error if the host is unreachable) ──
    emit(runId, { type: 'crawl:phase', phase: 'crawl', label: 'Exploring the app' });
    const nav0 = await gotoRendered(page, baseUrl);
    if (!nav0.ok) {
      emit(runId, { type: 'crawl:think', message: `Could not open ${baseUrl}: ${nav0.error}` });
      emit(runId, { type: 'crawl:phase', phase: 'done', label: 'Could not reach the site' });
      save('done');
      return;
    }
    await streamFrame(runId, page);

    // ── credential gate (the one blocking prompt) ──
    const _isLoginPage = await looksLikeLogin(page);
    console.log(`[XSION][crawl] run=${runId.slice(0,8)} landed url=${page.url()} looksLikeLogin=${_isLoginPage} hasCreds=${!!(opts.email && opts.password)}`);
    // L0-c HONESTY INVARIANT tracking. TWO INDEPENDENT signals, deliberately NOT derived from the detector (a detector
    // false-negative must not be able to disable the guard that catches a detector false-negative — the exact hole a
    // regressed schooltalk run exposed):
    //   • sessionEstablished — set true ONLY in the login-success branch. Nothing else. (NOT `!_isLoginPage`.)
    //   • everSawAuthedAffordance — set true from ACTUAL per-page observation in the crawl loop (a page that shows an
    //     authed-app affordance). Never inferred.
    // Tripwire = tiny map AND never-saw-authed-affordance AND never-logged-in → blocked. No live DOM re-read, no race.
    const landingWasLoginGated = _isLoginPage;
    let sessionEstablished = false;
    let everSawAuthedAffordance = false;
    // REUSABLE LOGIN (2026-08-29): hoisted so a reload that bounces a login-gated SPA back to its sign-in screen can be
    // RE-established mechanically (ensureSession, below) — WITHOUT re-running the tri-state emit/return control flow.
    const knownAppRoute = (u: string) => { try { const p = new URL(u).pathname; return !!p && !/^\/?login\b/i.test(p.replace(/^\//, '')); } catch { return false; } };
    const attemptLogin = async (): Promise<boolean> =>
      !!(opts.email && opts.password) &&
      (await tryLoginSettled(page, opts.email!, opts.password!, { knownAppRoute })) === 'signed-in';
    // ENSURE-SESSION (2026-08-29, the reload-kills-session fix): a login-gated SPA whose SESSION is in-memory (only
    // localStorage DATA survives) bounces to the login screen on ANY full document reload. After a reload, re-establish
    // the session iff we ACTUALLY got bounced to the gate. GUARD (regression-review): NOT looksLikeLogin (which fires on
    // any authed page that renders a password field — Settings/Change-Password — and would submit creds into that app
    // form). Require the STRUCTURAL bounce signal: a password field present AND no authed (non-nav) affordances = the
    // bare login screen. On a real page that legitimately shows a password field, authed affordances are present → no-op.
    const ensureSession = async (): Promise<boolean> => {
      if (!landingWasLoginGated || !opts.email || !opts.password) { if (process.env.XSION_CRAWL_DEBUG) emit(runId, { type: "crawl:think", message: `[ensureSession] skip (gated=${landingWasLoginGated})` }); return false; }
      const { authSignals } = await import('./authSignals');
      const sig = await authSignals(page).catch(() => null as any);
      const bounced = !!sig && sig.hasPasswordField && (sig.authedAffordances || []).filter((a: string) => !a.startsWith('__nav')).length === 0;
      if (process.env.XSION_CRAWL_DEBUG) emit(runId, { type: "crawl:think", message: `[ensureSession] pw=${sig?.hasPasswordField} authed=${(sig?.authedAffordances||[]).length} bounced=${bounced} url=${safePath(page.url())}` });
      if (!bounced) return false;   // still in-app (or a real password page) → do NOT re-submit creds
      const ok = await attemptLogin();
      if (process.env.XSION_CRAWL_DEBUG) emit(runId, { type: "crawl:think", message: `[ensureSession] re-login → ${ok}` });
      if (ok) { sessionEstablished = true; return true; }
      return false;
    };
    if (_isLoginPage) {
      if (opts.email && opts.password) {
        emit(runId, { type: 'crawl:think', message: 'This app requires a login. Signing in with the credentials you provided…' });
        console.log(`[XSION][crawl] attempting login with provided creds…`);
        // TRI-STATE (L0-a): distinguish rejected (wrong creds → clear) from indeterminate (slow/unknown → KEEP creds,
        // report blocked, never map the login page as the app). knownAppRoute: any non-/login route counts as in-app.
        const _outcome = await tryLoginSettled(page, opts.email, opts.password, { knownAppRoute });
        const ok = _outcome === 'signed-in';
        console.log(`[XSION][crawl] login outcome=${_outcome} url=${page.url()}`);
        if (ok) {
          sessionEstablished = true;   // L0-c: we earned a session — the final status may legitimately be 'done'
          // ── POST-LOGIN SEED (general-app fix): DON'T blindly re-navigate to baseUrl. For many apps the root URL
          // IS the login route (saucedemo `/`, any app that renders its sign-in form at `/`), so re-visiting baseUrl
          // logs us straight back OUT to the login page → the BFS then seeds from the login form (0 useful pages).
          // Instead START THE BFS FROM WHERE LOGIN LANDED US (the authenticated home, e.g. `/inventory.html`). Only
          // re-navigate to baseUrl when login left us somewhere that STILL looks like a login gate (rare).
          const landedUrl = page.url();
          const landedStillLogin = await looksLikeLogin(page, { noWait: true }).catch(() => false);   // fast one-shot: the 10s wait is for the LANDING decision, not a post-login re-check
          if (landedStillLogin) { try { await gotoRendered(page, baseUrl); } catch {} }
          emit(runId, { type: 'crawl:think', message: `Signed in — landed on ${safePath(page.url())}. Exploring the authenticated app from here (not re-visiting the login route).` });
          // seed the BFS frontier from the authenticated landing page, so we never map the login form as the app.
          if (!landedStillLogin && landedUrl) { try { if (enqueue(landedUrl)) { /* seeded from post-login home */ } } catch {} }
          await streamFrame(runId, page);
        } else if (_outcome === 'rejected') {
          // REJECTED — the form is still up WITH an auth error near it: the creds are genuinely wrong. Clear the
          // stored bad creds and re-prompt. Do NOT map the login page as if it were the app.
          if (!roleId) { try { (store as any).updateProject?.(projectId, { _defaultCreds: undefined }); } catch {} }
          emit(runId, { type: 'crawl:think', message: 'Those credentials did not sign in — the app rejected them (wrong email/password). I won\'t map the login page as if it were the app.' });
          emit(runId, { type: 'crawl:phase', phase: 'await-creds', label: 'Login failed — need correct credentials' });
          emit(runId, { type: 'crawl:need-creds', forUrl: page.url(), message: 'Sign-in failed with those credentials. Enter the correct email and password and I\'ll continue.' });
          save('crawling');   // keep status 'crawling' so a re-run with correct creds resumes cleanly
          await browser.close();
          return;
        } else {
          // INDETERMINATE — no terminal sign-in signal within the cap (slow app, SSO/consent redirect, or a shape we
          // can't verify). CRITICAL: the creds may be CORRECT (dent's were) — do NOT clear them and do NOT blame the
          // user. Report BLOCKED honestly (never map the login page as the app, never say 'done'). L0-c invariant.
          emit(runId, { type: 'crawl:think', message: 'I submitted the credentials but couldn\'t confirm I got into the app within the time limit (the app may be slow, or it uses an SSO/consent step I can\'t complete). I\'m stopping here rather than mapping the login screen as if it were the app.' });
          emit(runId, { type: 'crawl:phase', phase: 'await-creds', label: 'Could not confirm sign-in — blocked at the login gate' });
          emit(runId, { type: 'crawl:need-creds', forUrl: page.url(), message: 'Couldn\'t confirm sign-in. If the credentials are correct the app may be slow or use SSO/consent Xsion can\'t automate — re-run, or provide a path that lands directly in the app.' });
          save('crawling');   // NOT 'done' — a login-gated crawl with no session is blocked, not complete (keeps creds).
          await browser.close();
          return;
        }
      } else {
        emit(runId, { type: 'crawl:phase', phase: 'await-creds', label: 'Waiting for credentials' });
        emit(runId, { type: 'crawl:need-creds', forUrl: page.url(), message: 'This app needs a login before I can explore it. Enter credentials and I\'ll continue.' });
        // park: the route re-invokes with creds; for v1 we end here awaiting the client to re-run with creds.
        save('crawling');
        await browser.close();
        return;
      }
    }

    // ── SPA ROUTE-MANIFEST SEED (Mode 1 completeness): the crawler follows <a href>, but SPA routes live in the
    // ROUTER, not anchors. In code mode, SoA reads the router → the full declared route list → seed the frontier
    // with them so whole sections aren't missed. Zero clicks, no live-app mutation (the crawler's safe lane).
    // Skipped on resume (frontier already restored) and in black-box mode (no code to read).
    // ── ROUTE-MANIFEST READ (Mode 1 code-skeleton): fires on a FRESH crawl with a repo, whether or not the queue is
    // already seeded. BUGFIX: the old `queue.length === 0` guard was defeated by the post-login landing seed (line
    // ~443 enqueues the authenticated home), so on ANY login-gated app the manifest was NEVER read → Mode-1 lost its
    // whole code advantage (dent got routeManifest=0, converged to Mode-2 coverage). The manifest routes MERGE with
    // the post-login seed — both feed the same frontier. Gate on `!routeManifestOut` so it's still skipped on resume.
    if (repo && pages.length === 0 && !routeManifestOut) {
      try {
        emit(runId, { type: 'crawl:think', message: 'Reading the app’s router to find every route up front, so no section is missed…' });
        console.log(`[XSION][crawl] reading route-manifest from repo (queue already has ${queue.length} seed(s))`);
        const { routes, error } = await routeManifest(repo);
        if (error) emit(runId, { type: 'crawl:think', message: `Route-manifest note: ${error} — falling back to link-following.` });
        if (routes.length) routeManifestOut = routes;   // persist into the map for item 3 (field reqs) + item 4 (roles)
        let seeded = 0;
        for (const r of routes) {
          // param routes (/users/:id) need a real id to resolve → record as a data-gated unknown, don't 404-seed.
          if (/:[A-Za-z]/.test(r.path) || r.path.includes('*')) { noteUnknown(r.path); continue; }
          try { if (enqueue(new URL(r.path, baseUrl).href)) { seeded++; (queue[queue.length - 1] as any)._seed = true; } } catch {}
        }
        tracker.seededRoutes = seeded;
        // ── CODE-SEED-THEN-CLICK (the lever the experiment pointed at): the code oracle reaches the route SKELETON
        // cheaply (1 manifest read) AND surface click-discovery can NEVER address (role-gated /owner /team-member
        // entry points a customer-flow crawl has no links to). But the DEEP interaction surface (pagination, entity
        // detail, in-page tabs) lives ONLY in clicks. So one run should do BOTH: drain the code skeleton first, THEN
        // spend real budget on click-discovery. The old sizing gave the click phase only ~BASE/2 headroom, so on a
        // route-rich app it never ran (sloxt Mode-1's leftover frontier was all bare seeded routes, 0 click-paths).
        // NEW sizing: skeleton + a click allowance = CLICK_RATIO × the skeleton, so depth gets budget proportional
        // to breadth. Default on when a repo is present; tunable/off via env.
        if (seeded) {
          const codeSeedThenClick = (process.env.XSION_CODE_SEED_THEN_CLICK ?? '1') !== '0';
          const clickRatio = Number(process.env.XSION_CLICK_RATIO || 1);
          const clickAllowance = codeSeedThenClick ? Math.max(BASE_MAX_PAGES, Math.ceil(seeded * clickRatio)) : Math.ceil(BASE_MAX_PAGES / 2);
          maxPages = Math.min(MAX_PAGES_CAP, Math.max(BASE_MAX_PAGES, seeded + 1 + clickAllowance));
          emit(runId, { type: 'crawl:think', message: `Skeleton: SoA read the router → ${routes.length} declared routes, queued ${seeded} (code-seeded). Budget sized to ${maxPages} = ${seeded} skeleton + ~${clickAllowance} for click-discovery of the deep surface (pagination, entity detail, tabs) the router can't declare.` });
        }
      } catch (e: any) {
        emit(runId, { type: 'crawl:think', message: `Could not read routes from code (${String(e?.message || e).slice(0, 80)}); following links instead.` });
      }
    }

    // ── bounded BFS crawl ── (queue may already be seeded by a resume/route-manifest; add the current page if empty)
    if (queue.length === 0) queue.push({ url: page.url() });
    else if (!queue.some((q) => navKey(q) === navKey({ url: page.url() }))) queue.unshift({ url: page.url() });
    tracker.setBudget(maxPages);
    while (queue.length && pages.length < maxPages) {
      // ARM-DRIVEN pick: bfs=FIFO (unchanged); curiosity/hybrid=highest parent-novelty (1/√N). See exploreStrategy.
      const nav: Nav = tracker.pickNextNav(queue as (Nav & { _parentSig?: string; _seq?: number })[])!;
      const k = navKey(nav);
      if (visitedPaths.has(k)) continue;   // this url+click-path already mapped (dup, or a resume re-queue)
      visitedPaths.add(k);
      const p0 = navPath(nav);   // e.g. "/" or "/ › Demo School"

      // load the url, then REPLAY the click-path (for in-place SPA views like a Choose-Portal <li>). If any click
      // can't be replayed, skip this nav. RELOAD FIRST WHEN THERE'S A CLICK-PATH: a prior nav may have left the
      // SPA on a different in-place view (e.g. Demo's dashboard), so we can't assume the base state — force a
      // fresh load so the click targets (the portal list) are actually present. (The bug that mapped only 1 portal.)
      const needsClicks = (nav.clicks || []).length > 0;
      if (needsClicks) {
        // ORIGIN RESTORE for a click-path (2026-08-29): the click-path replays FROM the base/authed-landing state, but
        // a prior probe left the SPA on a DIFFERENT in-place view. gotoRendered(base) is a same-document NO-OP when the
        // page is already at that href (fragment-only), so it does NOT reset the view → the replay clicks run on the
        // wrong view and fail ("Couldn't re-open"). page.reload() ALWAYS does a real document load (unlike goto-to-
        // same-url), which resets the SPA to its entry state; on an in-memory-session app that drops the session, so
        // ensureSession re-auths into a CLEAN landing (dashboard) where the nav labels the click-path targets exist.
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await waitForHydration(page); } catch { const g = await gotoRendered(page, nav.url); if (!g.ok) continue; }
        await ensureSession();
      } else if (page.url() !== nav.url) {
        const g = await gotoRendered(page, nav.url); if (!g.ok) continue;
        // RE-AUTH after the reload (in-memory-session SPA bounces to login). ensureSession is a no-op on apps whose
        // session survives reload.
        await ensureSession();
      }
      else await waitForHydration(page);
      let replayOk = true;
      for (const step of (nav.clicks || [])) {
        // PASSIVE API-OBSERVATION: stamp the action label so any API call this click fires is attributed to it
        // (action→API edge). Cleared after the settle so idle background polling isn't mis-attributed.
        const actionLabel = typeof step === 'string' ? step : `fill ${step.fill}`;
        (page as any).__xsionSetAction?.(actionLabel);
        const ok = typeof step === 'string'
          ? await clickByLabel(page, step)                    // click a label
          : await fillByLabel(page, step.fill, step.value);   // multi-step unlock: type into a field
        if (!ok) { replayOk = false; (page as any).__xsionSetAction?.(undefined); break; }
        await page.waitForTimeout(700); await waitForHydration(page);
        (page as any).__xsionSetAction?.(undefined);
      }
      if (!replayOk) { emit(runId, { type: 'crawl:think', message: `Couldn't re-open “${p0}” (the app changed) — skipping.` }); continue; }
      await streamFrame(runId, page);
      emit(runId, { type: 'crawl:navigate', url: page.url(), path: p0 });
      emit(runId, { type: 'crawl:think', message: `Looking at ${p0} — cataloguing what a user can do here.` });

      // ── SCROLL-TO-REVEAL (CRAWL-c): the crawler was viewport-only — anything below the fold or lazy-loaded (infinite
      // scroll, virtualized lists) was invisible, so a rich page looked as small as its first screen. Scroll the page
      // to trigger lazy render BEFORE capturing affordances, so the honest count + the graph see the whole page. Two
      // termination tests: scrollHeight-stall for GROWING pages, and a stable-key Set-size-stall for VIRTUALIZED lists
      // (where scrollHeight doesn't move because rows recycle). Safe — scrolling fires no click/mutation. Bounded.
      // PERF NOTE (cache REVERTED — recorded negative): caching revealByScroll per routeKey (25→6 scroll calls) BROKE
      // COLLAPSE on scroll-dependent pages: an infinite-scroll route revealed 125 rows on first visit (high
      // contentVolume) but only 25 on a CACHED re-visit (no scroll) → collapseDecision saw materially-different content
      // → ENTERED it as a data-variant instead of collapsing → #list went 1 page → 5. The scroll's revealed content
      // feeds the collapse signal, so it can't be cached without corrupting the map. The real perf lever is the
      // safeClickExplore restore()-reloads (the nr·cr term), not this. Left un-cached; correctness over speed.
      const _tScroll = Date.now();
      const reveal = await revealByScroll(page).catch(() => ({ scrolls: 0, grew: false, mode: 'error' as const, kinds: 0 }));
      console.log(`[XSION][perf] revealByScroll ${Date.now() - _tScroll}ms (scrolls=${reveal.scrolls} mode=${reveal.mode}) page=${p0}`);
      if (reveal.scrolls > 0) emit(runId, { type: 'crawl:think', message: reveal.mode === 'saturated'
        ? `Scrolled ${reveal.scrolls}× — the list kept growing but stopped showing NEW kinds of content (saw ${reveal.kinds} distinct kinds), so I stopped early instead of scrolling the whole feed.`
        : `Scrolled ${reveal.scrolls}× to reveal ${reveal.mode === 'virtualized' ? 'virtualized rows' : 'lazy/below-the-fold content'} before mapping.` });

      // ── RECORD THE STATE (the measurement substrate). Capture a content-based signature of the view we landed in,
      // set it as `currentSig` (parent for anything we enqueue from here), and feed the tracker (curiosity N +
      // metrics). Cheap single evaluate(); inert-but-harmless for the bfs control arm.
      const shape = await captureShape(page, routeKey(page.url()));
      if ((shape as any)._captureError) { tracker.noteCaptureError(); emit(runId, { type: 'crawl:think', message: `⚠ state-capture failed (${(shape as any)._captureError}) — this run's state metrics are INVALID.` }); }
      // TEMP PROBE: on each Dashboard, is it a rendered page (anchors + body) or an empty shell? (regression hunt)
      if (/Dashboard/.test(page.url())) { try { const dp = await page.evaluate(() => { const d: any = (globalThis as any).document; return { anchors: d.querySelectorAll('a[href]').length, bodyLen: ((d.body && d.body.innerText) || '').length, buttons: d.querySelectorAll('button,[role="button"]').length }; }); fs.appendFileSync('/tmp/xsion-dash-probe.log', `${page.url()}  anchors=${dp.anchors} buttons=${dp.buttons} bodyLen=${dp.bodyLen} cv=${shape.contentVolume}\n`); } catch {} }
      // TEMP PROBE: on each Calendar, is cv=0 a TIMING problem (bodyLen~0) or a MEASUREMENT blind spot (bodyLen big
      // but contentVolume's selectors miss the calendar grid)? bodyLen + per-selector counts settle it. See advisor.
      if (/Calendar/.test(page.url()) && !(nav.clicks || []).length) { try { const cp = await page.evaluate(() => { const d: any = (globalThis as any).document; const q = (s: string) => d.querySelectorAll(s).length; return { bodyLen: ((d.body && d.body.innerText) || '').length, li: q('li'), tr: q('tr'), rows: q('[role="row"],[role="listitem"]'), event: q('[class*="event" i]'), cell: q('[class*="cell" i],[class*="day" i],td'), buttons: q('button,[role="button"]') }; }); fs.appendFileSync('/tmp/xsion-cal-probe.log', `${page.url()}  cv=${shape.contentVolume} bodyLen=${cp.bodyLen} li=${cp.li} tr=${cp.tr} rows=${cp.rows} event=${cp.event} cell=${cp.cell} buttons=${cp.buttons}\n`); } catch {} }
      currentSig = sigFromShape(shape);
      {
        const { novel } = tracker.onState(currentSig);
        if (!(nav as any)._seed) { recentNovel.push(novel); if (recentNovel.length > NOVELTY_WINDOW) recentNovel.shift(); }
        if (novel && (nav.clicks?.length) && !(nav as any)._seed) tracker.clickDiscovered++;
      }

      // ── COLLAPSE DECISION (crawl-budget fix): is this a STRUCTURAL DUPLICATE of a page we already entered? If so,
      // record it as a variant on that page and SKIP deep-crawling its subtree — freeing budget for unseen surface.
      // A content-divergent variant (same shell, more data) or a new structure ENTERS. Degenerate captures never
      // collapse. GENERAL — collapses because sig+content match, names nothing app-specific. See stateSignature.ts.
      const decision = collapseDecision(shape, seenShapes);

      // ── RECORD THE INTERACTION-GRAPH EDGE (CRAWL-b): the transition that got us HERE. from = the state we were in
      // when this nav was enqueued (_parentSig); to = currentSig; action = the click that produced this nav (last
      // click-path step) or a bare navigate. Recorded for BOTH new and collapsed destinations (a collapse is a real
      // back-edge/loop — "clicking X returns to known state Y" is a relation worth keeping). Deduped by from+action+to.
      {
        const fromSig = (nav as any)._parentSig as string | undefined;
        const clicksArr = nav.clicks || [];
        const lastStep = clicksArr.length ? clicksArr[clicksArr.length - 1] : undefined;
        // L1-a: the durable selector of the control that produced THIS nav rides on the queued nav as _selector/
        // _selectorTier (set at enqueue, like _parentSig) — so element identity survives to the edge without touching
        // NavStep/navKey/replay. A click/fill action carries it; a bare navigate has none.
        const elementId = (nav as any)._elementId as GraphEdge['action']['elementId'] | undefined;
        const clickLabel = (nav as any)._clickLabel as string | undefined;   // set when a URL nav was CLICK-discovered
        const action: GraphEdge['action'] = lastStep === undefined
          ? (clickLabel && elementId
              // a URL nav reached by CLICKING a control (school-picker): a `click` edge WITH identity, not a bare navigate.
              ? { kind: 'click', label: clickLabel, elementId }
              : { kind: 'navigate', label: safePath(nav.url) })
          : (typeof lastStep === 'string'
              ? { kind: 'click', label: lastStep, ...(elementId ? { elementId } : {}) }
              : { kind: 'fill', label: `${lastStep.fill}=${lastStep.value}`, ...(elementId ? { elementId } : {}) });
        const toIsNew = decision.action !== 'collapse' && !seenShapes.some((s) => s.sig === currentSig);
        const ek = edgeKey({ fromSig, toSig: currentSig!, action });
        const existing = edgeMap.get(ek);
        if (existing) { existing.count = (existing.count || 1) + 1; }
        else edgeMap.set(ek, { fromSig: fromSig || '', toSig: currentSig!, action, toPath: p0, toIsNew, toCollapsed: decision.action === 'collapse', count: 1 });
      }

      if (decision.action === 'collapse') {
        const target = pages[seenShapes.find((s) => s.sig === decision.sig)!.pageIndex];
        if (target) { (target.collapsedVariants ||= []).push(safePath(page.url())); }
        emit(runId, { type: 'crawl:think', message: `${p0} is the same structure as a page I already mapped (${decision.reason}) — recording it as a variant and NOT re-crawling its subtree, to spend the budget on new ground instead.` });
        save('crawling');
        continue;   // ← the budget saver: don't enqueue this duplicate's links
      }
      seenShapes.push({ sig: decision.sig, contentVolume: shape.contentVolume, pageIndex: pages.length, routeKey: shape.routeKey });

      // L0-c OBSERVATION: did THIS page show an authenticated-app affordance? Set the run flag from real observation
      // (detector-independent). Once true it stays true. Skip the evaluate once we've already seen one. This is the
      // signal that proves "we got past the login screen at least once" without trusting the login detector.
      if (!everSawAuthedAffordance) {
        try {
          const { authSignals: _as } = await import('./authSignals');
          const _s = await _as(page);
          // ONLY trust a SUCCESSFUL read: a threw read (ok:false) returns all-zeros, which must NOT be mistaken for
          // "no affordance here" — else a page that happened to throw could contribute to a false 'blocked'.
          if (_s.ok && _s.authedAffordances.length > 0) everSawAuthedAffordance = true;
        } catch {}
      }

      // ── SELF-CALIBRATED ACTION CAP (CRAWL-d, un-fake MAX_ACTIONS=10): capture as many actions as the page ACTUALLY
      // has (affordancesPresent, the honest count), not a fixed 10 — so a rich page like dent /users (40+ affordances)
      // is fully mapped, while a thin page captures only its few. Bounded by a generous safety ceiling (ACTION_CEILING)
      // so a pathological page can't explode the per-page cost; whatever exceeds it is recorded as a known-unknown.
      const presentCount = (shape as any).affordancesPresent || MAX_ACTIONS;
      const wantActions = Math.min(presentCount, ACTION_CEILING);
      const candidates = await getCandidateActions(page, { maxCandidates: wantActions }).catch(() => []);
      if (presentCount > ACTION_CEILING) noteUnknown(`actions-over-ceiling:${p0}:${presentCount - ACTION_CEILING}`);
      // ITEM 3: read the typed field requirements this page declares (generic, DOM-first).
      const requirements = await extractFieldRequirements(page);
      const mp: MappedPage = { id: uuid(), url: page.url(), path: p0, title: await page.title().catch(() => ''), interactives: candidates.length, affordancesPresent: (shape as any).affordancesPresent, requirements: requirements.length ? requirements : undefined, roles: roleId ? [roleId] : undefined, sig: decision.sig, contentVolume: shape.contentVolume, ...( { navKey: k, clicks: nav.clicks } as any) };
      pages.push(mp);
      emit(runId, { type: 'crawl:page-found', page: mp });
      if (requirements.length) emit(runId, { type: 'crawl:think', message: `This page needs ${requirements.length} input${requirements.length > 1 ? 's' : ''}: ${requirements.map((r) => r.kind).join(', ')}. Recording them as requirements so the flow is runnable.` });

      // ── GATE DETECTION: a page is a GATE (portal/workspace/tenant/school picker) when it's a hub of MANY similar
      // clickable ROWS and little else — a menu of divergent choices you must pick from to proceed. Detected
      // structurally (row-set with a "choose/select" cue), recorded so bug-repro/SoA know the picker + its options
      // instead of rediscovering it every run. General — the option LABELS come from the page, nothing hardcoded.
      const gate = await detectGate(page);
      if (gate && !gates.some((g) => g.path === gate.path)) {
        gates.push(gate);
        emit(runId, { type: 'crawl:think', message: `${p0} is a ${gate.kind} GATE — you must pick one of: ${gate.options.map((o) => o.label).slice(0, 6).join(', ')}${gate.options.length > 6 ? '…' : ''}. Recording it + SEEDING a few options as frontier so I actually go through them (not just the ones a link points to).` });
        // GATE-SEED THE FRONTIER (the real fix for coverage): the gate ENUMERATES its options — enqueue a few
        // UNVISITED ones as click-path navs so the crawl goes THROUGH the gate to each, instead of only entering
        // whichever option a plain <a href> happened to point at (that's why only demo/demonstration/doon got
        // crawled). Capped so it samples breadth without exploding; navKey(url+clicks) dedups per option.
        const GATE_SEED_CAP = 4;
        let seeded = 0;
        for (const opt of gate.options) {
          if (seeded >= GATE_SEED_CAP) { noteUnknown('choice:' + opt.label); continue; }   // HONEST: options past the cap are known-unknowns, not silently dropped
          if (enqueue({ url: page.url(), clicks: [opt.label] } as any)) {
            seeded++;
            // L1-a: stamp the option's resolvable identity on the queued nav → the gate edge carries identity, same as
            // a click-explore edge. _clickLabel marks it a click (not a bare navigate) at emission.
            if (opt.elementId) { const q = queue[queue.length - 1] as any; q._elementId = opt.elementId; q._clickLabel = opt.label; }
          }
        }
        if (seeded) emit(runId, { type: 'crawl:think', message: `Seeded ${seeded} portal option(s) into the frontier so I explore beyond the default one.` });
      }
      save('crawling');   // persist incrementally — a refresh now sees this page + the live frontier

      // collect nav links. Record what the per-page cap DROPS as known-unknowns (honest "what's left"), don't
      // silently truncate.
      const allLinks = await page.locator('a[href]').evaluateAll((els: any[]) =>
        els.map((e) => e.getAttribute('href')).filter(Boolean)).catch(() => []) as string[];
      const CAP = 40;
      for (let i = 0; i < allLinks.length; i++) {
        let abs: URL; try { abs = new URL(allLinks[i], page.url()); } catch { continue; }
        if (abs.origin !== new URL(baseUrl).origin) continue;
        const lk = routeKey(abs.href);
        if (visitedPaths.has(lk)) continue;
        if (i >= CAP) { noteUnknown(abs.pathname); continue; }   // beyond the per-page cap → recorded, not lost
        enqueue(abs.href);
      }

      // ── SAFE CLICK-EXPLORE (item 6 + CODE-SEED-THEN-CLICK): SPA sub-states reached via onClick/<Link>/menu — NOT
      // <a href> — are invisible to anchor harvesting AND undeclarable by the router (pagination, entity-detail,
      // in-page tabs, individual records). In BLACK-BOX mode this is the only way to find any deep surface. In CODE
      // mode the manifest gives the route SKELETON cheaply — but the EXPERIMENT proved the router CANNOT declare
      // the deep interaction surface, so "code mode skips clicks" was WRONG. Under code-seed-then-click we run this
      // in Mode-1 TOO, but ONLY AFTER the code skeleton is fully drained (no _seed left in queue) — so it spends
      // budget on DEPTH the code couldn't give, not on re-finding seeded routes. Never fires on destructive controls.
      const skeletonDrained = !queue.some((q) => (q as any)._seed);
      const runClickExplore = !repo || (((process.env.XSION_CODE_SEED_THEN_CLICK ?? '1') !== '0') && skeletonDrained);
      if (runClickExplore) {
        // AGGRESSIVE MODE: if this page has NO same-origin anchors, the app is fully click-driven (like sloxt/
        // schooltalk: 0 links, entry buttons "Select"/portal <li>). Then ANY non-destructive item is a nav
        // candidate, not just nav-word ones — otherwise we can't get past the front door / portal gate.
        const sameOriginAnchors = (allLinks as string[]).filter((h) => { try { return new URL(h, page.url()).origin === new URL(baseUrl).origin; } catch { return false; } }).length;
        const aggressive = sameOriginAnchors === 0;
        // returns {urlNavs:[full url changes], viewLabels:[in-place view swaps → become click-paths]}
        // pass the sigs we've already mapped so a view-swap click that lands on a KNOWN state isn't enqueued as a
        // new click-path (the fixture-verified click-path explosion fix). currentSig included (we're standing on it).
        const knownSigs = new Set<string>(seenShapes.map((s) => s.sig)); if (currentSig) knownSigs.add(currentSig);
        const _tSce = Date.now();
        const disc = await safeClickExplore(page, nav.url, routeKey, visitedPaths, aggressive, navKey, nav.clicks || [], knownSigs, ensureSession, probedNavLabels);
        console.log(`[XSION][perf] safeClickExplore ${Date.now() - _tSce}ms page=${p0}`);
        // CRAWL-e: record the dangerous controls we MAPPED-BUT-DIDN'T-CLICK as honest known-unknowns (so coverage
        // shows "there's a Send/Delete here" without ever firing it). A testing engine can target them under consent.
        for (const dgr of (disc.dangerous || [])) noteUnknown(`danger:${dgr.category}:${dgr.label}`);
        if ((disc.dangerous || []).length) emit(runId, { type: 'crawl:think', message: `Mapped ${disc.dangerous.length} risky control(s) on ${p0} (${disc.dangerous.slice(0, 3).map((d) => `"${d.label}"`).join(', ')}) — recorded, NOT clicked, so nothing on the live app is triggered.` });
        // FULL AFFORDANCE INVENTORY → attach to this page so the map reflects EVERY control the crawler saw (nav /
        // action-capability / guarded), not just the ones it clicked. This is what surfaces "Create Event" on the
        // NZ Curriculum dashboard as a discoverable capability the test engine can target under consent.
        if ((disc.affordances || []).length) {
          (mp as any).affordanceInventory = disc.affordances;
          const actions = disc.affordances.filter((a) => a.kind === 'action');
          if (actions.length) emit(runId, { type: 'crawl:think', message: `Catalogued ${disc.affordances.length} controls on ${p0}, incl ${actions.length} action-capabilit${actions.length === 1 ? 'y' : 'ies'} (${actions.slice(0, 4).map((a) => `"${a.label}"`).join(', ')}) — recorded for testing, not auto-clicked.` });
          // ── OPEN-TO-LEARN-THE-FORM (consented): an action-capability like "Create Event" hides its FORM behind a
          // click — the crawler can't scaffold attacks on fields it never saw. UNDER AUTHORIZATION only, open each
          // action control ONCE (read-only: opening a form is not a mutation — SUBMITTING is, and we never touch the
          // inner Save/Create), harvest the revealed form's fields into that inventory entry, then restore. This is
          // the "learn the shape" half of two-phase verify. Bounded so a dashboard of actions can't explode cost.
          const authorized = !!((store as any).getProject?.(projectId) as any)?.security?.authorized;
          if (authorized && actions.length) {
            const FORM_DISCOVERY_CAP = 6;
            // PRIORITIZE genuine capability-openers (Create/Add/New/Edit/Compose…) over incidental action-controls
            // (calendar tiles, chips) so the important forms are learned first within the cap. General verb list,
            // no app-specific words. Rank-by-verb, then original order — so "Create Event"/"Create Group" win the cap.
            // capability-openers whose click REVEALS A FORM (safe to open read-only), NOT direct-commit mutations.
            // Includes modal-openers like "Flag"/"Edit"/"Configure" (they open a dialog to fill). Deliberately EXCLUDES
            // direct-commit verbs (approve/allocate/ship/delete) — opening those IS the mutation, never "learn the form".
            const CAP_VERB = /\b(create|add|new|compose|schedule|invite|upload|import|assign|enrol|register|book|flag|edit|configure|customize|settings?)\b/i;
            const ranked = [...actions].sort((a, b) => (CAP_VERB.test(b.label) ? 1 : 0) - (CAP_VERB.test(a.label) ? 1 : 0));
            let learned = 0;
            for (const act of ranked.slice(0, FORM_DISCOVERY_CAP)) {
              const dedupKey = (act.label || '').trim().toLowerCase();
              // DEDUP: same control already harvested this run (e.g. "Create Group" on every school) → reuse, no click.
              if (dedupKey && learnedForms.has(dedupKey)) {
                const inv = ((mp as any).affordanceInventory as any[]).find((a) => a.label === act.label);
                if (inv) inv.revealedRequirements = learnedForms.get(dedupKey);
                continue;
              }
              const urlBeforeOpen = page.url();
              let navigated = false;
              try {
                const opened = await clickByLabel(page, act.label);
                if (!opened) continue;
                await page.waitForTimeout(800); await waitForHydration(page);   // the form/route hydrates slowly too
                navigated = page.url() !== urlBeforeOpen;
                const fields = await captureFormFields(page);
                if (fields.length) {
                  const inv = ((mp as any).affordanceInventory as any[]).find((a) => a.label === act.label);
                  if (inv) inv.revealedRequirements = fields;   // stored on the ENTRY, never the page's requirements[]
                  if (dedupKey) learnedForms.set(dedupKey, fields);
                  learned++;
                  emit(runId, { type: 'crawl:think', message: `Opened “${act.label}” and learned its form: ${fields.length} field${fields.length > 1 ? 's' : ''} (${fields.slice(0, 4).map((f) => f.label || f.kind).join(', ')}) — recorded for testing. Did NOT submit.` });
                }
              } catch { /* one bad open shouldn't abort the page */ }
              // RESTORE — cheaply. Opening "Create Event" NAVIGATES → goBack (one nav, ~20-30s) instead of a full
              // reload+replay (~2min). An in-place form (url unchanged) → just Escape it. Reload+replay only as a last
              // resort if goBack didn't return us to the dashboard. (Advisor: the reload+replay was the whole cost.)
              try {
                if (navigated) {
                  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                  await waitForHydration(page);
                  if (page.url() !== urlBeforeOpen) {   // goBack didn't land us right → fall back to reload+replay
                    const g = await gotoRendered(page, nav.url); if (g.ok) { for (const s of (nav.clicks || [])) { if (typeof s === 'string') await clickByLabel(page, s); else await fillByLabel(page, s.fill, s.value); await page.waitForTimeout(600); } await waitForHydration(page); }
                  }
                } else {
                  await page.keyboard.press('Escape').catch(() => {});   // in-place form → dismiss, no navigation
                  await page.waitForTimeout(300);
                }
              } catch {}
            }
            if (learned) console.log(`[XSION][crawl] open-to-learn: mapped ${learned} NEW form(s) on ${p0} (authorized; ${learnedForms.size} distinct forms known)`);
          }
        }
        let added = 0;
        for (const href of disc.urlNavs) if (enqueue({ url: href })) {
          added++;
          // L1-a: a URL nav DISCOVERED BY CLICKING carries the control's identity (the school-picker case: which
          // control opens /nzcurriculum). Stamp _selector on the queued nav (like _parentSig) so the edge is a
          // `click` with a selector, not an identity-less `navigate`. _clickLabel marks it click-derived at emission.
          const _s = disc.selByKey['url:' + href];
          // _clickLabel = the CONTROL's text (what was clicked), NOT the destination path (that's toPath already).
          if (_s) { const q = queue[queue.length - 1] as any; q._elementId = { tier: _s.tier, css: _s.css, name: _s.name, verifiedAtCapture: _s.verified, ambiguityCount: _s.ambiguity }; q._clickLabel = _s.name || safePath(href); }
          emit(runId, { type: 'crawl:think', message: `Found a route behind a click: ${safePath(href)} — queued.` });
        }
        // honest coverage: choices the click-cap didn't probe → known-unknowns. BUT only when THIS page was a real
        // CHOOSER (its clicks produced URL navigations, like the school picker) — otherwise every in-page widget
        // (calendar day-cells, colour chips, digit fragments) floods knownUnknowns and evicts the real dropped
        // schools. A page whose clicks changed no URL isn't a gate; its leftover candidates aren't "choices".
        if (disc.urlNavs.length > 0) {
          for (const choice of (disc.droppedChoices || [])) noteUnknown('choice:' + choice);
          if ((disc.droppedChoices || []).length) emit(runId, { type: 'crawl:think', message: `${disc.droppedChoices.length} more choice(s) on ${p0} beyond this pass's cap — recorded as known-unknowns, not dropped.` });
        }
        for (const label of disc.viewLabels) {
          // PERMUTATION GUARD (csc-2 fix): a tab bar re-enumerates its OWN siblings from inside each tab →
          // /explore›Challenges›Popular Meals where "Popular Meals" is already a depth-1 tab of /explore. Those are
          // the SAME rendered state reached by a longer path — 54/60 of the leftover frontier was this. Skip a
          // (base-route, terminal-label) pair we've ALREADY queued at ANY depth: the first (shortest) path wins,
          // deeper permutations of the same label set are dropped. Keyed on route-template + terminal label only.
          const permKey = routeKey(nav.url) + '::tab::' + stepLabel(label);
          if (seenTabLabels.has(permKey)) continue;
          seenTabLabels.add(permKey);
          // an in-place view: enqueue the CLICK-PATH to reach it (url + prior clicks + this label). This is the
          // Choose-Portal fix — the portal's inner view becomes an addressable page, not a dead #hash.
          const did = enqueue({ url: nav.url, clicks: [...(nav.clicks || []), label] });
          if (did) {
            added++;
            const _s = disc.selByKey['view:' + label];   // L1-a: stamp the view-swap control's identity on the queued nav
            if (_s) { const q = queue[queue.length - 1] as any; q._elementId = { tier: _s.tier, css: _s.css, name: _s.name, verifiedAtCapture: _s.verified, ambiguityCount: _s.ambiguity }; }
            emit(runId, { type: 'crawl:think', message: `Found a section behind “${label}” (no URL change) — queued to explore inside it.` });
          }
        }

        // ── SoA-ON-STALL (the brain in the loop): if the MECHANICAL pass found NO way deeper (0 new frontier) but
        // the page HAS clickable candidates, the heuristics are stuck — hand the page to SoA and let it REASON
        // about which items open new areas. Bounded: only when stalled, only a few times per crawl, cost-capped.
        // DEPTH CAP: don't ask SoA on a page that's already deep in a click-path (prevents endless re-search /
        // fill-again recursion — e.g. a search box SoA keeps re-querying with new values). Only stall-rescue
        // pages ≤2 clicks deep; beyond that the mechanical crawl carries what it found.
        const clickDepth = (nav.clicks || []).length;
        // TRIGGER: legacy = mechanical stall (added===0). For the soa-semantic/hybrid arms ALSO fire on a NOVELTY
        // PLATEAU (recent visits stopped finding new states) even if the mechanical pass queued something — the
        // LLMDroid "spend the model when the free explorer plateaus" rule. Both gated by the SAME cost ceiling
        // (MAX_SOA_EXPLORE) + depth cap (≤2, the anti-re-search fix we keep). recentNovel counts novel-in-window.
        const recentNoveltyCount = recentNovel.filter(Boolean).length;
        // Two-budget decision (#211) — stall and plateau each have their own allowance; see decideSoa. The window
        // gate uses recentNovel.LENGTH (non-seed observations), NOT total visits, so the plateau can't fire
        // vacuously on the first non-seed page after seeds drain (0 novelty in a 0-length window).
        const { fireStall, firePlateau } = decideSoa({
          arm: exploreArm, stalled: added === 0,
          stallSoaCalls, maxStall: MAX_SOA_EXPLORE,
          nonSeedObservations: recentNovel.length, recentNovelty: recentNoveltyCount, window: NOVELTY_WINDOW, minNovelty: 1,
          plateauSoaCalls, maxPlateau: MAX_PLATEAU_SOA,
        });
        if ((fireStall || firePlateau) && clickDepth <= 2) {
          const inv = await pageClickableInventory(page);
          if ((inv.clickables?.length || 0) + (inv.inputs?.length || 0) >= 2) {
            if (fireStall) stallSoaCalls++; else { plateauSoaCalls++; tracker.plateauFires++; emit(runId, { type: 'crawl:think', message: `Novelty plateaued (${recentNoveltyCount} new in last ${NOVELTY_WINDOW}) — spending a plateau SoA call (${plateauSoaCalls}/${MAX_PLATEAU_SOA}) to find a fresh area.` }); }
            tracker.soaCalls = soaExploreCalls();
            // save the screenshot as an artifact AND attach it as a data-URL so SoA can reason over the ACTUAL
            // PIXELS (multimodal) for visual-only gates the layout-as-text can't capture. Text-only fallback if
            // vision is unavailable. Capped size (already jpeg q60) to keep the call light.
            const shotKey = await saveStallShot(page, runId, soaExploreCalls());
            if (shotKey) (inv as any).screenshotArtifact = shotKey;
            try { const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }); (inv as any).screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`; } catch {}
            if (inv.overlays?.length) emit(runId, { type: 'crawl:think', message: `There's an overlay/modal covering ${p0} — SoA will consider dismissing it first.` });
            emit(runId, { type: 'crawl:think', message: `I don't see an obvious way deeper from ${p0} — asking SoA to look at the page (layout + overlays + inputs) and decide what to do.` });
            try {
              const { clicks: actions, vision, error } = await explorePage(inv);
              if (error) emit(runId, { type: 'crawl:think', message: `SoA explore note: ${error}` });
              if (vision) emit(runId, { type: 'crawl:think', message: `SoA looked at the actual screenshot of the page (visual reasoning).` });
              // SoA returns an ORDERED action list. FILL steps are PREREQUISITES for the click that follows them
              // (a multi-step unlock: type-then-click), so a fill is carried forward and prepended to the next
              // click's nav. Standalone clicks each become their own nav (e.g. 5 independent portals).
              const pending: NavStep[] = [];
              for (const a of actions) {
                if (a.action === 'fill') {
                  pending.push({ fill: a.label, value: a.value || 'test' });
                  emit(runId, { type: 'crawl:think', message: `SoA says: first type “${a.value || 'test'}” into “${a.label}” — ${a.why || 'to reveal content'}.` });
                  continue;
                }
                // a click: this nav = base clicks + any pending fills + this click. pending fills apply once.
                const steps: NavStep[] = [...(nav.clicks || []), ...pending, a.label];
                pending.length = 0;
                if (enqueue({ url: nav.url, clicks: steps })) {
                  added++;
                  // L1-a: SoA-on-stall is the THIRD discovery path (fires on /explore, /progress, /custom-plan — the
                  // measured source of dent's identity-less edges). The page is live on the SOURCE state here, so run
                  // the SAME shared deriver+verifier for SoA's proposed label and stamp identity on the queued nav —
                  // same contract as click-explore/gate. If the label matches no element (SoA hallucinated it), store
                  // NOTHING (honest gap), never a guess.
                  try {
                    const id = await page.evaluate((args: any) => {
                      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
                      const dv = new Function('return (' + args.src + ')')();
                      const lab = args.label;
                      const all = Array.prototype.slice.call(doc.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],a[href],li,[role="option"]'));
                      let el = null; for (const e of all) { if (((e.textContent || '').trim().replace(/\s+/g, ' ')) === lab && (e.offsetWidth || e.offsetHeight)) { el = e; break; } }
                      if (!el) return null;
                      return dv(el, lab, doc, win);
                    }, { src: DERIVE_AND_VERIFY, label: a.label });
                    if (id) { const q = queue[queue.length - 1] as any; q._elementId = { tier: id.tier, css: id.css, name: id.name, verifiedAtCapture: id.verifiedAtCapture, ambiguityCount: id.ambiguityCount }; }
                  } catch {}
                  emit(runId, { type: 'crawl:think', message: `SoA says: click “${a.label}” — ${a.why || 'opens a new area'}. Queued.` });
                }
              }
            } catch (e: any) { emit(runId, { type: 'crawl:think', message: `SoA explore failed (${String(e?.message || e).slice(0, 60)}); continuing mechanically.` }); }
          }
        }
      }
      // synthetic cursor over up to 3 interactive elements (the "watch it work" moment)
      await animateCursorOverActions(runId, page, 3);
    }
    // the crawl stopped with routes still queued → those are known-unknowns (budget clipped, not omitted)
    if (queue.length) {
      reachedLimit = true;
      for (const n of queue) { try { noteUnknown(navPath(n)); } catch {} }
    }

    // ── SoA synthesizes flows from the observed surface (with per-flow confidence) ──
    emit(runId, { type: 'crawl:phase', phase: 'synthesize', label: 'Making sense of the app' });
    emit(runId, { type: 'crawl:think', message: `I explored ${pages.length} pages and recorded ${apiMap.size} API endpoints. Now identifying the real user flows…` });
    // A (STRUCTURAL FLOWS): derive flows by WALKING THE GRAPH — deterministic, instant, never hangs. This is the
    // PRIMARY flow source (the LLM `map` call is variance-prone: sometimes hangs >150s, sometimes unparseable).
    // Structural flows are grounded in real edges + verified controls + mutations + per-page requirements + scope.
    const { deriveFlows, toMappedFlows } = await import('./graphFlows');
    const structural = toMappedFlows(deriveFlows({ baseUrl, edges: [...edgeMap.values()], pages, api: [...apiMap.values()] }));
    emit(runId, { type: 'crawl:think', message: `Derived ${structural.length} flows structurally from the interaction graph (${structural.filter((f: any) => f.reasoning?.startsWith('path fires')).length} exercise a real mutation).` });
    // The LLM is now OPTIONAL enrichment (naming/business-value), never the flow-FINDER. Kept behind a flag; if it
    // times out or returns nothing, we still ship the structural flows. For now, structural IS the flow set.
    let freshFlows = structural;
    if (process.env.XSION_LLM_FLOW_NAMING === '1') {
      const named = await synthesizeFlows({ baseUrl, repo, pages, api: [...apiMap.values()], edges: [...edgeMap.values()] }).catch(() => []);
      if (named.length) freshFlows = named;   // opt-in: prefer LLM-named flows when the call succeeds
    }
    if (roleId) for (const f of freshFlows) (f as any).roles = [roleId];   // tag this role's synthesized flows (item 4)

    // RESUME-PRESERVES-VALIDATION (the vicious-cycle fix): a resume must NEVER wipe flows the user already
    // validated — otherwise they're re-asked the same questions forever. Rule: on a resume/continued crawl, START
    // from every EXISTING flow (especially userCorrected ones) and merge in fresh flows by name; a fresh flow only
    // adds if its name is new. On a first crawl (nothing existing) it's just the fresh set.
    const isResume = !!(opts.resume || existing?.status === 'crawling') && (existing?.flows?.length);
    const key = (f: any) => (f.name || '').toLowerCase().trim();
    if (isResume) {
      const byName = new Map<string, any>();
      for (const f of (existing.flows as any[])) byName.set(key(f), f);   // existing first (keeps userCorrected + ids)
      for (const f of freshFlows) if (!byName.has(key(f))) byName.set(key(f), f);   // add only genuinely-new flows
      flowsSoFar = [...byName.values()];
    } else {
      flowsSoFar = freshFlows;
    }
    for (const f of flowsSoFar) emit(runId, { type: 'crawl:flow', flow: f });
    // no silent caps: if the knownUnknowns list was itself capped, say so rather than imply full coverage.
    if (kuDropped) emit(runId, { type: 'crawl:think', message: `(${knownUnknowns.size} unreached routes recorded; ${kuDropped} more beyond the cap not individually listed.)` });

    // ── ITEM 3, Mode-1 code cross-check: SoA reads the code to augment DOM requirements with server-side
    // constraints the DOM under-declares (file-size caps, allowed MIME, API-enforced regex). Augmentations are
    // matched back by selector; anything SoA can't cite in code is dropped (never fabricate a requirement).
    if (repo) {
      const observed = pages.flatMap((p) => (p.requirements || []).map((r) => ({ selector: r.selector, kind: r.kind, label: r.label, accepts: r.accepts, required: r.required, path: p.path })));
      if (observed.length) {
        try {
          emit(runId, { type: 'crawl:think', message: `Reading the code to confirm what these ${observed.length} fields REALLY require (server-side limits the page doesn’t show)…` });
          const { requirements: aug, error } = await fieldReqs(repo, observed);
          if (error) emit(runId, { type: 'crawl:think', message: `Field-requirement code note: ${error}` });
          const bySel = new Map(aug.map((a) => [a.selector, a]));
          let augmented = 0;
          for (const p of pages) for (const r of p.requirements || []) {
            const a = bySel.get(r.selector);
            if (!a) continue;
            if (a.codeNote) { r.codeNote = a.codeNote; r.source = 'dom+code'; augmented++; }
            if (a.accepts && a.accepts.length) r.accepts = a.accepts;
            if (a.pattern) r.pattern = a.pattern;
            if (a.maxSize) r.max = a.maxSize;
            if (a.required === true) r.required = true;
            // re-phrase the ask from the CONFIRMED constraints (code may have narrowed accepts/required)
            if (a.codeNote || a.accepts) r.prompt = phraseRequirement(r.kind, r.label, r.accepts, r.required);
          }
          if (augmented) emit(runId, { type: 'crawl:think', message: `Code confirmed ${augmented} field requirement${augmented > 1 ? 's' : ''} with constraints the page alone didn’t reveal.` });
        } catch (e: any) {
          emit(runId, { type: 'crawl:think', message: `Could not cross-check fields against code (${String(e?.message || e).slice(0, 80)}).` });
        }
      }
    }

    // ── EXPLORATION METRICS (the A/B matrix) — the ground-truth-free comparison across arms. Emitted on the WS AND
    // appended to a JSONL ledger so the matrix runner collects them without parsing the stream.
    const exploreMetrics = { ...tracker.metrics(queue.length), arm: exploreArm, baseUrl, mode: repo ? 'code' : 'url-only', pages: pages.length, stallSoaCalls, plateauSoaCalls };
    emit(runId, { type: 'crawl:think', message: `Exploration [${exploreArm}]${exploreMetrics.valid ? '' : ' ⚠INVALID'}: ${exploreMetrics.distinctStates} distinct states / ${exploreMetrics.pagesVisited} visits · skeleton ${exploreMetrics.seededRoutes} (code) + depth ${exploreMetrics.clickDiscovered} (click) · novelty ${(exploreMetrics.noveltyRate * 100).toFixed(0)}% · collapse ${(exploreMetrics.collapseRate * 100).toFixed(0)}% · SoA calls ${exploreMetrics.soaCalls} (plateau ${exploreMetrics.plateauFires}) · captureErrors ${exploreMetrics.captureErrors} · frontier ${exploreMetrics.frontierExhausted ? 'exhausted' : `clipped (${exploreMetrics.frontierLeftover} left)`}` });
    try {
      const ledger = path.join(process.env.XSION_METRICS_DIR || '/tmp', 'xsion_explore_metrics.jsonl');
      fs.appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), runId, ...exploreMetrics }) + '\n');
    } catch {}

    // ── final persist — L0-c HONESTY INVARIANT chokepoint ──
    // A login-gated app we never signed into cannot be reported 'done' (it would claim a complete map having only
    // seen the login screen). crawlTerminalStatus decides; 'blocked' persists as 'crawling' (re-run resumes) with an
    // honest note, never a false 'done'. A public app or an authed session completes normally.
    const { crawlTerminalStatus } = await import('./authSignals');
    // TRIPWIRE inputs are now BOTH observed run-level flags (no live DOM re-read, no race, no detector dependency):
    //   sessionEstablished — set true ONLY on a login success.
    //   everSawAuthedAffordance — set true when ANY mapped page showed an authed-app affordance (observed in the loop).
    // A tiny map that never logged in AND never saw an app affordance = we only ever saw the login screen → blocked.
    const _terminal = crawlTerminalStatus({
      landingWasLoginGated, sessionEstablished,
      pagesMapped: pages.length, everSawAuthedAffordance,
    });
    if (_terminal === 'blocked') {
      emit(runId, { type: 'crawl:think', message: 'This app is behind a login I could not get through, so I only ever saw the sign-in screen. I will NOT report a complete map — there is nothing verified behind the gate. Provide working credentials (or a path that lands in the app) and re-run.' });
      console.log(`[XSION][crawl] run=${runId.slice(0,8)} HONESTY-INVARIANT: login-gated + no session → status=blocked (NOT done)`);
      save('crawling');
      clearInterval(autosave);
      try { await browser.close(); } catch {}
      return;
    }
    const map = save('done');
    // ── SITE-MODEL / WARM-START (CRAWL-g, the amortization USP): distill the per-app learned model from this app's
    // FULL crawl history + the just-finished map, attach it, and report "re-confirmed the known skeleton + what's new
    // since last time." Purely additive; compounds every crawl (stable set grows). Best-effort — never fail the crawl.
    try {
      const history = ((store as any).getProjectMapHistory?.(projectId) || []) as any[];   // prior completed maps (newest last)
      const priorModel = history.length ? buildSiteModel(history) : null;                    // model from PRIOR crawls only
      const ws = warmStart(priorModel, map);
      const fullModel = buildSiteModel([...history, map]);                                    // model INCLUDING this crawl
      fullModel.updatedAt = new Date().toISOString();
      (map as any).siteModel = fullModel;
      (map as any).warmStart = ws;
      (store as any).saveProjectMap?.(projectId, map);   // re-persist with the model attached (same crawledAt → no re-archive)
      console.log(`[XSION][crawl] site-model: ${ws.summary} (stable states known: ${fullModel.stableSigs.length}, volatile: ${fullModel.volatileSigs.length})`);
      emit(runId, { type: 'crawl:think', message: ws.summary });
    } catch (e) { console.log(`[XSION][crawl] site-model skipped: ${String((e as any)?.message || e).slice(0, 80)}`); }
    emit(runId, { type: 'crawl:phase', phase: 'done', label: 'Map ready' });
    emit(runId, { type: 'crawl:done', map });
  } finally {
    clearInterval(autosave);
    clearInterval(frameTimer);
    await browser.close().catch(() => {});
  }
}

// ── helpers ──
function safePath(u: string): string { try { return new URL(u).pathname || '/'; } catch { return u; } }

/** normalize a row label into a KIND: lowercase, digit-runs → '#', collapse whitespace, cap length. Mirrors the
 *  state signature's normLabel so "Order #1041" and "Order #2277" are ONE kind — the adaptive-scroll saturation key. */
function normLabelForScroll(s: string): string {
  return (s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** SCROLL-TO-REVEAL (CRAWL-c). Scroll the page to trigger lazy-loaded / below-the-fold / virtualized content before
 *  the crawl captures it. Two termination tests (research-grounded — never trust networkidle alone):
 *   • GROWING pages (infinite scroll): scroll to bottom, wait, re-read document.body.scrollHeight; STOP after
 *     STALL_ROUNDS consecutive scrolls with no height growth (or a hard MAX_SCROLLS cap).
 *   • VIRTUALIZED lists (react-window / TanStack — rows recycle so scrollHeight is fixed): after each nudge, harvest a
 *     STABLE BUSINESS KEY (data-id / data-key / id / data-testid) of every visible row into a Set; STOP when the Set
 *     size stops increasing (survives DOM recycling). Whichever signal fires first ends the loop.
 *  SAFE: scrolling fires no click/mutation. Bounded by MAX_SCROLLS. All evaluate bodies inline (the __name rule).
 *  Returns {scrolls, grew, mode}. mode: 'virtualized' | 'grew' | 'none' | 'error'. */
async function revealByScroll(page: Page): Promise<{ scrolls: number; grew: boolean; mode: 'virtualized' | 'grew' | 'saturated' | 'none' | 'error'; kinds: number }> {
  const MAX_SCROLLS = Number(process.env.XSION_MAX_SCROLLS || 40);   // hard BACKSTOP only; the KIND-saturation stop
  // normally ends the loop far sooner (an infinite feed of one kind stops after ~STALL_ROUNDS, not 40 scrolls).
  const STALL_ROUNDS = 3;   // consecutive no-progress scrolls before we call it done
  try {
    // EARLY-OUT (the common case): if the page already fits in the viewport AND has no inner scrollable container,
    // there is nothing below the fold to reveal — skip the whole loop so scroll is ~free on short pages (most pages).
    const overflows = await page.evaluate(() => {
      const d: any = (globalThis as any).document; const w: any = globalThis as any;
      const pageOverflow = ((d.documentElement && d.documentElement.scrollHeight) || 0) > (w.innerHeight || 0) + 40;
      if (pageOverflow) return true;
      const nodes = Array.prototype.slice.call(d.querySelectorAll('div, section, main, ul, ol, table, [role="grid"], [role="list"]')).slice(0, 1500);
      for (let j = 0; j < nodes.length; j++) { const el = nodes[j]; if ((el.scrollHeight || 0) > (el.clientHeight || 0) + 40 && (el.clientHeight || 0) > 120) return true; }
      return false;
    }).catch(() => true);   // on error, don't skip (be safe — scroll anyway)
    if (!overflows) return { scrolls: 0, grew: false, mode: 'none', kinds: 0 };
    // seed lastHeight from the CURRENT height so the first observation isn't mis-counted as "growth" from a 0 baseline
    // (that off-by-one delayed termination by a round and falsely set grew on short pages).
    let lastHeight = await page.evaluate(() => { const d: any = (globalThis as any).document; return (d.documentElement && d.documentElement.scrollHeight) || (d.body && d.body.scrollHeight) || 0; }).catch(() => 0);
    let heightStall = 0;
    const keySet = new Set<string>();
    let lastKeyCount = 0, keyStall = 0;
    const kindSet = new Set<string>();
    let kindStall = 0, sawLabels = false;
    let grew = false, sawKeys = false;
    let i = 0;
    for (; i < MAX_SCROLLS; i++) {
      // one scroll step + harvest, in a single evaluate. NO named helpers inside (the tsx __name rule).
      const res = await page.evaluate(() => {
        const w: any = globalThis as any; const d: any = w.document;
        const before = (d.documentElement && d.documentElement.scrollHeight) || (d.body && d.body.scrollHeight) || 0;
        // nudge: scroll the main window a viewport down (covers the common infinite-scroll case)
        w.scrollTo(0, before);
        // also nudge the tallest scrollable inner container (virtualized lists live inside an overflow:auto div, not
        // window). PERF: scan the NARROW structural selector (~dozens of nodes) not querySelectorAll('*') (4000 nodes
        // × every scroll step = the crawl-slowdown root the perf timers found). A scroll container is always one of
        // these layout elements, never a leaf span/svg.
        let container: any = null, best = 0;
        const nodes = Array.prototype.slice.call(d.querySelectorAll('div, section, main, ul, ol, table, [role="grid"], [role="list"], [class*="scroll" i], [class*="list" i], [class*="table" i]')).slice(0, 600);
        for (let j = 0; j < nodes.length; j++) {
          const el = nodes[j];
          const sh = el.scrollHeight || 0, ch = el.clientHeight || 0;
          if (sh > ch + 40 && ch > 120 && sh - ch > best) { best = sh - ch; container = el; }
        }
        if (container) container.scrollTop = container.scrollTop + container.clientHeight;
        // harvest stable business keys of visible rows (survives virtualization DOM recycling)
        const keys: string[] = [];
        const rows = Array.prototype.slice.call(d.querySelectorAll('[data-id], [data-key], [data-testid], tr[id], li[id], [role="row"]')).slice(0, 2000);
        for (let j = 0; j < rows.length; j++) {
          const el = rows[j];
          const key = el.getAttribute('data-id') || el.getAttribute('data-key') || el.getAttribute('data-testid') || el.getAttribute('id');
          if (key) keys.push(String(key));
        }
        // harvest ROW LABELS (visible text of list-item-ish nodes) for the KIND-saturation stop — the caller
        // normalizes these (digits→#) so "Item #500" ≡ "Item #5" ≡ ONE kind. no named helpers (the __name rule).
        const labels: string[] = [];
        const rowNodes = Array.prototype.slice.call(d.querySelectorAll('li, tr, [role="row"], [role="listitem"], [class*="item" i], [class*="row" i], [class*="card" i]')).slice(0, 500);
        for (let j = 0; j < rowNodes.length; j++) { const t = (rowNodes[j].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60); if (t) labels.push(t); }
        const after = (d.documentElement && d.documentElement.scrollHeight) || (d.body && d.body.scrollHeight) || 0;
        return { before, after, keys, labels };
      });
      if (res.keys.length) { sawKeys = true; for (const k of res.keys) keySet.add(k); }
      // KIND SATURATION (the adaptive stop — replaces trusting a fixed scroll count): normalize each row label
      // (digits→#) into a KIND; track distinct kinds. On an infinite feed, height + keys grow forever but the KIND
      // set plateaus after a handful of rows (row 500 is the same KIND as row 5) → that plateau is the real
      // diminishing-returns signal. normLabel is the SAME digit-stripping the state signature uses.
      if (res.labels.length) sawLabels = true;
      let newKind = false;
      for (const l of res.labels) { const kind = normLabelForScroll(l); if (kind && !kindSet.has(kind)) { kindSet.add(kind); newKind = true; } }
      if (newKind) kindStall = 0; else kindStall++;
      // growing-page test
      if (res.after > lastHeight + 4) { grew = true; heightStall = 0; lastHeight = res.after; }
      else heightStall++;
      // virtualized-list test (only meaningful once we've seen keys)
      if (keySet.size > lastKeyCount) { keyStall = 0; lastKeyCount = keySet.size; }
      else keyStall++;
      await page.waitForTimeout(400);   // let lazy content / next virtual page render
      // TERMINATE when NO NEW KINDS keep appearing (the adaptive saturation) — this fires on a 10k-item feed after a
      // few scrolls (all one kind) instead of scrolling to the bottom, AND on a heterogeneous page it keeps going
      // while genuinely-new kinds surface. Height/key stalls are a secondary guard for pages with no row-labels.
      const heightDone = heightStall >= STALL_ROUNDS;
      const keyDone = sawKeys ? keyStall >= STALL_ROUNDS : true;
      // TERMINATION — kind-saturation is AUTHORITATIVE when the page has row-labels: once no NEW KINDS have appeared
      // for STALL_ROUNDS scrolls, STOP even if height/keys keep growing. That is the whole adaptive win — on a 10k-row
      // feed of one kind, height + keys grow forever, so requiring THEM to stall would scroll to the bottom; but we've
      // already learned every kind, so more rows teach nothing. If the page has NO row-labels (not a feed), fall back
      // to the mechanical height/key stalls.
      if (sawLabels) { if (kindStall >= STALL_ROUNDS) { i++; break; } }
      else if (heightDone && keyDone) { i++; break; }
    }
    // scroll back to top so capture/screenshot starts from a stable, natural position
    await page.evaluate(() => { (globalThis as any).scrollTo(0, 0); }).catch(() => {});
    // 'saturated' = we stopped because the KIND set plateaued while the page was STILL growing (the infinite-feed win:
    // we learned every kind without scrolling to the bottom of 10k rows). else virtualized/grew/none as before.
    const stoppedEarly = i < MAX_SCROLLS;
    const mode: 'virtualized' | 'grew' | 'saturated' | 'none' | 'error' =
      (sawLabels && grew && stoppedEarly) ? 'saturated'
      : (sawKeys && keySet.size > 0 && !grew) ? 'virtualized'
      : grew ? 'grew' : 'none';
    return { scrolls: i, grew, mode, kinds: kindSet.size };
  } catch { return { scrolls: 0, grew: false, mode: 'error', kinds: 0 }; }
}

// ── MODE-2 SAFE CLICK-EXPLORE (item 6) ──
// A control is DESTRUCTIVE if its label matches any of these — we never click it (it could mutate the live app).
// DEPRECATED (CRAWL-e): superseded by safetyGate.classifyElement, which uses DOM structure (link/GET-form/POST) to
// DEMOTE the false positives this crude label-regex produced (Cancel/Reset/Update-view). Kept only so any legacy
// reference still resolves; the live click-gate no longer uses it.
const DESTRUCTIVE_VERBS = /\b(delete|remove|send|submit|save|pay|buy|checkout|confirm|publish|post|create|add|update|edit|archive|cancel|deactivate|disable|logout|sign\s*out|reset|clear|revoke|approve|reject|transfer|withdraw|deposit)\b/i;
void DESTRUCTIVE_VERBS;   // silence unused (kept for back-compat)
// A control is NAVIGATIONAL if its label/role suggests moving between views (safe to click).
const NAV_HINT = /\b(view|open|details?|go|home|dashboard|users?|plans?|settings?|profile|explore|reports?|analytics|overview|list|browse|menu|tab|back|next|more|manage|show|see)\b/i;

/** Safely probe click-only navigation. For each candidate nav control: click it, see if it caused a URL change
 * (→ urlNavs) or an in-place VIEW swap with no URL change (→ viewLabels, which become click-paths), then restore
 * to the origin state by reloading the base url + replaying the prior click-path. Destructive controls never
 * clicked. `aggressive` (page has no anchors) → click ANY non-destructive item, not just nav-word ones, so we
 * get past entry/"Select"/portal <li> gates. `originClicks` = the click-path of the page we're exploring FROM. */
/** OPEN-TO-LEARN-THE-FORM: after opening an action control (e.g. "Create Event"), harvest the revealed FORM's input
 *  fields — its label (from placeholder/aria/associated <label>/name), kind, and required-ness — so a testing engine
 *  can scaffold attacks on real fields. Prefers a revealed dialog/form container; falls back to all visible inputs on
 *  the new view. NEVER touches submit buttons — this is pure field capture, no fill, no click. */
async function captureFormFields(page: Page): Promise<Array<{ label: string; kind: string; required: boolean; placeholder?: string }>> {
  try {
    return await page.evaluate(() => {
      const d: any = (globalThis as any).document;
      const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
      const win: any = (globalThis as any);
      const FIELD_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea';
      // SCOPE selection (the opener→fields mis-attribution fix): if a MODAL/OVERLAY is open (a fixed/absolute element
      // covering most of the viewport at a high z-index — the same geometry dismissOverlay uses), the fields the click
      // just revealed live INSIDE it → scope to that overlay, NOT to whatever container has the most fields globally
      // (which would grab the UNDERLYING page's filter/search inputs — the "12 forms all = Search customer…" bug).
      // Only when NO overlay is present do we fall back to "container with the most fields" (the navigated create-PAGE
      // case: a stray empty <form> must not win over the page's real 8 inputs).
      const isOverlay = (el: any) => { try { const s = win.getComputedStyle(el); if (s.position !== 'fixed' && s.position !== 'absolute') return false; if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width >= win.innerWidth * 0.5 && r.height >= win.innerHeight * 0.4 && (+s.zIndex || 0) >= 50; } catch { return false; } };
      let scope: any = null;
      // topmost overlay = the one with the highest z-index among viewport-spanning overlays that CONTAIN a field.
      let bestZ = -1;
      for (const el of Array.prototype.slice.call(d.querySelectorAll('body *'))) {
        if (!isOverlay(el)) continue;
        if (!Array.prototype.some.call(el.querySelectorAll(FIELD_SEL), vis)) continue;   // an overlay with no field isn't the form
        const z = +win.getComputedStyle(el).zIndex || 0;
        if (z >= bestZ) { bestZ = z; scope = el; }
      }
      if (!scope) {
        // no field-bearing overlay → fall back to the container-with-most-fields heuristic (navigated create-page).
        const containers = Array.prototype.slice.call(d.querySelectorAll('[role="dialog"], form, [class*="modal" i], [class*="dialog" i], [class*="drawer" i], main')).concat([d.body]);
        scope = d.body; let bestCount = -1;
        for (const c of containers) {
          const n = Array.prototype.filter.call(c.querySelectorAll(FIELD_SEL), vis).length;
          if (n > bestCount) { bestCount = n; scope = c; }
        }
      }
      const els = Array.prototype.slice.call(scope.querySelectorAll(FIELD_SEL)).filter(vis);
      const out: Array<{ label: string; kind: string; required: boolean; placeholder?: string }> = [];
      const seen: any = {};
      for (const el of els) {
        const tag = (el.tagName || '').toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        // label: aria-label, placeholder, associated <label for=id>, name — first non-empty.
        let label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        if (!label) { const id = el.getAttribute('id'); if (id) { const lab = d.querySelector('label[for="' + id + '"]'); if (lab) label = (lab.textContent || '').trim(); } }
        if (!label) label = el.getAttribute('name') || '';
        label = String(label).replace(/\s+/g, ' ').trim().slice(0, 50);
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen[key]) continue; seen[key] = 1;
        const kind = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (type || 'text');
        const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
        out.push({ label, kind, required, placeholder: el.getAttribute('placeholder') || undefined });
      }
      return out.slice(0, 25);
    });
  } catch { return []; }
}

async function safeClickExplore(page: Page, baseUrl: string, routeKey: (u: string) => string, visited: Set<string>, aggressive: boolean, navKey: (n: Nav) => string, originClicks: NavStep[], knownSigs: Set<string>, ensureSession: () => Promise<boolean> = async () => false, probedNavLabels: Set<string> = new Set()): Promise<{ urlNavs: string[]; viewLabels: string[]; droppedChoices: string[]; dangerous: Array<{ label: string; category: string; why: string }>; selByKey: Record<string, { tier: string; css: string | null; name: string | null; verified: boolean; ambiguity: number }>; affordances: Array<{ label: string; kind: 'nav' | 'action' | 'guarded'; selName?: string; tier?: string }> }> {
  const urlNavs: string[] = [];
  const viewLabels: string[] = [];
  const droppedChoices: string[] = [];
  const dangerousFound: Array<{ label: string; category: string; why: string }> = [];   // CRAWL-e: mapped-but-never-clicked
  // FULL affordance inventory of this page: every distinct control, its kind (nav=followed / action=capability not
  // auto-clicked / guarded=dangerous). Nothing the crawler sees is silently dropped. See the inventory block below.
  const affordances: Array<{ label: string; kind: 'nav' | 'action' | 'guarded'; selName?: string; tier?: string }> = [];
  // L1-a: the RESOLVABLE identity of the control that produced each urlNav/viewLabel, keyed 'url:<href>' /
  // 'view:<label>' so the caller stamps it on the enqueued nav (element identity survives to the edge). Shape:
  // {tier, css?, role?, name?} — css for id/testid/aria/positional; {role?,name} for the text tier.
  const selByKey: Record<string, { tier: string; css: string | null; name: string | null; verified: boolean; ambiguity: number }> = {};
  const origin = new URL(baseUrl).origin;
  const baseUrlHref = page.url();   // the url we're currently on (already at the origin state)
  const restore = async (): Promise<boolean> => {
    // page.reload() (not gotoRendered-to-same-url, a same-document NO-OP that leaves the SPA on the CURRENT view; and
    // NOT a location.hash reset, which on a hash-WRITE-ONLY SPA changes the URL without re-rendering) forces a real
    // document load → resets the SPA to its entry state so the originClicks replay lands on the controls it expects.
    // On an in-memory-session app the reload drops auth → ensureSession re-auths. Also the portal-enumeration mechanism.
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await waitForHydration(page); }
    catch { const g = await gotoRendered(page, baseUrlHref); if (!g.ok) return false; }
    await ensureSession();
    try { const { authSignals } = await import('./authSignals'); const s = await authSignals(page).catch(() => null as any); if (s && s.hasPasswordField && (s.authedAffordances || []).filter((a: string) => !a.startsWith('__nav')).length === 0) return false; } catch {}
    for (const s of originClicks) { const ok = typeof s === 'string' ? await clickByLabel(page, s) : await fillByLabel(page, s.fill, s.value); if (!ok) return false; await page.waitForTimeout(600); await waitForHydration(page); }
    return true;
  };
  await waitForHydration(page);   // the SPA fix: don't enumerate buttons before the app rendered them
  try {
    // DYNAMIC clickable detection (the "Choose Portal" fix): real apps (Material-UI, Ant, custom React) render
    // clickable items as plain <div>/<li> with a React onClick + cursor:pointer — NO role, NO <button>, NO
    // onclick attr. So enumerate by the UNIVERSAL clickable signal: computed cursor:pointer (plus the usual
    // roles). Tag each candidate with a data attribute so we can click the exact element back. Framework-agnostic.
    const cands = await page.evaluate((DERIVE_SRC: string) => {
      const doc: any = (globalThis as any).document;
      const win: any = (globalThis as any);
      const deriveAndVerify = new Function('return (' + DERIVE_SRC + ')')();   // the ONE shared deriver+verifier
      // SHADOW-AWARE candidate enumeration (gap 2, fixtures E2E): deep-query so controls inside open shadow roots
      // (web components) reach the affordance inventory — measured on hard-target.html where plain shadow buttons were
      // missed. Fallback to light-DOM if the deep-query shim is absent. NOTE: a shadow-rooted candidate is INVENTORIED
      // (capability visibility, the goal) but the later data-xsclk token-click may not pierce the shadow boundary — that
      // degrades to "recorded but not auto-clicked", the honest outcome, never a silent failure.
      const Qd: any = (globalThis as any).__xsionQueryAllDeep;
      const qd = (sel: string) => Qd ? Qd(sel, doc) : Array.prototype.slice.call(doc.querySelectorAll(sel));
      const roleSel = 'button, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="link"]:not(a), [onclick]';
      const set = new Set<any>(qd(roleSel));
      // add cursor:pointer elements that are LEAF-ish (don't add a huge container) and have a short text label
      const allEls: any[] = qd('li, div, span, a, article, [class*="item" i], [class*="card" i], [class*="tile" i], [class*="portal" i], [class*="option" i]');
      for (const el of allEls) {
        try {
          if (win.getComputedStyle(el).cursor !== 'pointer') continue;
          const txt = (el.textContent || '').trim();
          if (!txt || txt.length > 40) continue;                 // must be a labeled, item-sized control
          if (el.querySelector && el.querySelector('[style*="cursor: pointer"], button, a')) continue; // prefer the innermost
          set.add(el);
        } catch {}
      }
      const out: { name: string; token: string; tag: string; href: string | null; sameOrigin: boolean; inFormMethod: string | null; inputType: string | null; hasFormaction: boolean; selectorTier: string; css: string | null; selName: string | null; verified: boolean; ambiguity: number }[] = [];
      let n = 0;
      const origin = win.location ? win.location.origin : '';
      set.forEach((el: any) => {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!name) return;
        const token = 'xsclk-' + (n++);
        el.setAttribute('data-xsclk', token);   // stable handle to click this exact element back
        // ── DOM FACTS for the safety classifier (CRAWL-e): tag, href+same-origin (a link is navigation), the ancestor
        // form's method (GET=read / POST=mutation), input type, and formaction (overrides the form action → a submit).
        const tag = (el.tagName || '').toLowerCase();
        const rawHref = tag === 'a' ? el.getAttribute('href') : null;
        let sameOrigin = false;
        if (rawHref) { try { sameOrigin = new URL(rawHref, win.location.href).origin === origin; } catch { sameOrigin = false; } }
        const form = el.closest ? el.closest('form') : null;
        const inFormMethod = form ? ((form.getAttribute('method') || '').toLowerCase() || null) : null;
        const inputType = (tag === 'input' || tag === 'button') ? ((el.getAttribute('type') || '').toLowerCase() || null) : null;
        const hasFormaction = !!(el.getAttribute && el.getAttribute('formaction'));
        const id = deriveAndVerify(el, name, doc, win);   // the shared deriver+verifier
        out.push({ name, token, tag, href: rawHref, sameOrigin, inFormMethod, inputType, hasFormaction, selectorTier: id.tier, css: id.css, selName: id.name, verified: id.verifiedAtCapture, ambiguity: id.ambiguityCount });
      });
      return out.slice(0, 60);
    }, DERIVE_AND_VERIFY);
    // ── SAFETY CLASSIFY (CRAWL-e): decide per candidate — SAFE to click, or GENUINELY DANGEROUS (map-but-never-click).
    // Replaces the crude DESTRUCTIVE_VERBS label-regex (which over-flagged Cancel/Reset/Update-view). The classifier
    // uses the DOM facts we just collected: a same-origin <a href> or a GET-form control is navigation/read → safe;
    // a hard-danger label (Delete/Send/Pay/Logout) or a POST/submit is dangerous → recorded as an affordance but
    // NEVER auto-clicked, so a crawl of a live/prod app can't fire a real Send/Delete/Pay. (User's rule.)
    const nonDestr = cands.filter((c) => {
      const v = classifyElement({ label: c.name, tag: c.tag, href: c.href, sameOrigin: c.sameOrigin, inFormMethod: c.inFormMethod, inputType: c.inputType, hasFormaction: c.hasFormaction });
      if (!v.clickable) { dangerousFound.push({ label: c.name, category: v.category, why: v.why }); return false; }
      return true;
    });
    if (dangerousFound.length) {
      console.log(`[XSION][crawl] safety: mapped-but-NOT-clicked ${dangerousFound.length} dangerous control(s): ${dangerousFound.slice(0, 4).map((d) => `"${d.label}"(${d.category})`).join(', ')}`);
    }
    // ── FULL AFFORDANCE INVENTORY ("understand every button/text/action"): record EVERY distinct control the crawler
    // saw on this page — clickable-and-probed, clickable-but-not-probed (NAV_HINT-filtered, e.g. "Create Event"), and
    // dangerous (map-but-never-click). Previously a control that survived the safety gate but failed NAV_HINT was
    // SILENTLY DROPPED (never clicked, never recorded) — so real capabilities like "Create Event" vanished from the
    // map. Now nothing the crawler sees is lost: it becomes coverage the test engine can target under consent.
    const seenAff = new Set<string>();
    for (const c of cands) {
      const key = (c.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key || seenAff.has(key)) continue; seenAff.add(key);
      const cls = classifyElement({ label: c.name, tag: c.tag, href: c.href, sameOrigin: c.sameOrigin, inFormMethod: c.inFormMethod, inputType: c.inputType, hasFormaction: c.hasFormaction });
      affordances.push({ label: c.name, kind: cls.clickable ? (NAV_HINT.test(c.name) ? 'nav' : 'action') : 'guarded', selName: c.selName || undefined, tier: c.selectorTier });
    }
    // DEDUP BY LABEL before the cap (the schooltalk portal-picker root fix): the picker renders each school as
    // NESTED markup, so "NZ Curriculum" appeared 3× in `cands` — 13 real schools became 41 candidates, and the
    // slice(0,10) truncated to just Demo/Demonstration/Doon (the alphabetical head). Collapse identical labels so
    // the cap counts DISTINCT choices, not duplicated DOM. Plain lowercase+whitespace normalize — NOT normLabel,
    // which strips digits and would wrongly merge "School 1"/"School 2" on some other app. General, no app words.
    const gated = aggressive ? nonDestr : nonDestr.filter((c) => NAV_HINT.test(c.name));
    const seenLabel = new Set<string>();
    const distinct = gated.filter((c) => { const key = c.name.trim().toLowerCase().replace(/\s+/g, ' '); if (!key || seenLabel.has(key)) return false; seenLabel.add(key); return true; });
    // CAP: a hard ceiling for pathological pages PLUS an "unproductive" cap that stops when probes stop discovering.
    // The old fixed 7/5 dropped admin's users(idx7)+danger(idx8) nav items → "map every view" impossible. Now: probe
    // up to CLICK_CAP, but a probe that discovers a NEW view resets the unproductive counter — so a wide nav (each
    // item = a new view) is fully mapped, while a dashboard of dead widgets still stops after UNPRODUCTIVE_CAP. The
    // productive-reset keys on urlChanged ONLY (a real move), NOT the crude viewChanged bodyLen test (a filter/toggle
    // that shifts body length would falsely reset it). (2026-08-29, regression-review-corrected)
    const CLICK_CAP = aggressive ? 24 : 12;
    const UNPRODUCTIVE_CAP = aggressive ? 8 : 6;
    const safe = distinct.slice(0, CLICK_CAP);
    // HONEST COVERAGE: a distinct choice we won't click this pass is returned as a dropped-choice so the CALLER
    // (which owns noteUnknown) records it — "3 of 13 schools" must never read as complete. (Silent-truncation rule.)
    for (const c of distinct.slice(CLICK_CAP)) droppedChoices.push(c.name.trim());
    let unproductive = 0;
    // probe each candidate BY LABEL. RELOAD-ONLY-WHEN-NEEDED: the picker's enumeration mechanism IS reload-per-probe
    // (after clicking school N you are ON school N's page; the ONLY way back to click school N+1 is a reload — two
    // live runs proved that removing it drops coverage from 6 tenants to 1, and that arriving via picker-click vs
    // direct-URL — not reload count — is what blanks a dashboard capture). So restore() STAYS in the navigating
    // case. What we DO delete are the two unconditional reloads that were never needed:
    //   • click never landed → DOM unchanged → `continue`, no restore.
    //   • click produced NO url change AND NO view change → page untouched → keep probing, no restore.
    // Only a real move (navigated OR in-place view swap) triggers the reload. (Crawljax isDomChanged idea, applied
    // to the cases where it's actually safe.)
    for (const c of safe) {
      try {
        // CRAWL-WIDE NAV DEDUP: a persistent nav label already probed on an earlier page (its view is/will be mapped)
        // is STILL inventoried above (affordances), but NOT re-clicked here — that re-click + its reload-restore is the
        // storm. Skip probing it; enqueue nothing new (the view's already in the frontier from its first sighting).
        const navKey0 = c.name.trim().toLowerCase().replace(/\s+/g, ' ');
        if (probedNavLabels.has(navKey0)) continue;
        // DISMISS A STRAY MODAL/OVERLAY before probing: a PRIOR probe (e.g. "Notifications", a Flag/action button) can
        // open a full-viewport modal that then INTERCEPTS every subsequent click — the crawl stalls at 1 page with each
        // nav element reporting "covered by modalWrap". General fix: if a fixed, high-z, viewport-spanning overlay is up,
        // press Escape (+ click a backdrop as fallback) to clear it before this probe. No app knowledge — pure geometry.
        await dismissOverlay(page);
        const before = page.url();
        const beforeSig = await domSignature(page);
        const clicked = await clickByLabel(page, c.name);
        if (!clicked) { continue; }   // couldn't click → DOM unchanged, nothing to restore
        await page.waitForTimeout(800);
        await waitForHydration(page);   // REVERTED a speculative 800→350ms + hydration-removal: SPA view-swaps render
        // async, so dropping this made `viewChanged` under-detect and silently lose click-discovered states (no
        // measurement showed detection held). The safeClickExplore cost is restore() reloads (the nr·cr term the
        // research says dominates) — not a bug to shave. Kept the narrowed container selector (that one's a real win).
        const after = page.url();
        const afterSig = await domSignature(page);
        const urlChangedRaw = after !== before && new URL(after).origin === origin;
        // HASH-ONLY MIRAGE (2026-08-29, the completeness-review fix): a nav click that changes ONLY the fragment
        // (#/orders) AND swaps the content in place is a CLICK-DRIVEN view — many SPAs write location.hash but render
        // the view ONLY from the onclick handler, with NO hashchange/popstate listener that reads the hash. Re-
        // navigating to that hash URL then renders NOTHING (or the default view) → every hash "page" captures the
        // DEFAULT view's DOM behind a distinct routeKey (the mirage: pages count looks right, content is duplicated).
        // So when the change is fragment-only AND the content moved, treat it as a CLICK-PATH (reach by clicking the
        // label — the only real render trigger), NOT a bare urlNav. A real cross-route URL change still goes urlNav.
        let hashOnly = false;
        try { const ub = new URL(before), ua = new URL(after); hashOnly = ub.origin === ua.origin && ub.pathname === ua.pathname && ub.search === ua.search && ub.hash !== ua.hash; } catch {}
        // HASH-ONLY = a CLICK-DRIVEN view (the hash IS the distinctness signal — do NOT also require a content-length
        // delta: measured, these table-swap views move body text by ≤155 chars < 250 and never change <title>, so the
        // old conjunction dropped EVERY view). Classify hash-only as viewChanged (click-path) unconditionally; the
        // viewChanged branch below already dedups via swapSig (captureShape) so genuinely-same states still collapse.
        const contentMoved = afterSig.title !== beforeSig.title || Math.abs(afterSig.len - beforeSig.len) > 250;
        const urlChanged = urlChangedRaw && !hashOnly;                    // hash-only → NOT a urlNav (it's a click-view)
        const viewChanged = !urlChanged && (after === before ? contentMoved : hashOnly);   // same-url→content test; hash-only→always a view
        // this label produced a nav → record it crawl-wide so no later page re-probes (re-reloads) the same persistent nav.
        if (urlChanged || viewChanged) probedNavLabels.add(navKey0);
        if (urlChanged) {
          const rk = routeKey(after);
          if (!visited.has(rk) && !urlNavs.includes(after)) { urlNavs.push(after); selByKey['url:' + after] = { tier: c.selectorTier, css: c.css, name: c.selName, verified: c.verified, ambiguity: c.ambiguity }; }
        } else if (viewChanged) {
          // ── SAME-ROUTE VIEW-SWAP DEDUP (the click-path explosion fix, verified on the fixture: 11 pages/3 sigs).
          // A no-op or toggle click can trip the crude bodyLen>250 viewChange test yet land on a state we've ALREADY
          // mapped (home reached via a different click-path). Compute the REAL state signature here and only enqueue
          // this click-path if it reaches a genuinely NEW state. Same-route only (we didn't navigate), so this can't
          // re-merge schooltalk's cross-route cv=0 collisions — those live at different routeKeys. (Advisor: use the
          // full sig, one decision function; this is the cheap post-click capture that also saves a later reset.)
          const _tSwap = Date.now();
          const swapShape = await captureShape(page, routeKey(after)).catch(() => null);
          console.log(`[XSION][perf] view-swap captureShape ${Date.now() - _tSwap}ms`);
          const swapSig = swapShape ? sigFromShape(swapShape) : null;
          const label = c.name;
          const k = navKey({ url: baseUrlHref, clicks: [...originClicks, label] });
          const reachesNewState = !swapSig || !knownSigs.has(swapSig);
          if (reachesNewState && !visited.has(k) && !viewLabels.includes(label)) { viewLabels.push(label); selByKey['view:' + label] = { tier: c.selectorTier, css: c.css, name: c.selName, verified: c.verified, ambiguity: c.ambiguity }; if (swapSig) knownSigs.add(swapSig); }
        }
        // PRODUCTIVITY: a probe that produced a real move (new url OR a genuine view swap) is productive → reset the
        // unproductive counter so a wide productive nav is fully mapped; otherwise count toward the unproductive cap.
        if (urlChanged || viewChanged) unproductive = 0; else if (++unproductive >= UNPRODUCTIVE_CAP) break;
        // restore ONLY when the page actually moved (nav or view swap) — this is the enumeration mechanism for a
        // picker (reload back → click the next option). A no-op click leaves us on the origin; no reload needed.
        if (urlChanged || viewChanged) { const r = await restore(); if (!r) break; }
      } catch { /* one bad probe shouldn't abort the page */ }
    }
  } catch { /* click-explore is best-effort */ }
  await restore().catch(() => false);
  return { urlNavs, viewLabels, droppedChoices, dangerous: dangerousFound, selByKey, affordances };
}

/** Type a value into an input identified by label/placeholder/name/aria — dynamically (multi-step unlock: fill a
 * search/access field before the click that reveals content). Returns true if it found + filled a field. */
async function fillByLabel(page: Page, label: string, value: string): Promise<boolean> {
  try {
    const norm = label.trim().toLowerCase();
    const token = await page.evaluate((args: any) => {
      const [want] = args; const doc: any = (globalThis as any).document;
      const inputs: any[] = Array.prototype.slice.call(doc.querySelectorAll('input, textarea, select'));
      const score = (el: any): number => {
        const hay = [el.getAttribute('aria-label'), el.placeholder, el.name, el.id, el.getAttribute('type')].filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(want)) return 2;
        // also match a nearby label
        const id = el.getAttribute('id'); if (id) { const l = doc.querySelector(`label[for="${id}"]`); if (l && (l.textContent || '').toLowerCase().includes(want)) return 2; }
        return 0;
      };
      let best: any = null, bs = 0;
      for (const el of inputs) { const s = score(el); if (s > bs) { bs = s; best = el; } }
      if (!best && inputs.length === 1) best = inputs[0];   // only one field → it's the one
      if (!best) return '';
      best.setAttribute('data-xsfill', '1'); return '1';
    }, [norm]);
    if (!token) return false;
    const el = page.locator('[data-xsfill="1"]').first();
    const { fillMaybeAutocomplete } = await import('./autocompleteFill');   // autocomplete-aware (teacher/group search fields)
    const r = await fillMaybeAutocomplete(page, el, value);
    await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsfill="1"]'); if (e) e.removeAttribute('data-xsfill'); });
    return r !== 'failed';
  } catch { return false; }
}

/** Click an element on the page by its visible label / aria-label — dynamically (works for button, link, or a
 * cursor:pointer <li>/<div>). Returns true if a matching clickable was found and clicked. Used to REPLAY a
 * click-path (e.g. re-enter a portal) and by safeClickExplore's restore. */
/** Dismiss a stray full-viewport MODAL/OVERLAY so it can't intercept the next probe's click (the "stalls at 1 page —
 *  everything covered by modalWrap" bug: a prior probe like "Notifications" opens a modal that blocks all nav). Pure
 *  GEOMETRY, no app knowledge: detect a fixed/absolute element that covers most of the viewport at a high z-index, then
 *  press Escape and, as a fallback, click the backdrop corner. Returns true if an overlay was present + cleared. */
async function dismissOverlay(page: Page): Promise<boolean> {
  try {
    const present = await page.evaluate(() => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
      const vw = win.innerWidth, vh = win.innerHeight;
      for (const el of Array.prototype.slice.call(doc.querySelectorAll('body *'))) {
        const s = win.getComputedStyle(el); if (s.position !== 'fixed' && s.position !== 'absolute') continue;
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
        const r = el.getBoundingClientRect(); if (r.width < vw * 0.6 || r.height < vh * 0.6) continue;   // must cover most of the viewport
        if ((+s.zIndex || 0) < 50) continue;                                                            // and sit on a high layer
        return true;
      }
      return false;
    });
    if (!present) return false;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
    // still there? click the top-left backdrop (outside a centered dialog card) to dismiss click-away modals.
    const still = await page.evaluate(() => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
      const vw = win.innerWidth, vh = win.innerHeight;
      return Array.prototype.some.call(doc.querySelectorAll('body *'), (el: any) => { const s = win.getComputedStyle(el); if ((s.position !== 'fixed' && s.position !== 'absolute') || s.display === 'none' || s.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width >= vw * 0.6 && r.height >= vh * 0.6 && (+s.zIndex || 0) >= 50; });
    });
    if (still) { await page.mouse.click(8, 8).catch(() => {}); await page.waitForTimeout(150); }
    return true;
  } catch { return false; }
}

async function clickByLabel(page: Page, label: string): Promise<boolean> {
  try {
    const norm = label.trim().toLowerCase();
    const token = await page.evaluate((want: string) => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
      // CLEAR any stranded marker from a PRIOR failed clickByLabel FIRST (the poisoning fix): the failure path used to
      // leave data-xsclk-replay set on a now-detached node (e.g. a post-login "Sign In"), so every later `.first()`
      // resolved to that stale 0×0 element → all subsequent nav clicks timed out. Clearing before marking guarantees
      // exactly ONE marked element = the one THIS call targets.
      Array.prototype.forEach.call(doc.querySelectorAll('[data-xsclk-replay]'), (e: any) => e.removeAttribute('data-xsclk-replay'));
      const cands: any[] = Array.prototype.slice.call(doc.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], li, div, span, [onclick]'));
      for (const el of cands) {
        const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (t !== want) continue;
        // prefer a clickable one (has role/tag or cursor:pointer)
        let clickable = el;
        try { if (win.getComputedStyle(el).cursor !== 'pointer' && !/^(button|a)$/i.test(el.tagName) && !el.getAttribute('role') && !el.getAttribute('onclick')) { const p = el.closest('button, a, [role], [onclick], [style*="cursor: pointer"]'); if (p) clickable = p; } } catch {}
        clickable.setAttribute('data-xsclk-replay', '1');
        return '1';
      }
      return '';
    }, norm);
    if (!token) return false;
    const el = page.locator('[data-xsclk-replay="1"]').first();
    try {
      await el.click({ timeout: 4000 });
      return true;
    } finally {
      // ALWAYS clear the marker — on success AND on failure — so a failed click can never strand it and poison the next.
      await page.evaluate(() => { Array.prototype.forEach.call((globalThis as any).document.querySelectorAll('[data-xsclk-replay]'), (e: any) => e.removeAttribute('data-xsclk-replay')); }).catch(() => {});
    }
  } catch { return false; }
}
/** Build the page view SoA reasons over when the crawl stalls. Beyond text + clickables, it captures the VISUAL
 * LAYOUT as text — each element's position/size/visibility/prominence and, critically, OVERLAYS/MODALS on top
 * (fixed/absolute high-z-index covering the viewport) + text INPUTS — so SoA can reason about visual gates
 * ("a modal is blocking the page, dismiss it first") and multi-step unlocks ("type in the search then click"). */
/** a cheap fingerprint of the current view: path + title + body length. Used to detect client-side view swaps. */
async function domSignature(page: Page): Promise<{ path: string; title: string; len: number }> {
  try {
    return await page.evaluate(() => ({
      path: (globalThis as any).location.pathname,
      title: (globalThis as any).document.title || '',
      len: ((globalThis as any).document.body?.innerText || '').length,
    }));
  } catch { return { path: safePath(page.url()), title: '', len: 0 }; }
}

// ── MULTI-ROLE MERGE (item 4) ──
function apiKey(e: any): string { return e.graphql ? `GQL ${e.gqlKind}:${e.gqlOperation}` : `${e.method} ${e.url}`; }

/** Merge a role's fresh findings into the previous map's list: entities present in both get their roles[] unioned;
 * new entities are appended (carrying this role's tag). Identity is by `key`. Never loses another role's data. */
function mergeByKey<T extends { roles?: string[] }>(prev: T[], fresh: T[], key: (x: T) => string, roleId: string): T[] {
  const out = new Map<string, T>();
  for (const p of prev || []) out.set(key(p), { ...p });
  for (const f of fresh) {
    const k = key(f);
    const existing = out.get(k);
    if (!existing) { out.set(k, f); continue; }
    const roles = new Set([...(existing.roles || []), ...(f.roles || []), roleId]);
    // keep the richer entity (prefer one with requirements/payload) but always union roles
    const merged: any = { ...existing, ...f, roles: [...roles] };
    if ((existing as any).requirements && !(f as any).requirements) merged.requirements = (existing as any).requirements;
    out.set(k, merged);
  }
  return [...out.values()];
}

/** Keep the roster of roles crawled into this map current — add/update this role, stamp crawledAt on completion. */
function mergeRoleRoster(prev: any[] | undefined, role: { id: string; name: string }, hasCreds: boolean, done: boolean): any[] {
  const roster = [...(prev || [])];
  const at = roster.findIndex((r) => r.id === role.id);
  const entry = { id: role.id, name: role.name, hasCredentials: hasCreds, crawledAt: done ? new Date().toISOString() : (at >= 0 ? roster[at].crawledAt : undefined) };
  if (at >= 0) roster[at] = { ...roster[at], ...entry };
  else roster.push(entry);
  return roster;
}

/** Save the actual screenshot of a stuck page as an artifact (for the human to inspect + a future multimodal
 * SoA to reason over pixels). Returns the artifact filename or ''. */
async function saveStallShot(page: Page, runId: string, n: number): Promise<string> {
  try {
    const dir = path.join(process.env.XSION_DATA_DIR || path.resolve(process.cwd(), 'data'), 'artifacts');
    await fs.promises.mkdir(dir, { recursive: true });
    const name = `stall-${runId.slice(0, 8)}-${n}.jpg`;
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
    await fs.promises.writeFile(path.join(dir, name), buf);
    return name;
  } catch { return ''; }
}

async function streamFrame(runId: string, page: Page) {
  try {
    // quality 40 = smaller payload → faster encode + lighter WS frame, so the timer-driven stream stays smooth.
    const buf = await page.screenshot({ type: 'jpeg', quality: 40, timeout: 4000 });
    emit(runId, { type: 'crawl:screenshot', dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, path: safePath(page.url()) });
  } catch {}
}

/**
 * L0-b: is this page a login gate? SCORED over unitless signals via classifyLoginGate — NOT password-field-only.
 * FIXES the measured schooltalk false-negative: an SSO-first wall (Continue with Google/Microsoft, Setup new
 * password; NO password field until you pick a provider) is now recognized as a gate, so the crawler no longer maps
 * the login screen as the app. `routeRequiresAuth` (Mode-1 routeManifest) corroborates when known.
 */
export async function looksLikeLogin(page: Page, opts?: { routeRequiresAuth?: boolean; noWait?: boolean }): Promise<boolean> {
  try {
    const { authSignals, classifyLoginGate } = await import('./authSignals');
    // HYDRATION-ROBUST (measured on schooltalk: at ~1s the SPA has NO password field / NO vocab → false-negative;
    // at ~3s it shows SIGN IN + password). Re-check while the page shows no decisive signal YET — but a read that
    // THREW (ok:false) is NOT "empty", it's "unknown", so keep waiting on it too rather than deciding on a failed read.
    // noWait = a fast one-shot (for the post-login "is a password form STILL up" check — the wait is for the LANDING
    // decision only, not for re-checks on an already-authenticated page).
    let s = await authSignals(page);
    let waited = 0;
    const cap = opts?.noWait ? 0 : 10000;
    while (waited < cap && (!s.ok || (!s.hasPasswordField && s.authVocabControls.length === 0 && s.authedAffordances.length === 0))) {
      await page.waitForTimeout(1000).catch(() => {});
      waited += 1000;
      s = await authSignals(page);
    }
    const verdict = classifyLoginGate(s, { routeRequiresAuth: opts?.routeRequiresAuth });
    // DIAGNOSTIC: log ok + the exit signals so a false-negative is diagnosable as read-threw (ok:false) vs
    // genuinely-empty (ok:true, all zeros) vs signals-present-but-not-a-gate. Closes the ambiguity that hid run #4's root.
    console.log(`[XSION][gate] looksLikeLogin waited=${waited}ms ok=${s.ok} signals={pw:${s.hasPasswordField},vocab:${s.authVocabControls.length},authed:${s.authedAffordances.length}} → isLoginGate=${verdict.isLoginGate} (${verdict.why})`);
    return verdict.isLoginGate;
  } catch (e) { console.log(`[XSION][gate] looksLikeLogin THREW (→false): ${String((e as any)?.message || e).slice(0, 80)}`); return false; }
}

/** DYNAMIC identifier-field resolution (de-hardcoded): instead of a fixed selector list, read the FULL context of
 * every candidate input — type, name, id, autocomplete, placeholder, aria-label, and the nearest label/surrounding
 * text — and SCORE which one is the login identifier (email/username/phone/login). Adapts to ANY form, including
 * type=text fields with unlinked labels. Returns the 0-based index among non-password text-like inputs, or null. */
export async function resolveIdentifierField(page: Page): Promise<number | null> {
  try {
    const idx = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const inputs: any[] = Array.prototype.slice.call(doc.querySelectorAll('input'))
        .filter((el: any) => !['password', 'checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'file', 'range', 'color'].includes((el.type || 'text').toLowerCase()));
      const nearText = (el: any): string => {
        const id = el.getAttribute('id');
        let t = '';
        if (id) { const l = doc.querySelector(`label[for="${id}"]`); if (l) t += ' ' + (l.textContent || ''); }
        const wrap = el.closest && el.closest('label'); if (wrap) t += ' ' + (wrap.textContent || '');
        // the label often sits just before the input in the DOM
        const prev = el.previousElementSibling; if (prev && /label|span|div/i.test(prev.tagName)) t += ' ' + (prev.textContent || '');
        return t;
      };
      const score = (el: any): number => {
        const hay = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label'), nearText(el)]
          .filter(Boolean).join(' ').toLowerCase();
        let s = 0;
        if (/\bemail\b|e-?mail/.test(hay)) s += 5;
        if (el.type === 'email') s += 5;
        if (/\busername\b|\buser ?id\b|\blogin\b|\baccount\b/.test(hay)) s += 4;
        if (el.getAttribute('autocomplete') === 'username' || el.getAttribute('autocomplete') === 'email') s += 4;
        if (/\bphone\b|\bmobile\b/.test(hay)) s += 2;
        if (/\bsearch\b|\bcoupon\b|\bpromo\b|\bnewsletter\b/.test(hay)) s -= 6;  // clearly-not-login inputs
        return s;
      };
      let best = -1, bestScore = 0;
      inputs.forEach((el, i) => { const sc = score(el); if (sc > bestScore) { bestScore = sc; best = i; } });
      // if nothing scored positively but there IS exactly one text input near the password, use it (the common
      // "text field then password field" login shape) — still dynamic, not a hardcoded selector.
      if (best < 0 && inputs.length >= 1) best = 0;
      return best;
    });
    return typeof idx === 'number' && idx >= 0 ? idx : null;
  } catch { return null; }
}
/** the Playwright locator for the resolved identifier field (by index among non-password text-like inputs). */
export function identifierLocator(page: Page, index: number) {
  return page.locator('input:not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"])').nth(index);
}

/**
 * TRI-STATE login (L0-a). Fill + submit exactly as before (that part was measured-correct on dent), but VERIFY with
 * settleLogin — a POLL to a terminal signal — instead of a fixed 2500ms sleep + absence check. Returns:
 *   'signed-in'     — positive app evidence, settled.
 *   'rejected'      — form present + auth error near it (wrong creds → caller CLEARS creds).
 *   'indeterminate' — no terminal signal within the cap (slow/unknown app → caller KEEPS creds, reports blocked).
 *
 * WHY: dent login SUCCEEDS in ~3s (adminLogin→200) but the old fixed 2500ms check fired mid-request → returned false
 * → 0-page crawl AND wiped the correct creds blaming the user. The tri-state never conflates "slow" with "wrong".
 * `knownAppRoute` (optional, Mode-1): a predicate that recognizes a post-login app route (not /login) for a faster,
 * surer positive verdict.
 */
export async function tryLoginSettled(
  page: Page, email: string, password: string, opts?: { knownAppRoute?: (url: string) => boolean },
): Promise<import('./authSignals').LoginOutcome> {
  try {
    // ORDERING FIX: WAIT for the login form to actually render BEFORE resolving the identifier field (schooltalk
    // hydrates slowly; a too-early scan filled the wrong field). waitForHydration is satisfied by a stray link while
    // inputs are still absent, so it's not a form-ready check — wait on a real visible non-password input instead.
    await page.locator('input:not([type=password]):not([type=hidden])').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const idxRaw = await resolveIdentifierField(page);
    const e = identifierLocator(page, idxRaw ?? 0);
    await e.waitFor({ state: 'visible', timeout: 8000 });
    const urlBefore = page.url();
    await e.fill(email, { timeout: 5000 });
    await page.locator('input[type="password"]').first().fill(password, { timeout: 5000 });
    // click the submit/sign-in button, but NOT an OAuth button (Google/Microsoft) — those start a different flow.
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    const namedBtn = page.getByRole('button', { name: /^\s*(sign ?in|log ?in|submit|continue|next)\s*$/i }).first();
    const clickTarget = (await submitBtn.count()) ? submitBtn : namedBtn;
    await clickTarget.click({ timeout: 6000 }).catch(async () => {
      await page.locator('input[type="password"]').first().press('Enter').catch(() => {});   // last resort: submit via Enter
    });
    // POLL to a terminal, tri-state verdict (no fixed sleep, no absence-based false-pass).
    const { settleLogin } = await import('./authSignals');
    const res = await settleLogin(page, urlBefore, { capMs: 20000, knownAppRoute: opts?.knownAppRoute });
    return res.outcome;
  } catch { return 'indeterminate'; }
}

/** Boolean login for the UNIFIED-LOGIN consumers (intentRunner, authGate) — signed-in ⇒ true, else false. Now backed
 *  by the tri-state settle, so every engine inherits the dent timing fix. */
export async function tryLogin(page: Page, email: string, password: string): Promise<boolean> {
  // DEFAULT knownAppRoute so EVERY bare-boolean consumer (authGate, intentRunner→bug-repro/break-it) gets the same
  // positive-evidence signal the crawler's call site already supplies: a URL that moved OFF the login gate (path is
  // not /login) IS being-in-the-app. WITHOUT this, settleLogin could only confirm success via authed-affordances —
  // which on slow-hydrating apps (schooltalk /Teacher renders blank ~15s) don't appear in time → false 'indeterminate'
  // → a FALSE "login failed" gate-block on creds that actually worked (measured: landed /Teacher, tryLogin=false).
  const knownAppRoute = (u: string) => { try { const p = new URL(u).pathname.replace(/^\//, ''); return !!p && !/^login\b/i.test(p); } catch { return false; } };
  return (await tryLoginSettled(page, email, password, { knownAppRoute })) === 'signed-in';
}

/** Detect a rendered authentication error (wrong credentials, invalid login, etc.) so we never call a failed
 * login a success. Looks for common error phrasings in visible text near the form. */
async function hasAuthError(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const text = (doc.body?.innerText || '').toLowerCase();
      // common auth-failure phrasings; kept conservative to avoid false positives on ordinary page copy
      return /\b(invalid|incorrect|wrong|failed|unable to (log|sign)|not (found|recognized)|does ?n['’]?t match|bad credentials|authentication failed|please try again|invalid email or password|incorrect password)\b/.test(text)
        && /\b(email|password|credential|login|sign ?in|account)\b/.test(text);
    });
  } catch { return false; }
}

// ── ITEM 3: read TYPED FIELD REQUIREMENTS off the DOM, generically (no hardcoded email/pw/image/pdf). For every
// input/select/textarea on the page, take what the DOM already declares — type, accept, required, pattern, min/
// max, label — and turn it into a {kind, required, accepts, prompt, met} requirement. Credentials fall out of
// this as ordinary email/password kinds, not a special case. Runs entirely in-page; no code needed (DOM-first).
async function extractFieldRequirements(page: Page): Promise<FieldRequirement[]> {
  try {
    const raw = await page.evaluate(() => {
      // runs in the BROWSER — DOM globals exist at runtime; no TS DOM lib in the Node build, so keep it untyped.
      const doc: any = (globalThis as any).document;
      const cssEsc = (s: string) => ((globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
      const out: any[] = [];
      const labelFor = (el: any): string => {
        const id = el.getAttribute('id');
        if (id) { const l = doc.querySelector(`label[for="${cssEsc(id)}"]`); if (l?.textContent?.trim()) return l.textContent.trim(); }
        const wrap = el.closest && el.closest('label'); if (wrap?.textContent?.trim()) return wrap.textContent.trim();
        return el.getAttribute('aria-label') || el.placeholder || el.getAttribute('name') || '';
      };
      const sel = (el: any): string => {
        const id = el.getAttribute('id'); if (id) return `#${id}`;
        const name = el.getAttribute('name'); if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
        const t = el.type; return t ? `input[type="${t}"]` : el.tagName.toLowerCase();
      };
      const inputs: any[] = Array.prototype.slice.call(doc.querySelectorAll('input, select, textarea'), 0, 40);
      for (const el of inputs) {
        const tag = el.tagName.toLowerCase();
        const type = el.type || (tag === 'select' ? 'select' : 'text');
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        out.push({
          selector: sel(el), tag, type,
          label: String(labelFor(el) || '').slice(0, 80),
          required: !!el.required || el.getAttribute('aria-required') === 'true',
          accept: el.accept || '',
          pattern: el.pattern || '',
          min: el.min || '', max: el.max || '',
          maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        });
      }
      return out;
    });
    return raw.map((r: any): FieldRequirement => {
      const kind = normalizeKind(r.type, r.tag);
      const accepts = r.accept ? normalizeAccept(r.accept) : undefined;
      return {
        selector: r.selector, kind, label: r.label || undefined,
        required: !!r.required, accepts, pattern: r.pattern || undefined,
        min: r.min || undefined, max: r.max || undefined, maxLength: r.maxLength,
        prompt: phraseRequirement(kind, r.label, accepts, !!r.required),
        met: false, source: 'dom',
      };
    });
  } catch { return []; }
}
function normalizeKind(type: string, tag: string): string {
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'text';
  const t = (type || '').toLowerCase();
  if (['email', 'password', 'file', 'number', 'date', 'datetime-local', 'tel', 'url', 'checkbox', 'radio', 'color', 'range', 'search', 'time', 'month', 'week'].includes(t)) return t === 'datetime-local' ? 'date' : t;
  return 'text';
}
function normalizeAccept(accept: string): string[] {
  const cats = new Set<string>();
  for (const a of accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (a.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(a)) cats.add('image');
    else if (a === 'application/pdf' || a === '.pdf') cats.add('pdf');
    else if (a.startsWith('video/') || /\.(mp4|mov|webm)$/.test(a)) cats.add('video');
    else if (a.startsWith('audio/')) cats.add('audio');
    else if (/\.(csv|xlsx?|tsv)$/.test(a) || a.includes('spreadsheet')) cats.add('spreadsheet');
    else if (/\.(docx?|txt|rtf)$/.test(a) || a.includes('word')) cats.add('document');
    else cats.add(a.replace(/^\./, '').replace(/\/.*$/, '') || 'file');
  }
  return [...cats];
}
function phraseRequirement(kind: string, label: string | undefined, accepts: string[] | undefined, required: boolean): string {
  const name = (label || '').trim();
  const req = required ? '' : ' (optional)';
  if (kind === 'file') {
    const what = accepts?.length ? accepts.join(' or ') : 'a file';
    return `Upload ${what}${name ? ` for “${name}”` : ''}${req}`;
  }
  if (kind === 'email') return `Enter an email${name ? ` for “${name}”` : ''}${req}`;
  if (kind === 'password') return `Enter a password${name ? ` for “${name}”` : ''}${req}`;
  if (kind === 'select') return `Choose ${name ? `“${name}”` : 'an option'}${req}`;
  return `Provide ${name ? `“${name}”` : `a ${kind} value`}${req}`;
}

async function animateCursorOverActions(runId: string, page: Page, n: number) {
  try {
    const els = page.getByRole('button').or(page.getByRole('link'));
    const count = Math.min(await els.count(), n);
    for (let i = 0; i < count; i++) {
      const box = await els.nth(i).boundingBox().catch(() => null);
      if (box) {
        const label = (await els.nth(i).textContent().catch(() => ''))?.trim().slice(0, 24) || '';
        emit(runId, { type: 'crawl:cursor', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), label });
        await page.waitForTimeout(400);
      }
    }
  } catch {}
}
