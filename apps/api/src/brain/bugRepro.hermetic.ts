/**
 * bugRepro.hermetic.ts — pins the schooltalk FALSE "REPRODUCED" (bug-repro judged a date-persistence bug from the
 * LOGIN PAGE). Run: cd apps/api && npx tsx src/brain/bugRepro.hermetic.ts
 *
 * PHASE 1 (pre-fix, documentation): reconstruct the user's exact scenario and CONFIRM which branch fired.
 * PHASE 2 (post-fix): the sequence gate must turn it into cant-perform, and genuine reproductions must still pass.
 */
import { judgeRepro, reproNeedsLogin, detectSSO, detectInterstitial } from './bugReproService';
import { shouldRecover, filterRecoveryActions, scoreCandidate, contentWords } from './intentRunner';

// the user's real ticket (schooltalk lesson-date persistence)
const repro: any = {
  steps: [
    { intent: 'Log in as a Teacher' },
    { intent: 'Navigate to Calendar' },
    { intent: 'Click on Lesson 2' },
    { intent: 'Set the Lesson 2 start date to 2024-10-10' },
    { intent: 'Refresh the browser page' },
    { intent: 'Verify the Lesson 2 start date' },
  ],
  expectedBehavior: "Lesson 2 should retain the user-selected start date (2024-10-10) after the page is refreshed, and Lesson 1's end date should be recalculated correctly",
  actualBehavior: 'After page refresh, Lesson 2 start date is automatically changed from 2024-10-10 to 2024-09-10 (the first recurring event date), and the lesson mapping is not retained',
  interaction: 'form interaction with date selection, tab navigation, and page refresh',
  openQuestion: 'The Teacher Portal with Calendar, Events, Planning tab, and Lesson management does not exist in the provided admin-ui codebase.',
};

