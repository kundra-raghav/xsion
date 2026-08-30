/**
 * apiProber.ts — the REAL API-request path for break-it's `api` phase (task #207).
 *
 * DISCIPLINE (why this is safe + honest, not a fabrication engine):
 *  1. REPLAY, DON'T SYNTHESIZE. We only probe an endpoint the CRAWL OBSERVED (`map.api[]`). SoA's `apiHint` is
 *     prose and often "(assumed)" — a fabricated URL probed for real returns a 404 that masquerades as a finding.
 *     So we match the attack's hint to a real observed method+route-template; no match → needs-review, never probed.
 *  2. SAME-ORIGIN ONLY. We probe only the baseUrl's own origin. A crawl records third-party calls too
 *     (accounts.google.com, an APIM gateway) — those are never ours to attack.
 *  3. NO AUTH REPLAY. We skip auth endpoints (/login,/token,/auth,/signin) entirely and NEVER read a captured
 *     samplePayload (it holds real credentials — scrubbed from disk earlier; must not resurface in a finding).
 *  4. MUTATION GATE ON THE HTTP VERB. GET/HEAD run read-only on any target; POST/PUT/PATCH/DELETE need authorized.
 *  5. VERDICT FROM STATUS+BODY vs the pre-declared oracle, with the same fail-safe floor as the UI path:
 *     ambiguous → needs-review, never `broke` without a hard signal (5xx / stack / a clear oracle match).
 *
 * The request rides the BROWSER CONTEXT (page.request / APIRequestContext) so cookies + auth headers come along
 * automatically — we never touch credentials ourselves.
 */
import type { APIRequestContext } from 'playwright';

export interface ObservedEndpoint { method: string; url: string; statuses?: number[]; count?: number; graphql?: boolean; gqlOperation?: string; gqlKind?: string; }
export interface ProbeResult { verdict: 'held' | 'broke' | 'needs-review'; detail: string; status?: number; }

/** id/uuid/hex segments → :id, drop query+hash → a comparable route template (same idea as crawl's normUrl). */
export function routeTemplate(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname
      .replace(/\/(?=[0-9a-f]{6,}(?:[/.]|$))(?=[a-f]*\d)[0-9a-f]{6,}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');
    return `${x.origin}${path}`;
  } catch { return u; }
}

const AUTH_RE = /\/(login|token|auth|signin|sign-in|oauth|session|logout)\b/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** registrable domain (eTLD+1 approx: last two labels, or three for common 2-level TLDs like co.uk/com.au).
 *  Real apps put their API on a SIBLING host (app: qa.schooltalkapp.com, api: qa-auth.schooltalkapp.com) — both
 *  share the registrable domain schooltalkapp.com, so probing the sibling is probing the SAME app. Third parties
 *  (accounts.google.com, *.amazonaws.com) do NOT share it → still excluded without an explicit attestation. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevelTld = /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevelTld ? -3 : -2).join('.');
}
/** same app = same registrable domain (app host and its API sibling), NOT arbitrary cross-origin. */
export function sameApp(originA: string, urlB: string): boolean {
  try { return registrableDomain(new URL(originA).hostname) === registrableDomain(new URL(urlB).hostname); }
  catch { return false; }
}

/** Parse "POST /dapi/cart/add (assumed)" → {method, path, assumed}. Returns null if unparseable. */
export function parseApiHint(hint?: string): { method: string; path: string; assumed: boolean } | null {
  if (!hint) return null;
  const assumed = /\bassumed\b/i.test(hint);
  const m = hint.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\b\s+(\S+)/i);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2].replace(/[)（].*$/, '').trim(), assumed };
}

/** Match the attack's hint to a REAL observed endpoint. Exact method + route-template equality (no fuzzy scoring).
 *  Returns the observed endpoint or a reason string for why we won't probe. */
