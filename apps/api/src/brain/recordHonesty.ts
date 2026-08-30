/**
 * recordHonesty.ts — the two record-writing invariants EVERY engine must obey, in one place. The recurring bug
 * class this closes: (1) a catch-handler wrote a bare `status:'failed'` with no artifact → the user opened the run
 * and saw a blank `{}` instead of WHY it failed; (2) a terminal path wrote `status:'passed'` when steps actually
 * failed (or nothing ran) → dishonest green in the runs list. Both are the same sin: the record must never lie
 * about what happened.
 *
 * These are helpers, not a forced funnel — each engine keeps its own rich artifact shape and calls these only for
 * the two spots the whole class lives in (the error catch, and the pass/fail decision).
 */
import { store } from '../store';

/** HONEST STATUS: 'passed' only when nothing failed AND something actually ran; 'failed' if any failure; a run where
 *  zero units executed is NOT a pass (green must mean "verified working", never "we didn't check"). */
export function honestStatus(passed: number, failed: number, ran: number): 'passed' | 'failed' {
  if (failed > 0) return 'failed';
  if (ran <= 0) return 'failed'; // nothing executed → not a pass (the caller supplies an artifact explaining why)
  return 'passed';
}

/** ERROR RECORD: persist the failure INTO an artifact so the opened run shows the reason, never a blank {}.
 *  `kind` matches the engine's own artifact kind so the UI renders it the same way a normal record renders. */
export function recordError(runId: string, kind: string, e: unknown, detailPrefix = 'The run could not complete') {
  const msg = String((e as any)?.message || e).slice(0, 400);
  store.updateTestRun(runId, {
    status: 'failed', finishedAt: new Date().toISOString(),
    artifacts: [{ kind, error: msg, results: [], detail: `${detailPrefix}: ${msg}`, resolution: { kind: 'needs-input', question: 'The run errored — retry, or check the app is reachable and the creds are set?' } } as any],
  } as any);
}
