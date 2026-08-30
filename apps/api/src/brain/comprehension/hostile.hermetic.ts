/**
 * hostile.hermetic.ts — the SIDEWAYS test: feed the assembler HOSTILE / malformed maps and assert it DEGRADES
 * HONESTLY (no crash, no fabricated confidence, no evidence leak) rather than producing a confident-wrong artifact.
 * The other hermetics prove correctness on well-formed input; this proves the "military-grade / fail-proof" claim on
 * the input a real crawler actually emits under stress. Run: cd apps/api && npx tsx src/brain/comprehension/hostile.hermetic.ts
 */
import { deriveComprehension, type CompInputMap } from './index';
import { containsEvidenceKey } from './firewall';
import { confidence } from './substrate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const NOW = '2026-08-29T00:00:00Z';
const tryRun = (n: string, m: CompInputMap, opts?: any) => { try { return deriveComprehension(m, { now: NOW, ...opts }); } catch (e) { ok(n + ' [did not throw]', false, String((e as Error)?.message).slice(0, 80)); return null; } };
// every model, however hostile the input, must: not throw, never leak an evidence key, never claim > its ceiling.
const invariants = (tag: string, cm: ReturnType<typeof deriveComprehension> | null) => {
  if (!cm) return;
  ok(`${tag}: no throw`, true);
  ok(`${tag}: promptSurface firewall-clean`, !containsEvidenceKey(cm.promptSurface));
  const allClaims = [...cm.entity.entities.map((e) => e.claim), ...cm.capability.capabilities.map((c) => c.derivation), ...cm.effect.edges.map((e) => e.claim)];
  ok(`${tag}: no claim exceeds confidence 1.0`, allClaims.every((c) => confidence(c) <= 1 + 1e-9));
  ok(`${tag}: coverage flag is a real boolean`, typeof cm.entity.coverage.sufficient === 'boolean');
};

// 1. 200 ROLES on a tiny map — must not explode combinatorially or crash; comparability still honest.
{
  const roles = Array.from({ length: 200 }, (_, i) => ({ id: 'r' + i }));
  const m: CompInputMap = { roles, routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: roles.map((r) => r.id) })), api: [{ method: 'GET', url: '/api/x', entity: 'x', roles: roles.map((r) => r.id), respFields: ['id'] }] };
  const cm = tryRun('200-roles', m); invariants('200-roles', cm);
  ok('200 identical-status roles ⇒ not comparable (no fabricated differential)', !cm || cm.capability.roleCoverage.comparable === false);
}

// 2. FUTURE crawledAt (clock skew / bad data) — stamped verbatim, never used to inflate liveness.
{
  const future = '2099-12-31T00:00:00Z';
  const m: CompInputMap = { crawledAt: future, roles: [{ id: 'a' }], routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: ['a'] })), api: [{ method: 'POST', url: '/api/order', writes: true, entity: 'order', roles: ['a'], respFields: ['id', 'status'] }] };
  const cm = tryRun('future-date', m); invariants('future-date', cm);
  ok('future crawledAt stamped verbatim (not silently rewritten)', !cm || cm.sourceMapCrawledAt === future);
}

// 3. 500-KEY respFields (a giant/garbage response) — no crash; state-key detection still terminates + finds the real one.
{
  const bigFields = Array.from({ length: 500 }, (_, i) => 'f' + i).concat(['orderStatus']);
  const m: CompInputMap = { roles: [{ id: 'a' }], routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: ['a'] })), api: [{ method: 'GET', url: '/api/order', entity: 'order', roles: ['a'], respFields: bigFields }] };
  const cm = tryRun('500-fields', m); invariants('500-fields', cm);
  const order = cm?.entity.entities.find((e) => e.canonical === 'order');
  ok('500-field entity still detects the real state key', !!order && order.stateMachine.kind === 'stateful-values-unknown');
}

// 4. ONE URL for EVERY endpoint (opaque/uniform routing) — the degenerate guard must fire, not emit a mega-entity.
{
  const api = Array.from({ length: 30 }, (_, i) => ({ method: 'POST', url: '/api/do', writes: true, entity: 'do', roles: ['a'], reqFields: ['op' + i] }));
  const m: CompInputMap = { roles: [{ id: 'a' }], routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: ['a'] })), api };
  const cm = tryRun('one-url', m); invariants('one-url', cm);
  ok('uniform single-URL routing ⇒ degenerate guard fires (no confident mega-entity)', !cm || cm.entity.entityDerivationDegenerate === true);
}

// 5. CONTRADICTORY role tags: a page lists a role its endpoints never fired, and vice-versa. Must not crash; per-role
//    rows reflect only what each source actually says.
{
  const m: CompInputMap = { roles: [{ id: 'admin' }, { id: 'ghost' }], routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: ['admin', 'ghost', 'undeclared'] })), api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'] }] };
  const cm = tryRun('contradictory-roles', m); invariants('contradictory-roles', cm);
  const approve = cm?.capability.capabilities.find((c) => c.verb === 'approve');
  ok('an endpoint-role not on any page still yields an exercised row (source-faithful)', !!approve && approve.perRole.some((r) => r.role === 'admin' && r.status === 'exercised'));
}

// 6. EMPTY / null-ish everything — the pathological minimum. Must return a withheld model, never throw.
{
  const cm = tryRun('empty', { pages: [], api: [], roles: [] } as any); invariants('empty', cm);
  ok('empty map ⇒ coverage insufficient, entities withheld', !cm || (cm.entity.coverage.sufficient === false && cm.entity.entities.length === 0));
  ok('empty map ⇒ effect not-applicable / insufficient (never applicable-with-empty-edges)', !cm || cm.effect.applicability !== 'applicable');
}

// 7. MALICIOUS FIELD NAMES that collide with evidence-key names (a crawl that captured a field literally called
//    "observedDelta" / "why") must NOT let that field name leak into the prompt surface.
{
  const m: CompInputMap = { roles: [{ id: 'a' }], routeManifest: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i })), pages: Array.from({ length: 5 }, (_, i) => ({ path: '/p' + i, roles: ['a'] })), api: [{ method: 'POST', url: '/api/order', writes: true, entity: 'order', roles: ['a'], respFields: ['why', 'observedDelta', 'statusCodes', 'id'] }] };
  const cm = tryRun('evidence-named-fields', m); invariants('evidence-named-fields', cm);
  ok('a real field literally named "why"/"observedDelta" never leaks into the prompt surface', !!cm && !containsEvidenceKey(cm.promptSurface));
}

console.log(`\nhostile (sideways) hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
