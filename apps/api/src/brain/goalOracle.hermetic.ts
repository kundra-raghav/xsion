/**
 * goalOracle.hermetic.ts — the goal walk-off "reached by observed effect" predicate. A goal with no verify node
 * ("flag X and confirm it saved") used to STOP even when the action committed a real persisted write. This oracle
 * turns those stops into honest successes — so its FAILURE MODE IS A FAKE PASS, which is why it's tested hard here,
 * especially the apply-then-revert case (torture's 12% 500-that-rolls-back must NOT read as reached).
 */
import { goalReachedByEffect } from './intentRunner';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const P = (hash: string, bytes: number) => ({ rowCount: 0, domSig: '', storageHash: hash, storageBytes: bytes, textLen: 0 });

// PERSISTED write → reached (storage changed AND survived reload)
ok('storage changed + survived reload → REACHED (storage-persisted)', goalReachedByEffect(P('a', 100), P('b', 150), P('b', 150), false).reached === true);
ok('  ...via storage-persisted', goalReachedByEffect(P('a', 100), P('b', 150), P('b', 150), false).via === 'storage-persisted');

// APPLY-THEN-REVERT → NOT reached (the critical false-pass guard)
ok('storage changed but REVERTED on reload → NOT reached (apply-then-fail)', goalReachedByEffect(P('a', 100), P('b', 150), P('a', 100), false).reached === false);

// no storage change at all → NOT reached (unless an HTTP write corroborates)
ok('no storage change, no http write → NOT reached', goalReachedByEffect(P('a', 100), P('a', 100), P('a', 100), false).reached === false);

// HTTP confirming write → reached even with no storage signal (real-app backend case)
ok('confirming HTTP write → REACHED (http-write)', goalReachedByEffect(P('a', 100), P('a', 100), P('a', 100), true).reached === true);
ok('  ...via http-write', goalReachedByEffect(P('a', 100), P('a', 100), P('a', 100), true).via === 'http-write');

// storage-persisted takes precedence over / coexists with http-write (both true → still reached, storage wins the via)
ok('both signals → reached (storage-persisted wins the via)', goalReachedByEffect(P('a', 100), P('b', 200), P('b', 200), true).via === 'storage-persisted');

// missing probes (couldn't snapshot) fall back to http-write only
ok('null probes + http write → reached via http', goalReachedByEffect(null, null, null, true).reached === true);
ok('null probes + no http write → NOT reached (no evidence)', goalReachedByEffect(null, null, null, false).reached === false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
