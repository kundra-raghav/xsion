/**
 * Hermetic checks for the API prober's PURE logic (no network): route-template matching + the
 * observed-only / same-origin / auth-skip / assumed-reject discipline, and the verdict floor.
 * Run: npx tsx src/brain/apiProber.hermetic.ts
 */
import { routeTemplate, parseApiHint, matchObserved, probeEndpoint, registrableDomain, sameApp, ObservedEndpoint } from './apiProber';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

console.log('apiProber hermetic checks');
const ORIGIN = 'https://app.example.com';
const observed: ObservedEndpoint[] = [
  { method: 'GET', url: 'https://app.example.com/api/cart', statuses: [200] },
  { method: 'POST', url: 'https://app.example.com/api/cart/add', statuses: [201] },
  { method: 'DELETE', url: 'https://app.example.com/api/cart/item/8891', statuses: [200] },
  { method: 'POST', url: 'https://app.example.com/api/login', statuses: [200] },        // auth — must never probe
  { method: 'GET', url: 'https://accounts.google.com/gsi/status', statuses: [200] },     // 3rd-party — must skip
];

// routeTemplate: ids/uuids/query collapse
ok('routeTemplate collapses numeric id', routeTemplate('https://app.example.com/api/cart/item/8891') === 'https://app.example.com/api/cart/item/:id');
ok('routeTemplate drops query', routeTemplate('https://app.example.com/api/cart?x=1') === 'https://app.example.com/api/cart');

// parseApiHint
ok('parseApiHint reads method+path', JSON.stringify(parseApiHint('POST /api/cart/add')) === JSON.stringify({ method: 'POST', path: '/api/cart/add', assumed: false }));
ok('parseApiHint flags assumed', parseApiHint('POST /dapi/cart/add (assumed)')?.assumed === true);
ok('parseApiHint null on junk', parseApiHint('just some prose') === null);

// matchObserved
ok('matches a real observed endpoint', matchObserved('POST /api/cart/add', observed, ORIGIN).endpoint?.url === 'https://app.example.com/api/cart/add');
ok('matches through an id template', matchObserved('DELETE /api/cart/item/999', observed, ORIGIN).endpoint?.method === 'DELETE');
ok('ASSUMED hint is NOT probed', !!matchObserved('POST /dapi/cart/add (assumed)', observed, ORIGIN).reason && !matchObserved('POST /dapi/cart/add (assumed)', observed, ORIGIN).endpoint);
ok('unobserved endpoint is NOT probed', !matchObserved('GET /api/nonexistent', observed, ORIGIN).endpoint);
ok('auth endpoint is NEVER matched (skipped)', !matchObserved('POST /api/login', observed, ORIGIN).endpoint);
ok('cross-origin endpoint is NEVER matched', !matchObserved('GET /gsi/status', observed, ORIGIN).endpoint);
ok('method mismatch → no match', !matchObserved('PUT /api/cart/add', observed, ORIGIN).endpoint);

// registrable-domain siblings (the app's own API on a sibling host) ARE the same app; 3rd parties are NOT.
ok('registrableDomain: sub.host → host', registrableDomain('qa-auth.schooltalkapp.com') === 'schooltalkapp.com');
ok('registrableDomain: co.uk kept', registrableDomain('api.shop.co.uk') === 'shop.co.uk');
ok('sameApp: app host vs its API sibling → true', sameApp('https://qa.schooltalkapp.com', 'https://qa-auth.schooltalkapp.com/data'));
ok('sameApp: app vs AWS execute-api → false', !sameApp('https://admin.thedent.in', 'https://fq0r3bh5a8.execute-api.ap-south-1.amazonaws.com/graphql'));
ok('sameApp: app vs Google → false', !sameApp('https://app.example.com', 'https://accounts.google.com/gsi/status'));
{
  const sibling: ObservedEndpoint[] = [{ method: 'GET', url: 'https://api.example.com/v1/cart', statuses: [200] }];
  ok('matches an API-SIBLING host endpoint (same registrable domain)', matchObserved('GET /v1/cart', sibling, 'https://app.example.com').endpoint?.url === 'https://api.example.com/v1/cart');
}

// probeEndpoint verdict floor — use a fake APIRequestContext with scripted responses.
const fakeReq = (status: number, body: string): any => ({ fetch: async () => ({ status: () => status, text: async () => body }) });
(async () => {
  // mutation gate: POST unauthorized → needs-review (not probed)
  const gated = await probeEndpoint(fakeReq(200, 'x') as any, observed[1], false, 'held', 'broke');
  ok('POST unauthorized → needs-review (mutation gate)', gated.verdict === 'needs-review');

  // GET works unauthorized; a 4xx the oracle wants → held
  const held = await probeEndpoint(fakeReq(400, 'validation error') as any, observed[0], false, 'API returns 400 Bad Request with validation error', 'API returns 200, accepts invalid');
  ok('GET 400 + oracle wants rejection → held', held.verdict === 'held', held.detail);

  // 5xx → broke regardless of oracle
  const broke5xx = await probeEndpoint(fakeReq(500, 'Internal Server Error') as any, observed[0], false, 'held', 'broke');
  ok('GET 500 → broke (hard signal)', broke5xx.verdict === 'broke');

  // stack in body → broke
  const brokeStack = await probeEndpoint(fakeReq(200, 'TypeError: cannot read property foo of undefined\n at Cart.add (cart.js:12)') as any, observed[0], false, 'held', 'broke');
  ok('2xx body with stack trace → broke', brokeStack.verdict === 'broke');

  // authorized POST 201 where oracle says a 2xx-accept IS the defect → broke
  const brokeAccept = await probeEndpoint(fakeReq(201, 'ok') as any, observed[1], true, 'API returns 400', 'API returns 200/201, item added without validation', );
  ok('authorized POST 201 + oracle says accept-is-defect → broke', brokeAccept.verdict === 'broke', brokeAccept.detail);

  // ambiguous 200 read → needs-review (fail-safe floor)
  const amb = await probeEndpoint(fakeReq(200, 'ok') as any, observed[0], false, 'something', 'something else', );
  ok('ambiguous 200 → needs-review (fail-safe)', amb.verdict === 'needs-review');

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
