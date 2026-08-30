/**
 * Hermetic checks for the human-confirmed correction EXTRACTION (the teach-the-app loop's last mile, enforced in
 * the executor). Proves the pure part: from stored knowledge, pull ONLY human-confirmed selector corrections and
 * their control labels — never observed facts (cross-tenant noise). The live click is proven separately.
 * Run: npx tsx src/brain/correction.hermetic.ts
 */
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

// mirror bugReproService's extraction (kept in lockstep — if that regex changes, this test must too).
function extractCorrections(knowledge: any[]): string[] {
  return (knowledge || [])
    .filter((e: any) => e.provenance === 'human-confirmed' && e.kind === 'selector')
    .map((e: any) => { const m = /click the control "([^"]+)"/i.exec(e.fact || ''); return m ? m[1] : ''; })
    .filter(Boolean);
}

console.log('correction extraction checks');

const knowledge = [
  { kind: 'selector', provenance: 'human-confirmed', fact: 'for "select "Recurring" option", click the control "Set Learning & Schedule"' },
  { kind: 'selector', provenance: 'observed', fact: 'for "X", click the control "Wrong Observed Control"' },   // observed → MUST be excluded
  { kind: 'route', provenance: 'human-confirmed', fact: 'clicking "Demo School" → /demo/Teacher/Dashboard' },   // route → not a control correction
  { kind: 'selector', provenance: 'human-confirmed', fact: 'for "click Save", click the control "Apply Changes"' },
  { kind: 'selector', provenance: 'human-confirmed', fact: 'login: email#email + password#password' },   // no control-label → skipped
];

const corr = extractCorrections(knowledge);
ok('extracts human-confirmed control labels', corr.includes('Set Learning & Schedule') && corr.includes('Apply Changes'));
ok('EXCLUDES observed facts (cross-tenant noise never auto-clicks)', !corr.includes('Wrong Observed Control'));
ok('EXCLUDES route facts (only selector corrections)', !corr.some((c) => /Demo School/.test(c)));
ok('skips a selector fact with no control-label pattern', corr.length === 2);
ok('empty knowledge → no corrections', extractCorrections([]).length === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
