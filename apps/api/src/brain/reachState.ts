/**
 * reachState.ts — CONSUMPTION of the crawl's recorded navigation (the shared unblock for bug-repro / break-it /
 * mission). Many apps gate a feature behind a PORTAL/SCHOOL/WORKSPACE picker. The crawl already maps it: it records
 * the picker's options (as `ProjectMap.gates[].options[]`) AND the click-paths that reach each tenant (pages whose
 * `clicks:['<Option>']`). So an engine doesn't need to re-derive navigation — it READS what the crawl observed and
 * prepends the exact clicks to land inside the right tenant BEFORE its own steps run.
 *
 * PURE — no LLM, no IO. General: derives the option set from the map, matches the intent's own words. No app-
 * specific vocabulary (the option LABELS come from the crawl).
 */

export interface ReachStep { intent: string; expectedOutcome?: string; }

/** Collect the picker OPTIONS the crawl observed: from ProjectMap.gates[].options[] AND from any page reached via a
 *  single-click path (`clicks:['X']`) off the entry — both are "a choice you pick to get somewhere". */
export function observedChoices(map: any): string[] {
  const out = new Set<string>();
  for (const g of (map?.gates || [])) for (const o of (g?.options || [])) if (o?.label) out.add(String(o.label));
  for (const p of (map?.pages || [])) {
    const clicks = (p as any)?.clicks;
    if (Array.isArray(clicks) && clicks.length === 1 && typeof clicks[0] === 'string') out.add(clicks[0]);
  }
  return [...out];
}

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Which observed choice does this text (ticket + steps) reference? Longest-label match wins (so "NZ Curriculum"
 *  beats a bare "NZ"). Returns the option's real label (as the crawl recorded it), or null. */
export function chosenOption(text: string, choices: string[]): string | null {
  const hay = norm(text);
  let best: string | null = null; let bestLen = 0;
  for (const c of choices) {
    const nc = norm(c);
    if (nc && hay.includes(nc) && nc.length > bestLen) { best = c; bestLen = nc.length; }
  }
  return best;
}

/** Build the click-path prefix to reach the referenced tenant. Empty when there's no picker or no referenced
 *  option. ALWAYS prepends the crawl's EXACT option label (a reliable getByText click) — we do NOT skip when SoA
 *  already has a select step, because THAT step is the unreliable one (target-mangling / picker gone) we're
 *  replacing; the redundant SoA step is dropped separately by pruneRedundantSteps. */
export function buildReachStatePrefix(map: any, ticket: string, steps: Array<{ intent?: string }>): ReachStep[] {
  const choices = observedChoices(map);
  if (!choices.length) return [];
  const text = `${ticket || ''} ${(steps || []).map((s) => s.intent || '').join(' ')}`;
  const option = chosenOption(text, choices);
  if (!option) return [];
  return [{ intent: `click "${option}"`, expectedOutcome: `the app switches into the "${option}" workspace/portal` }];
}

/** TENANT-REACH for engines that DON'T carry tenant text in a ticket (break-it names a FEATURE, e.g. "create
 *  event", with no school hint). Detects a real multi-tenant PICKER from the map (cue-gated gates[] + scoped-path
 *  fan-out) and returns the ONE deterministic click to enter the target tenant, or [] (a strict no-op on single-
 *  tenant apps). Target ladder: explicitScope → the scope of the page that supplied the attack fields → the most-
 *  crawled scope → the first option. PURE. Reuses observedChoices/chosenOption + scopeOfPath.
 *
 *  Detection (ALL must hold — each blocks a false-fire independently, verified against the real schooltalk map):
 *   1. a cue-verified picker gate exists: gates[] with kind ∈ {portal,workspace,tenant} and ≥2 options. detectGate
 *      only emits these kinds behind a "choose/select/pick + portal|workspace|school|tenant|…" body cue, so a plain
 *      nav sidebar (Dashboard/Reports/Settings) never becomes one.
 *   2. the gate sits on an UNSCOPED landing path (scopeOfPath(gate.path) === undefined, e.g. "/Teacher").
 *   3. the gate's destinations fan out into ≥2 DISTINCT scopes (scopeOfPath needs ≥2 path segments, so single-
 *      segment nav links like /dashboard yield undefined and can't fake a fan-out). */
