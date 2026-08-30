/**
 * Hermetic checks for rollupActions — mission-level "next actions" (the entrepreneur-lens loop at mission scope).
 * A mission aggregates every sub-run's resolutions so it ends with WHAT TO DO NEXT, not a summary dead-end.
 * Run: npx tsx src/brain/missionRollup.hermetic.ts
 */
import { rollupActions } from './missionService';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

console.log('rollupActions checks');

// a mission with a break-it step (findings array) + a bug-repro step (artifact object)
const steps = [
  { engine: 'break-it', findings: [
    { verdict: 'broke', resolution: { kind: 'file-ticket' } },
    { verdict: 'broke', resolution: { kind: 'file-ticket' } },
    { verdict: 'needs-review', resolution: { kind: 'answer-oracle' } },
    { verdict: 'held', resolution: { kind: 'none' } },        // 'none' must NOT count as an action
  ] },
  { engine: 'bug-repro', findings: { verdict: 'cant-perform', resolution: { kind: 'needs-input' } } },
];
const actions = rollupActions(steps);
const byKind = Object.fromEntries(actions.map((a) => [a.kind, a.count]));

ok('rolls up file-ticket count', byKind['file-ticket'] === 2);
ok('rolls up answer-oracle count', byKind['answer-oracle'] === 1);
ok('rolls up bug-repro needs-input', byKind['needs-input'] === 1);
ok('does NOT count "none" (a clean hold is not an action)', !('none' in byKind));
ok('each action has a human label', actions.every((a) => !!a.label && /\d×/.test(a.label)));

// empty / all-clean mission → no actions (nothing to do — the honest empty state)
ok('all-held mission → no actions', rollupActions([{ engine: 'break-it', findings: [{ verdict: 'held', resolution: { kind: 'none' } }] }]).length === 0);
ok('empty mission → no actions', rollupActions([]).length === 0);
ok('a step with no findings → no crash', rollupActions([{ engine: 'flow' }]).length === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
