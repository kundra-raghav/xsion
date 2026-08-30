/**
 * modelRoute.hermetic.ts — per-task SoA model routing precedence. Each bridge task (audit/breakit/…) can route to a
 * different model (measured A/B: Kimi fast enough for breakit's cap, Claude better at code-grounded audit). Precedence:
 * XSION_MODEL_<TASK>  >  SOA_PPLX_MODEL (global pin)  >  '' (bridge's own router = today's default). All unset ⇒ '' ⇒
 * behavior unchanged. Asserted so a future edit can't silently reorder precedence or break the default-is-unchanged
 * guarantee.
 */
import { modelForTask } from './soaClient';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

ok('all unset → "" (default: bridge router, behavior unchanged)', modelForTask('audit', {}) === '');
ok('SOA_PPLX_MODEL (global pin) used when no per-task', modelForTask('breakit', { SOA_PPLX_MODEL: 'perplexity/kimi-k2.7-code' }) === 'perplexity/kimi-k2.7-code');
ok('XSION_MODEL_AUDIT wins over the global pin', modelForTask('audit', { XSION_MODEL_AUDIT: 'anthropic/claude-sonnet-4-5', SOA_PPLX_MODEL: 'perplexity/kimi-k2.7-code' }) === 'anthropic/claude-sonnet-4-5');
ok('per-task is scoped to ITS task (breakit unaffected by XSION_MODEL_AUDIT)', modelForTask('breakit', { XSION_MODEL_AUDIT: 'anthropic/claude-sonnet-4-5' }) === '');
ok('the real target config: audit→sonnet, breakit→(router)', (() => { const env = { XSION_MODEL_AUDIT: 'anthropic/claude-sonnet-4-5' }; return modelForTask('audit', env) === 'anthropic/claude-sonnet-4-5' && modelForTask('breakit', env) === ''; })());
ok('task name normalized (case / punctuation) → XSION_MODEL_BUGREPRO', modelForTask('bugrepro', { XSION_MODEL_BUGREPRO: 'x/y' }) === 'x/y');
ok('whitespace trimmed', modelForTask('audit', { XSION_MODEL_AUDIT: '  a/b  ' }) === 'a/b');

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
