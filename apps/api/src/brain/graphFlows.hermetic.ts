/** graphFlows.hermetic.ts — locks the structural flow derivation. Run: npx tsx src/brain/graphFlows.hermetic.ts */
import { deriveFlows, scopeOfPath } from './graphFlows';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

console.log('graphFlows hermetic:');

// scope extraction
ok('scope from /nzcurriculum/...', scopeOfPath('/nzcurriculum/Teacher/Dashboard') === 'nzcurriculum');
ok('no scope for flat /users', scopeOfPath('/users') === undefined);
ok('login is not a scope', scopeOfPath('/login/foo') === undefined);

const edge = (fromSig: string, to: string, toSig: string, label: string, kind = 'click') =>
  ({ fromSig, toSig, action: { kind, label }, toPath: to, toIsNew: true, count: 1 } as any);

// a 2-step path to a page that fires a mutation → HIGH confidence flow named by capability
const flows = deriveFlows({
  baseUrl: 'https://x',
  edges: [edge('', '/explore', 's1', '/explore', 'navigate'), edge('s1', '/explore › Create Meal Plan', 's2', 'Create Meal Plan')],
  pages: [{ path: '/explore › Create Meal Plan', requirements: [{ kind: 'text', label: 'Plan name', required: true }] } as any],
  api: [{ method: 'POST', url: '/graphql', graphql: true, gqlKind: 'mutation', gqlOperation: 'CreateMealPlan', firstSeenOnPath: '/explore › Create Meal Plan', statuses: [200], count: 1 } as any],
});
const createFlow = flows.find((f) => f.reachesMutation?.capability === 'CreateMealPlan');
ok('mutation path → high-confidence flow', !!createFlow && createFlow.confidence === 'high');
ok('flow named by capability', !!createFlow && createFlow.name.includes('CreateMealPlan'));
ok('flow carries the requirement', !!createFlow && createFlow.requirements.some((r) => r.label === 'Plan name'));
ok('flow chains 2 steps', !!createFlow && createFlow.steps.length === 2);
ok('step names the real control', !!createFlow && createFlow.steps[1].control === 'Create Meal Plan');

// a leaf nav with no mutation, no data → low confidence
const flows2 = deriveFlows({
  baseUrl: 'https://x',
  edges: [edge('', '/about', 'a1', '/about', 'navigate')],
  pages: [{ path: '/about' } as any],
  api: [],
});
ok('bare leaf nav → low confidence', flows2[0]?.confidence === 'low');

// GET api does NOT make a mutation flow
const flows3 = deriveFlows({
  baseUrl: 'https://x',
  edges: [edge('', '/list', 'l1', '/list', 'navigate')],
  pages: [{ path: '/list', contentVolume: 12 } as any],
  api: [{ method: 'GET', url: '/api/list', statuses: [200], count: 1, firstSeenOnPath: '/list' } as any],
});
ok('GET-only data page → medium (not high)', flows3[0]?.confidence === 'medium');

// scoped mutation flow carries its scope
const flows4 = deriveFlows({
  baseUrl: 'https://x',
  edges: [edge('', '/nzcurriculum/Teacher/Calendar', 'c1', '/nzcurriculum/Teacher/Calendar', 'navigate')],
  pages: [{ path: '/nzcurriculum/Teacher/Calendar' } as any],
  api: [{ method: 'POST', url: '/graphql', graphql: true, gqlKind: 'mutation', gqlOperation: 'CreateEvent', firstSeenOnPath: '/nzcurriculum/Teacher/Calendar', statuses: [200], count: 1 } as any],
});
ok('scoped flow carries scope', flows4[0]?.scope === 'nzcurriculum' && flows4[0]?.reachesMutation?.capability === 'CreateEvent');

console.log(`\n${fail === 0 ? '✓' : '✗'} graphFlows: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
