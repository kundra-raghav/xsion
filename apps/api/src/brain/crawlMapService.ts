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
import { captureShape, sigFromShape } from './stateSignature';
import { ExploreTracker, ArmName, decideSoa } from './exploreStrategy';
import { installEvalShim } from './evalShim';
import type { CrawlEvent, MappedPage, ApiEndpoint, ProjectMap, FieldRequirement } from './crawlTypes';

const BASE_MAX_PAGES = Number(process.env.XSION_CRAWL_MAX_PAGES || 8);   // the floor for a fresh/black-box crawl
const MAX_PAGES_CAP = Number(process.env.XSION_CRAWL_MAX_PAGES_CAP || 40); // hard ceiling even if a manifest is huge
const MAX_ACTIONS = Number(process.env.XSION_CRAWL_MAX_ACTIONS || 10);  // per page
const NAV_TIMEOUT = 25000;
const HYDRATE_TIMEOUT = 12000;   // how long to wait for a JS SPA to render interactive content after nav

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
async function waitForHydration(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const d: any = (globalThis as any).document;
      const interactive = d.querySelectorAll('a[href], button, [role="button"], [role="link"], input, select, [onclick]').length;
      const root = d.querySelector('#root, #app, [data-reactroot], main');
      const rootFilled = root && root.children && root.children.length > 0;
      return interactive > 0 || rootFilled;
    }, { timeout: HYDRATE_TIMEOUT, polling: 250 });
  } catch { /* nothing rendered in time — a real (empty/blocked) page; caller handles it honestly */ }
  // a short settle so late-mounting nav/menus finish
  await page.waitForTimeout(600).catch(() => {});
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
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname
      // a long hex segment that CONTAINS a digit = an id (uuid/hash); a pure a–f word is left alone
      .replace(/\/(?=[0-9a-f]{6,}(?:[/.]|$))(?=[a-f]*\d)[0-9a-f]{6,}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');
    return x.origin + path;
  } catch { return u; }
}
function redact(s?: string): string | undefined {
  if (!s) return s;
  return s.replace(/("?(?:password|token|secret|authorization|apikey|api_key)"?\s*[:=]\s*)"?[^",}\s]+/gi, '$1"***"').slice(0, 400);
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
      let ep = apiMap.get(key);
      if (!ep) {
        ep = { method: req.method(), url: normUrl(url), statuses: [], count: 0, firstSeenOnPath: safePath(page.url()) };
        ep.samplePayload = redact(payload);
        try { const body = await resp.text(); ep.sampleResponse = redact(body); } catch {}
        if (gql.graphql) { ep.graphql = true; ep.gqlKind = gql.gqlKind; ep.gqlOperation = gql.gqlOperation; }
        if (roleId) ep.roles = [roleId];
        apiMap.set(key, ep);
        emit(runId, { type: 'crawl:api', endpoint: ep });
      }
      if (roleId && ep.roles && !ep.roles.includes(roleId)) ep.roles.push(roleId);
      ep.count++;
      if (!ep.statuses.includes(status)) ep.statuses.push(status);
    } catch {}
  });

  const pages: MappedPage[] = [];
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
  // rolling novelty window for the plateau trigger (soa/hybrid): novel states found in the last WINDOW visits.
  const NOVELTY_WINDOW = Number(process.env.XSION_NOVELTY_WINDOW || 8);
  const recentNovel: boolean[] = [];
  const knownUnknowns = new Set<string>();
  const seenTabLabels = new Set<string>();   // (route-template, tab-label) pairs already queued — kills tab-permutation explosion (csc-2)
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

    const map: ProjectMap = {
      baseUrl, mode: repo ? 'code' : 'blackbox', repo, pages: outPages, flows: outFlows, api: outApi,
      crawledAt: new Date().toISOString(),
      bounded: { maxPages, maxActionsPerPage: MAX_ACTIONS, reachedLimit },
      status,
      frontier: [...queue],
      knownUnknowns: [...knownUnknowns],
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
      for (const u of (existing.knownUnknowns || [])) noteUnknown(u);
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
    if (await looksLikeLogin(page)) {
      if (opts.email && opts.password) {
        emit(runId, { type: 'crawl:think', message: 'This app requires a login. Signing in with the credentials you provided…' });
        const ok = await tryLogin(page, opts.email, opts.password);
        if (ok) {
          emit(runId, { type: 'crawl:think', message: 'Signed in. Now I can explore the authenticated app.' });
          // re-navigate to the app root so the BFS starts from the authenticated home, not /login
          try { await gotoRendered(page, baseUrl); } catch {}
          await streamFrame(runId, page);
        } else {
          // LOGIN FAILED (wrong creds / rejected) — do NOT proceed to map the login page as if it were the app.
          // Clear the stored bad creds and re-prompt so the user can correct them. This is the honesty fix: never
          // claim "signed in" or explore behind a gate we didn't pass.
          if (!roleId) { try { (store as any).updateProject?.(projectId, { _defaultCreds: undefined }); } catch {} }
          emit(runId, { type: 'crawl:think', message: 'Those credentials did not sign in — the app is still on the login screen (wrong email/password, or the account was rejected). I won\'t map the login page as if it were the app.' });
          emit(runId, { type: 'crawl:phase', phase: 'await-creds', label: 'Login failed — need correct credentials' });
          emit(runId, { type: 'crawl:need-creds', forUrl: page.url(), message: 'Sign-in failed with those credentials. Enter the correct email and password and I\'ll continue.' });
          save('crawling');   // keep status 'crawling' so a re-run with correct creds resumes cleanly
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
    if (repo && queue.length === 0 && pages.length === 0) {
      try {
        emit(runId, { type: 'crawl:think', message: 'Reading the app’s router to find every route up front, so no section is missed…' });
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
      if (page.url() !== nav.url || needsClicks) { const g = await gotoRendered(page, nav.url); if (!g.ok) continue; }
      else await waitForHydration(page);
      let replayOk = true;
      for (const step of (nav.clicks || [])) {
        const ok = typeof step === 'string'
          ? await clickByLabel(page, step)                    // click a label
          : await fillByLabel(page, step.fill, step.value);   // multi-step unlock: type into a field
        if (!ok) { replayOk = false; break; }
        await page.waitForTimeout(700); await waitForHydration(page);
      }
      if (!replayOk) { emit(runId, { type: 'crawl:think', message: `Couldn't re-open “${p0}” (the app changed) — skipping.` }); continue; }
      await streamFrame(runId, page);
      emit(runId, { type: 'crawl:navigate', url: page.url(), path: p0 });
      emit(runId, { type: 'crawl:think', message: `Looking at ${p0} — cataloguing what a user can do here.` });

      // ── RECORD THE STATE (the measurement substrate). Capture a content-based signature of the view we landed in,
      // set it as `currentSig` (parent for anything we enqueue from here), and feed the tracker (curiosity N +
      // metrics). Cheap single evaluate(); inert-but-harmless for the bfs control arm.
      {
        const shape = await captureShape(page, routeKey(page.url()));
        if ((shape as any)._captureError) { tracker.noteCaptureError(); emit(runId, { type: 'crawl:think', message: `⚠ state-capture failed (${(shape as any)._captureError}) — this run's state metrics are INVALID.` }); }
        currentSig = sigFromShape(shape);
        const { novel } = tracker.onState(currentSig);
        // PLATEAU novelty counts only NON-SEEDED visits: a code-seeded route being novel is EXPECTED (the manifest
        // handed it over), so it is NOT evidence the free explorer is still productive. Without this, a code-seeded
        // run reads as 100% novelty → the plateau NEVER fires → the depth phase never runs (the csc-run-1 bug).
        if (!(nav as any)._seed) { recentNovel.push(novel); if (recentNovel.length > NOVELTY_WINDOW) recentNovel.shift(); }
        // CODE-SEED-THEN-CLICK accounting: a NEW state reached via a click-path (has clicks, wasn't code-seeded) is
        // DEEP surface the router couldn't declare — the click-discovery phase's contribution.
        if (novel && (nav.clicks?.length) && !(nav as any)._seed) tracker.clickDiscovered++;
      }

      const candidates = await getCandidateActions(page, { maxCandidates: MAX_ACTIONS }).catch(() => []);
      // ITEM 3: read the typed field requirements this page declares (generic, DOM-first).
      const requirements = await extractFieldRequirements(page);
      const mp: MappedPage = { id: uuid(), url: page.url(), path: p0, title: await page.title().catch(() => ''), interactives: candidates.length, requirements: requirements.length ? requirements : undefined, roles: roleId ? [roleId] : undefined, ...( { navKey: k, clicks: nav.clicks } as any) };
      pages.push(mp);
      emit(runId, { type: 'crawl:page-found', page: mp });
      if (requirements.length) emit(runId, { type: 'crawl:think', message: `This page needs ${requirements.length} input${requirements.length > 1 ? 's' : ''}: ${requirements.map((r) => r.kind).join(', ')}. Recording them as requirements so the flow is runnable.` });
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
        const disc = await safeClickExplore(page, nav.url, routeKey, visitedPaths, aggressive, navKey, nav.clicks || []);
        let added = 0;
        for (const href of disc.urlNavs) if (enqueue({ url: href })) { added++; emit(runId, { type: 'crawl:think', message: `Found a route behind a click: ${safePath(href)} — queued.` }); }
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
          if (did) { added++; emit(runId, { type: 'crawl:think', message: `Found a section behind “${label}” (no URL change) — queued to explore inside it.` }); }
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
    const freshFlows = await synthesizeFlows({ baseUrl, repo, pages, api: [...apiMap.values()] });
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

    // ── final persist (status=done) ──
    const map = save('done');
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

// ── MODE-2 SAFE CLICK-EXPLORE (item 6) ──
// A control is DESTRUCTIVE if its label matches any of these — we never click it (it could mutate the live app).
const DESTRUCTIVE_VERBS = /\b(delete|remove|send|submit|save|pay|buy|checkout|confirm|publish|post|create|add|update|edit|archive|cancel|deactivate|disable|logout|sign\s*out|reset|clear|revoke|approve|reject|transfer|withdraw|deposit)\b/i;
// A control is NAVIGATIONAL if its label/role suggests moving between views (safe to click).
const NAV_HINT = /\b(view|open|details?|go|home|dashboard|users?|plans?|settings?|profile|explore|reports?|analytics|overview|list|browse|menu|tab|back|next|more|manage|show|see)\b/i;

/** Safely probe click-only navigation. For each candidate nav control: click it, see if it caused a URL change
 * (→ urlNavs) or an in-place VIEW swap with no URL change (→ viewLabels, which become click-paths), then restore
 * to the origin state by reloading the base url + replaying the prior click-path. Destructive controls never
 * clicked. `aggressive` (page has no anchors) → click ANY non-destructive item, not just nav-word ones, so we
 * get past entry/"Select"/portal <li> gates. `originClicks` = the click-path of the page we're exploring FROM. */
async function safeClickExplore(page: Page, baseUrl: string, routeKey: (u: string) => string, visited: Set<string>, aggressive: boolean, navKey: (n: Nav) => string, originClicks: NavStep[]): Promise<{ urlNavs: string[]; viewLabels: string[] }> {
  const urlNavs: string[] = [];
  const viewLabels: string[] = [];
  const origin = new URL(baseUrl).origin;
  const baseUrlHref = page.url();   // the url we're currently on (already at the origin state)
  const restore = async (): Promise<boolean> => {
    const g = await gotoRendered(page, baseUrlHref); if (!g.ok) return false;
    for (const s of originClicks) { const ok = typeof s === 'string' ? await clickByLabel(page, s) : await fillByLabel(page, s.fill, s.value); if (!ok) return false; await page.waitForTimeout(600); await waitForHydration(page); }
    return true;
  };
  await waitForHydration(page);   // the SPA fix: don't enumerate buttons before the app rendered them
  try {
    // DYNAMIC clickable detection (the "Choose Portal" fix): real apps (Material-UI, Ant, custom React) render
    // clickable items as plain <div>/<li> with a React onClick + cursor:pointer — NO role, NO <button>, NO
    // onclick attr. So enumerate by the UNIVERSAL clickable signal: computed cursor:pointer (plus the usual
    // roles). Tag each candidate with a data attribute so we can click the exact element back. Framework-agnostic.
    const cands = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const win: any = (globalThis as any);
      const roleSel = 'button, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="link"]:not(a), [onclick]';
      const set = new Set<any>(Array.prototype.slice.call(doc.querySelectorAll(roleSel)));
      // add cursor:pointer elements that are LEAF-ish (don't add a huge container) and have a short text label
      const allEls: any[] = Array.prototype.slice.call(doc.querySelectorAll('li, div, span, a, article, [class*="item" i], [class*="card" i], [class*="tile" i], [class*="portal" i], [class*="option" i]'));
      for (const el of allEls) {
        try {
          if (win.getComputedStyle(el).cursor !== 'pointer') continue;
          const txt = (el.textContent || '').trim();
          if (!txt || txt.length > 40) continue;                 // must be a labeled, item-sized control
          if (el.querySelector && el.querySelector('[style*="cursor: pointer"], button, a')) continue; // prefer the innermost
          set.add(el);
        } catch {}
      }
      const out: { name: string; token: string }[] = [];
      let n = 0;
      set.forEach((el: any) => {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!name) return;
        const token = 'xsclk-' + (n++);
        el.setAttribute('data-xsclk', token);   // stable handle to click this exact element back
        out.push({ name, token });
      });
      return out.slice(0, 60);
    });
    // never click destructive controls. In aggressive mode, any remaining candidate is fair game; otherwise only
    // nav-word ones. Click more when aggressive (the only way through a click-only front door / portal gate).
    const nonDestr = cands.filter((c) => !DESTRUCTIVE_VERBS.test(c.name));
    const safe = (aggressive ? nonDestr : nonDestr.filter((c) => NAV_HINT.test(c.name))).slice(0, aggressive ? 10 : 5);
    // probe each candidate BY LABEL (not by the data-token) — because restore() reloads the page and wipes the
    // tokens, so the 2nd/3rd portal would be unreachable by token. clickByLabel re-finds the element each time.
    for (const c of safe) {
      try {
        const before = page.url();
        const beforeSig = await domSignature(page);
        const clicked = await clickByLabel(page, c.name);
        if (!clicked) { await restore(); continue; }
        await page.waitForTimeout(800);
        await waitForHydration(page);
        const after = page.url();
        const afterSig = await domSignature(page);
        const urlChanged = after !== before && new URL(after).origin === origin;
        // in-place VIEW swap: same URL, but the content changed substantially (title changed OR body length moved
        // a lot). This is the Choose-Portal case — the label becomes a click-path, not a dead #hash.
        const viewChanged = !urlChanged && after === before &&
          (afterSig.title !== beforeSig.title || Math.abs(afterSig.len - beforeSig.len) > 250);
        if (urlChanged) {
          const rk = routeKey(after);
          if (!visited.has(rk) && !urlNavs.includes(after)) urlNavs.push(after);
        } else if (viewChanged) {
          const label = c.name;
          const k = navKey({ url: baseUrlHref, clicks: [...originClicks, label] });
          if (!visited.has(k) && !viewLabels.includes(label)) viewLabels.push(label);
        }
        // ALWAYS restore to the origin state before the next probe (reload + replay prior clicks), so each probe
        // starts clean. If restore fails (app broke), stop probing this page.
        const r = await restore();
        if (!r) break;
      } catch { /* one bad probe shouldn't abort the page */ }
    }
  } catch { /* click-explore is best-effort */ }
  await restore().catch(() => false);
  return { urlNavs, viewLabels };
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
    await el.fill(value, { timeout: 4000 });
    await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsfill="1"]'); if (e) e.removeAttribute('data-xsfill'); });
    return true;
  } catch { return false; }
}

/** Click an element on the page by its visible label / aria-label — dynamically (works for button, link, or a
 * cursor:pointer <li>/<div>). Returns true if a matching clickable was found and clicked. Used to REPLAY a
 * click-path (e.g. re-enter a portal) and by safeClickExplore's restore. */
async function clickByLabel(page: Page, label: string): Promise<boolean> {
  try {
    const norm = label.trim().toLowerCase();
    const token = await page.evaluate((want: string) => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
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
    await el.click({ timeout: 4000 });
    await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsclk-replay="1"]'); if (e) e.removeAttribute('data-xsclk-replay'); });
    return true;
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

async function looksLikeLogin(page: Page): Promise<boolean> {
  try {
    const pw = await page.locator('input[type="password"]').count();
    if (pw < 1) return false;
    // there's a password field; is there also an identifier (email/username) field? resolve it dynamically.
    const idField = await resolveIdentifierField(page);
    return idField != null;
  } catch { return false; }
}

/** DYNAMIC identifier-field resolution (de-hardcoded): instead of a fixed selector list, read the FULL context of
 * every candidate input — type, name, id, autocomplete, placeholder, aria-label, and the nearest label/surrounding
 * text — and SCORE which one is the login identifier (email/username/phone/login). Adapts to ANY form, including
 * type=text fields with unlinked labels. Returns the 0-based index among non-password text-like inputs, or null. */
async function resolveIdentifierField(page: Page): Promise<number | null> {
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
function identifierLocator(page: Page, index: number) {
  return page.locator('input:not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"])').nth(index);
}

async function tryLogin(page: Page, email: string, password: string): Promise<boolean> {
  try {
    // DYNAMICALLY resolve which input is the identifier (email/username) — no hardcoded selector list.
    const idxRaw = await resolveIdentifierField(page);
    const e = identifierLocator(page, idxRaw ?? 0);
    // wait for the SPA login form to render (the fix that made the intent-runner auth reliable)
    await e.waitFor({ state: 'visible', timeout: 10000 });
    const urlBefore = page.url();
    await e.fill(email, { timeout: 5000 });
    await page.locator('input[type="password"]').first().fill(password, { timeout: 5000 });
    // click the submit/sign-in button, but NOT an OAuth button (Google/Microsoft) — those start a different flow.
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    const namedBtn = page.getByRole('button', { name: /^\s*(sign ?in|log ?in|submit|continue|next)\s*$/i }).first();
    const clickTarget = (await submitBtn.count()) ? submitBtn : namedBtn;
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      clickTarget.click({ timeout: 6000 }).catch(async () => {
        // last resort: press Enter in the password field to submit the form
        await page.locator('input[type="password"]').first().press('Enter').catch(() => {});
      }),
    ]);
    await page.waitForTimeout(2500);   // let the auth request resolve + the SPA re-render (error or redirect)
    await waitForHydration(page).catch(() => {});

    // ── HONEST VERIFICATION (the false-"Signed in" bug fix) ──
    // The OLD check required the URL to contain "login" — but SPAs put the login form at "/" (schooltalk), so a
    // FAILED login on a wrong password (form still showing) was reported as success. The real signals:
    //   FAIL if the password field is STILL on the page (we never left the form), OR an auth error is shown.
    //   PASS only if the password field is GONE (we actually entered the app).
    const pwStillThere = (await page.locator('input[type="password"]').count()) > 0;
    const errorShown = await hasAuthError(page);
    const urlChanged = page.url() !== urlBefore;

    // if the password field is gone AND (url changed or no error) → genuinely signed in
    if (!pwStillThere && !errorShown) return true;
    // password field still present, or an error is visible → login did NOT succeed (wrong creds / rejected)
    return false;
  } catch { return false; }
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
