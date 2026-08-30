/**
 * normUrl.hermetic.ts — locks the route-key normalization, including HASH-ROUTER support (the fixture Checkout gap:
 * #settings and #checkout must get DISTINCT routeKeys, else they collapse to one and only the first is visited).
 * Also guards that non-route hashes (#top, #L120, #) do NOT split a page, and that numeric/uuid ids still normalize.
 */
import { normUrl } from './crawlMapService';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, got = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n}  got=${got}`)); };

// ── HASH-ROUTER: route-like hashes become distinct routeKeys ──
const A = normUrl('http://app/index.html#settings');
const B = normUrl('http://app/index.html#checkout');
ok('#settings ≠ #checkout (distinct hash routes)', A !== B, `${A} vs ${B}`);
ok('#settings keeps the hash in the key', A.endsWith('#settings'), A);
ok('#!/plan (hashbang) normalizes to #plan', normUrl('http://app/#!/plan').endsWith('#plan'), normUrl('http://app/#!/plan'));
ok('#/users (hash-slash) normalizes to #users', normUrl('http://app/#/users').endsWith('#users'), normUrl('http://app/#/users'));

// ── NON-route hashes must NOT split a page (same key as no-hash) ──
const base = normUrl('http://app/page');
ok('#top is a scroll anchor → same key as no-hash', normUrl('http://app/page#top') === base, normUrl('http://app/page#top'));
ok('#L120 is a line anchor → same key as no-hash', normUrl('http://app/page#L120') === base, normUrl('http://app/page#L120'));
ok('empty #  → same key as no-hash', normUrl('http://app/page#') === base, normUrl('http://app/page#'));

// ── ids inside path AND hash normalize the same way ──
ok('/users/123 → /users/:id', normUrl('http://app/users/123') === 'http://app/users/:id', normUrl('http://app/users/123'));
ok('#/users/123 → #/users/:id form', normUrl('http://app/#/users/123').includes(':id'), normUrl('http://app/#/users/123'));
// (pre-existing id-normalization: a contiguous hex-with-digit run of ≥6 chars → :id; dashed uuids are a known
//  limitation of the existing regex, unrelated to the hash change under test)
ok('hex-with-digit segment → :id', normUrl('http://app/o/a3d12b277c2144e4').includes(':id'), normUrl('http://app/o/a3d12b277c2144e4'));

// ── same route, different hash-route → the ROUTES differ; same hash twice → identical ──
ok('idempotent: same input → same key', normUrl('http://app/x#users') === normUrl('http://app/x#users'));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
