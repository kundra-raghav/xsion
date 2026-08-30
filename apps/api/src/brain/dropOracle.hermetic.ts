/**
 * dropOracle.hermetic.ts — proves the coordinate-precise drop + read-back oracle in BOTH directions, against known
 * ground truth. Run: cd apps/api && npx tsx src/brain/dropOracle.hermetic.ts
 *
 * PART 1 (pure, always runs): judgeDrop + the geometry helpers on hand-built snapshots — reproduced, not-reproduced,
 *   and every inconclusive branch (missing after, no-op drag, empty column). This is the safety invariant: NO
 *   positional verdict without a positional observation.
 * PART 2 (LIVE, requires a browser + the fixture served): drives a real offset drop on calendar-dnd.html and asserts
 *   the FULL pipeline (snapshot → aim → drop → snapshot → judge) reports reproduced on ?mode=buggy and not-reproduced
 *   on ?mode=correct. Skips gracefully (not a failure) if chromium/the fixture server isn't available.
 */
import { judgeDrop, judgeDropDifferential, slotForY, aimYForSlot, observedSlotOf, orderByY, snapshotColumn, offsetDrop, liveDropPrecisionVerdict, type ColumnSnapshot } from './dropOracle';

let pass = 0, fail = 0, skip = 0;
const ok = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };

// a column: long event (tall) on top, short event below it. y/height in px.
const before: ColumnSnapshot = [
  { id: 'evt-long',  y: 0,   height: 120, time: '9:00' },
  { id: 'evt-short', y: 128, height: 40,  time: '11:00' },
];

console.log('PART 1 — pure judge + geometry');
// ── geometry ──
ok('slotForY above everything → slot 0', slotForY(before, -5) === 0);
ok('slotForY between the two events → slot 1', slotForY(before, 130) === 1, String(slotForY(before, 130)));
ok('slotForY below both → slot 2', slotForY(before, 300) === 2, String(slotForY(before, 300)));
ok('aimYForSlot(0) is above the first event', aimYForSlot(before, 0) < before[0].y + 1);
ok('aimYForSlot(2) is below the last event', aimYForSlot(before, 2) > before[1].y + before[1].height);
// aiming for slot 1 (between) must itself resolve back to slot 1 — geometry round-trips.
ok('aimYForSlot(1) round-trips to slot 1', slotForY(before, aimYForSlot(before, 1)) === 1, String(aimYForSlot(before, 1)));
ok('orderByY sorts top→bottom', orderByY([before[1], before[0]]).map((e) => e.id).join() === 'evt-long,evt-short');
ok('observedSlotOf finds the id', observedSlotOf(before, 'evt-short') === 1);
ok('observedSlotOf returns null for a missing id', observedSlotOf(before, 'nope') === null);

// ── THE JUDGE, both directions ──
// intended: drop the NEW event BELOW the short event = slot 2 (after long, after short).
const intendedBelow = 2;

// NOT-REPRODUCED: the app honored it — new event landed at slot 2 (bottom).
const afterCorrect: ColumnSnapshot = [
  { id: 'evt-long', y: 0, height: 120 }, { id: 'evt-short', y: 128, height: 40 }, { id: 'evt-new', y: 172, height: 40 },
];
{
  const j = judgeDrop([...before, { id: 'evt-new', y: -50, height: 40 }], afterCorrect, 'evt-new', intendedBelow);
  ok('CORRECT app → not-reproduced (landed where aimed)', j.verdict === 'not-reproduced', `${j.verdict} obs=${j.observedSlot} ${j.why}`);
  ok('  observedSlot === intendedSlot (2)', j.observedSlot === 2, String(j.observedSlot));
}

// REPRODUCED: the bug — new event snapped to just below the LONG event (slot 1), NOT where we aimed (slot 2).
const afterBuggy: ColumnSnapshot = [
  { id: 'evt-long', y: 0, height: 120 }, { id: 'evt-new', y: 124, height: 40 }, { id: 'evt-short', y: 168, height: 40 },
];
{
  const j = judgeDrop([...before, { id: 'evt-new', y: -50, height: 40 }], afterBuggy, 'evt-new', intendedBelow);
  ok('BUGGY app → reproduced (landed below the long event, not where aimed)', j.verdict === 'reproduced', `${j.verdict} obs=${j.observedSlot} ${j.why}`);
  ok('  observedSlot(1) !== intendedSlot(2)', j.observedSlot === 1 && j.intendedSlot === 2, `obs=${j.observedSlot}`);
}

