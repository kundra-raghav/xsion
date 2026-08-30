/**
 * Hermetic checks for deriveBugReproResolution — bug-repro's "every verdict → a next action" surface (the
 * entrepreneur-lens loop). The novel kind is `needs-input`: reached the feature but a control didn't match → ask
 * the user which control that step is (stored navigational for run #2), NEVER guess. Run: npx tsx src/brain/bugResolution.hermetic.ts
 */
import { deriveBugReproResolution } from './bugReproService';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

console.log('deriveBugReproResolution checks');

const base = { needsCreds: false, loginWall: false, isSSO: false, stepResults: [] as any[], flowSteps: [] as any[] };

ok('reproduced → file-ticket', deriveBugReproResolution('reproduced', base).kind === 'file-ticket');
ok('not-reproduced → none', deriveBugReproResolution('not-reproduced', base).kind === 'none');
ok('needsCreds → credentials', deriveBugReproResolution('cant-perform', { ...base, needsCreds: true }).kind === 'credentials');
ok('loginWall → credentials', deriveBugReproResolution('cant-perform', { ...base, loginWall: true }).kind === 'credentials');
ok('SSO → unreachable', deriveBugReproResolution('cant-perform', { ...base, isSSO: true }).kind === 'unreachable');

// THE KEY CASE: reached the feature, a control didn't match, candidates ARE present → needs-input with the list.
const stepResults = [
  { stepIndex: 0, status: 'pass' },
  { stepIndex: 1, status: 'fail', note: 'no match for "Save" (best=0). Candidates on page: button:"Set Learning & Schedule" | button:"Select Teachers" | button:"Planning"' },
];
const flowSteps = [{ intent: 'click "NZ Curriculum"' }, { intent: 'click "Save"' }];
const r = deriveBugReproResolution('cant-perform', { ...base, stepResults, flowSteps });
ok('unmatched control WITH candidates → needs-input', r.kind === 'needs-input');
ok('needs-input carries the failing step', r.forStep === 'click "Save"');
ok('needs-input carries the candidate list', !!r.candidates && r.candidates.length === 3 && r.candidates.some((c) => /Set Learning/.test(c)));
ok('needs-input carries a question (no guessing)', !!r.question && /which/i.test(r.question!));

// a fail with NO candidate list (page was empty / nothing there) → NOT needs-input (nothing to pick from).
const emptyFail = [{ stepIndex: 0, status: 'fail', note: 'no match for "X" (best=0). Candidates on page: ' }];
ok('unmatched control with NO candidates → unreachable (not needs-input)', deriveBugReproResolution('cant-perform', { ...base, stepResults: emptyFail, flowSteps: [{ intent: 'click X' }] }).kind === 'unreachable');

// DEGENERATE: only the avatar button rendered (`sc`) → NOT an answerable needs-input (page hadn't hydrated) → unreachable.
const avatarOnly = [{ stepIndex: 0, status: 'fail', note: 'no match for "My Calendar" (best=0). Candidates on page: button:"sc"' }];
ok('only an avatar-initials button → unreachable (not a pickable needs-input)', deriveBugReproResolution('cant-perform', { ...base, stepResults: avatarOnly, flowSteps: [{ intent: 'click "My Calendar"' }] }).kind === 'unreachable');
// but ≥2 REAL controls → needs-input (the answerable case).
const realControls = [{ stepIndex: 0, status: 'fail', note: 'no match for "Save" (best=0). Candidates on page: button:"Set Learning" | button:"sc" | button:"Add New Tag"' }];
ok('≥2 real controls (avatar filtered out) → needs-input', deriveBugReproResolution('cant-perform', { ...base, stepResults: realControls, flowSteps: [{ intent: 'click "Save"' }] }).kind === 'needs-input');

// EVERY verdict yields a resolution (no dead ends)
for (const v of ['reproduced', 'not-reproduced', 'cant-perform', 'inconclusive'] as const) {
  ok(`${v} always yields a resolution kind`, !!deriveBugReproResolution(v, base).kind);
}

// authorize branch: a step skipped-for-authorization → resolution 'authorize' (the approve-to-click button), not unreachable.
{
  const r = deriveBugReproResolution('inconclusive', { needsCreds: false, loginWall: false, isSSO: false,
    stepResults: [{ status: 'unverifiable', note: 'SKIPPED mutating step (not authorized): click "Add to cart"' }], flowSteps: [] });
  ok('skipped-for-auth step → resolution authorize (not unreachable)', r.kind === 'authorize');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
