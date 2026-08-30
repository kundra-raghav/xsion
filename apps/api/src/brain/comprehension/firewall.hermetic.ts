/**
 * firewall.hermetic.ts — THE non-negotiable test (design §4): assert the comprehension→prompt serializer emits NO
 * evidence-typed field, so interpretation can never launder into a verdict through an LLM prompt. Pure, no browser.
 * Run: cd apps/api && npx tsx src/brain/comprehension/firewall.hermetic.ts
 */
import { toPromptSurface, containsEvidenceKey, EVIDENCE_FIELDS, type TestTarget } from './firewall';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

// A target carrying a heavy, verdict-shaped `why` (the exact thing that must NOT reach a prompt).
const targets: TestTarget[] = [
  {
    target: 'nav:Users', action: 'click', order: 1, entity: 'user', scope: '/admin',
    kind: 'cross-role-write-differential',
    why: 'operator got 403 on delete(user); admin succeeded — probe whether operator delete is enforced server-side (statusCodes:[403])',
  },
  {
    target: 'combo:status', action: 'select', order: 2, entity: 'order',
    kind: 'state-transition',
    why: 'order status enum {draft,approved}; app rendered archived — CODE SAYS X / APP DID Y',
  },
];

const surface = toPromptSurface(targets);

// 1. The serializer output carries the ADDRESSING fields (so the planner can actually target).
ok('surface keeps addressing fields', surface[0].target === 'nav:Users' && surface[0].action === 'click' && surface[0].kind === 'cross-role-write-differential' && surface[0].entity === 'user');

// 2. THE FIREWALL: no evidence key survives — not `why`, not any evidence-named field, at any depth.
ok('serializer output contains NO evidence key', !containsEvidenceKey(surface), 'leaked: ' + JSON.stringify(surface));
for (const f of EVIDENCE_FIELDS) {
  ok(`evidence field "${f}" absent from every surface item`, surface.every((s) => !(f in (s as any))));
}

// 3. Even the raw INPUT targets carry `why` (proving the test isn't vacuous — the serializer is what strips it).
ok('raw targets DO carry the evidence `why` (serializer is the barrier, not the input)', containsEvidenceKey(targets));

// 4. `kind` uses neutral targeting vocab, never a bug-class verdict name.
ok('kind is neutral targeting vocab, not a bug-class name', surface.every((s) => !/privilege-escalation|vulnerability|bug|broke|fail/i.test(String(s.kind))));

// 5. Stringifying the surface (what the prompt actually does) never emits the evidence prose.
{
  const asPrompt = JSON.stringify(surface);
  ok('stringified surface does not contain the 403/CODE-SAYS evidence prose', !/403|archived|enforced server-side|CODE SAYS/i.test(asPrompt), asPrompt.slice(0, 120));
}

// 6. A future evidence-shaped field added to a target (not in the allowlist) is excluded by DEFAULT (safe direction).
{
  const rogue: any = { target: 'x', action: 'click', order: 9, kind: 'coverage-gap', observedDelta: 'rows 11→54', rationale: 'looks broken' };
  const out = toPromptSurface([rogue]);
  ok('unlisted evidence-shaped fields excluded by default', !containsEvidenceKey(out) && !('observedDelta' in (out[0] as any)) && !('rationale' in (out[0] as any)));
}

console.log(`\nfirewall hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
