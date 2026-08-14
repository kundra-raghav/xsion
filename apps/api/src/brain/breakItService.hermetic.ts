/**
 * Hermetic checks for the break-it verdict floor — no browser, no LLM, no network.
 * Covers exactly the paths that produced the false-positive flood the mission surfaced:
 *   1. api-phase step → needs-review (never runs as a UI fill), oracle preserved verbatim.
 *   2. mutating step without consent → needs-review, oracle preserved.
 * Run: npx tsx src/brain/breakItService.hermetic.ts
 */
import { runStep, BreakFinding } from './breakItService';
import { BreakStep } from './soaClient';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

const oracle = { expectHeld: 'HTTP 400 rejecting the bad payload', expectBroke: 'HTTP 201 accepting invalid data' };
function step(over: Partial<BreakStep>): BreakStep {
  return { phase: 'adversarial', title: 't', intent: 'do it', fields: [], acceptIsDefect: false, value: '', apiHint: '', codeRef: null, ...oracle, ...over } as BreakStep;
}

async function main() {
  console.log('break-it hermetic verdict-floor checks');

  // 1. api phase → needs-review, oracle verbatim, and NEVER broke/held (it must not run as a UI fill)
  const api: BreakFinding = await runStep('run-x', 'http://localhost:1', step({ phase: 'api', apiHint: 'POST createEvent' }), 'MK', true, { repo: '', feature: 'f' });
  ok('api-phase → needs-review', api.verdict === 'needs-review', `got ${api.verdict}`);
  ok('api-phase detail carries expectHeld verbatim', api.detail.includes(oracle.expectHeld));
  ok('api-phase detail carries expectBroke verbatim', api.detail.includes(oracle.expectBroke));
  ok('api-phase detail carries apiHint', api.detail.includes('POST createEvent'));
  ok('api-phase is never a broke/held on the UI path', api.verdict !== 'broke' && api.verdict !== 'held');

  // 2. mutating step without authorization → needs-review, oracle verbatim (pre-existing consent gate, kept intact)
  const noAuth: BreakFinding = await runStep('run-x', 'http://localhost:1', step({ phase: 'crud', title: 'delete the event', intent: 'delete the event' }), 'MK', false, { repo: '', feature: 'f' });
  ok('mutating + no consent → needs-review', noAuth.verdict === 'needs-review', `got ${noAuth.verdict}`);
  ok('no-consent detail carries the oracle', noAuth.detail.includes(oracle.expectHeld) && noAuth.detail.includes(oracle.expectBroke));

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
