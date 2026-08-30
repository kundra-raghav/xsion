/**
 * autonomy.hermetic.ts — the staging-autonomy authorization + destructive-ack defaults. Xsion is staging-only, so the
 * attestation defaults ON (attacks mutate, no waiting to be permitted) — but an EXPLICITLY-SET project flag still wins
 * (a future non-staging target can force it off), and XSION_AUTHORIZED_DEFAULT=0 restores opt-in. Locked so the default
 * can't silently flip and an explicit false can't be overridden by the default.
 */
import { isAuthorized, isDestructiveAcked } from './runtimeGuards';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const withEnv = (k: string, v: string | undefined, fn: () => void) => { const old = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { fn(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } };

// authorization: unset project flag → default ON
withEnv('XSION_AUTHORIZED_DEFAULT', undefined, () => {
  ok('unset project flag → authorized (staging default ON)', isAuthorized({}) === true);
  ok('project with no security → authorized', isAuthorized({ name: 'x' }) === true);
  ok('explicit security.authorized=true → true', isAuthorized({ security: { authorized: true } }) === true);
  ok('explicit security.authorized=FALSE → false (explicit wins over the default)', isAuthorized({ security: { authorized: false } }) === false);
});
// env can restore opt-in
withEnv('XSION_AUTHORIZED_DEFAULT', '0', () => {
  ok('XSION_AUTHORIZED_DEFAULT=0 + unset flag → NOT authorized (opt-in restored)', isAuthorized({}) === false);
  ok('XSION_AUTHORIZED_DEFAULT=0 but explicit true → still authorized (explicit wins)', isAuthorized({ security: { authorized: true } }) === true);
});

// destructive ack: default true, explicit false wins
withEnv('XSION_DESTRUCTIVE_ACK_DEFAULT', undefined, () => {
  ok('ack undefined → true (staging default)', isDestructiveAcked(undefined) === true);
  ok('ack true → true', isDestructiveAcked(true) === true);
  ok('ack FALSE → false (explicit refusal wins)', isDestructiveAcked(false) === false);
});
withEnv('XSION_DESTRUCTIVE_ACK_DEFAULT', '0', () => {
  ok('XSION_DESTRUCTIVE_ACK_DEFAULT=0 + undefined → false', isDestructiveAcked(undefined) === false);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
