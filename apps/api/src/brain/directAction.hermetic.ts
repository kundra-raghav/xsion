/**
 * directAction.hermetic.ts — feature-surface shape after the capture-probe's opener click. A MODAL feature (Flag)
 * opens a dialog and does not persist; a DIRECT ROW-ACTION (Approve/Allocate) mutates on click and opens no modal; a
 * direct action has no form to attack (its scraped crawl fields must be cleared). The 'unknown' case is the safety
 * guard — never clear a genuine form feature's fields just because it wasn't reached.
 */
import { directActionSurface } from './breakItService';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

ok('modal opened → "modal" (Flag)', directActionSurface(true, false) === 'modal');
ok('modal opened AND persisted → "modal" (modal wins; a modal that also wrote is still a modal)', directActionSurface(true, true) === 'modal');
ok('no modal, click PERSISTED → "direct-action" (Approve/Allocate)', directActionSurface(false, true) === 'direct-action');
ok('no modal, no persist → "unknown" (GUARD: do NOT clear a form feature we simply did not reach)', directActionSurface(false, false) === 'unknown');

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
