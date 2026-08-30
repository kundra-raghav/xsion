/* reconcileStaleRuns.ts — STARTUP RECONCILIATION for orphaned runs.
 *
 * THE BUG this fixes: a testRun is created with status:'running', and the engine marks it 'passed'/'failed' on
 * completion via a .catch() handler. But if the WHOLE PROCESS dies mid-run (e.g. `EADDRINUSE :::4000` on a tsx-watch
 * restart, an OOM kill, a hard crash), no in-process handler can ever fire — the record stays 'running' FOREVER,
 * with 0 artifacts, lying about a run that is no longer executing. That's the "green-lie" inverted: a dead run that
 * reports in-progress.
 *
 * THE FIX (advisor): in-memory execution state (timers, browsers, promises) does NOT survive a restart. Therefore
 * ANY run still marked 'running' at the moment the store loads is BY DEFINITION orphaned — nothing is driving it.
 * So we reconcile ALL of them unconditionally (no age heuristic — an age window would just let a genuinely-dead run
 * keep lying for a while). Mark them failed + interrupted, with an HONEST reason that names the HARNESS, not the app
 * (a bare 'failed' misreads as "the target app broke" — the exact misattribution class we keep fixing).
 *
 * SCOPE: only testRuns. Crawls persist progressively and carry their own status ('crawling'/'done'/'bounded') on the
 * projectMap, NOT on testRuns — a killed crawl leaves a usable partial map we must NOT trash. (Verified: crawl paths
 * never call createTestRun.) This sweep touches testRuns only.
 */

export interface ReconcilableRun { id: string; status?: string; finishedAt?: string | null; [k: string]: any }

export const INTERRUPTED_DETAIL =
  'Run did not complete — the server process restarted or died mid-run, so no results were recorded. This is a harness interruption, not a failure of the app under test. Re-run to get a real verdict.';

/** PURE: given the current runs + a timestamp, return the set of updates to apply (id → patch). A run is stale iff
 *  its status is 'running' (in-flight per the record) — since in-memory drivers don't survive a restart, that's
 *  always orphaned at load time. Already-terminal runs (passed/failed/etc.) are left untouched. */
export function planStaleRunReconciliation(
  runs: ReconcilableRun[],
  now: string,
): Array<{ id: string; patch: { status: 'failed'; finishedAt: string; interrupted: true; detail: string } }> {
  const out: Array<{ id: string; patch: any }> = [];
  for (const r of runs || []) {
    if (r && r.status === 'running') {
      out.push({ id: r.id, patch: { status: 'failed', finishedAt: now, interrupted: true, detail: INTERRUPTED_DETAIL } });
    }
  }
  return out;
}
