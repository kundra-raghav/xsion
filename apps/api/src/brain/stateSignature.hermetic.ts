/**
 * Hermetic checks for the state-equivalence substrate — no browser. Proves the properties every strategy's score
 * depends on: correct collapse (id-invariance), correct split (SPA view-swap), and correct curiosity/collapse math.
 * Run: npx tsx src/brain/stateSignature.hermetic.ts
 */
import { sigFromShape, normLabel, StateModel, PageShape, collapseDecision } from './stateSignature';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

const base = (over: Partial<PageShape> = {}): PageShape => ({
  routeKey: 'https://x.io/users',
  affordances: ['Edit', 'Delete', 'New User'],
  landmarks: { forms: 0, tables: 1, lists: 0, headings: 1, nav: 1 },
  heading: 'Users',
  ...over,
});

console.log('state-signature hermetic checks');

// normLabel: id/digit invariance + punctuation strip
ok('normLabel strips digits', normLabel('Order #1041') === normLabel('Order #2277'), `${normLabel('Order #1041')} vs ${normLabel('Order #2277')}`);
ok('normLabel collapses whitespace+case', normLabel('  New   USER ') === 'new user');

// 1. identical structure → identical signature
ok('same shape → same sig', sigFromShape(base()) === sigFromShape(base()));

// 2. id-varying content on the SAME structure → SAME sig (don't split per-user/per-order — the collapse we WANT)
ok('per-id detail pages collapse', sigFromShape(base({ heading: 'Order #1041', affordances: ['Refund', 'Cancel'] })) === sigFromShape(base({ heading: 'Order #2277', affordances: ['Refund', 'Cancel'] })));

// 3. THE SPA VIEW-SWAP CASE normUrl MISSES: same route, DIFFERENT action-set → DIFFERENT sig
const listView = base({ affordances: ['Edit', 'Delete', 'New User'], landmarks: { forms: 0, tables: 1, lists: 0, headings: 1, nav: 1 } });
const formView = base({ affordances: ['Save', 'Cancel', 'Upload Avatar'], landmarks: { forms: 1, tables: 0, lists: 0, headings: 1, nav: 1 }, heading: 'Create User' });
ok('same route, different view → different sig (SPA swap caught)', sigFromShape(listView) !== sigFromShape(formView));

// 4. affordance ORDER doesn't matter (set-based)
ok('affordance order-independent', sigFromShape(base({ affordances: ['Delete', 'New User', 'Edit'] })) === sigFromShape(base({ affordances: ['Edit', 'Delete', 'New User'] })));

// 5. a real route change → different sig even with same content shape
ok('different route → different sig', sigFromShape(base({ routeKey: 'https://x.io/settings' })) !== sigFromShape(base()));

// 6. coarse landmark banding: N vs N+1 rows in the "many" band do NOT split (2-4 same band, 5+ same band)
ok('landmark banding merges near-counts', sigFromShape(base({ landmarks: { forms: 0, tables: 5, lists: 0, headings: 1, nav: 1 } })) === sigFromShape(base({ landmarks: { forms: 0, tables: 9, lists: 0, headings: 1, nav: 1 } })));

// 6b. HEADING is NOT part of the signature — data identity (which school/order) must not split a structural state.
//     "Demo School Dashboard" and "Doon School Dashboard" with identical affordances+landmarks are ONE state.
ok('heading does NOT affect the signature (data identity ≠ structure)', sigFromShape(base({ heading: 'Demo School Dashboard' })) === sigFromShape(base({ heading: 'Doon School Dashboard' })));
ok('same affordances+landmarks collapse regardless of heading', sigFromShape(base({ heading: 'X', affordances: ['Students', 'Classes', 'Reports'], landmarks: { forms: 0, tables: 0, lists: 0, headings: 1, nav: 1 } })) === sigFromShape(base({ heading: 'Y totally different', affordances: ['Students', 'Classes', 'Reports'], landmarks: { forms: 0, tables: 0, lists: 0, headings: 1, nav: 1 } })));

// 7. StateModel: curiosity decays with visits, counts + collapse-rate correct
const m = new StateModel();
const sA = sigFromShape(listView), sB = sigFromShape(formView);
const c1 = m.curiosity(sA); m.visit(sA);
const c2 = m.curiosity(sA); m.visit(sA);
ok('curiosity decays on revisit', c2 < c1, `${c2} !< ${c1}`);
ok('curiosity = 1/sqrt(N+1)', Math.abs(m.curiosity(sA) - 1 / Math.sqrt(2 + 1)) < 1e-9);
m.visit(sB);
ok('distinctStates counts unique sigs', m.distinctStates() === 2, `got ${m.distinctStates()}`);
ok('observations counts all visits', m.totalObservations() === 3, `got ${m.totalObservations()}`);
// 3 observations, 2 distinct → collapseRate = 1 - 2/3 = 0.333
ok('collapseRate correct', Math.abs(m.collapseRate() - (1 - 2 / 3)) < 1e-9, `got ${m.collapseRate()}`);

