/**
 * appliedFailure.hermetic.ts — the "applied-despite-failure" BROKE oracle. An app that says the action FAILED but
 * whose write PERSISTED anyway lied and left the data changed (torture's api() applied-anyway-500 — the nastiest real
 * bug). This rule MINTS brokes, so a false positive burns the moat: it must fire ONLY when a real committed write
 * coincides with a failure signal, and NEVER on a clean accept (persisted + no failure = held).
 */
import { brokeOnApplyDespiteFailure } from './breakItService';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// THE BUG: failure toast + persisted write → BROKE
ok('"(500)" toast + persisted → BROKE', brokeOnApplyDespiteFailure('Something went wrong (500). Please retry.', false, true) === true);
ok('"Failed (500)" + persisted → BROKE', brokeOnApplyDespiteFailure('Failed (500)', false, true) === true);
ok('a rendered 5xx/stack + persisted → BROKE', brokeOnApplyDespiteFailure('', true, true) === true);
ok('"could not save" + persisted → BROKE', brokeOnApplyDespiteFailure('The record could not be saved', false, true) === true);

// THE GUARD (the moat): a CLEAN accept must NOT broke
ok('persisted, NO failure signal → NOT broke (that is a clean accept = held)', brokeOnApplyDespiteFailure('Saved successfully', false, true) === false);
ok('persisted, empty observed text → NOT broke', brokeOnApplyDespiteFailure('', false, true) === false);

// NO committed write ⇒ never broke (a failure toast with NO persist is an honest rejection)
ok('failure toast but NOT persisted → NOT broke (honest rejection)', brokeOnApplyDespiteFailure('Failed (500)', false, false) === false);
ok('5xx but NOT persisted → NOT broke (the write really did fail)', brokeOnApplyDespiteFailure('', true, false) === false);

// success words must not accidentally match the failure regex
ok('"created successfully" (success) → NOT broke', brokeOnApplyDespiteFailure('Event created successfully', false, true) === false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
