/**
 * index.hermetic.ts — locks the ASSEMBLER: it runs all 4 facets over a ProjectMap-shaped input, the adapter copies
 * fields faithfully, Facet-4 reconciliation wires in, and the emitted promptSurface is FIREWALL-CLEAN (the seam that
 * matters — a leak here is interpretation reaching an LLM as a verdict).
 * Run: cd apps/api && npx tsx src/brain/comprehension/index.hermetic.ts
 */
import { deriveComprehension, type CompInputMap } from './index';
import { containsEvidenceKey } from './firewall';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const NOW = '2026-08-29T00:00:00Z';

// a realistic 2-role map with a real API surface + a denial + affordances.
const map: CompInputMap = {
  baseUrl: 'https://app.example.com',
  crawledAt: NOW,
  roles: [{ id: 'admin' }, { id: 'operator' }],
  routeManifest: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i })),
  pages: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i, roles: ['admin', 'operator'], affordanceInventory: i === 0 ? [{ label: 'Delete Order', kind: 'guarded' as const }] : [] })),
  api: [
    { method: 'GET', url: '/api/order/:id', respFields: ['id', 'customer', 'orderStatus'], entity: 'order', roles: ['admin', 'operator'] },
    { method: 'POST', url: '/api/order/:id/approve', writes: true, firedBy: ['Approve'], entity: 'order', roles: ['admin'] },
    { method: 'DELETE', url: '/api/order/:id', writes: true, entity: 'order', roles: ['admin'] },
  ],
};

const cm = deriveComprehension(map, { now: NOW });

// 1. all four facets ran and are present.
ok('entity facet present', !!cm.entity && Array.isArray(cm.entity.entities));
ok('capability facet present', !!cm.capability && Array.isArray(cm.capability.capabilities));
ok('effect facet present', !!cm.effect && typeof cm.effect.applicability === 'string');
ok('code facet present (blackbox, no source)', !!cm.code && cm.code.parsed === false);

// 2. the adapter copied fields → real derivation happened (not empty).
ok('entities derived from the copied api', cm.entity.entities.some((e) => e.canonical === 'order'));
ok('capabilities derived (incl the destructive DELETE)', cm.capability.capabilities.some((c) => c.verb === 'delete' && c.destructive.value === true));
ok('state key detected via copied respFields (orderStatus)', cm.entity.entities.some((e) => e.stateMachine.kind === 'stateful-values-unknown'));

// 3. sourceMapCrawledAt threaded through (stale-substrate honesty).
ok('stamps sourceMapCrawledAt from the map', cm.sourceMapCrawledAt === NOW);

// 4. THE SEAM: promptSurface is firewall-clean — NO evidence key, even though capability.testTargets carry `why`.
ok('capability facet DID produce test targets with evidence why (test not vacuous)', cm.capability.testTargets.length > 0 && cm.capability.testTargets.some((t) => !!t.why));
ok('promptSurface contains NO evidence key (the firewall holds through the assembler)', !containsEvidenceKey(cm.promptSurface), JSON.stringify(cm.promptSurface).slice(0, 160));
ok('promptSurface items carry addressing (target/kind), never a why', cm.promptSurface.every((s) => 'target' in s && 'kind' in s && !('why' in (s as any))));
ok('promptSurface kind is neutral vocab (no bug-class name)', cm.promptSurface.every((s) => !/privilege|escalation|vuln|bug|broke/i.test(String((s as any).kind))));

