/**
 * planDedup.hermetic.ts — single-source plan de-dup. Two generators (deterministic scaffold + live-page regeneration,
 * or a future capture-probe) both append to one plan; without a shared dedup they produced duplicate attacks (the
 * duplicate "manual-review" that reverted the probe). dedupeByTitle keeps the FIRST of each title, order-stable — the
 * prerequisite the probe re-add needs, tested here so it can't regress.
 */
import { dedupeByTitle } from './breakItService';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// keeps first of a duplicate title
{
  const out = dedupeByTitle([{ title: 'Click action "manual-review"', id: 1 }, { title: 'Click action "priority"', id: 2 }, { title: 'Click action "manual-review"', id: 3 }]);
  ok('duplicate title dropped (2 unique of 3)', out.length === 2);
  ok('FIRST occurrence kept (id 1, not 3)', out[0].id === 1 && !out.some((s: any) => s.id === 3));
  ok('order stable', out[0].title.includes('manual-review') && out[1].title.includes('priority'));
}
// case-insensitive
ok('case-insensitive de-dup', dedupeByTitle([{ title: 'Overflow X' }, { title: 'overflow x' }]).length === 1);
// no titles / empty
ok('untitled steps all kept (no false collapse on empty title)', dedupeByTitle([{ title: '' }, { title: '' }, {}]).length === 3);
ok('empty input → empty output', dedupeByTitle([]).length === 0);
// the real shape: prefix (already-run) + addition (regenerated) sharing a title collapses to one
{
  const prefix = [{ title: 'Click action "manual-review" and verify effect', phase: 'ran' }];
  const addition = [{ title: 'Click action "manual-review" and verify effect', phase: 'regen' }, { title: 'Click action "hold" and verify effect', phase: 'regen' }];
  const merged = dedupeByTitle([...prefix, ...addition]);
  ok('prefix+addition same-title collapses (no re-run duplicate)', merged.length === 2 && merged[0].phase === 'ran');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
