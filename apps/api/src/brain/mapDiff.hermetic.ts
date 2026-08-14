/**
 * mapDiff.hermetic.ts — hermetic proof for the crawl-diff spine (#216). No browser, no network, no store.
 * Run: cd apps/api && npx tsx src/brain/mapDiff.hermetic.ts
 *
 * The load-bearing claims:
 *   1. A diff of two maps that differ in ONE page names ONLY that page (not "everything") — the whole reframe.
 *   2. Cosmetic churn (one extra row / a renamed entity) does NOT register as a change (coarse banding holds).
 *   3. A 200→500 endpoint surfaces as a statusRegression (the highest-signal delta); a 500→200 fix does NOT.
 *   4. Added/removed pages, flows, changed-flow steps, added endpoints all classify correctly.
 *   5. Identical maps → clean:true (the beloved-tool "silent when nothing moved" law).
 *   6. First-crawl (prev=null) → all-added, not a crash.
 */
import { mapDiff, pageSig, summarizeDiff } from './mapDiff';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── a base map: 3 pages, 2 flows, 2 endpoints ──
const base = {
  crawledAt: '2026-08-14T00:00:00Z',
  pages: [
    { path: '/dashboard', interactives: 8, requirements: [] },
    { path: '/patients', interactives: 12, requirements: [] },
    { path: '/patients/new', interactives: 5, requirements: [{ name: 'firstName', required: true }, { name: 'dob', required: true }] },
  ],
  flows: [
    { id: 'f1', name: 'Add patient', steps: [{ intent: 'open /patients/new' }, { intent: 'fill form' }, { intent: 'submit' }] },
    { id: 'f2', name: 'View dashboard', steps: [{ intent: 'open /dashboard' }] },
  ],
  api: [
    { method: 'GET', url: '/api/patients', statuses: [200] },
    { method: 'POST', url: '/api/patients', statuses: [201] },
  ],
};

// ── CLAIM 1 + 2: change ONE page structurally (a new required field on /patients/new), churn another COSMETICALLY. ──
const changedOne = JSON.parse(JSON.stringify(base));
changedOne.crawledAt = '2026-08-14T01:00:00Z';
changedOne.pages[2].requirements.push({ name: 'insuranceId', required: true });  // real structural change
changedOne.pages[1].interactives = 13;   // 12→13: same band (many) → cosmetic, must NOT register

{
  const d = mapDiff(base, changedOne);
  ok('names exactly ONE changed state', d.changedStates.length === 1, `got ${d.changedStates.length}: ${d.changedStates.map(c => c.path).join(',')}`);
  ok('the changed state is /patients/new', d.changedStates[0]?.path === '/patients/new');
  ok('reason mentions the added field', /insuranceid/i.test(d.changedStates[0]?.reason || ''), d.changedStates[0]?.reason);
  ok('cosmetic 12→13 interactives did NOT register', !d.changedStates.some(c => c.path === '/patients'));
  ok('no phantom added/removed pages', d.addedPages.length === 0 && d.removedPages.length === 0);
  ok('retestPaths = just the one changed', d.retestPaths.length === 1 && d.retestPaths[0] === '/patients/new');
  ok('not clean', d.clean === false);
}

// ── entity-identity churn: same structure, different data (renamed heading / different ids) must NOT diff ──
{
  const cosmetic = JSON.parse(JSON.stringify(base));
  cosmetic.pages[1].path = '/patients';   // same
  // interactives band-equal, requirements identical → pageSig identical
  ok('pageSig stable under entity churn', pageSig(base.pages[1]) === pageSig(cosmetic.pages[1]));
  const d = mapDiff(base, cosmetic);
  ok('identical-structure maps → clean', d.clean === true, summarizeDiff(d));
}

// ── CLAIM 3: a 200→500 endpoint is a statusRegression; a 500→200 fix is not ──
{
  const regressed = JSON.parse(JSON.stringify(base));
  regressed.api[0].statuses = [200, 500];   // GET /api/patients now 5xx
  const d = mapDiff(base, regressed);
  ok('one statusRegression', d.statusRegressions.length === 1, `got ${d.statusRegressions.length}`);
  ok('regression is GET /api/patients', d.statusRegressions[0]?.url === '/api/patients' && d.statusRegressions[0]?.method === 'GET');
  ok('worstAfter is 500', d.statusRegressions[0]?.worstAfter === 500);

  const fixed = JSON.parse(JSON.stringify(base));
  fixed.api[0].statuses = [500];            // baseline was healthy [200]…
  const back = JSON.parse(JSON.stringify(fixed));
  back.api[0].statuses = [200];             // …now fixed 500→200
  const d2 = mapDiff(fixed, back);
  ok('a 500→200 fix is NOT a regression', d2.statusRegressions.length === 0);
}

// ── CLAIM 4: added/removed page, added flow, changed-flow steps, added endpoint ──
{
  const evolved = JSON.parse(JSON.stringify(base));
  evolved.pages.push({ path: '/billing', interactives: 6, requirements: [] });       // added page
  evolved.pages.splice(0, 1);                                                         // removed /dashboard
  evolved.flows.push({ id: 'f3', name: 'Pay invoice', steps: [{ intent: 'open /billing' }] }); // added flow
  evolved.flows[0].steps.push({ intent: 'confirm insurance' });                       // Add patient gains a step
  evolved.api.push({ method: 'GET', url: '/api/billing', statuses: [200] });          // added endpoint
  const d = mapDiff(base, evolved);
  ok('added /billing page', d.addedPages.includes('/billing'));
  ok('removed /dashboard page', d.removedPages.includes('/dashboard'));
  ok('added flow "Pay invoice"', d.addedFlows.includes('Pay invoice'));
  ok('changed flow "Add patient" gains a step', d.changedFlows.some(c => c.name === 'Add patient' && c.addedSteps.length === 1));
  ok('added endpoint GET /api/billing', d.addedEndpoints.some(e => /GET \/api\/billing/.test(e)));
  // /dashboard was removed → the flow "View dashboard" still exists (name-keyed), so it is NOT auto-removed. correct.
  ok('retestPaths includes added + not removed', d.retestPaths.includes('/billing') && !d.retestPaths.includes('/dashboard'));
}

// ── CLAIM 5 + 6: identical → clean; first crawl (prev=null) → all-added, no crash ──
{
  const d = mapDiff(base, JSON.parse(JSON.stringify(base)));
  ok('identical maps → clean', d.clean === true);
  ok('clean summary reads right', /no drift/i.test(summarizeDiff(d)));

  const first = mapDiff(null, base);
  ok('first crawl → all pages added', first.addedPages.length === 3);
  ok('first crawl → all flows added', first.addedFlows.length === 2);
  ok('first crawl → not clean', first.clean === false);
  ok('first crawl → no removed', first.removedPages.length === 0 && first.removedFlows.length === 0);
}

// ── GraphQL endpoints keyed by operation, not the shared /graphql url ──
{
  const g1 = { api: [{ method: 'POST', url: '/graphql', statuses: [200], graphql: true, gqlOperation: 'GetUser' }] };
  const g2 = { api: [
    { method: 'POST', url: '/graphql', statuses: [200], graphql: true, gqlOperation: 'GetUser' },
    { method: 'POST', url: '/graphql', statuses: [200], graphql: true, gqlOperation: 'DeleteUser' },
  ] };
  const d = mapDiff(g1, g2);
  ok('new gql operation is an added endpoint', d.addedEndpoints.some(e => /DeleteUser/.test(e)) && d.addedEndpoints.length === 1);
}

console.log(`\nmapDiff hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
