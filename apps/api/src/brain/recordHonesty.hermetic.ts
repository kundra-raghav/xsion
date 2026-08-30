/**
 * recordHonesty.hermetic.ts — locks the honest-status invariant that closed the dishonest-green bug class:
 * green ('passed') means "verified working" — it requires zero failures AND something actually ran. A run where
 * nothing executed, or where any unit failed, is NEVER green.
 */
import { honestStatus } from './recordHonesty';

let n = 0, fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  n++;
  if (a !== b) { fails++; console.error(`FAIL: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
}

// any failure → failed, regardless of passes
eq(honestStatus(3, 1, 4), 'failed', '1 fail among 4 → failed');
eq(honestStatus(0, 5, 5), 'failed', 'all fail → failed');
eq(honestStatus(10, 2, 12), 'failed', 'mostly-pass but 2 fail → failed');

// nothing ran → NOT a pass (the green-lie the class was about)
eq(honestStatus(0, 0, 0), 'failed', 'zero ran → failed (green must mean verified, not un-checked)');
eq(honestStatus(0, 0, -1), 'failed', 'negative ran (defensive) → failed');

// clean run with real execution → passed
eq(honestStatus(5, 0, 5), 'passed', 'all pass, ran → passed');
eq(honestStatus(1, 0, 1), 'passed', 'single pass, ran → passed');
// needs-review-only (passed<ran but failed==0, ran>0) still passes — needs-review is not a hard failure
eq(honestStatus(2, 0, 5), 'passed', 'some unverifiable (passed<ran) but 0 fail + ran>0 → passed');

console.log(fails === 0 ? `recordHonesty hermetic: ${n}/${n} PASS` : `recordHonesty hermetic: ${n - fails}/${n} (${fails} FAIL)`);
if (fails) process.exit(1);
