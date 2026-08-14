/**
 * exploreStrategy.ts — the SWAPPABLE frontier strategy + the run METRICS, for the A/B matrix.
 *
 * The crawl loop stays the same shape (a frontier of Navs drained until budget); ONLY two decisions vary by arm:
 *   1. pickNext(queue)  — which frontier entry to explore next.
 *   2. onState(sig, nav)— record the state we landed in (feeds curiosity + metrics).
 * A Strategy object encapsulates both, so the loop is arm-agnostic and BFS stays byte-for-byte the control.
 *
 * Arms:
 *   • 'bfs'       — FIFO (shift). The current behaviour, the control. Ignores state signatures for ordering.
 *   • 'curiosity' — priority: pick the frontier entry whose PARENT-state is most novel (highest 1/√N), so the
 *                   crawl pushes toward under-visited regions instead of discovery-order. This is the RL-shaped arm.
 *   The SoA-semantic and code-seeded arms are the SAME frontier mechanics with (respectively) a plateau-triggered
 *   SoA action-injection and a pre-seeded frontier — both handled in the loop, not here, so this stays small.
 *
 * METRICS are the ground-truth-free comparison the advisor mandated: distinct-states/budget, novelty-rate,
 * SoA-calls, $ (tracked by the loop), frontier-exhaustion-vs-clip, collapseRate (equivalence health).
 */
import { StateModel } from './stateSignature';

export type ArmName = 'bfs' | 'curiosity' | 'soa-semantic' | 'code-seeded' | 'hybrid';

/** A frontier entry the strategy orders. `sig` is the signature of the state this entry was DISCOVERED FROM (its
 * parent) — curiosity ranks by parent-novelty because we can't know a child's novelty before visiting it. */
export interface FrontierItem<T = any> { nav: T; parentSig?: string; seq: number; }

export interface ExploreMetrics {
  arm: ArmName;
  pagesVisited: number;
  distinctStates: number;      // unique signatures seen — the primary quality signal
  observations: number;
  novelStates: number;         // times a visit landed on a NEVER-SEEN signature (the novelty numerator)
  noveltyRate: number;         // novelStates / pagesVisited — how often exploration paid off
  collapseRate: number;        // equivalence health (0=all new, →1=heavy merge)
  soaCalls: number;
  budget: number;              // maxPages
  frontierExhausted: boolean;  // true = ran out of things to explore before budget; false = budget-clipped
  frontierLeftover: number;    // items still queued when we stopped (only meaningful if budget-clipped)
  plateauFires: number;        // SoA calls from the plateau trigger (vs the mechanical stall) — 0 so far, all live
  seededRoutes: number;        // routes seeded from code (skeleton phase)
  clickDiscovered: number;     // states first reached by click-discovery (deep-surface phase)
  captureErrors: number;       // pages with a failed signature capture
  valid: boolean;              // false ⇒ do NOT trust this run's state metrics (captureErrors>0 = degenerate sigs)
}

/** The shared exploration state for one crawl run under one arm. The loop owns a single Tracker. */
export class ExploreTracker<T = any> {
  readonly model = new StateModel();
  private novel = 0;
  private visited = 0;
  soaCalls = 0;
  plateauFires = 0;    // # of SoA calls that came from the PLATEAU trigger (vs the mechanical added===0 stall).
  seededRoutes = 0;    // # of routes seeded from the code route-manifest (the cheap SKELETON phase).
  clickDiscovered = 0; // # of states first reached via click-discovery, not code (the DEEP-surface phase).
  captureErrors = 0;   // # of pages whose captureShape failed (empty/degenerate sig). >0 ⇒ the run is INVALID.
  budget: number;
  constructor(public readonly arm: ArmName, budget: number) { this.budget = budget; }
  setBudget(b: number) { this.budget = b; }
  noteCaptureError() { this.captureErrors++; }

  /** record landing in a state; returns {sig-novelty} so the loop can log it. */
  onState(sig: string): { novel: boolean; visitN: number } {
    const wasSeen = this.model.count(sig) > 0;
    const n = this.model.visit(sig);
    this.visited++;
    if (!wasSeen) this.novel++;
    return { novel: !wasSeen, visitN: n };
  }

