/**
 * siteModel.ts — CRAWL-g: the PERSISTED PER-APP LEARNED MODEL (the amortization USP). No published crawler persists a
 * per-app model across crawls to get more efficient over time; Xsion does. The substrate already exists (mapHistory =
 * a ring of past completed maps, mapDiff = crawl-over-crawl delta, projectKnowledge = human/observed facts); this
 * DISTILLS them into a compact model that (a) says which states/selectors are STABLE (seen across crawls, trustworthy)
 * vs VOLATILE (one-off, data-dependent), and (b) drives a WARM-START: on crawl N+1, re-confirm the known-stable
 * skeleton cheaply and report only what genuinely changed — precise "what's new since last time."
 *
 * All ONLINE signals, ZERO training: it's counting + set arithmetic over the sigs/edges the crawl already computes.
 * Efficiency compounds: crawl 1 = everything volatile (nothing to compare); crawl 3 = a clear confirmed skeleton.
 */

export interface SiteModel {
  crawlCount: number;                                   // how many completed crawls have contributed
  stableSigs: string[];                                 // state signatures seen in ≥2 crawls — the app's persistent skeleton
  volatileSigs: string[];                               // sigs seen in exactly 1 crawl — transient / data-dependent (don't trust as structure)
  stableActions: string[];                              // edge action labels (element→state transitions) seen in ≥2 crawls — trustworthy for testing
  sigFirstSeen: Record<string, number>;                 // sig → the crawl index it first appeared (0-based); for age/churn analysis
  routeKeysEverSeen: string[];                          // every route (hash-aware) the app has ever exposed across crawls
  updatedAt?: string;
}

// a minimal shape we read from each historical/current map — resilient to the map's `any`-typed boundary.
interface MapLike {
  pages?: Array<{ sig?: string; url?: string; path?: string }>;
  edges?: Array<{ action?: { label?: string; kind?: string }; toSig?: string }>;
  crawledAt?: string;
}

/** distill a SiteModel from the ordered crawl history (oldest→newest, INCLUDING the just-finished current map last).
 *  Pure: counting over sigs + edge labels across crawls. A sig/action is STABLE once it appears in ≥2 distinct crawls. */
export function buildSiteModel(crawlsOldestFirst: MapLike[]): SiteModel {
  const crawls = (crawlsOldestFirst || []).filter(Boolean);
  const sigCrawlCount = new Map<string, number>();      // sig → # of distinct crawls it appeared in
  const actionCrawlCount = new Map<string, number>();   // action label → # of distinct crawls it appeared in
  const sigFirstSeen: Record<string, number> = {};
  const routeKeys = new Set<string>();

  crawls.forEach((m, idx) => {
    const sigsThisCrawl = new Set<string>();
    for (const p of (m.pages || [])) {
      if (p.sig) { sigsThisCrawl.add(p.sig); if (!(p.sig in sigFirstSeen)) sigFirstSeen[p.sig] = idx; }
      const rk = p.url || p.path; if (rk) routeKeys.add(rk);
    }
    for (const s of sigsThisCrawl) sigCrawlCount.set(s, (sigCrawlCount.get(s) || 0) + 1);

    const actionsThisCrawl = new Set<string>();
    for (const e of (m.edges || [])) { const l = e.action?.label; if (l) actionsThisCrawl.add(l); }
    for (const a of actionsThisCrawl) actionCrawlCount.set(a, (actionCrawlCount.get(a) || 0) + 1);
  });

  const stableSigs: string[] = [], volatileSigs: string[] = [];
  for (const [sig, n] of sigCrawlCount) (n >= 2 ? stableSigs : volatileSigs).push(sig);
  const stableActions: string[] = [];
  for (const [a, n] of actionCrawlCount) if (n >= 2) stableActions.push(a);

  return {
    crawlCount: crawls.length,
    stableSigs: stableSigs.sort(),
    volatileSigs: volatileSigs.sort(),
    stableActions: stableActions.sort(),
    sigFirstSeen,
    routeKeysEverSeen: Array.from(routeKeys).sort(),
  };
}

export interface WarmStart {
  isFirstCrawl: boolean;
  knownStableStates: number;      // stable states the model KNEW before this crawl
  reconfirmed: number;            // known-stable states this crawl saw again (the cheap-to-verify skeleton)
  newStates: number;              // states in this crawl the model had never seen (genuinely new surface)
  disappeared: number;            // known-stable states this crawl did NOT see (removed / unreachable this run)
  summary: string;
}

/** WARM-START: compare the just-finished crawl's states against the model built from PRIOR crawls, so the report is
 *  "re-confirmed the known skeleton + here's what's genuinely new/gone" — the compounding-efficiency payoff. */
export function warmStart(priorModel: SiteModel | null, currentMap: MapLike): WarmStart {
  const curSigs = new Set<string>();
  for (const p of (currentMap.pages || [])) if (p.sig) curSigs.add(p.sig);

  // FIRST CRAWL = the prior model has literally NO states (stable AND volatile both empty). A prior crawl that saw
  // states which aren't yet CONFIRMED-stable (needs ≥2 crawls) is still a real prior model — the states are known
  // (as volatile). The earlier bug treated "0 stable" as first-crawl, so crawl-2 wrongly reported first-crawl.
  const everSeen = new Set([...(priorModel?.stableSigs || []), ...(priorModel?.volatileSigs || [])]);
  if (!priorModel || priorModel.crawlCount === 0 || everSeen.size === 0) {
    return { isFirstCrawl: true, knownStableStates: 0, reconfirmed: 0, newStates: curSigs.size, disappeared: 0,
      summary: `First crawl (no prior model) — mapped ${curSigs.size} states; every subsequent crawl gets faster + reports only what changed.` };
  }
  // reconfirm / disappeared are measured against ALL KNOWN states (stable + volatile), so a state seen in the single
  // prior crawl and seen again now is a re-confirmation (and — implicitly — is being PROMOTED to stable this crawl).
  const known = everSeen;
  let reconfirmed = 0, disappeared = 0;
  for (const s of known) (curSigs.has(s) ? reconfirmed++ : disappeared++);
  let newStates = 0;
  for (const s of curSigs) if (!everSeen.has(s)) newStates++;

  return {
    isFirstCrawl: false, knownStableStates: priorModel.stableSigs.length, reconfirmed, newStates, disappeared,
    summary: `Warm-start from ${priorModel.crawlCount} prior crawl(s): re-confirmed ${reconfirmed}/${known.size} known states, ${newStates} genuinely new, ${disappeared} not seen this run.`,
  };
}
