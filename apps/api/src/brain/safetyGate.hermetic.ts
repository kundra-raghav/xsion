/**
 * safetyGate.hermetic.ts — CRAWL-e classifier. Locks the real dent cases the measurement surfaced: the lexicon must
 * catch every Send/Delete (map-but-never-click), and the DOM-structure demotion must recover the false positives
 * (Cancel/Reset/Update-view, a delete LINK) WITHOUT a bridge call.
 */
import { classifyElement, riskCategory } from './safetyGate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)); };

// ── GENUINELY DANGEROUS (must be dangerous + NOT clickable) — the real dent buttons ──
{
  const v = classifyElement({ label: 'Send to 3 Users', tag: 'button', inputType: 'submit', inFormMethod: 'post' });
  ok('Send to 3 Users (POST submit) → dangerous, not clickable', v.risk === 'dangerous' && v.clickable === false);
  ok('  → category messaging', v.category === 'messaging');
}
{
  const v = classifyElement({ label: 'Send Bulk Notification', tag: 'button', inputType: 'button' });
  ok('Send Bulk Notification (bare button, hard-danger label) → dangerous', v.risk === 'dangerous' && !v.clickable);
}
{
  const v = classifyElement({ label: 'Delete the test user', tag: 'button' });
  ok('Delete (bare button) → dangerous, not clickable', v.risk === 'dangerous' && !v.clickable);
}
{
  const v = classifyElement({ label: 'Pay $49.99', tag: 'button', inputType: 'submit', inFormMethod: 'post' });
  ok('Pay (POST) → dangerous + category payment', v.risk === 'dangerous' && v.category === 'payment');
}
{
  const v = classifyElement({ label: 'Log out', tag: 'button' });
  ok('Log out → dangerous (auth) — never auto-click, it ends the session', v.risk === 'dangerous' && v.category === 'auth');
}

// ── FALSE POSITIVES the measurement flagged — must DEMOTE to safe + clickable, no bridge ──
{
  const v = classifyElement({ label: 'Cancel', tag: 'button', inputType: 'button' });
  ok('Cancel (soft verb, no submit) → demoted safe', v.risk === 'safe' && v.clickable);
}
{
  const v = classifyElement({ label: 'Reset Filters', tag: 'button', inFormMethod: 'get' });
  ok('Reset Filters (GET form) → demoted safe (a read/filter)', v.risk === 'safe' && v.clickable);
}
{
  const v = classifyElement({ label: 'Clear selection', tag: 'button', inputType: 'button' });
  ok('Clear selection (soft, no submit) → demoted safe', v.risk === 'safe' && v.clickable);
}
{
  const v = classifyElement({ label: 'Update user details', tag: 'a', href: '/users/1/edit', sameOrigin: true });
  ok('Update... as a same-origin LINK → safe navigation (goes to an edit PAGE, not the mutation)', v.risk === 'safe' && v.clickable);
}

// ── the key demotion: a "Delete" that is actually a same-origin LINK to a confirm page = navigation, safe ──
{
  const v = classifyElement({ label: 'Delete account', tag: 'a', href: '/settings/delete', sameOrigin: true });
  ok('Delete-LINK (same-origin <a href>) → safe navigation (the link, not the act)', v.risk === 'safe' && v.clickable);
}
// but a "Delete" that POSTs (or a bare button) is NOT demoted
{
  const v = classifyElement({ label: 'Delete account', tag: 'button', inputType: 'submit', inFormMethod: 'post' });
  ok('Delete as a POST submit → stays dangerous', v.risk === 'dangerous' && !v.clickable);
}

// ── genuinely-benign labels never flagged at all ──
{
  const v = classifyElement({ label: 'View User Profile', tag: 'a', href: '/users/1', sameOrigin: true });
  ok('View User Profile → safe (no risk term)', v.risk === 'safe' && v.clickable && v.category === 'none');
}
{
  const v = classifyElement({ label: 'Search', tag: 'button', inFormMethod: 'get' });
  ok('Search → safe (no risk term)', v.risk === 'safe' && v.clickable);
}

// ── category mapping spot-checks ──
ok('category: "Transfer funds" → payment', riskCategory('Transfer funds') === 'payment');
ok('category: "Revoke access" → permissions', riskCategory('Revoke access') === 'permissions');
ok('category: "Deactivate account" → account-mgmt', riskCategory('Deactivate account') === 'account-mgmt');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