  /** choose + REMOVE the next frontier item from `queue` per the arm's policy. Returns undefined if empty. */
  pickNext(queue: FrontierItem<T>[]): FrontierItem<T> | undefined {
    if (!queue.length) return undefined;
    if (this.arm === 'bfs') return queue.shift();           // FIFO — the control, unchanged
    // curiosity / hybrid: pick the item discovered from the MOST NOVEL parent-state (highest 1/√N). Ties → FIFO
    // (stable by seq) so it degrades to BFS-order when no state info exists (e.g. first picks, unknown parents).
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const it = queue[i];
      // unknown parent (root/seed) gets max curiosity so seeds are explored eagerly; else 1/√(N+1).
      const score = it.parentSig ? this.model.curiosity(it.parentSig) : 1;
      // tie-break toward earlier seq (stable, BFS-like) by nudging score down slightly with seq
      const adj = score - it.seq * 1e-9;
      if (adj > bestScore) { bestScore = adj; bestIdx = i; }
    }
    return queue.splice(bestIdx, 1)[0];
  }

  /** pickNext adapter for a plain Nav[] queue whose items carry `_parentSig` + `_seq` (stamped by the loop's
   * enqueue). Same policy as pickNext, but mutates the Nav[] in place — so the crawl loop keeps its native queue. */
  pickNextNav<N extends { _parentSig?: string; _seq?: number; _seed?: boolean; clicks?: any[] }>(queue: N[]): N | undefined {
    if (!queue.length) return undefined;
    // THREE-TIER frontier ordering — BREADTH before DEPTH, so click-discovered sub-states never STARVE un-visited
    // real routes (the csc-2 regression: /explore tab-permutations crowded out /blood-analysis, /progress, …):
    //   tier 1: code-seeded skeleton routes (_seed) — cheapest breadth, drain first in seed order.
    //   tier 2: bare routes (no click-path) — real breadth from anchors/click-nav; take before any depth.
    //   tier 3: click-path sub-states (clicks.length) — DEPTH; only once tiers 1 & 2 are empty.
    // Within the earliest non-empty tier, apply the arm's policy (bfs FIFO / curiosity by parent-novelty).
    const tier = (q: N): number => q._seed ? 1 : (q.clicks && q.clicks.length ? 3 : 2);
    let minTier = 3; for (const q of queue) { const t = tier(q); if (t < minTier) minTier = t; }
    const eligible = (i: number) => tier(queue[i]) === minTier;
    if (minTier === 1) { let best = -1; for (let i = 0; i < queue.length; i++) if (eligible(i) && (best === -1 || (queue[i]._seq ?? i) < (queue[best]._seq ?? best))) best = i; return queue.splice(best, 1)[0]; }
    if (this.arm === 'bfs') { const i = queue.findIndex((_, idx) => eligible(idx)); return queue.splice(i, 1)[0]; }
    // curiosity/hybrid: among the earliest non-empty TIER only, pick highest parent-novelty (1/√N), FIFO tie-break.
    let bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      if (!eligible(i)) continue;
      const it = queue[i];
      const score = it._parentSig ? this.model.curiosity(it._parentSig) : 1;
      const adj = score - (it._seq ?? i) * 1e-9;
      if (adj > bestScore) { bestScore = adj; bestIdx = i; }
    }
    return queue.splice(bestIdx, 1)[0];
  }

  metrics(frontierLeftover: number): ExploreMetrics {
    const snap = this.model.snapshot();
    return {
      arm: this.arm,
      pagesVisited: this.visited,
      distinctStates: snap.distinctStates,
      observations: snap.observations,
      novelStates: this.novel,
      noveltyRate: this.visited ? this.novel / this.visited : 0,
      collapseRate: snap.collapseRate,
      soaCalls: this.soaCalls,
      budget: this.budget,
      frontierExhausted: frontierLeftover === 0,
      frontierLeftover,
      plateauFires: this.plateauFires,
      seededRoutes: this.seededRoutes,
      clickDiscovered: this.clickDiscovered,
      captureErrors: this.captureErrors,
      valid: this.captureErrors === 0,
    };
  }
}

/** The two-budget SoA decision (#211): the STALL path and the PLATEAU path have SEPARATE allowances so exhausting
 * one never starves the other. Pure so the crawl loop and the hermetic test share ONE source of truth (no drift).
 *   - fireStall: a hard mechanical stall (added===0) AND the stall budget has room. Takes priority.
 *   - firePlateau: NOT stalled, novelty flatlined over a FULL window of NON-SEED observations, plateau budget has room.
 * A hard stall with an exhausted stall budget deliberately gets nothing (keeps the two paths attributable). */
export function decideSoa(opts: {
  arm: ArmName; stalled: boolean;
  stallSoaCalls: number; maxStall: number;
  nonSeedObservations: number; recentNovelty: number; window: number; minNovelty: number;
  plateauSoaCalls: number; maxPlateau: number;
}): { fireStall: boolean; firePlateau: boolean } {
  const fireStall = opts.stalled && opts.stallSoaCalls < opts.maxStall;
  const firePlateau = !opts.stalled && shouldSpendSoa({
    arm: opts.arm, visited: opts.nonSeedObservations, recentNovelty: opts.recentNovelty,
    window: opts.window, minNovelty: opts.minNovelty, soaCalls: opts.plateauSoaCalls, maxSoa: opts.maxPlateau,
  });
  return { fireStall, firePlateau };
}

/** Should the SoA-semantic / hybrid arm spend an LLM call NOW? Fire on a coverage PLATEAU (novelty-growth stalls),
 * NOT on every stall — the LLMDroid trigger. `recentNovelty` = novel states found in the last `window` visits.
 * Returns true when the crawl has visited enough to judge AND recent novelty dropped below `minNovelty`. */
export function shouldSpendSoa(opts: {
  arm: ArmName; visited: number; recentNovelty: number; window: number; minNovelty: number; soaCalls: number; maxSoa: number;
}): boolean {
  if (opts.arm !== 'soa-semantic' && opts.arm !== 'hybrid') return false;
  if (opts.soaCalls >= opts.maxSoa) return false;         // hard cost ceiling (read-thrash guard)
  if (opts.visited < opts.window) return false;           // need a window to judge a plateau
  return opts.recentNovelty <= opts.minNovelty;           // novelty stalled → the free explorer is stuck → spend
}
