/**
 * exploreDivergence.hermetic.ts — proves the WIRED arms actually diverge, with no browser.
 *
 * The unit tests proved pickNextNav/curiosity in isolation. This proves the thing that actually matters for the
 * experiment: given the SAME discovered frontier, BFS and curiosity visit in DIFFERENT order, and the plateau
 * trigger fires for the hybrid arm. It simulates a crawl by feeding a scripted set of (state → children) into a
 * tracker exactly as the loop does: pick next → land in a state → enqueue its children stamped with the parent sig.
 *
 * Run: npx tsx src/brain/exploreDivergence.hermetic.ts
 */
import { ExploreTracker, shouldSpendSoa } from './exploreStrategy';
import { sigFromShape, PageShape } from './stateSignature';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

// What parent-keyed curiosity ACTUALLY promises: it differentiates ACROSS parents, not within siblings enqueued
// from one page (those share a parent sig → tie → FIFO). So the discriminating topology is TWO HUBS: `A` and `C`,
// both with children. `A` is a near-duplicate of the root (its state gets REVISITED, so its curiosity decays);
// `C` is a fresh state. Under a CLIPPED budget, curiosity should drain fresh-`C`'s children before revisited-`A`'s
// remaining ones — BFS drains them in strict discovery order regardless. (Single-hub can't show this; sibling
// order under one parent is FIFO for both arms by design — that's not a claim the mechanism makes.)
type Nav = { id: string; _parentSig?: string; _seq?: number };
const shape = (id: string, affs: string[]): PageShape => ({ routeKey: 'app/' + id, affordances: affs, landmarks: { forms: 0, tables: 0, lists: 1, headings: 1, nav: 1 } });
const APP: Record<string, { shape: PageShape; children: string[] }> = {
  // root reveals both hubs. `A` shares the ROOT's shape (so visiting A revisits the root-state → decays its
  // curiosity); `C` is a distinct fresh state.
  root: { shape: shape('root', ['home', 'menu']), children: ['A', 'C'] },
  A:    { shape: shape('root', ['home', 'menu']), children: ['a1', 'a2'] },   // A ≡ root shape → revisits root-state
  C:    { shape: shape('C', ['orders', 'billing', 'reports']), children: ['c1', 'c2'] },
  a1:   { shape: shape('a1', ['x']), children: [] }, a2: { shape: shape('a2', ['y']), children: [] },
  c1:   { shape: shape('c1', ['refund']), children: [] }, c2: { shape: shape('c2', ['approve']), children: [] },
};

/** simulate a crawl under one arm; return the ORDER pages were visited + final metrics. */
function simulate(arm: 'bfs' | 'curiosity' | 'hybrid', budget = 8) {
  const t = new ExploreTracker<Nav>(arm, budget);
  let seq = 0;
  const queue: Nav[] = [{ id: 'root', _parentSig: undefined, _seq: seq++ }];
  const visitedOrder: string[] = [];
  const seen = new Set<string>();
  let currentSig: string | undefined;
  let soaFires = 0;
  const recentNovel: boolean[] = [];
  while (queue.length && visitedOrder.length < budget) {
    const nav = t.pickNextNav(queue)!;
    if (seen.has(nav.id)) continue;
    seen.add(nav.id);
    visitedOrder.push(nav.id);
    // land in the state
    const sig = sigFromShape(APP[nav.id].shape);
    currentSig = sig;
    const { novel } = t.onState(sig);
    recentNovel.push(novel); if (recentNovel.length > 3) recentNovel.shift();
    // plateau check (hybrid) — same call the loop makes
    const recentNoveltyCount = recentNovel.filter(Boolean).length;
    if (shouldSpendSoa({ arm, visited: t.metrics(queue.length).pagesVisited, recentNovelty: recentNoveltyCount, window: 3, minNovelty: 1, soaCalls: soaFires, maxSoa: 3 })) {
      soaFires++; t.soaCalls = soaFires;
    }
    // enqueue children, stamped with THIS state as parent
    for (const c of APP[nav.id].children) {
      if (!seen.has(c) && !queue.some((q) => q.id === c)) queue.push({ id: c, _parentSig: currentSig, _seq: seq++ });
    }
  }
  return { order: visitedOrder, metrics: t.metrics(queue.length), soaFires };
}

console.log('explore divergence (simulated two-hub crawl, no browser)');

// CLIPPED budget (5 of 7 reachable) — reordering can ONLY matter when the frontier is clipped (an exhausted
// frontier visits the same SET under every arm, so all metrics tie by construction).
const BUDGET = 5;
const bfs = simulate('bfs', BUDGET);
const cur = simulate('curiosity', BUDGET);