// what actually happened: EVERY actionable step matched nothing on the sign-in page (matched:0), + a login console error.
const loginPageSteps = [
  { stepIndex: 0, status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "in as a Teacher" (best=0)' }] },
  { stepIndex: 2, status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "on Lesson 2"' }] },
  { stepIndex: 3, status: 'fail', attempts: [{ kind: 'fill', matched: 0, error: 'no input for "Lesson 2 start date"' }] },
  { stepIndex: 4, status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "browser page"' }] },
  // the vacuous "verify" steps that scored pass on the login screen (asserted nothing)
  { stepIndex: 1, status: 'pass', attempts: [{ kind: 'navigate', matched: 1 }] },
  { stepIndex: 5, status: 'pass', attempts: [{ kind: 'verify', matched: 1 }] },
];
const loginFinalText = 'SchoolTalk Sign in Email Password Google Microsoft Sign In Contact your administrator';
const oneConsoleError = ['Failed to load resource: 401'];   // an SPA login page reliably emits some console noise

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

// ── THE BUG: current code returns 'reproduced' from the login page. After the fix it must be 'cant-perform'. ──
const v = judgeRepro(repro, loginPageSteps, oneConsoleError, loginFinalText);
console.log(`\n[schooltalk scenario] judgeRepro → ${v}`);
ok('login-gated repro is NOT falsely reproduced', v !== 'reproduced', `got '${v}' — a date bug "confirmed" from the sign-in page`);
ok('login-gated repro → cant-perform (actionable steps never matched)', v === 'cant-perform', `got '${v}'`);

// ── a console error ALONE (no executed steps) must not manufacture 'reproduced' ──
const vConsoleOnly = judgeRepro(repro, loginPageSteps, oneConsoleError, loginFinalText);
ok('console error on un-executed steps ≠ reproduced', vConsoleOnly !== 'reproduced');

// ── REGRESSION GUARD: a GENUINE reproduction must still be 'reproduced'. Steps executed, page shows the buggy state. ──
const goodSteps = [
  { stepIndex: 0, status: 'pass', attempts: [{ kind: 'click', matched: 1 }] },
  { stepIndex: 1, status: 'pass', attempts: [{ kind: 'fill', matched: 1 }] },
  { stepIndex: 2, status: 'pass', attempts: [{ kind: 'click', matched: 1 }] },
];
const buggyRepro: any = {
  steps: goodSteps.map((_, i) => ({ intent: `step ${i}` })),
  expectedBehavior: 'form rejects the empty title with a validation error',
  actualBehavior: 'form accepts the empty title and saves silently with no error',
  interaction: 'form fill and submit',
};
const vGood = judgeRepro(buggyRepro, goodSteps, [], 'Saved successfully. Item stored. Record created.');
ok('genuine repro (steps ran, buggy state seen) still reproduced', vGood === 'reproduced', `got '${vGood}'`);

// ── a genuine NOT-reproduced (steps ran, expected state seen) still classifies not-reproduced ──
const vNot = judgeRepro(buggyRepro, goodSteps, [], 'Validation error: title is required. The form rejected your input.');
ok('genuine not-reproduced still not-reproduced', vNot === 'not-reproduced', `got '${vNot}'`);

// ── cant-perform for a hard interaction that failed (existing behavior preserved) ──
const dragRepro: any = { steps: [{ intent: 'drag A onto B' }], expectedBehavior: 'x', actualBehavior: 'y', interaction: 'native drag-and-drop' };
const vDrag = judgeRepro(dragRepro, [{ stepIndex: 0, status: 'fail', attempts: [{ kind: 'drag', matched: 0 }] }], [], '');
ok('hard-interaction failure still cant-perform', vDrag === 'cant-perform', `got '${vDrag}'`);

// ── reproNeedsLogin: the cred-prompt trigger. Must fire on the schooltalk ticket, NOT on a public/customer flow. ──
ok('schooltalk ticket needs login (has "Log in as a Teacher")', reproNeedsLogin(repro.steps, undefined) === true);
ok('needs login detected from ticket text too', reproNeedsLogin([{ intent: 'open the page' }], 'Log in as an admin then...') === true);
ok('"sign in" phrasing detected', reproNeedsLogin([{ intent: 'Sign in to the portal' }]) === true);
ok('a no-login customer flow does NOT trigger the prompt', reproNeedsLogin([{ intent: 'Open the homepage' }, { intent: 'Click Buy Now' }, { intent: 'Fill the address' }], 'Checkout total is wrong') === false);
ok('empty steps → no login needed', reproNeedsLogin([], '') === false);

// ── detectSSO: the schooltalk case — correct creds, but the app uses Google/Microsoft SSO → cant-perform, NOT inconclusive. ──
const gsiErrors = ['Failed to load resource: the server responded with a status of 401 ()', '[GSI_LOGGER]: FedCM get() rejects with AbortError: signal is aborted without reason'];
// SSO only when there was NO usable password form (an SSO-ONLY page). authResult with no hadPasswordForm attempt.
ok('SSO detected: SSO-only page (no password form) + GSI/401', detectSSO(true, { status: 'fail', attempts: [{ kind: 'auth' }] }, gsiErrors) === true);
ok('SSO detected: creds + NO auth result + GSI', detectSSO(true, null, gsiErrors) === true);
ok('NOT SSO: no creds provided', detectSSO(false, null, gsiErrors) === false);
ok('NOT SSO: creds worked (auth passed)', detectSSO(true, { status: 'pass', attempts: [{ hadPasswordForm: true }] }, ['Failed to load resource: 401']) === false);
ok('NOT SSO: auth failed but no IdP signal', detectSSO(true, { status: 'fail', attempts: [{ kind: 'auth' }] }, ['some app console warning']) === false);
ok('SSO detected via microsoft login host (no password form)', detectSSO(true, { status: 'fail', attempts: [{ kind: 'auth' }] }, ['blocked https://login.microsoftonline.com/...']) === true);
// ★ THE FIX: a PASSWORD FORM was present + filled but login didn't take → NOT SSO, even with GSI/401 console noise.
ok('NOT SSO when a password form existed (failed password login, not SSO)', detectSSO(true, { status: 'fail', attempts: [{ kind: 'auth', hadPasswordForm: true }] }, gsiErrors) === false);

// ── detectInterstitial: the schooltalk case — logged in, then PARKED on a "Choose Portal" school-picker for every step. ──
const stuckSteps = [
  { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "Calendar" (best=0). Candidates on page: button:"Demo School" | button:"Doon School" | button:"NZ Curriculum"' }] },
  { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "recurring event" (best=0). Candidates on page: button:"Demo School" | button:"Doon School" | button:"NZ Curriculum"' }] },
  { status: 'fail', attempts: [{ kind: 'fill', matched: 0, error: 'no input for "start date" (best=0). Candidates on page: button:"Demo School" | button:"Doon School" | button:"NZ Curriculum"' }] },
  { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "Lesson 2" (best=0). Candidates on page: button:"Demo School" | button:"Doon School" | button:"NZ Curriculum"' }] },
];
{
  const it = detectInterstitial(stuckSteps, 'SchoolTalk Choose Portal: Demo School Doon School');
  ok('interstitial detected (≥3 fails, unchanging candidates)', !!it);
  ok('interstitial quotes the options', !!it && it.options.includes('Demo School') && it.options.includes('Doon School'), JSON.stringify(it));
  ok('interstitial heading from finalText', !!it && /choose portal/i.test(it.heading), it?.heading);
}
// NOT an interstitial: the page CHANGED across steps (different candidates each) → a normal weak-match, not stuck.
{
  const changing = [
    { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "A". Candidates on page: button:"X"' }] },
    { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "B". Candidates on page: button:"Y"' }] },
    { status: 'fail', attempts: [{ kind: 'click', matched: 0, error: 'no match for "C". Candidates on page: button:"Z"' }] },
  ];
  ok('changing pages ≠ interstitial', detectInterstitial(changing, '') === null);
}
// NOT an interstitial: fewer than 3 action-fails.
ok('too few fails ≠ interstitial', detectInterstitial(stuckSteps.slice(0, 2), '') === null);

// ── vacuous-pass: 'unverifiable' steps must NOT count as executed (they assert nothing). ──
{
  // a repro where the ONLY "successes" are unverifiable observe/verify steps → NOT reproduced (nothing was checked).
  const onlyObserves = [
    { stepIndex: 0, status: 'unverifiable', attempts: [{ kind: 'observe', matched: 1 }] },
    { stepIndex: 1, status: 'unverifiable', attempts: [{ kind: 'observe', matched: 1 }] },
  ];
  const r = { steps: [{ intent: 'x' }], expectedBehavior: 'saves silently', actualBehavior: 'shows error', interaction: 'form' } as any;
  const v = judgeRepro(r, onlyObserves, ['some 500 error'], '');
  ok('unverifiable-only steps do NOT manufacture reproduced', v !== 'reproduced', `got '${v}'`);
}

// ── judgeRepro treats a run of only-skipped (unverifiable) mutation steps as NOT reproduced/executed. ──
{
  // all steps were mutation-gated skips (status unverifiable) → nothing executed → inconclusive, never reproduced.
  const skipped = [
    { stepIndex: 0, status: 'unverifiable', attempts: [{ kind: 'skipped', matched: 0, error: 'mutating step skipped — needs authorization' }] },
    { stepIndex: 1, status: 'unverifiable', attempts: [{ kind: 'skipped', matched: 0, error: 'mutating step skipped — needs authorization' }] },
  ];
  const r = { steps: [{ intent: 'create event' }], expectedBehavior: 'saves', actualBehavior: 'shows error', interaction: 'form' } as any;
  ok('all-skipped(mutation-gated) run → not reproduced', judgeRepro(r, skipped, [], '') !== 'reproduced');
}

// ── ON-STALL RECOVERY: fire-decision (2nd consecutive miss, under the per-run cap). ──
ok('recovery does NOT fire on the 1st miss', shouldRecover({ consecutiveMisses: 1, recoveriesUsed: 0, maxRecoveries: 2 }) === false);
ok('recovery FIRES on the 2nd consecutive miss', shouldRecover({ consecutiveMisses: 2, recoveriesUsed: 0, maxRecoveries: 2 }) === true);
ok('recovery does NOT fire once the per-run cap is reached', shouldRecover({ consecutiveMisses: 3, recoveriesUsed: 2, maxRecoveries: 2 }) === false);

// ── ON-STALL RECOVERY: safety filter — SoA's recovery clicks pass the SAME destructive/mutation gate. ──
{
  const actions = [
    { action: 'click', label: 'Demo School', why: 'portal picker' },
    { action: 'click', label: 'Delete account', why: 'x' },       // destructive → always dropped
    { action: 'click', label: 'Create Event', why: 'x' },          // mutating → dropped when not authorized
    { action: 'fill', label: 'Search', value: 'x', why: 'x' },
  ];
  const unauth = filterRecoveryActions(actions as any, false);
  ok('recovery keeps the safe portal click', unauth.kept.some((a) => a.label === 'Demo School'));
  ok('recovery drops the destructive click (unauthorized)', unauth.dropped.some((d) => d.label === 'Delete account'));
  ok('recovery drops the mutating click (unauthorized)', unauth.dropped.some((d) => d.label === 'Create Event'));
  ok('unauthorized keeps only non-mutating', unauth.kept.length === 2);

  const auth = filterRecoveryActions(actions as any, true);
  ok('authorized still drops destructive', auth.dropped.some((d) => d.label === 'Delete account'));
  ok('authorized ALLOWS the mutating click', auth.kept.some((a) => a.label === 'Create Event'));
}

// ── MATCHER ROBUSTNESS: a verbose real-world step must still match the SHORT button (label ⊆ intent). ──
// This is the "don't depend on perfect wording" fix — the whole point of coverage scoring.
{
  const cand = (name: string) => ({ role: 'button', name, ref: 'button#0' });
  // the exact failure: a wordy ticket step vs the actual "Create Event" button.
  const verbose = contentWords('Create a new recurring event with occurrences on 10 September, 10 October, and 10 December, or open an existing one in Edit mode');
  const createBtn = scoreCandidate(verbose, cand('Create Event'));
  const noise = scoreCandidate(verbose, cand('Create Group'));   // a distractor sharing 'create'
  ok('verbose intent matches the short "Create Event" button', createBtn >= 1.5, `score ${createBtn}`);
  ok('"Create Event" (label ⊆ intent) OUTSCORES "Create Group" (partial)', createBtn > noise, `${createBtn} vs ${noise}`);

  // "click Demo School" vs a "Demo School" list row → strong.
  const demo = scoreCandidate(contentWords('click Demo School to select the portal'), cand('Demo School'));
  ok('label fully covered by intent scores strongly', demo >= 3, `score ${demo}`);

  // a lone common word must NOT spuriously full-match: intent "add lesson 2" vs a bare "Add" button shouldn't
  // outrank the real "Add Lesson" button.
  const addLesson = scoreCandidate(contentWords('click Add Lesson to create lesson 2'), cand('Add Lesson'));
  const bareAdd = scoreCandidate(contentWords('click Add Lesson to create lesson 2'), cand('Add'));
  ok('"Add Lesson" outranks a bare "Add"', addLesson > bareAdd, `${addLesson} vs ${bareAdd}`);
}

console.log(`\nbugRepro hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