// 4b. RANKING + JUNK-FILTER of the prompt surface (advisor: don't ship unranked noise into the planner prompt).
{
  const noisy: CompInputMap = {
    roles: [{ id: 'admin' }, { id: 'operator' }],
    routeManifest: Array.from({ length: 9 }, (_, i) => ({ path: '/p' + i })),
    pages: Array.from({ length: 9 }, (_, i) => ({
      path: '/p' + i, roles: ['admin', 'operator'],
      affordanceInventory: i === 0
        ? [{ label: 'Delete all orders', kind: 'guarded' as const }, { label: 'View report', kind: 'action' as const }, { label: '+', kind: 'action' as const }, { label: '@admin', kind: 'action' as const }]
        : [{ label: 'Reset database', kind: 'guarded' as const }],
    })),
    api: [{ method: 'GET', url: '/api/order', entity: 'order', roles: ['admin', 'operator'], respFields: ['id'] }],
  };
  const c = deriveComprehension(noisy, { now: NOW });
  const ents = c.promptSurface.map((s) => (s as any).entity);
  ok('junk entities filtered from the surface (no "+", "@admin", single-char)', !ents.some((e) => e === '+' || e === '@admin' || (e || '').length <= 2));
  ok('a latent-destructive probe (delete/reset) is ranked at the TOP (order 0)', c.promptSurface.length > 0 && /delete|reset|purge/i.test(String((c.promptSurface[0] as any).target)));
  ok('order field is the RANK (monotonic from 0), not the derivation counter', c.promptSurface.every((s, i) => (s as any).order === i));
  const keys = c.promptSurface.map((s) => `${(s as any).target}::${(s as any).kind}`);
  ok('surface is deduped', new Set(keys).size === keys.length);
}

// 4c. prioritizeAttacks (firewall §1: ORDER only): reorders by rank, WITHIN phase groups, same steps out, no verdict touched.
{
  const { prioritizeAttacks } = require('./index');
  // steps across two phases; field labels reference entities the surface ranks.
  const steps = [
    { phase: 'happy', title: 'baseline', fields: [{ name: 'customer' }] },
    { phase: 'adversarial', title: 'attack tag', fields: [{ name: 'tag label' }] },       // low priority
    { phase: 'adversarial', title: 'attack order', fields: [{ name: 'order status' }] },   // high priority (order is #0)
    { phase: 'adversarial', title: 'attack misc', fields: [{ name: 'note' }] },            // unranked
  ];
  const surface = [{ order: 0, target: 'delete:order', entity: 'order' }, { order: 5, target: 'view:tag', entity: 'tag' }];
  const out = prioritizeAttacks(steps, surface, (s: any) => s.fields.map((f: any) => f.name), (s: any) => s.phase);
  ok('same number of steps out (nothing dropped/added)', out.length === steps.length);
  ok('same SET of titles (reorder, not rewrite)', new Set(out.map((s: any) => s.title)).size === 4 && out.every((s: any) => steps.find((o) => o.title === s.title)));
  ok('phase grouping preserved (happy still before any adversarial)', out.findIndex((s: any) => s.phase === 'happy') < out.findIndex((s: any) => s.phase === 'adversarial'));
  const adv = out.filter((s: any) => s.phase === 'adversarial').map((s: any) => s.title);
  ok('within adversarial, the high-ranked (order) attack runs before the low-ranked (tag)', adv.indexOf('attack order') < adv.indexOf('attack tag'));
  ok('unranked step sinks to the end of its phase (stable, not dropped)', adv[adv.length - 1] === 'attack misc');
  // firewall: prioritize NEVER reads or sets a verdict field — the steps have none, and it only reorders.
  ok('no step gained an oracle/verdict field', out.every((s: any) => !('acceptIsDefect' in s) && !('verdict' in s)));
}

// 5. FACET 4 wiring: with source, code parses + reconciles against observed state.
{
  const src = `const ORDER_STATUS = ['draft','approved','shipped']; if (user.role === 'admin') {}`;
  const withCode = deriveComprehension(map, { now: NOW, source: src, sourceFile: 'app.js' });
  ok('source supplied → code facet parses', withCode.code.parsed === true && withCode.code.stateEnums.length === 1);
  ok('reconciliation runs when code enums exist', !!withCode.codeReconciled && withCode.codeReconciled.enums.length === 1);
}

console.log(`\nindex (assembler) hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
