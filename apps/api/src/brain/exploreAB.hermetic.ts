/**
 * exploreAB.hermetic.ts — the MEASURED A/B for CRAWL-f. #208 found curiosity "PROVEN-INERT" because it was never
 * enabled in prod (default arm = bfs). Before enabling it, this proves — deterministically, over the real
 * ExploreTracker.pickNext mechanism — WHETHER curiosity discovers more distinct states than bfs under a BUDGET, and
 * on WHAT structure. Honest: if curiosity does NOT beat bfs here, we do not ship it (the advisor's bar).
 *
 * The structure that discriminates the arms (curiosity ranks by PARENT-state novelty): a tree where a NOVEL branch
 * keeps yielding novel children, while a STALE branch yields duplicates. bfs (FIFO) drains whatever was enqueued
 * first; curiosity re-prioritizes toward the branch whose parent-state is most novel.
 */
import { ExploreTracker } from './exploreStrategy';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };

// A synthetic app: a NOVEL branch N whose nodes each reveal a fresh child (all distinct sigs), interleaved-enqueued
// AFTER a STALE branch S whose nodes all collapse to one already-seen sig. Under a tight budget, an arm that keeps
// choosing the novel branch reaches more distinct states.
type Item = { url: string; _parentSig?: string; _seq?: number };

// simulate a crawl: pick from frontier, "visit" → onState(sig), enqueue that node's children with parentSig=its sig.
function simulate(arm: 'bfs' | 'curiosity', budget: number): { distinct: number; visited: number } {
  const t = new ExploreTracker<Item>(arm, budget);
  // node → its sig + its children (each child is [sig, ...]). Novel branch: n0→n1→n2→… each a NEW sig. Stale: s* all 'DUP'.
  const sigOf: Record<string, string> = {};
  const childrenOf: Record<string, string[]> = {};
  // build: hub → [s1..s6 (all DUP), n1 (novel chain start)]. n1→n2→…→n8 each fresh. s1..s6 children all DUP too.
  sigOf['hub'] = 'HUB';
  const stale = ['s1', 's2', 's3', 's4', 's5', 's6'];
  for (const s of stale) { sigOf[s] = 'DUP'; childrenOf[s] = []; }
  const novel: string[] = [];
  for (let i = 1; i <= 8; i++) { const id = 'n' + i; novel.push(id); sigOf[id] = 'NOVEL' + i; childrenOf[id] = i < 8 ? ['n' + (i + 1)] : []; }
  // hub enqueues the STALE ones FIRST (bfs-FIFO trap), then the novel chain start
  childrenOf['hub'] = [...stale, 'n1'];

  const seenSig = new Set<string>();
  const queue: Item[] = [];
  let seq = 0;
  const enqueue = (url: string, parentSig?: string) => { queue.push({ url, _parentSig: parentSig, _seq: seq++ }); };
  enqueue('hub');
  let visited = 0;
  while (queue.length && visited < budget) {
    const it = t.pickNextNav(queue as any);
    if (!it) break;
    visited++;
    const sig = sigOf[it.url];
    t.onState(sig);          // feeds the model (curiosity reads model.curiosity(parentSig))
    seenSig.add(sig);
    for (const c of (childrenOf[it.url] || [])) enqueue(c, sig);
  }
  return { distinct: seenSig.size, visited };
}

// Budget = 6 (less than the 9 distinct states hub+n1..n8). The novel chain has 8 distinct states single-file; the
// stale branch has 1. bfs drains s1..s6 first (all DUP) → few distinct. curiosity should prefer the novel chain.
const B = 6;
const bfs = simulate('bfs', B);
const cur = simulate('curiosity', B);
console.log(`  [budget=${B}] bfs distinct=${bfs.distinct}  curiosity distinct=${cur.distinct}`);
ok('both arms respect the budget', bfs.visited <= B && cur.visited <= B);
ok('curiosity is NEVER WORSE than bfs', cur.distinct >= bfs.distinct, `bfs=${bfs.distinct} cur=${cur.distinct}`);
// ★ THE FINDING (CRAWL-f measured negative): curiosity does NOT beat bfs — it TIES. Mechanism-level reason: the arm
// ranks a frontier entry by its PARENT-state novelty (curiosity(parentSig)), but a page's out-links ALL share that
// page as their parent, so the score is CONSTANT across the frontier and the arm degrades to FIFO-by-seq = bfs. This
// reproduces #208's "curiosity PROVEN-INERT" — this time the arm was actually ENABLED and measured. Verdict: keep
// bfs; do not ship curiosity. (If this assertion ever flips to a WIN, the mechanism changed — re-open the decision.)
ok('curiosity TIES bfs (parent-novelty is constant across siblings → degrades to FIFO)', cur.distinct === bfs.distinct, `bfs=${bfs.distinct} cur=${cur.distinct}`);

// Sanity: with UNLIMITED budget both reach every distinct state (arm only changes ORDER, not reachability).
// distinct sigs = HUB + DUP + NOVEL1..NOVEL8 = 10.
const bfsFull = simulate('bfs', 100), curFull = simulate('curiosity', 100);
ok('unlimited budget: both reach ALL 10 distinct states (arm = order, not coverage ceiling)', bfsFull.distinct === curFull.distinct && bfsFull.distinct === 10, `bfs=${bfsFull.distinct} cur=${curFull.distinct}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