export function buildTenantReachPrefix(
  map: any,
  scopeOfPath: (p: string) => string | undefined,
  fieldSourcePath?: string,
  explicitScope?: string,
): { steps: ReachStep[]; note?: string } {
  const gates = (map?.gates || []).filter((g: any) =>
    ['portal', 'workspace', 'tenant'].includes(String(g?.kind)) && (g?.options || []).length >= 2);
  if (!gates.length) return { steps: [] };
  const gate = gates.find((g: any) => scopeOfPath(String(g?.path || '')) === undefined);
  if (!gate) return { steps: [] };   // conjunct 2: picker must be on an unscoped landing path
  const optLabels: string[] = (gate.options || []).map((o: any) => String(o?.label || '')).filter(Boolean);

  // conjunct 3: the gate's destinations must fan out into ≥2 distinct scopes (a real tenant split, not a nav menu).
  // Join gate-option labels → destination scope via edges (option.elementId === edge.action.elementId; label match
  // as the robust fallback since both come from the same crawl).
  const edgeScopeByLabel = new Map<string, string>();
  const scopeSet = new Set<string>();
  for (const e of (map?.edges || [])) {
    const lbl = String(e?.action?.label || '');
    const sc = scopeOfPath(String(e?.toPath || ''));
    if (sc) { scopeSet.add(sc); if (lbl && !edgeScopeByLabel.has(lbl)) edgeScopeByLabel.set(lbl, sc); }
  }
  if (scopeSet.size < 2) return { steps: [] };

  // ── target ladder (NEVER abstain once we've confirmed a real picker; a named tenant is what the user asked for) ──
  let target: string | null = null;
  let how = '';
  if (explicitScope) { target = chosenOption(explicitScope, optLabels); if (target) how = `you asked for "${explicitScope}"`; }
  if (!target && fieldSourcePath) {
    const want = scopeOfPath(fieldSourcePath);
    if (want) { const m = optLabels.find((l) => edgeScopeByLabel.get(l) === want); if (m) { target = m; how = `the attack's form fields came from the "${want}" tenant`; } }
  }
  if (!target) {
    // most-crawled scope: the tenant with the most pages in the map (cheap, map-derived tiebreak)
    const pageScopeCount = new Map<string, number>();
    for (const p of (map?.pages || [])) { const sc = scopeOfPath(String((p as any)?.path || (p as any)?.url || '')); if (sc) pageScopeCount.set(sc, (pageScopeCount.get(sc) || 0) + 1); }
    let bestScope = ''; let bestN = 0;
    for (const [sc, n] of pageScopeCount) if (n > bestN) { bestScope = sc; bestN = n; }
    if (bestScope) { const m = optLabels.find((l) => edgeScopeByLabel.get(l) === bestScope); if (m) { target = m; how = `"${bestScope}" is the most-explored tenant in the map`; } }
  }
  if (!target && optLabels.length) { target = optLabels[0]; how = 'first available tenant (no other signal)'; }
  if (!target) return { steps: [] };

  return {
    steps: [{ intent: `click "${target}"`, expectedOutcome: `the app switches into the "${target}" portal` }],
    note: `Multi-tenant picker detected — entering the "${target}" portal first (${how}) so attacks run inside the tenant where the feature lives, not on the picker screen.`,
  };
}

const LOGIN_STEP = /\b(log ?in|sign ?in|authenticate|enter (your )?(credentials|email|password)|accept .*(terms|cookies|consent)|agree to)\b/i;
// field-level login steps SoA emits separately ("fill the Email field with…", "fill Password field…") — pure noise
// once the auth pre-step signed us in; they fail on the app (no login form present) and clutter the verdict.
const LOGIN_FIELD_STEP = /\b(fill|enter|type|input)\b.*\b(email|username|user name|password|credential)\b/i;
const SELECT_VERB = /\b(select|choose|pick|open|switch to|go to|click)\b/i;   // 'click "<School>"' is SoA's other form
// a step that ALSO does real work (create/add data, fill a field, reach a feature) is NOT a pure school-select even
// if it mentions the school — pruning it would DROP the ticket's precondition/action (e.g. "click Create Event in
// NZ Curriculum" is a CREATE, not a picker click). Only prune when the school is the WHOLE point of the step.
const NON_SELECT_WORK = /\b(create|add|new|fill|enter|type|submit|save|delete|remove|update|edit|calendar|event|dashboard|report|progress|setting|lesson|planning)\b/i;
// a PURE "navigate/go to <the app root URL or /login>" step: once auth put us INSIDE the app, re-visiting the root
// URL logs us back OUT on any app whose root IS the login route (saucedemo `/`) → the rest of the repro then runs on
// the login page. Prune it (general — same root-is-login pattern the crawler's post-login-seed fix handles). Only a
// BARE navigate to the origin root or an explicit login path; a navigate to a real inner route (/reports) is kept.
const NAVIGATE_VERB = /\b(navigate to|go to|open|visit|load)\b/i;

/** Drop SoA steps made REDUNDANT by the login pre-step + the reach-state prepend, so they don't fail on a page
 *  where their target no longer exists (a mid-flow fail that would poison the verdict — the same face-plant that
 *  turned earlier runs into cant-perform). Removes: (1) login/consent steps when auth already succeeded;
 *  (2) a "select/open <chosenOption>" step (the prepend already did it, and the picker is now gone). PURE. */
export function pruneRedundantSteps<T extends { intent?: string }>(steps: T[], chosenOpt: string | null, authPassed: boolean, baseUrl?: string): T[] {
  const nc = chosenOpt ? norm(chosenOpt) : '';
  // the origin root path(s) that, when re-visited, would log an authenticated session back out
  let rootHosts: string[] = [];
  try { if (baseUrl) { const u = new URL(baseUrl); rootHosts = [u.origin.toLowerCase(), (u.origin + '/').toLowerCase(), u.host.toLowerCase()]; } } catch {}
  return (steps || []).filter((s) => {
    const i = s.intent || '';
    if (authPassed && (LOGIN_STEP.test(i) || LOGIN_FIELD_STEP.test(i))) return false;   // login pre-step already did this
    // prune ONLY a PURE school-select (mentions the option + a select verb, and does NO other real work) — else a
    // "create event in <school>" precondition step would be wrongly dropped (the regression the click-verb caused).
    if (nc && SELECT_VERB.test(i) && norm(i).includes(nc) && !NON_SELECT_WORK.test(i)) return false;
    // prune a BARE navigate-to-app-root (or /login) once authenticated — it would log us out on login-at-root apps.
    if (authPassed && NAVIGATE_VERB.test(i) && !NON_SELECT_WORK.test(i)) {
      const low = i.toLowerCase();
      const toRoot = /\/login\b|\/signin\b|\/sign-in\b/.test(low)
        || rootHosts.some((h) => h && low.includes(h) && !/[a-z0-9]\/[a-z0-9]/i.test(low.split(h)[1] || ''));  // host present + no real inner path after it
      if (toRoot) return false;
    }
    return true;
  });
}
