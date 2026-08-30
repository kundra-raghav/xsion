/** elementSelector.hermetic.ts — locks the tier ranking + stable-tier rule. Run: npx tsx src/brain/elementSelector.hermetic.ts */
import { rankSelectorTier, isStableTier, verdictFromCounts, identityKey } from './elementSelector';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

console.log('elementSelector hermetic:');

// tier ranking — best basis wins
ok('stable id → id', rankSelectorTier({ id: 'email' }) === 'id');
ok('testid beats nothing → testid', rankSelectorTier({ testid: 'submit-btn' }) === 'testid');
ok('id preferred over testid', rankSelectorTier({ id: 'email', testid: 'x' }) === 'id');
ok('aria when no id/testid', rankSelectorTier({ ariaLabel: 'Close dialog' }) === 'aria');
ok('text when only a label', rankSelectorTier({ label: 'Popular Meals' }) === 'text');
ok('positional when nothing', rankSelectorTier({}) === 'positional');

// generated-id skip (the stability trap): framework/random ids must NOT count as a stable id
ok('radix generated id skipped → falls to label', rankSelectorTier({ id: 'radix-:r3:', label: 'Menu' }) === 'text');
ok('mui generated id skipped', rankSelectorTier({ id: 'mui-4821', label: 'Tab' }) === 'text');
ok('long-hex id skipped (uuid-ish)', rankSelectorTier({ id: 'a1b2c3d4e5', label: 'Row' }) === 'text');
ok('react :r id skipped', rankSelectorTier({ id: ':r7:', label: 'X' }) === 'text');
// but a real semantic id with digits (short) is kept
ok('short semantic id kept', rankSelectorTier({ id: 'tab2', label: 'X' }) === 'id');

// stable-tier gate (what may enter the dedup key)
ok('id is stable', isStableTier('id'));
ok('testid is stable', isStableTier('testid'));
ok('aria is stable', isStableTier('aria'));
ok('text is stable', isStableTier('text'));
ok('positional is NOT stable (never in key)', !isStableTier('positional'));

// verify-at-capture verdict (the smart/dynamic core)
ok('unique + is-target → verified', verdictFromCounts(1, true).verifiedAtCapture === true);
ok('unique but NOT target → unverified', verdictFromCounts(1, false).verifiedAtCapture === false);
ok('ambiguous (2 matches) → unverified, count=2', verdictFromCounts(2, true).verifiedAtCapture === false && verdictFromCounts(2, true).ambiguityCount === 2);
ok('vanished (0 matches) → unverified, count=0', verdictFromCounts(0, false).verifiedAtCapture === false && verdictFromCounts(0, false).ambiguityCount === 0);
// identityKey shape (css vs text, no role)
ok('identityKey css', identityKey({ tier: 'id', css: '#email' }) === 'css:#email');
ok('identityKey text', identityKey({ tier: 'text', name: 'NZ Curriculum' }) === 'text:NZ Curriculum');

console.log(`\n${fail === 0 ? '✓' : '✗'} elementSelector: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