// ── the SAFETY INVARIANT: no positional verdict without a positional observation ──
{
  // dropped event missing from the after snapshot → inconclusive, NEVER reproduced.
  const j = judgeDrop(before, afterCorrect.filter((e) => e.id !== 'evt-new'), 'evt-new', intendedBelow);
  ok('missing dropped event in after → inconclusive (not a false verdict)', j.verdict === 'inconclusive' && j.observedSlot === null, j.verdict);
}
{
  // no-op drag: before order === after order (nothing moved) → inconclusive.
  const withNew: ColumnSnapshot = [...before, { id: 'evt-new', y: 200, height: 40 }];
  const j = judgeDrop(withNew, [...withNew], 'evt-new', 0);   // intended slot 0 but nothing moved
  ok('no-op drag (identical before/after) → inconclusive', j.verdict === 'inconclusive', `${j.verdict} ${j.why}`);
}
{
  const j = judgeDrop([], [], 'evt-new', 0);
  ok('empty column → inconclusive', j.verdict === 'inconclusive');
}
{
  // DUPLICATE-ID: two "Math Class" events → the dropped id is ambiguous → inconclusive, never a false verdict.
  const dupBefore: ColumnSnapshot = [{ id: 'Math', y: 0, height: 40 }, { id: 'Math', y: 44, height: 40 }, { id: 'evt-new', y: -50, height: 40 }];
  const dupAfter: ColumnSnapshot = [{ id: 'Math', y: 0, height: 40 }, { id: 'evt-new', y: 44, height: 40 }, { id: 'Math', y: 88, height: 40 }];
  const j = judgeDrop(dupBefore, dupAfter, 'Math', 1);
  ok('duplicate dropped-id → inconclusive (ambiguous identity, no false verdict)', j.verdict === 'inconclusive', j.why);
}

console.log('\nPART 1b — TWO-AIM DIFFERENTIAL (separates "ignores drop position" from grid-snapping)');
{
  // THE BUG: two different aims (slot 1 and slot 2) BOTH land at slot 1 → drop position ignored → reproduced.
  const d = judgeDropDifferential({ intendedSlot: 1, observedSlot: 1 }, { intendedSlot: 2, observedSlot: 1 });
  ok('both aims collapse to the same slot → reproduced', d.verdict === 'reproduced', d.why);
}
{
  // CORRECT: aim 1 → slot 1, aim 2 → slot 2 → different aims land differently → honored → not-reproduced.
  const d = judgeDropDifferential({ intendedSlot: 1, observedSlot: 1 }, { intendedSlot: 2, observedSlot: 2 });
  ok('different aims land at different slots → not-reproduced', d.verdict === 'not-reproduced', d.why);
}
{
  // SNAP-ONLY (the false-positive the differential exists to KILL): a correct app rounds each drop to a grid slot, so
  // a SINGLE aim mismatches — but the two aims STILL differ from each other → honored, NOT the bug.
  const d = judgeDropDifferential({ intendedSlot: 1, observedSlot: 0 }, { intendedSlot: 2, observedSlot: 1 });
  ok('grid-snapping (aims still differ) → not-reproduced, NOT a false reproduced', d.verdict === 'not-reproduced', d.why);
}
{
  // safety: either arm unreadable → inconclusive (two positional observations required).
  const d = judgeDropDifferential({ intendedSlot: 1, observedSlot: 1 }, { intendedSlot: 2, observedSlot: null, inconclusiveWhy: 'lost the event' });
  ok('one arm unreadable → inconclusive', d.verdict === 'inconclusive', d.why);
  const same = judgeDropDifferential({ intendedSlot: 1, observedSlot: 1 }, { intendedSlot: 1, observedSlot: 1 });
  ok('two aims at the SAME slot → inconclusive (not a real differential)', same.verdict === 'inconclusive', same.why);
}

