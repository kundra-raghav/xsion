/**
 * cli.coverage.hermetic.ts — proves the `xsion check` exit/coverage decision (the live-dent misleading-summary bug).
 * Run: cd apps/api && npx tsx src/cli.coverage.hermetic.ts
 *
 * The bug this locks: break-it ran every attack against the LOGIN PAGE (nothing landed = all needs-review) and the
 * CLI still printed "✓ Changed flows held. Safe to push." A false "held" is worse than a real bug. These assertions
 * exercise every branch of summarizeCoverage — the code the two offline fixtures (clean/regress) never reach.
 */
import { summarizeCoverage } from './cli';

const F = (verdicts: string[]) => ({ feature: 'f', findings: verdicts.map((v) => ({ verdict: v })) });
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

// 1. a hard break → code 1, "do not push"
{
  const c = summarizeCoverage([F(['broke', 'held'])], true, 0);
  ok('hard break → code 1', c.code === 1);
  ok('hard break kind', c.kind === 'broke');
  ok('do-not-push note', /do not push/.test(c.note));
}

// 2. a status regression (hardBroke true, no broke findings) → code 1, counts the regression
{
  const c = summarizeCoverage([F(['needs-review'])], true, 2);
  ok('status regression → code 1', c.code === 1);
  ok('note mentions status regression', /status regression/.test(c.note), c.note);
}

// 3. ALL needs-review (login-gated) → code 2, NEVER "safe to push" — THE live-dent bug
{
  const c = summarizeCoverage([F(['needs-review', 'needs-review']), F(['needs-review'])], false, 0);
  ok('nothing verified → code 2', c.code === 2, `got ${c.code}`);
  ok('kind nothing-verified', c.kind === 'nothing-verified');
  ok('never says safe to push', !/safe to push/i.test(c.note), c.note);
  ok('unreached counted', c.unreached === 2 && c.noPlan === 0);
}

// 4. no-plan features (zero findings) also → code 2 when nothing else verified (the F5c gap: silently dropped before)
{
  const c = summarizeCoverage([F([]), F([])], false, 0);
  ok('all no-plan → code 2 (not hidden)', c.code === 2, `got ${c.code}`);
  ok('noPlan counted', c.noPlan === 2 && c.unreached === 0);
}

// 5. some verified + a no-plan target → code 0 but the note NAMES the uncovered target (never hidden) — the dent case
{
  const c = summarizeCoverage([F(['held', 'needs-review']), F([])], false, 0);   // users held, plans no-plan
  ok('partial coverage → code 0', c.code === 0, `got ${c.code}`);
  ok('verified=1', c.verified === 1);
  ok('note names the uncovered', /1 target\(s\) NOT verified/.test(c.note) && /1 no-plan/.test(c.note), c.note);
  ok('partial coverage does NOT say "Safe to push."', !/Safe to push\./.test(c.note), c.note);
}

// 6. some verified + an unreached target → code 0, note distinguishes unreached from no-plan
{
  const c = summarizeCoverage([F(['held']), F(['needs-review', 'needs-review'])], false, 0);
  ok('mixed verified+unreached → code 0', c.code === 0);
  ok('note: 1 unreached, 0 no-plan', /1 unreached, 0 no-plan/.test(c.note), c.note);
}

// 7. everything verified & held, nothing uncovered → code 0 AND the clean "Safe to push."
{
  const c = summarizeCoverage([F(['held']), F(['held', 'passed'])], false, 0);
  ok('all held → code 0', c.code === 0);
  ok('all held → Safe to push.', /Safe to push\./.test(c.note), c.note);
  ok('all held → no "NOT verified" caveat', !/NOT verified/.test(c.note));
}

// 8. a passed verdict counts as verified (not just held)
{
  const c = summarizeCoverage([F(['passed', 'needs-review'])], false, 0);
  ok('passed counts as verified', c.code === 0 && c.verified === 1);
}

console.log(`\ncli coverage hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
