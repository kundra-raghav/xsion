/**
 * Hermetic checks for the frontier strategy + metrics + plateau trigger — no browser.
 * Run: npx tsx src/brain/exploreStrategy.hermetic.ts
 */
import { ExploreTracker, shouldSpendSoa, decideSoa, FrontierItem } from './exploreStrategy';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }
const item = (nav: string, parentSig: string | undefined, seq: number): FrontierItem<string> => ({ nav, parentSig, seq });

console.log('explore-strategy hermetic checks');

// 1. BFS is FIFO regardless of state novelty
{
  const t = new ExploreTracker<string>('bfs', 10);
  const q = [item('A', 'sigHot', 0), item('B', 'sigCold', 1), item('C', undefined, 2)];
  ok('bfs picks in FIFO order', t.pickNext(q)!.nav === 'A' && t.pickNext(q)!.nav === 'B' && t.pickNext(q)!.nav === 'C');
}

// 2. curiosity prefers the frontier entry from the MORE NOVEL (less-visited) parent state
{
  const t = new ExploreTracker<string>('curiosity', 10);
  // make sigCold heavily visited (low curiosity), sigHot unseen (high curiosity)
  for (let i = 0; i < 9; i++) t.model.visit('sigCold');
  const q = [item('fromCold', 'sigCold', 0), item('fromHot', 'sigHot', 1)];
  const picked = t.pickNext(q)!;
  ok('curiosity picks the novel-parent entry first', picked.nav === 'fromHot', `picked ${picked.nav}`);
}

// 3. curiosity degrades to FIFO when no parent-state info (unknown parents tie → stable seq order)
{
  const t = new ExploreTracker<string>('curiosity', 10);
  const q = [item('X', undefined, 0), item('Y', undefined, 1)];
  ok('curiosity ties → FIFO (stable)', t.pickNext(q)!.nav === 'X');
}

// 4. onState: novelty + counts
{
  const t = new ExploreTracker<string>('curiosity', 10);
  const r1 = t.onState('s1'); const r2 = t.onState('s1'); const r3 = t.onState('s2');
  ok('first visit is novel', r1.novel === true && r1.visitN === 1);
  ok('revisit is not novel', r2.novel === false && r2.visitN === 2);
  ok('new sig is novel', r3.novel === true);
  const m = t.metrics(0);
  ok('metrics: 3 visits, 2 distinct, 2 novel', m.pagesVisited === 3 && m.distinctStates === 2 && m.novelStates === 2);
  ok('metrics: noveltyRate = 2/3', Math.abs(m.noveltyRate - 2 / 3) < 1e-9);
  ok('metrics: frontierExhausted when leftover 0', m.frontierExhausted === true);
  ok('metrics: budget-clipped when leftover>0', t.metrics(5).frontierExhausted === false && t.metrics(5).frontierLeftover === 5);
}

// 5. plateau trigger: only for soa/hybrid arms, only after window, only when novelty stalled, only under cost cap
{
  const base = { visited: 20, recentNovelty: 0, window: 10, minNovelty: 1, soaCalls: 0, maxSoa: 3 };
  ok('bfs never spends SoA', shouldSpendSoa({ ...base, arm: 'bfs' }) === false);
  ok('curiosity-solo never spends SoA', shouldSpendSoa({ ...base, arm: 'curiosity' }) === false);
  ok('soa-semantic spends when novelty stalled', shouldSpendSoa({ ...base, arm: 'soa-semantic' }) === true);
  ok('hybrid spends when novelty stalled', shouldSpendSoa({ ...base, arm: 'hybrid' }) === true);
  ok('does NOT spend before the window', shouldSpendSoa({ ...base, arm: 'soa-semantic', visited: 5 }) === false);
  ok('does NOT spend when novelty still flowing', shouldSpendSoa({ ...base, arm: 'soa-semantic', recentNovelty: 4 }) === false);
  ok('does NOT spend past the cost ceiling', shouldSpendSoa({ ...base, arm: 'soa-semantic', soaCalls: 3 }) === false);
}

