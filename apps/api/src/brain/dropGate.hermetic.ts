/**
 * dropGate.hermetic.ts — the SUBTRACTIVE drop-gate label logic, tested as pure functions (a server crash can never
 * truncate a unit assertion the way it truncates a 3-minute end-to-end run). Covers the bug this fixed: a modal-scoped
 * capture whose union carried an ambient page input ("Search customer…") let a phantom "Overflow Search customer…"
 * survive the drop, because the union — not the modal cohort — was the trusted set.
 */
import { dropLabelSet, stepTargetsLiveField } from './breakItService';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// ── dropLabelSet: modal ⇒ cohort labels; page/undefined ⇒ union labels ──
{
  const union = [{ label: 'Search customer…' }, { label: 'Number' }];          // ambient page inputs captured pre-modal
  const cohort: Array<{ label?: string }> = [];                                 // a FIELD-LESS action modal (Flag presets)
  ok('modal + empty cohort → empty drop set (page inputs excluded)', dropLabelSet('modal', cohort, union).size === 0);
  ok('page scope → union labels used', dropLabelSet('page', cohort, union).has('search customer…'));
  ok('undefined scope → union labels used (safe default)', dropLabelSet(undefined, cohort, union).has('search customer…'));
}
{
  const union = [{ label: 'Search customer…' }, { label: 'Flag reason' }];
  const cohort = [{ label: 'Flag reason' }];                                    // a modal WITH a real field
  const set = dropLabelSet('modal', cohort, union);
  ok('modal + real cohort field → cohort label present', set.has('flag reason'));
  ok('modal + real cohort field → page input EXCLUDED', !set.has('search customer…'));
}

// ── stepTargetsLiveField: keep iff every fill target is live; non-fill always kept ──
{
  const modalSet = dropLabelSet('modal', [], [{ label: 'Search customer…' }]);   // empty (field-less modal)
  const overflowSearch = { title: 'Overflow Search customer…', fields: [{ name: 'search customer…' }] };
  const clickAttack = { title: 'Click action "priority"', fields: [] as Array<{ name?: string }> };
  ok('phantom "Overflow Search customer…" DROPPED on a field-less modal', !stepTargetsLiveField(overflowSearch, modalSet));
  ok('a fieldless click-action attack is KEPT (no fill to miss)', stepTargetsLiveField(clickAttack, modalSet));
}
{
  const pageSet = dropLabelSet('page', [], [{ label: 'Name' }, { label: 'Email' }]);
  ok('legit page attack on a live field is KEPT', stepTargetsLiveField({ fields: [{ name: 'name' }] }, pageSet));
  ok('page attack on an absent field is dropped', !stepTargetsLiveField({ fields: [{ name: 'phone' }] }, pageSet));
  ok('fuzzy: live "flag reason" covers step field "reason"', stepTargetsLiveField({ fields: [{ name: 'reason' }] }, new Set(['flag reason'])));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
