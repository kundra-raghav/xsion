/* revealControl.hermetic.ts — locks the PURE reveal-control selector (the command-palette / click-to-reveal fix):
 * pick the control whose label matches the target's content words, REJECT dangerous labels (safety gate), and extract
 * the keyboard shortcut from the control's own text. Run: cd apps/api && npx tsx src/brain/revealControl.hermetic.ts
 */
import { pickRevealControl } from './intentRunner';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };

// dent's real case: a "Search everything…⌘K" control reveals the search input.
{
  const cands = [{ label: 'Dashboard' }, { label: 'Search everything…⌘K' }, { label: 'Refresh' }];
  const r = pickRevealControl('Search Input', cands);
  ok('picks the search-matching reveal control', !!r && /search/i.test(r!.label), JSON.stringify(r));
  ok('extracts the ⌘K shortcut from the label', !!r && r!.shortcut === 'Meta+K', r?.shortcut);
}
// Ctrl+K variant.
{
  const r = pickRevealControl('search users', [{ label: 'Open search (Ctrl+K)' }]);
  ok('extracts Ctrl+K → Control+K', !!r && r!.shortcut === 'Control+K', r?.shortcut);
}
// no shortcut in label → control still pickable, shortcut undefined (click-only).
{
  const r = pickRevealControl('search', [{ label: 'Search' }]);
  ok('picks a plain "Search" control (click-only, no shortcut)', !!r && r!.label === 'Search' && !r!.shortcut, JSON.stringify(r));
}
// ★ SAFETY: never pick a dangerous-labelled control even if it word-matches.
{
  const r = pickRevealControl('delete search history', [{ label: 'Delete all search history', tag: 'button' }]);
  ok('rejects a DANGEROUS control ("Delete all…") as a reveal affordance', r === null, JSON.stringify(r));
}
// no content match → null (don't click a random button).
{
  const r = pickRevealControl('search', [{ label: 'Dashboard' }, { label: 'Settings' }, { label: 'Logout' }]);
  ok('returns null when nothing matches the target (no random click)', r === null, JSON.stringify(r));
}
// empty target → null.
{
  ok('empty target → null', pickRevealControl('', [{ label: 'Search' }]) === null);
}
// a same-origin nav link that matches is fine (safe), picked.
{
  const r = pickRevealControl('search page', [{ label: 'Search page', tag: 'a', href: '/search', sameOrigin: true }]);
  ok('a same-origin "Search page" link is a valid (safe) reveal control', !!r, JSON.stringify(r));
}

console.log(`\nrevealControl hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
