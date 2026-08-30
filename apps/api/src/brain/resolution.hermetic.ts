/**
 * Hermetic checks for deriveResolution — the "every finding → a next action" mapping (the entrepreneur-lens fix:
 * a verdict must never be a dead end; it carries WHAT THE USER DOES NEXT). Run: npx tsx src/brain/resolution.hermetic.ts
 */
import { deriveResolution, BreakFinding } from './breakItService';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }
const f = (verdict: any, detail: string, expectBroke?: string): BreakFinding => ({ phase: 'x', title: 't', verdict, detail, expectBroke });

console.log('deriveResolution checks');

// broke → file a ticket (durable artifact)
ok('broke → file-ticket', deriveResolution(f('broke', 'matched the BROKE oracle')).kind === 'file-ticket');
// held/passed → nothing to do, keep the passing spec
ok('held → none', deriveResolution(f('held', 'the app rejected the bad input')).kind === 'none');
ok('passed → none', deriveResolution(f('passed', 'completed as expected')).kind === 'none');
ok('skipped → unreachable', deriveResolution(f('skipped', 'destructive')).kind === 'unreachable');

// needs-review CAUSES → the right control:
ok('unauthorized mutation → authorize', deriveResolution(f('needs-review', 'mutating step — needs the "I own/authorize this target" attestation to run live')).kind === 'authorize');
ok('login wall → credentials', deriveResolution(f('needs-review', 'the app showed a SIGN-IN screen, so the feature under test was never reached (the tester session isn\'t authenticated)')).kind === 'credentials');
ok('endpoint not observed → unreachable', deriveResolution(f('needs-review', 'API attack not probed — no crawl-observed POST endpoint matches "/api/x"')).kind === 'unreachable');
ok('assumed endpoint → unreachable', deriveResolution(f('needs-review', 'endpoint was ASSUMED by the planner, not observed')).kind === 'unreachable');
ok('no step executed → unreachable', deriveResolution(f('needs-review', 'couldn\'t run this attack — no step executed against the app')).kind === 'unreachable');
ok('couldn\'t drive form → unreachable', deriveResolution(f('needs-review', 'couldn\'t drive the form to run this attack (0/2 fields filled)')).kind === 'unreachable');

// ambiguous outcome the app actually produced → the teach-the-oracle QUESTION (acceptIsDefect)
const amb = deriveResolution(f('needs-review', 'inconclusive — neither a clear rejection nor a clear accept', 'Event created with empty title'));
ok('ambiguous → answer-oracle', amb.kind === 'answer-oracle');
ok('answer-oracle carries a yes/no QUESTION', !!amb.question && /bug/i.test(amb.question!), amb.question);

// CAUSE-FIRST (authoritative, not prose): the branch's `cause` wins over any string in `detail`.
const withCause = (cause: any, detail = 'unrelated prose'): BreakFinding => ({ phase: 'x', title: 't', verdict: 'needs-review', detail, cause });
ok('cause=authorize wins over prose', deriveResolution(withCause('authorize')).kind === 'authorize');
ok('cause=credentials wins over prose', deriveResolution(withCause('credentials')).kind === 'credentials');
ok('cause=unreachable wins over prose', deriveResolution(withCause('unreachable')).kind === 'unreachable');
ok('cause=answer-oracle → question', deriveResolution({ ...withCause('answer-oracle'), expectBroke: 'X happened' }).question?.includes('X happened') === true);
ok('a reworded detail does NOT flip a caused finding', deriveResolution(withCause('authorize', 'totally different wording that mentions login and sign-in')).kind === 'authorize');

// EVERY verdict yields a resolution (no dead ends — the whole point)
for (const v of ['broke', 'held', 'passed', 'skipped', 'needs-review'] as const) {
  ok(`${v} always yields a resolution kind`, !!deriveResolution(f(v, 'some detail')).kind);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