// 6. CODE-SEED-THEN-CLICK: seeded (_seed) navs ALWAYS drain first, in seed order, regardless of arm or curiosity.
{
  const t = new ExploreTracker<any>('curiosity', 10);
  // make a click-discovered entry look MOST novel (highest curiosity) — it must STILL wait behind seeds.
  const q: any[] = [
    { nav: 'click-hot', _parentSig: 'freshSig', _seq: 0 },   // most novel parent, but not seeded
    { nav: 'seed-B', _seed: true, _seq: 2 },
    { nav: 'seed-A', _seed: true, _seq: 1 },
  ];
  const first = t.pickNextNav(q), second = t.pickNextNav(q), third = t.pickNextNav(q);
  ok('seeds drain first, in seq order (A before B)', first.nav === 'seed-A' && second.nav === 'seed-B', `${first?.nav},${second?.nav}`);
  ok('click-discovered entry only after all seeds', third.nav === 'click-hot');
}
{
  const t = new ExploreTracker<any>('bfs', 10);
  const q: any[] = [{ nav: 'x', _seq: 0 }, { nav: 'seed', _seed: true, _seq: 1 }];
  ok('bfs also honors seed-first (seed before earlier non-seed)', t.pickNextNav(q).nav === 'seed');
}
// 7. THREE-TIER: breadth (bare routes) drains before depth (click-paths) — the csc-2 crowding-out fix.
{
  const t = new ExploreTracker<any>('bfs', 10);
  const q: any[] = [
    { nav: 'deep', clicks: ['Tab'], _seq: 0 },      // tier 3 (click-path) — enqueued FIRST but must wait
    { nav: 'route', _seq: 1 },                        // tier 2 (bare route) — must go before deep
    { nav: 'seed', _seed: true, _seq: 2 },            // tier 1 — first of all
  ];
  const a = t.pickNextNav(q), b = t.pickNextNav(q), c = t.pickNextNav(q);
  ok('tiers: seed → bare-route → click-path', a.nav === 'seed' && b.nav === 'route' && c.nav === 'deep', `${a?.nav},${b?.nav},${c?.nav}`);
}
{
  // curiosity arm also respects tiers: a max-novelty DEEP entry still waits behind a bare route.
  const t = new ExploreTracker<any>('curiosity', 10);
  const q: any[] = [
    { nav: 'deep-hot', clicks: ['x'], _parentSig: 'freshSig', _seq: 0 },
    { nav: 'route-cold', _parentSig: 'coldSig', _seq: 1 },
  ];
  for (let i = 0; i < 9; i++) t.model.visit('coldSig');   // make route-cold's parent heavily visited (low curiosity)
  ok('curiosity: bare route beats a more-novel click-path (breadth before depth)', t.pickNextNav(q).nav === 'route-cold');
}

// 8. TWO-BUDGET SoA decision (#211) — the core fix: an exhausted STALL budget must NOT starve the plateau.
{
  const flat = { arm: 'hybrid' as const, minNovelty: 1, window: 3 };
  // plateau condition met (novelty flatlined over a full non-seed window), STALL budget EXHAUSTED:
  const exhaustedStall = decideSoa({ ...flat, stalled: false, stallSoaCalls: 8, maxStall: 8, nonSeedObservations: 3, recentNovelty: 0, plateauSoaCalls: 0, maxPlateau: 4 });
  ok('plateau STILL fires when the stall budget is exhausted (the #211 fix)', exhaustedStall.firePlateau === true && exhaustedStall.fireStall === false);
  // BEFORE the split this was impossible; sanity that a shared-budget check would have blocked it:
  ok('shared-budget check WOULD have blocked it (proves the split matters)', shouldSpendSoa({ arm: 'hybrid', visited: 3, recentNovelty: 0, window: 3, minNovelty: 1, soaCalls: 8, maxSoa: 8 }) === false);

  // VACUOUS-firing path CLOSED: after seeds drain, non-seed observations < window → plateau must NOT fire.
  const noData = decideSoa({ ...flat, stalled: false, stallSoaCalls: 0, maxStall: 8, nonSeedObservations: 0, recentNovelty: 0, plateauSoaCalls: 0, maxPlateau: 4 });
  ok('plateau does NOT fire on an empty non-seed window (no vacuous firing)', noData.firePlateau === false);
  const partial = decideSoa({ ...flat, stalled: false, stallSoaCalls: 0, maxStall: 8, nonSeedObservations: 2, recentNovelty: 0, plateauSoaCalls: 0, maxPlateau: 4 });
  ok('plateau does NOT fire before a FULL non-seed window', partial.firePlateau === false);

  // stall path still works + takes priority when both true; plateau budget exhausted blocks plateau.
  const hardStall = decideSoa({ ...flat, stalled: true, stallSoaCalls: 0, maxStall: 8, nonSeedObservations: 3, recentNovelty: 0, plateauSoaCalls: 0, maxPlateau: 4 });
  ok('hard stall fires the stall path (not plateau)', hardStall.fireStall === true && hardStall.firePlateau === false);
  const plateauExhausted = decideSoa({ ...flat, stalled: false, stallSoaCalls: 0, maxStall: 8, nonSeedObservations: 3, recentNovelty: 0, plateauSoaCalls: 4, maxPlateau: 4 });
  ok('plateau does NOT fire past its own budget', plateauExhausted.firePlateau === false);
  // still-flowing novelty → neither fires (not a plateau).
  const flowing = decideSoa({ ...flat, stalled: false, stallSoaCalls: 0, maxStall: 8, nonSeedObservations: 3, recentNovelty: 3, plateauSoaCalls: 0, maxPlateau: 4 });
  ok('novelty still flowing → plateau does NOT fire', flowing.firePlateau === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