// ── COLLAPSE DECISION (the crawl-budget fix): collapse structural duplicates, ENTER data-divergent variants,
//    NEVER collapse a degenerate/unhydrated capture (the over-collapse trap the advisor flagged). ──
console.log('\ncollapse-decision checks');
const dash = (cv: number): PageShape => ({
  routeKey: 'https://x.io/:portal/Teacher/Dashboard',
  affordances: ['Create Event', 'Create Group', 'Add Progress', 'My Calendar', 'View All'],
  landmarks: { forms: 0, tables: 0, lists: 2, headings: 3, nav: 1 }, heading: 'Dashboard', contentVolume: cv,
});
{
  const demoSig = sigFromShape(dash(1));
  // 1. IDENTICAL structure + similar content → COLLAPSE (the /demo vs /doon empty-dashboard case)
  const d1 = collapseDecision(dash(1), [{ sig: demoSig, contentVolume: 1 }]);
  ok('identical structure + similar content → collapse', d1.action === 'collapse', d1.reason);
  // 2. SAME structure but MATERIALLY MORE content → ENTER (the Demo-empty vs NZ-Curriculum-11-events case)
  const d2 = collapseDecision(dash(14), [{ sig: demoSig, contentVolume: 1 }]);
  ok('same structure, data-rich variant → ENTER (do not skip the events)', d2.action === 'enter', d2.reason);
  ok('...and it is the same signature (proves collapse-by-content not by-structure)', d2.sig === demoSig);
  // 3. DIFFERENT structure → ENTER
  const other: PageShape = { routeKey: 'https://x.io/x', affordances: ['Save', 'Cancel', 'Submit'], landmarks: { forms: 1, tables: 0, lists: 0, headings: 1, nav: 0 }, contentVolume: 2 };
  ok('different structure → enter', collapseDecision(other, [{ sig: demoSig, contentVolume: 1 }]).action === 'enter');
  // 4. DEGENERATE (empty affordances + zero landmarks = unhydrated SPA) → NEVER collapse, even against a seen empty.
  const empty: PageShape = { routeKey: 'https://x.io/loading', affordances: [], landmarks: { forms: 0, tables: 0, lists: 0, headings: 0, nav: 0 }, contentVolume: 0 };
  const emptySig = sigFromShape(empty);
  ok('degenerate capture NEVER collapses (empty-DOM over-collapse guard)', collapseDecision(empty, [{ sig: emptySig, contentVolume: 0 }]).action === 'enter');
  // 5. first sight of any shape (nothing seen) → ENTER
  ok('unseen signature → enter', collapseDecision(dash(1), []).action === 'enter');
  // 6. REAL-WORLD trap (the schooltalk login collapse): a page with contentVolume 0 but 1+ affordance is NOT fully
  //    degenerate, yet MUST NOT collapse — "/" (login) collapsed into "/ Setup new password" and killed the crawl.
  const loginish: PageShape = { routeKey: 'https://x.io/', affordances: ['Setup new password'], landmarks: { forms: 0, tables: 0, lists: 0, headings: 1, nav: 0 }, contentVolume: 0 };
  const loginishSig = sigFromShape(loginish);
  ok('zero-content page NEVER collapses (even with 1 affordance)', collapseDecision(loginish, [{ sig: loginishSig, contentVolume: 0 }]).action === 'enter');

  // 7. THE CALENDAR-WEEK TRAP (documents why a naive contentVolume selector-fix must NOT ship alone): two calendars
  //    at the SAME routeKey template (same slug, different ?date=) have identical structure. TODAY both have cv=0 →
  //    the `cv===0 → enter` guard keeps them BOTH explorable (different weeks = different events). But if a future
  //    contentVolume change makes an EMPTY week score a NON-zero grid-cell count (e.g. 14 day-cells), two empty
  //    weeks become "same sig + similar content" → COLLAPSE, and the crawler stops exploring OTHER weeks of the same
  //    calendar — exactly where 10-Sep/Oct/Dec events live. This test PINS the trap: with equal NON-zero cv, same
  //    sig, collapseDecision returns 'collapse'. So a contentVolume selector-fix MUST arrive WITH sibling-relative
  //    richness (only ENTER a week that is an OUTLIER vs its sibling weeks), never as a bare count. See advisor.
  const cal = (cv: number): PageShape => ({ routeKey: 'https://x.io/:slug/Teacher/Calendar', affordances: ['Create Event', 'Select week'], landmarks: { forms: 0, tables: 0, lists: 0, headings: 1, nav: 1 }, contentVolume: cv });
  const calSig = sigFromShape(cal(14));
  ok('TRAP: two same-template calendar weeks with equal NON-zero cv → COLLAPSE (why a bare cv-fix is unsafe)', collapseDecision(cal(14), [{ sig: calSig, contentVolume: 14 }]).action === 'collapse');
  ok('...but a week with OUTLIER content (events!) vs empty siblings → ENTER (the fix a sibling-relative metric must give)', collapseDecision(cal(40), [{ sig: calSig, contentVolume: 14 }]).action === 'enter');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
