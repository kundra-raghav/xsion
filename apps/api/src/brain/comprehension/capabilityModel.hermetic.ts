/**
 * capabilityModel.hermetic.ts — locks FACET 2's two irreversible-consequence guards + the per-role table semantics.
 * Run: cd apps/api && npx tsx src/brain/comprehension/capabilityModel.hermetic.ts
 */
import { deriveCapabilityModel, type CMInput } from './capabilityModel';
import { toPromptSurface, containsEvidenceKey, type TestTarget } from './firewall';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const NOW = '2026-08-29T00:00:00Z';
const cov = (over: Partial<CMInput> = {}): CMInput => ({ pages: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i, roles: ['admin', 'operator'], reachedByRoles: ['admin', 'operator'] })), api: [], routesKnown: 9, rolesDeclared: ['admin', 'operator'], sourceMapCrawledAt: NOW, now: NOW, ...over });

// 1. INSUFFICIENT COVERAGE → withheld.
{
  const m = deriveCapabilityModel({ pages: [{ path: '/x' }], api: [{ method: 'POST', url: '/api/order', writes: true }], routesKnown: 9, rolesDeclared: ['admin'], sourceMapCrawledAt: NOW, now: NOW });
  ok('1-page → capabilities withheld + whyEmpty', m.capabilities.length === 0 && !!m.whyEmpty);
}

// 2. FAIL-CLOSED DESTRUCTIVE: an UNKNOWN domain verb ⇒ destructive:true, autoExercise:'never'.
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/invoice/:id/disburse', writes: true, firedBy: ['Disburse'], entity: 'invoice', roles: ['admin'] }] }));
  const cap = m.capabilities.find((c) => c.verb === 'disburse')!;
  ok('unknown domain verb "disburse" ⇒ destructive:true (fail-closed)', cap && cap.destructive.value === true);
  ok('… and never auto-exercised', cap && cap.autoExercise === 'never');
}

// 3. KNOWN-SAFE verb ⇒ destructive:false + probe-data-only (the ONLY licensed non-destructive).
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'GET', url: '/api/report/export', firedBy: ['Export'], entity: 'report', roles: ['admin'] }] }));
  const cap = m.capabilities.find((c) => c.verb === 'export')!;
  ok('known-safe "export" ⇒ destructive:false', cap && cap.destructive.value === false);
  ok('… and probe-data-only', cap && cap.autoExercise === 'probe-data-only');
}

// 4. explicit destroyer "delete" ⇒ destructive:true even via a plain DELETE method.
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'DELETE', url: '/api/order/:id', entity: 'order', roles: ['admin'] }] }));
  const cap = m.capabilities.find((c) => c.verb === 'delete')!;
  ok('DELETE order ⇒ destructive:true, never auto', cap && cap.destructive.value === true && cap.autoExercise === 'never');
}

// 5. 'denied' is licensed ONLY by authz-class 403 observed ≥2×; ONE 403 stays 'denied-unconfirmed' (a target, not a claim).
{
  const oneShot = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 403, body: 'forbidden: insufficient role' }] }] }));
  const c1 = oneShot.capabilities.find((c) => c.entity.startsWith('order'))!;
  const op1 = c1.perRole.find((r) => r.role === 'operator')!;
  ok('single authz-403 ⇒ denied-UNCONFIRMED (not a "cannot" claim)', op1.status === 'denied-unconfirmed', 'got ' + op1.status);

  const twice = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 403, body: 'forbidden: role' }, { role: 'operator', status: 401, body: 'unauthorized' }] }] }));
  const op2 = twice.capabilities.find((c) => c.entity.startsWith('order'))!.perRole.find((r) => r.role === 'operator')!;
  ok('≥2 authz denials ⇒ denied (the licensed "cannot")', op2.status === 'denied', 'got ' + op2.status);
}

