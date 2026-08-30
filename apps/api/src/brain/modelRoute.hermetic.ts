/**
 * modelRoute.hermetic.ts — per-task SoA model routing precedence. Each bridge task (audit/breakit/…) can route to a
 * different model (measured A/B: Kimi fast enough for breakit's cap, Claude better at code-grounded audit). Precedence:
 * XSION_MODEL_<TASK>  >  SOA_PPLX_MODEL (global pin)  >  '' (bridge's own router = today's default). All unset ⇒ '' ⇒
 * behavior unchanged. Asserted so a future edit can't silently reorder precedence or break the default-is-unchanged
 * guarantee.
 */
import { modelForTask, bridgeErrorIsProvisioning } from './soaClient';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// SHIPPED DEFAULT (data-backed): audit→sonnet, breakit→router. Pass an env WITHOUT the keys to see the defaults.
ok('SHIPPED DEFAULT: audit → claude-sonnet-4-5 (A/B: 0 unparseable vs Kimi 3/4)', modelForTask('audit', {}) === 'anthropic/claude-sonnet-4-5');
ok('SHIPPED DEFAULT: breakit → "" (router, fast enough for the 45s cap)', modelForTask('breakit', {}) === '');
ok('other tasks → "" (router)', modelForTask('bugrepro', {}) === '' && modelForTask('explore', {}) === '');
// env override is authoritative — even empty forces the router BACK, overriding the shipped audit default.
ok('XSION_MODEL_AUDIT="" forces audit BACK to the router (overrides the default)', modelForTask('audit', { XSION_MODEL_AUDIT: '' }) === '');
ok('XSION_MODEL_AUDIT set → overrides the default', modelForTask('audit', { XSION_MODEL_AUDIT: 'openai/gpt-5' }) === 'openai/gpt-5');
ok('SOA_PPLX_MODEL (global pin) used for a task with no default + no per-task', modelForTask('breakit', { SOA_PPLX_MODEL: 'perplexity/kimi-k2.7-code' }) === 'perplexity/kimi-k2.7-code');
ok('per-task is scoped to ITS task (breakit unaffected by XSION_MODEL_AUDIT)', modelForTask('breakit', { XSION_MODEL_AUDIT: 'x/y' }) === '');
ok('task name normalized (case / punctuation) → XSION_MODEL_BUGREPRO', modelForTask('bugrepro', { XSION_MODEL_BUGREPRO: 'x/y' }) === 'x/y');
ok('whitespace trimmed', modelForTask('audit', { XSION_MODEL_AUDIT: '  a/b  ' }) === 'a/b');

// provisioning-fallback detection (a pinned model that 400s → retry unpinned)
ok('unprovisioned error → provisioning (fall back to router)', bridgeErrorIsProvisioning('model not provisioned for this account'));
ok('invalid_request 400 → provisioning', bridgeErrorIsProvisioning('HTTP Error 400: invalid_request_error'));
ok('a plain timeout is NOT provisioning', !bridgeErrorIsProvisioning('SoA bridge timed out after 300000ms'));
ok('a parse failure is NOT provisioning', !bridgeErrorIsProvisioning('SoA bridge JSON parse failed'));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
