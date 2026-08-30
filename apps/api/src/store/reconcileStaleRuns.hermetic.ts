/* reconcileStaleRuns.hermetic.ts — locks the pure orphaned-run sweep: only 'running' runs get reconciled, terminal
 * runs are untouched, and the reason names the HARNESS not the app. Run: cd apps/api && npx tsx src/store/reconcileStaleRuns.hermetic.ts
 */
import { planStaleRunReconciliation, INTERRUPTED_DETAIL } from './reconcileStaleRuns';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };
const T = '2026-08-16T00:00:00Z';

const runs = [
  { id: 'orphan1', status: 'running' },                         // ← the 9e41f677 case: crashed, still running
  { id: 'orphan2', status: 'running', startedAt: 'x' },
  { id: 'donePass', status: 'passed', finishedAt: 'y' },        // terminal — leave alone
  { id: 'doneFail', status: 'failed', finishedAt: 'z' },        // terminal — leave alone (e.g. c2c54aee)
  { id: 'weird', status: undefined as any },                    // no status — not 'running', leave alone
];
const plan = planStaleRunReconciliation(runs, T);

ok('reconciles exactly the 2 running runs', plan.length === 2, `got ${plan.length}`);
ok('targets orphan1 + orphan2 (not the terminal ones)', plan.map((p) => p.id).sort().join() === 'orphan1,orphan2', plan.map((p) => p.id).join());
ok('never touches a passed run', !plan.some((p) => p.id === 'donePass'));
ok('never touches an already-failed run', !plan.some((p) => p.id === 'doneFail'));
ok('never touches a status-less run', !plan.some((p) => p.id === 'weird'));

const patch = plan[0].patch;
ok('patch sets status=failed', patch.status === 'failed');
ok('patch sets a finishedAt timestamp', patch.finishedAt === T);
ok('patch flags interrupted:true (distinguishes harness-death from a real failure)', patch.interrupted === true);
ok('reason names the HARNESS not the app (no "app broke" misattribution)', /harness interruption, not a failure of the app/i.test(patch.detail));
ok('reason == the shared INTERRUPTED_DETAIL constant', patch.detail === INTERRUPTED_DETAIL);

// idempotence: re-running on the RESULT (now failed) reconciles nothing.
const afterFirst = runs.map((r) => { const p = plan.find((x) => x.id === r.id); return p ? { ...r, ...p.patch } : r; });
ok('idempotent — a second sweep reconciles 0 (all now terminal)', planStaleRunReconciliation(afterFirst, T).length === 0);

// empty / null safety
ok('empty list → empty plan', planStaleRunReconciliation([], T).length === 0);
ok('null list → empty plan (no throw)', planStaleRunReconciliation(null as any, T).length === 0);

console.log(`\nreconcileStaleRuns hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