// 6. a NON-authz denial (rate-limit) is NEVER 'denied' even twice — wrong class.
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 429, headers: { 'Retry-After': '30' } }, { role: 'operator', status: 429, headers: { 'Retry-After': '30' } }] }] }));
  const op = m.capabilities.find((c) => c.entity.startsWith('order'))!.perRole.find((r) => r.role === 'operator')!;
  ok('rate-limit 429 ×2 ⇒ denied-unconfirmed (not denied — wrong class)', op.status === 'denied-unconfirmed' && op.denialClass === 'rate-limit');
}

// 7. PER-ROLE TABLE: admin-exercised + operator-denied is ONE capability, not two.
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 403, body: 'forbidden role' }, { role: 'operator', status: 401, body: 'unauthorized' }] }] }));
  const approve = m.capabilities.filter((c) => c.verb === 'approve' && c.entity.startsWith('order'));
  ok('one (verb,entity,scope) capability, not one-per-role', approve.length === 1);
  const roles = approve[0].perRole;
  ok('admin=exercised, operator=denied in the SAME row-set', roles.find((r) => r.role === 'admin')?.status === 'exercised' && roles.find((r) => r.role === 'operator')?.status === 'denied');
}

// 8. cross-role-write-differential test target emitted, neutral vocab, why is Evidence (stripped by firewall).
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 403, body: 'forbidden role' }] }] }));
  const tt = m.testTargets.find((t) => t.kind === 'cross-role-write-differential');
  ok('emits a cross-role-write-differential target', !!tt);
  ok('kind is neutral targeting vocab (no bug-class name)', m.testTargets.every((t) => !/privilege|escalation|vuln|bug/i.test(t.kind)));
  // the firewall: the target's addressing serializes with NO evidence key (why never reaches a prompt).
  const surface = toPromptSurface(m.testTargets.map((t): TestTarget => ({ target: `${t.capability.verb}:${t.capability.entity}`, action: 'observe', order: t.order, entity: t.capability.entity, scope: t.capability.scope, kind: t.kind === 'unverified-mutation-probe' ? 'unverified-capability' : t.kind === 'latent-destructive-probe' ? 'unverified-capability' : t.kind, why: (t.why as unknown as string) })));
  ok('testTargets → prompt surface carries NO evidence key', !containsEvidenceKey(surface), JSON.stringify(surface).slice(0, 120));
}

// 9. COMPARABLE requires a POSITIVE differentiator; identical inventory across roles ⇒ not comparable + client-side-gating flag.
{
  // identical: both roles reached same pages, same single GET, both exercised → no differentiator.
  const identical = deriveCapabilityModel(cov({ api: [{ method: 'GET', url: '/api/dash', entity: 'dash', roles: ['admin', 'operator'] }] }));
  ok('identical cross-role capability ⇒ NOT comparable', identical.roleCoverage.comparable === false);
  ok('… and flags possibleClientSideGating', identical.roleCoverage.possibleClientSideGating === true);
  // differing: admin exercised, operator denied → comparable true.
  const differ = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/approve', writes: true, entity: 'order', roles: ['admin'], roleStatuses: [{ role: 'operator', status: 403, body: 'forbidden role' }, { role: 'operator', status: 403, body: 'forbidden role' }] }] }));
  ok('a real cross-role difference ⇒ comparable', differ.roleCoverage.comparable === true);
}

// 10. verb conflict is RECORDED not resolved (label says delete, method POST).
{
  const m = deriveCapabilityModel(cov({ api: [{ method: 'POST', url: '/api/order/:id/nuke', writes: true, firedBy: ['Delete Order'], entity: 'order', roles: ['admin'] }] }));
  const cap = m.capabilities.find((c) => c.verb === 'delete');
  ok('label verb "delete" wins over method POST (human intent)', !!cap && cap.destructive.value === true);
  ok('… and the http/label conflict is recorded', !!cap && !!cap.verbConflict);
}

console.log(`\ncapabilityModel hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
