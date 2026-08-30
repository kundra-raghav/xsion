/**
 * substrate.hermetic.ts — locks the comprehension-layer FOUNDATION invariants (the ones that make confidence mean
 * EVIDENCE, not crawl-count, and that cap the confident-wrong negatives). Pure, no browser.
 * Run: cd apps/api && npx tsx src/brain/comprehension/substrate.hermetic.ts
 */
import { claim, confidence, isLive, reinforce, contradict, openWorldSet, computeCoverage, PROVENANCE_CEILING } from './substrate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const near = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps;

// 1. RUNG CEILING holds against hit inflation: a code-unwitnessed claim with many hits stays ≤ 0.4 (dead-code guard).
{
  let c = claim('code-unwitnessed', 'file#enum#h1', 'status enum in source');
  for (let i = 0; i < 10; i++) c = reinforce(c, { provenance: 'code-unwitnessed', evId: 'file#enum#h' + i });
  ok('code-unwitnessed capped ≤0.4 despite 10 hits', confidence(c) <= 0.4 + 1e-9, 'got ' + confidence(c).toFixed(3));
}

// 2. NEGATIVE CLAIM ceiling holds — the whole point of the module: a negative with ceiling 0.5 stays ≤0.5 forever.
{
  let c = claim('observed', 'obs#0', 'no state key observed on entity order', 0.5);
  for (let i = 1; i <= 20; i++) c = reinforce(c, { provenance: 'observed', evId: 'obs#' + i });
  ok('negative claim (ceiling 0.5) capped ≤0.5 despite 20 hits', confidence(c) <= 0.5 + 1e-9, 'got ' + confidence(c).toFixed(3));
  ok('… and it did accumulate hits (not frozen)', c.hits === 21);
}

// 3. EVIDENCE-ID DEDUP: reinforcing with a REPEATED evidenceId does NOT bump hits (confidence = evidence, not looks).
{
  let c = claim('observed', 'POST /order#hashA', 'create order');
  const before = c.hits;
  c = reinforce(c, { provenance: 'observed', evId: 'POST /order#hashA' });   // SAME evidence → idempotent
  ok('repeated evidenceId does not bump hits (dedup)', c.hits === before, 'hits ' + before + '→' + c.hits);
  c = reinforce(c, { provenance: 'observed', evId: 'POST /order#hashB' });   // NEW evidence → +1
  ok('new evidenceId bumps hits', c.hits === before + 1);
}

// 4. CONTRADICT semantics.
{
  const hc = claim('human-confirmed', 'human#1', 'admin can delete');
  ok('contradict on human-confirmed is a no-op', contradict(hc).misses === 0 && contradict(hc).provenance === 'human-confirmed');
  let cao = claim('code-and-observed', 'both#1', 'order has status enum');
  cao = contradict(cao, 'app rendered a state not in the enum');
  ok('contradict on code-and-observed lands on observed (not below)', cao.provenance === 'observed', 'got ' + cao.provenance);
  ok('… and records the miss', cao.misses === 1);
}

// 5. PROVENANCE UPGRADE: code + a live observation agreeing → code-and-observed (the real top rung below human).
{
  let c = claim('code-unwitnessed', 'file#x#h', 'role check user.role===admin in source');
  c = reinforce(c, { provenance: 'observed', evId: 'GET /admin#h' });
  ok('code-unwitnessed + observed agreement → code-and-observed', c.provenance === 'code-and-observed', 'got ' + c.provenance);
  ok('… now uncapped by the code-unwitnessed ceiling (can exceed 0.4)', PROVENANCE_CEILING['code-and-observed'] === 1);
}

// 6. isLive expiry: contradictions dominate → drops out; human-confirmed never expires.
{
  let c = claim('observed', 'o#1', 'x');
  c = contradict(c, 'gone'); c = contradict(c, 'gone'); c = contradict(c, 'gone');
  ok('a mostly-contradicted claim is not live', !isLive(c));
  const hc = claim('human-confirmed', 'h#1', 'x');
  ok('human-confirmed is always live', isLive(contradict(contradict(contradict(hc)))));
}

// 7. OPEN-WORLD SET never yields complete:true from derivation.
{
  const s = openWorldSet(['a', 'b', 'a']);
  ok('openWorldSet dedups + is complete:false', s.observed.length === 2 && (s as any).complete === false);
}

// 8. COVERAGE ENVELOPE: one-screen map is insufficient; a full map is sufficient; zero-API does NOT gate.
{
  const oneScreen = computeCoverage({ pagesCrawled: 1, routesKnown: 9, endpointsObserved: 0, rolesCrawled: ['admin'], rolesDeclared: ['admin'], pagesPerRole: { admin: 1 } });
  ok('1-page/9-route map is INSUFFICIENT', oneScreen.sufficient === false && /page/i.test(String(oneScreen.reason)));
  const full = computeCoverage({ pagesCrawled: 9, routesKnown: 9, endpointsObserved: 0, rolesCrawled: ['admin'], rolesDeclared: ['admin'], pagesPerRole: { admin: 9 } });
  ok('9-page/9-route map is SUFFICIENT even with ZERO observed endpoints (zero-API app)', full.sufficient === true);
  const blackbox = computeCoverage({ pagesCrawled: 5, routesKnown: 0, endpointsObserved: 3, rolesCrawled: ['x'], rolesDeclared: ['x'], pagesPerRole: { x: 5 } });
  ok('blackbox (no manifest) 5 pages is sufficient (page-floor)', blackbox.sufficient === true);
  const blackbox1 = computeCoverage({ pagesCrawled: 1, routesKnown: 0, endpointsObserved: 3, rolesCrawled: ['x'], rolesDeclared: ['x'], pagesPerRole: { x: 1 } });
  ok('blackbox 1 page is INSUFFICIENT (page-floor rejects one screen)', blackbox1.sufficient === false);
}

console.log(`\nsubstrate hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
