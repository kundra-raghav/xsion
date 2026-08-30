/**
 * soaRetry.hermetic.ts — the SoA-bridge retry DECISION as a pure function. The bridge is an LLM behind a subprocess
 * that intermittently emits no/unparseable JSON (the shared root of audit's 6/4/0 drift, bug-repro's "reply not valid
 * JSON", goal's dead steps). We retry ONLY those shapes — never a timeout (would double a 300s wait), never a spawn
 * failure, and CRUCIALLY never a valid-but-empty response (that's a legitimate "found nothing", e.g. auditPlan's 0
 * probes which the audit guard correctly reports; retrying it would re-break that guard + churn cost). Keyed on the
 * ERROR shape, so a parsed empty array never even reaches this decision — asserted here so a future edit can't regress it.
 */
import { bridgeErrorIsRetryable } from './soaClient';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// RETRYABLE — transient serialization hiccups a fresh call clears
ok('no JSON produced → retry', bridgeErrorIsRetryable('SoA bridge produced no JSON (exit 0). stderr: ...'));
ok('JSON parse failed → retry', bridgeErrorIsRetryable('SoA bridge JSON parse failed: Unexpected token. Got: <html>...'));

// NOT retryable — a second attempt can't help / would waste a long wait
ok('timeout → NO retry (would double a 300s wait)', !bridgeErrorIsRetryable('SoA bridge timed out after 300000ms (args: audit)'));
ok('spawn failure → NO retry (environment, not transient)', !bridgeErrorIsRetryable('Failed to spawn SoA bridge: ENOENT'));

// GUARD: a "no JSON" that is ALSO a timeout must NOT retry (the timeout dominates)
ok('no-JSON-on-timeout → NO retry (timeout dominates)', !bridgeErrorIsRetryable('SoA bridge produced no JSON (exit null). timed out after 300000ms'));

// CONTRACT: the decision keys on ERROR text only. A VALID empty response never throws, so it never reaches this
// function — meaning an empty auditPlan (0 probes, a real "found nothing") is never retried. Assert the negative shape.
ok('a non-error / empty string is NOT retryable (only real bridge errors are)', !bridgeErrorIsRetryable(''));
ok('an unrelated error is NOT retryable', !bridgeErrorIsRetryable('some other failure'));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
