/**
 * entityModel.hermetic.ts — locks FACET 1's derivation rules + adversarial guards. Pure, no browser.
 * Run: cd apps/api && npx tsx src/brain/comprehension/entityModel.hermetic.ts
 */
import { deriveEntityModel, type EMInput } from './entityModel';
import { confidence } from './substrate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const NOW = '2026-08-29T00:00:00Z';
// a "sufficient" coverage baseline: enough pages vs routes
const cov = (over: Partial<EMInput> = {}): EMInput => ({ pages: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i, roles: ['admin'] })), api: [], routesKnown: 9, rolesDeclared: ['admin'], sourceMapCrawledAt: NOW, now: NOW, ...over });

// 1. INSUFFICIENT COVERAGE → honest empty, never a confident model (the one-screen guard).
{
  const m = deriveEntityModel({ pages: [{ path: '/dash' }], api: [{ method: 'GET', url: '/api/order' }], routesKnown: 9, rolesDeclared: ['admin'], sourceMapCrawledAt: NOW, now: NOW });
  ok('1-page map → entities empty + whyEmpty', m.entities.length === 0 && !!m.whyEmpty && /insufficient/i.test(m.whyEmpty));
}

// 2. Basic API entity + fields + WRITE transition with from/to UNKNOWN (never fabricated).
{
  const m = deriveEntityModel(cov({ api: [
    { method: 'GET', url: '/api/order/:id', respFields: ['id', 'customer', 'orderStatus'], entity: 'order', roles: ['admin'] },
    { method: 'POST', url: '/api/order/:id/approve', writes: true, firedBy: ['Approve'], entity: 'order', roles: ['editor'] },
  ] }));
  const order = m.entities.find((e) => e.canonical === 'order');
  ok('derives the order entity (api origin)', !!order && order.origin === 'api');
  ok('captures fields (shapes only)', !!order && order.fields.map((f) => f.name).sort().join(',') === 'customer,id,orderStatus');
  ok('write endpoint → a transition', !!order && order.transitions.length === 1 && order.transitions[0].triggerKind === 'rest-write');
  ok('transition from/to are UNKNOWN (never fabricated)', !!order && order.transitions[0].from === 'unknown' && order.transitions[0].to === 'unknown');
  ok('detects orderStatus as a state key (non-anchored)', !!order && order.stateMachine.kind === 'stateful-values-unknown' && (order.stateMachine as any).stateKey === 'orderStatus');
}

// 3. NO state key → 'no-state-key-observed' CLAIM, capped ≤0.5, NOT "transitions impossible".
{
  const m = deriveEntityModel(cov({ api: [{ method: 'GET', url: '/api/tag/:id', respFields: ['id', 'label'], entity: 'tag', roles: ['admin'] }] }));
  const tag = m.entities.find((e) => e.canonical === 'tag')!;
  ok('no-state-key is a CLAIM (four-way), not silence', tag.stateMachine.kind === 'no-state-key-observed');
  ok('… capped ≤0.5 (negative branch)', confidence((tag.stateMachine as any).claim) <= 0.5 + 1e-9);
}

// 4. MERGED-ENTITY SPLIT (Attack1 #2): same name, disjoint schemas, different prefixes → two nodes + mergeRisk.
{
  const m = deriveEntityModel(cov({ api: [
    { method: 'GET', url: '/admin/users/:id', respFields: ['id', 'globalRole', 'billingPlan'], entity: 'users', roles: ['admin'] },
    { method: 'GET', url: '/org/:id/users/:id', respFields: ['id', 'seat', 'invitedBy'], entity: 'users', roles: ['editor'] },
  ] }));
  const userNodes = m.entities.filter((e) => e.canonical.startsWith('user'));
  ok('distinct-schema same-name entities are SPLIT (not fused)', userNodes.length === 2, 'got ' + userNodes.length);
  ok('… and flagged mergeRisk', userNodes.every((n) => n.mergeRisk.sharedNameDistinctSchema === true));
}

// 5. DEGENERATE guard (Attack1 #7): uniform routing → refuse a confident mega-entity.
{
  const api = Array.from({ length: 10 }, (_, i) => ({ method: 'POST', url: `/api/resource/type${i}`, entity: 'resource', writes: true, roles: ['admin'] }));
  const m = deriveEntityModel(cov({ api }));
  ok('uniform /resource routing → degenerate flag + no mega-entity', m.entityDerivationDegenerate === true && m.entities.length === 0 && !!m.whyEmpty);
}

// 6. ZERO-API app (in-memory fixture): entities fall back to AFFORDANCE labels, capped ≤0.5.
{
  const m = deriveEntityModel(cov({ api: [], pages: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i, roles: ['operator'], affordanceInventory: i === 0 ? [{ label: 'Create Event', kind: 'action' as const }] : [] })) }));
  const ev = m.entities.find((e) => e.canonical === 'event');
  ok('zero-API → affordance-origin entity', !!ev && ev.origin === 'affordance');
  ok('… capped ≤0.5 (affordance ceiling, beatable by API)', !!ev && confidence(ev.claim) <= 0.5 + 1e-9);
  ok('… and coverage still sufficient (zero-API not gated)', m.coverage.sufficient === true);
}

// 7. sourceMapCrawledAt stamped (stale-substrate honesty).
{
  const m = deriveEntityModel(cov());
  ok('stamps sourceMapCrawledAt (what it was derived FROM)', m.sourceMapCrawledAt === NOW);
}

console.log(`\nentityModel hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