// ── PART 2: LIVE fixture (real browser, real offset drop, real DOM read-back) ──
(async () => {
  const FIX = process.env.XSION_FIXTURE_URL || 'http://localhost:5199';
  let chromium: any;
  try { ({ chromium } = await import('playwright')); } catch { console.log('\nPART 2 — SKIPPED (playwright not installed)'); skip++; return finish(); }

  // ONE aim: fresh page, snapshot, aim the NEW event at `desiredSlot`, drop, re-snapshot → observed slot. This is the
  // real live pipeline for a single arm of the differential.
  async function oneAim(mode: string, desiredSlot: number): Promise<{ intendedSlot: number; observedSlot: number | null } | 'skip' | string> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const resp = await page.goto(`${FIX}/calendar-dnd.html?mode=${mode}`, { timeout: 5000 }).catch(() => null);
      if (!resp || !resp.ok()) return 'skip';
      await page.waitForSelector('[data-testid="evt-new"]', { timeout: 3000 });
      const beforeSnap = await snapshotColumn(page, 'Monday');
      if (beforeSnap.length < 3) return 'error:before(' + beforeSnap.length + ')';
      const others = beforeSnap.filter((e) => e.id !== 'evt-new');
      const aimY = aimYForSlot(others, desiredSlot);                 // aim at the requested inter-event slot
      const colX = await page.evaluate(() => { const doc: any = (globalThis as any).document; const n: any = doc.querySelector('[data-testid="evt-long"]'); const r = n.getBoundingClientRect(); return r.left + r.width / 2; });
      const droppedId = await offsetDrop(page, 'evt-new', colX, aimY);
      if (!droppedId) return 'error:no-source';
      await page.waitForTimeout(150);
      const afterSnap = await snapshotColumn(page, 'Monday');
      return { intendedSlot: desiredSlot, observedSlot: observedSlotOf(afterSnap, 'evt-new') };
    } finally { await browser.close(); }
  }

  // run the TWO-AIM DIFFERENTIAL for a mode: aim slot 1 (just below the long event) and slot 2 (below both) → judge.
  async function runDifferential(mode: string): Promise<string> {
    const a = await oneAim(mode, 1);
    if (a === 'skip') return 'skip';
    if (typeof a === 'string') return a;
    const b = await oneAim(mode, 2);
    if (b === 'skip') return 'skip';
    if (typeof b === 'string') return b;
    const d = judgeDropDifferential(a, b);
    console.log(`    [${mode}] aim1→${a.observedSlot}  aim2→${b.observedSlot}  → ${d.verdict}`);
    return d.verdict;
  }

  console.log('\nPART 2 — LIVE fixture, TWO-AIM DIFFERENTIAL (offset drop + DOM read-back)');
  const buggy = await runDifferential('buggy');
  const correct = await runDifferential('correct');
  const snap = await runDifferential('snap');
  if ([buggy, correct, snap].includes('skip')) {
    console.log(`  (fixture server not at ${FIX} — serve apps/api/test-fixture/ on :5199 to run live. SKIPPED, not failed.)`);
    skip++;
  } else {
    ok('LIVE ?mode=buggy → reproduced (both aims collapse to below the long event)', buggy === 'reproduced', buggy);
    ok('LIVE ?mode=correct → not-reproduced (aims land at different slots)', correct === 'not-reproduced', correct);
    ok('LIVE ?mode=snap → not-reproduced (grid-snapping is NOT the bug — the differential kills this false positive)', snap === 'not-reproduced', snap);
  }

  // ── PART 3: the SHARED-PAGE path with a REAL reset — proves the comparability assertion (the advisor's reload bug). ──
  // liveDropPrecisionVerdict runs BOTH aims on ONE page, resetting between them. On a resetting app the verdict lands;
  // on a PERSISTING app (drop sticks across reload) the two aims start from different states → it MUST be inconclusive,
  // never a false verdict. This is the exact case the fixture's plain reload used to mask.
  async function sharedPageVerdict(mode: string): Promise<string> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const url = `${FIX}/calendar-dnd.html?${mode}`;
      const resp = await page.goto(url, { timeout: 5000 }).catch(() => null);
      if (!resp || !resp.ok()) return 'skip';
      await page.waitForSelector('[data-testid="evt-new"]', { timeout: 3000 });
      const reset = async () => { try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }); await page.waitForTimeout(300); } catch {} };
      const r = await liveDropPrecisionVerdict(page, { sourceId: 'New event', columnHint: 'Monday', resetToState: reset });
      console.log(`    [${mode}] shared-page → ${r.verdict}  (${r.why.slice(0, 90)})`);
      return r.verdict;
    } finally { await browser.close(); }
  }

  console.log('\nPART 3 — SHARED-PAGE + REAL reset (comparability assertion)');
  const sharedCorrect = await sharedPageVerdict('mode=correct');       // reload truly resets → a real verdict lands
  const sharedPersist = await sharedPageVerdict('mode=correct&persist=1'); // reload does NOT reset → must be inconclusive
  if ([sharedCorrect, sharedPersist].includes('skip')) {
    console.log('  (fixture server not up — SKIPPED, not failed.)');
    skip++;
  } else {
    ok('shared-page ?mode=correct → not-reproduced (reset restored order, arms comparable)', sharedCorrect === 'not-reproduced', sharedCorrect);
    ok('shared-page persisting app → INCONCLUSIVE (reset failed → arms not comparable → refuses to guess)', sharedPersist === 'inconclusive', sharedPersist);
  }
  finish();
})();

function finish() {
  console.log(`\ndropOracle hermetic: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
}