export function matchObserved(hint: string | undefined, observed: ObservedEndpoint[], baseOrigin: string):
  { endpoint?: ObservedEndpoint; reason?: string } {
  const parsed = parseApiHint(hint);
  if (!parsed) return { reason: 'no method+path in the plan hint' };
  if (parsed.assumed) return { reason: 'endpoint was ASSUMED by the planner, not observed in the crawl — not probed' };
  // build the attack's template against the base origin (hint paths are relative)
  let hintTemplate: string;
  try { hintTemplate = routeTemplate(new URL(parsed.path, baseOrigin).href); } catch { return { reason: `unparseable hint path "${parsed.path}"` }; }
  // hint template's PATH (origin-independent), so an app-host hint can match its API-sibling-host endpoint.
  const hintPath = (() => { try { return new URL(hintTemplate).pathname; } catch { return hintTemplate; } })();
  for (const e of observed) {
    if (!e.url || (e.method || '').toUpperCase() !== parsed.method) continue;
    if (!sameApp(baseOrigin, e.url)) continue;                  // SAME APP (registrable domain), not arbitrary x-origin
    if (AUTH_RE.test(e.url)) continue;                          // never probe auth endpoints
    let ePath: string; try { ePath = new URL(routeTemplate(e.url)).pathname; } catch { continue; }
    if (ePath === hintPath) return { endpoint: e };
  }
  return { reason: `no crawl-observed ${parsed.method} endpoint matches "${parsed.path}" (same app-domain) — not probed` };
}

/** Issue the probe and verdict it against the oracle. `expectHeld`/`expectBroke` are SoA's pre-declared oracle. */
export async function probeEndpoint(
  req: APIRequestContext, ep: ObservedEndpoint, authorized: boolean, expectHeld: string, expectBroke: string,
): Promise<ProbeResult> {
  const method = (ep.method || 'GET').toUpperCase();
  // mutation gate on the VERB: reads run anywhere; writes need authorization.
  if (MUTATING_METHODS.has(method) && !authorized) {
    return { verdict: 'needs-review', detail: `${method} ${routeTemplate(ep.url)} is a mutating call — needs the "I authorize this target" attestation to probe live. Oracle stands: HELD "${expectHeld}", BROKE "${expectBroke}".` };
  }
  let status = 0; let bodyText = '';
  try {
    const resp = await req.fetch(ep.url, { method, timeout: 12000, failOnStatusCode: false });
    status = resp.status();
    bodyText = (await resp.text().catch(() => '')).slice(0, 400);
  } catch (e: any) {
    return { verdict: 'needs-review', detail: `probe could not reach ${routeTemplate(ep.url)}: ${String(e?.message || e).slice(0, 120)}` };
  }
  const body = bodyText.toLowerCase();
  // HARD BROKE signals (fail-safe: only mechanical evidence flips to broke).
  const is5xx = status >= 500 && status <= 599;
  const hasStack = /stack|traceback|unhandled|cannot read propert|is not a function|nullreferenceexception|at \w+\.\w+ \(/i.test(body);
  if (is5xx || hasStack) {
    return { verdict: 'broke', status, detail: `${method} ${routeTemplate(ep.url)} → ${status}${hasStack ? ' with a stack trace in the body' : ''} — matches BROKE "${expectBroke}".` };
  }
  // HELD signal: a proper client-error rejection (4xx) is usually what an adversarial api attack EXPECTS.
  const is4xx = status >= 400 && status <= 499;
  const oracleWants4xx = /\b(400|401|403|404|422|bad request|unauthorized|forbidden|not found|validation)\b/i.test(expectHeld);
  if (is4xx && oracleWants4xx) {
    return { verdict: 'held', status, detail: `${method} ${routeTemplate(ep.url)} → ${status} (rejected) — matches HELD "${expectHeld}".` };
  }
  // a 2xx when the oracle said the app must REJECT invalid input = accepted-invalid = broke, but only when the
  // oracle explicitly frames a 2xx as the defect (avoid false positives on a benign read).
  const is2xx = status >= 200 && status <= 299;
  const oracleBreakOn2xx = /\b(200|201|accepts?|added|succeeds?|no error|without (a )?(validation|error))\b/i.test(expectBroke);
  if (is2xx && oracleBreakOn2xx && MUTATING_METHODS.has(method)) {
    return { verdict: 'broke', status, detail: `${method} ${routeTemplate(ep.url)} → ${status} accepted the request the oracle said to reject — matches BROKE "${expectBroke}".` };
  }
  // anything else → honest needs-review (fail-safe floor).
  return { verdict: 'needs-review', status, detail: `${method} ${routeTemplate(ep.url)} → ${status}; neither a clear rejection nor a clear accept-invalid. Human review vs oracle: HELD "${expectHeld}", BROKE "${expectBroke}".` };
}