console.log('  bfs order:      ', bfs.order.join(' → '), `(${bfs.metrics.frontierExhausted ? 'exhausted' : 'clipped'})`);
console.log('  curiosity order:', cur.order.join(' → '), `(${cur.metrics.frontierExhausted ? 'exhausted' : 'clipped'})`);

// 0. sanity: the budget is genuinely clipping (else the comparison is vacuous — the advisor's core caveat)
ok('budget is clipped, not exhausted (else arms tie by construction)', !bfs.metrics.frontierExhausted && !cur.metrics.frontierExhausted);

// 1. the two arms visit in DIFFERENT order (the wiring diverges across parents)
ok('bfs and curiosity diverge in visit order', bfs.order.join() !== cur.order.join(), `both: ${bfs.order.join()}`);

// 2. bfs is FIFO: at the clip it visited A's children (a1,a2), NOT C's — strict discovery order.
ok('bfs drains A-branch (discovery order) at the clip', bfs.order.includes('a1') && !bfs.order.includes('c1'), bfs.order.join());

// 3. curiosity, at the SAME clip, visited fresh-C's children (c1,c2) instead — A≡root so its curiosity decayed,
//    C is fresh so its frontier entries outrank A's. This is the whole point: same budget, MORE novel surface.
ok('curiosity drains fresh-C-branch instead of revisited-A-branch', cur.order.includes('c1') && !cur.order.includes('a1'), cur.order.join());
ok('curiosity ends on more distinct states than bfs (or equal)', cur.metrics.distinctStates >= bfs.metrics.distinctStates, `cur ${cur.metrics.distinctStates} vs bfs ${bfs.metrics.distinctStates}`);

// 4. collapse happened (A shares root's sig) — distinct states < pages visited
ok('near-dup collapse (distinct < visits)', bfs.metrics.distinctStates < bfs.metrics.pagesVisited, `${bfs.metrics.distinctStates} vs ${bfs.metrics.pagesVisited}`);
ok('collapseRate in (0,1) — neither degenerate', bfs.metrics.collapseRate > 0 && bfs.metrics.collapseRate < 1, `${bfs.metrics.collapseRate}`);

// 5. the hybrid plateau fires when novelty genuinely STALLS — a chain of near-duplicate pages (the real link-
//    starved-SPA scenario the trigger exists for). `dup1..dup4` all share one shape → after the window fills with
//    non-novel visits, shouldSpendSoa fires. A small all-novel app (above) correctly does NOT trigger — that's the
//    point of a plateau trigger vs firing on every stall.
const DUP: Record<string, { shape: PageShape; children: string[] }> = {
  root: { shape: shape('root', ['go']), children: ['dup1', 'dup2', 'dup3', 'dup4'] },
  dup1: { shape: shape('dup', ['x']), children: [] }, dup2: { shape: shape('dup', ['x']), children: [] },
  dup3: { shape: shape('dup', ['x']), children: [] }, dup4: { shape: shape('dup', ['x']), children: [] },
};
function simulatePlateau(arm: 'hybrid' | 'bfs') {
  const t = new ExploreTracker<Nav>(arm, 6); let seq = 0;
  const queue: Nav[] = [{ id: 'root', _parentSig: undefined, _seq: seq++ }];
  const seen = new Set<string>(); const recentNovel: boolean[] = []; let soaFires = 0; let currentSig: string | undefined;
  while (queue.length && seen.size < 6) {
    const nav = t.pickNextNav(queue)!; if (seen.has(nav.id)) continue; seen.add(nav.id);
    currentSig = sigFromShape(DUP[nav.id].shape);
    const { novel } = t.onState(currentSig); recentNovel.push(novel); if (recentNovel.length > 3) recentNovel.shift();
    if (shouldSpendSoa({ arm, visited: t.metrics(queue.length).pagesVisited, recentNovelty: recentNovel.filter(Boolean).length, window: 3, minNovelty: 1, soaCalls: soaFires, maxSoa: 3 })) { soaFires++; t.soaCalls = soaFires; }
    for (const c of DUP[nav.id].children) if (!seen.has(c) && !queue.some((q) => q.id === c)) queue.push({ id: c, _parentSig: currentSig, _seq: seq++ });
  }
  return soaFires;
}
ok('hybrid plateau fires on a near-dup chain (novelty stalls)', simulatePlateau('hybrid') >= 1, `soaFires=${simulatePlateau('hybrid')}`);
ok('bfs never fires the plateau even on the same chain', simulatePlateau('bfs') === 0);
ok('small all-novel app does NOT over-trigger', simulate('hybrid', 7).soaFires === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
