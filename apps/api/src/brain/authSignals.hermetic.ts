/**
 * authSignals.hermetic.ts — locks the PURE auth deciders against the two measured live failures.
 * Run: npx tsx src/brain/authSignals.hermetic.ts
 */
import { classifyLoginGate, judgeTick, crawlTerminalStatus, type AuthSignals } from './authSignals';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sig = (p: Partial<AuthSignals>): AuthSignals => ({
  url: 'https://x/', ok: true, hasPasswordField: false, authVocabControls: [], authedAffordances: [], errorNearForm: null, ...p,
});

console.log('authSignals hermetic:');

// ── classifyLoginGate (L0-b) ──
// dent: password + "Sign In" → gate
ok('dent login page = gate', classifyLoginGate(sig({ hasPasswordField: true, authVocabControls: ['Sign In'] })).isLoginGate);
// schooltalk THE bug: SSO-first, NO password field, only provider buttons → MUST still be a gate
ok('schooltalk SSO-first = gate (the fixed false-negative)',
  classifyLoginGate(sig({ authVocabControls: ['Continue with Google', 'Continue with Microsoft', 'Setup new password'] })).isLoginGate,
  `score=${classifyLoginGate(sig({ authVocabControls: ['Continue with Google', 'Setup new password'] })).score}`);
// authenticated dashboard: nav + logout, no password, no auth vocab → NOT a gate
ok('dashboard = not a gate',
  !classifyLoginGate(sig({ authedAffordances: ['Logout', 'My Account', '__nav:8'] })).isLoginGate);
// a page with a nav AND a stray "Sign in" link but real app affordances → not a gate (inside-app dominates)
ok('app page with stray sign-in link but authed affordances = not a gate',
  !classifyLoginGate(sig({ authVocabControls: ['Sign in'], authedAffordances: ['Logout', '__nav:6'] })).isLoginGate);
// public marketing page: nothing auth → not a gate
ok('public page = not a gate', !classifyLoginGate(sig({ authedAffordances: ['__nav:4'] })).isLoginGate);
// Mode-1 corroboration: password + routeRequiresAuth
ok('routeManifest requiresAuth boosts', classifyLoginGate(sig({ hasPasswordField: true }), { routeRequiresAuth: true }).isLoginGate);

// ── judgeTick (L0-a) ──
const before = 'https://admin.thedent.in/login';
// dent success: password gone, authed nav present → in-app
ok('dent settled = in-app', judgeTick(sig({ url: 'https://admin.thedent.in/', authedAffordances: ['__nav:8', 'Logout'] }), before) === 'in-app');
// THE false-pass trap: password gone but NO authed affordance yet (unmount→mount gap) → pending, NOT in-app
ok('form-gone-but-blank-shell = pending (not false-pass)',
  judgeTick(sig({ url: 'https://admin.thedent.in/', hasPasswordField: false, authedAffordances: [] }), before) === 'pending');
// url moved to a known app route → in-app even before affordances enumerate
ok('url moved to known app route = in-app',
  judgeTick(sig({ url: 'https://admin.thedent.in/users', hasPasswordField: false }), before, { knownAppRoute: (u) => /\/users/.test(u) }) === 'in-app');
// rejected: form still present + error near it
ok('wrong creds = rejected', judgeTick(sig({ url: before, hasPasswordField: true, errorNearForm: 'invalid email or password' }), before) === 'rejected');
// slow app: form still present, no error yet → pending (NOT rejected — keeps creds)
ok('slow app, form present no error = pending', judgeTick(sig({ url: before, hasPasswordField: true }), before) === 'pending');
// error text present but form ALREADY gone → do NOT trust the error (dashboard false-positive guard) → in-app if affordances, else pending
ok('error ignored once form is gone', judgeTick(sig({ url: 'https://x/', hasPasswordField: false, errorNearForm: 'failed', authedAffordances: [] }), before) === 'pending');

// ── crawlTerminalStatus (L0-c honesty invariant) ──
// THE schooltalk lie: login-gated, no session → MUST be blocked, never done
ok('gated + no session = blocked (the honesty invariant)',
  crawlTerminalStatus({ landingWasLoginGated: true, sessionEstablished: false }) === 'blocked');
// authed session on a gated app → done is legitimate
ok('gated + session = done', crawlTerminalStatus({ landingWasLoginGated: true, sessionEstablished: true }) === 'done');
// public app (not gated) → done, no session needed
ok('public app = done', crawlTerminalStatus({ landingWasLoginGated: false, sessionEstablished: false }) === 'done');
// DETECTOR-INDEPENDENT TRIPWIRE: the REGRESSED schooltalk failure — detector false-negatived (landingWasLoginGated
// =false), and the OLD code set sessionEstablished=true from that miss. Now sessionEstablished is login-success-ONLY,
// so a 2-page map, never-authed, never-saw-app-affordance → blocked despite the detector saying not-a-gate.
ok('tripwire: tiny map, no login, no app affordance = blocked (catches detector false-negative)',
  crawlTerminalStatus({ landingWasLoginGated: false, sessionEstablished: false, pagesMapped: 2, everSawAuthedAffordance: false }) === 'blocked');
// tripwire does NOT trip on a real public app: an app affordance (nav) was seen on page 1 → done
ok('tripwire: authed/app affordance seen = done (public app not blocked)',
  crawlTerminalStatus({ landingWasLoginGated: false, sessionEstablished: false, pagesMapped: 2, everSawAuthedAffordance: true }) === 'done');
// tripwire does NOT trip on a large map even if no app affordance flag (not the login-screen shape)
ok('tripwire: large map = done (not tripped)',
  crawlTerminalStatus({ landingWasLoginGated: false, sessionEstablished: false, pagesMapped: 17, everSawAuthedAffordance: false }) === 'done');
// a genuinely logged-in tiny app (e.g. 2-page authed tool) → done (sessionEstablished true)
ok('tripwire: logged-in tiny app = done',
  crawlTerminalStatus({ landingWasLoginGated: true, sessionEstablished: true, pagesMapped: 2, everSawAuthedAffordance: false }) === 'done');

console.log(`\n${fail === 0 ? '✓' : '✗'} authSignals: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
