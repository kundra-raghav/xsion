/**
 * Hermetic checks for reachState — consuming the crawl's recorded navigation to reach a gated feature. Proves it
 * reads observed choices (never synthesizes), matches the ticket's own words, and doesn't double-click when the
 * steps already lead with the selection. Run: npx tsx src/brain/reachState.hermetic.ts
 */
import { observedChoices, chosenOption, buildReachStatePrefix, pruneRedundantSteps } from './reachState';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

console.log('reachState hermetic checks');

// a schooltalk-shaped map: pages reached via a single school-select click, plus a gate with options.
const map = {
  gates: [{ options: [{ label: 'NZ Curriculum' }, { label: 'Demo School' }] }],
  pages: [
    { path: '/Teacher › Demo School', clicks: ['Demo School'] },
    { path: '/Teacher › NZ Curriculum', clicks: ['NZ Curriculum'] },
    { path: '/nzcurriculum/Teacher/Dashboard', clicks: null },
    { path: '/facilitation/Teacher/Dashboard › View All', clicks: ['View All'] },   // a 1-click that ISN'T a school
  ],
};

// observedChoices: union of gate options + single-click labels
const choices = observedChoices(map);
ok('observedChoices includes gate options', choices.includes('NZ Curriculum') && choices.includes('Demo School'));
ok('observedChoices includes single-click page labels', choices.includes('View All'));
ok('observedChoices is empty on a map with no gates/click-paths', observedChoices({ pages: [{ path: '/x' }] }).length === 0);

// chosenOption: the ticket's words pick the right option; longest match wins
ok('ticket referencing NZ Curriculum → picks it', chosenOption('open NZ Curriculum as school then My Calendar', choices) === 'NZ Curriculum');
ok('ticket referencing Demo → picks Demo School', chosenOption('log in and use Demo School', choices) === 'Demo School');
ok('ticket referencing no known option → null', chosenOption('just click the big button', choices) === null);

// buildReachStatePrefix: the actual prepend
const ticket = 'Lesson 2 start date resets. Log in as Teacher, open NZ Curriculum, go to My Calendar…';
const steps = [{ intent: 'Navigate to /Teacher' }, { intent: 'Click My Calendar' }];
const prefix = buildReachStatePrefix(map, ticket, steps);
ok('prepends a click on the referenced school', prefix.length === 1 && /click "NZ Curriculum"/i.test(prefix[0].intent));

// ALWAYS prepends the reliable click even when SoA has its own (unreliable) select step — that's the point.
const stepsSelectFirst = [{ intent: 'Select the NZ Curriculum school' }, { intent: 'Click My Calendar' }];
ok('STILL prepends the reliable click when SoA has its own select step', buildReachStatePrefix(map, ticket, stepsSelectFirst).length === 1);

// no map / no gate → no prepend (a non-gated app is unaffected — fail-safe)
ok('no prefix when the app has no picker', buildReachStatePrefix({ pages: [{ path: '/home' }] }, ticket, steps).length === 0);
ok('no prefix when ticket names no known option', buildReachStatePrefix(map, 'some unrelated bug', steps).length === 0);

// pruneRedundantSteps: drop login/consent (auth done) + the now-redundant school-select (prepend did it).
const fullSteps = [
  { intent: 'Navigate to /Teacher' },
  { intent: 'Authenticate as a teacher' },
  { intent: 'Accept terms of service' },
  { intent: 'Select the NZ Curriculum school' },
  { intent: 'Click My Calendar' },
  { intent: 'Click Edit' },
];
const pruned = pruneRedundantSteps(fullSteps, 'NZ Curriculum', true);
const prunedIntents = pruned.map((s) => s.intent);
ok('prunes the login step (auth passed)', !prunedIntents.some((i) => /authenticate/i.test(i)));
// field-level login steps SoA emits separately must ALSO prune (they were the gap)
ok('prunes "fill Email field" / "fill Password field" when auth passed', pruneRedundantSteps([{ intent: 'fill "Email" field with teacher account email' }, { intent: 'fill "Password" field with pw' }, { intent: 'Click My Calendar' }], 'NZ Curriculum', true).length === 1);
ok('prunes the accept-terms step', !prunedIntents.some((i) => /accept terms/i.test(i)));
ok('prunes the redundant school-select step', !prunedIntents.some((i) => /select the nz curriculum/i.test(i)));
ok('KEEPS the real repro steps (My Calendar, Edit)', prunedIntents.includes('Click My Calendar') && prunedIntents.includes('Click Edit'));
ok('does NOT prune login steps when auth did NOT pass', pruneRedundantSteps(fullSteps, 'NZ Curriculum', false).some((s) => /authenticate/i.test(s.intent)));
ok('does NOT prune a select step for a DIFFERENT option', pruneRedundantSteps([{ intent: 'Select the Demo School' }], 'NZ Curriculum', true).length === 1);
// SoA's OTHER form of the select step is `click "<School>"` — the prepend already did it, so prune it too.
ok('prunes a redundant click "<School>" step (SoA\'s other form)', pruneRedundantSteps([{ intent: 'click "NZ Curriculum"' }, { intent: 'Click My Calendar' }], 'NZ Curriculum', true).length === 1);
// ★ REGRESSION GUARD: a step that mentions the school but ALSO does real work (create/fill/reach a feature) is NOT
// a pure select — must NOT be pruned (else the ticket's precondition/action is silently dropped).
ok('does NOT prune "click Create Event in NZ Curriculum" (a CREATE, not a picker click)', pruneRedundantSteps([{ intent: 'click "Create Event" in NZ Curriculum calendar' }], 'NZ Curriculum', true).length === 1);
ok('does NOT prune "open NZ Curriculum My Calendar" (reaches a feature)', pruneRedundantSteps([{ intent: 'open NZ Curriculum My Calendar' }], 'NZ Curriculum', true).length === 1);
ok('STILL prunes a bare "click NZ Curriculum" (pure select)', pruneRedundantSteps([{ intent: 'click NZ Curriculum' }], 'NZ Curriculum', true).length === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// navigate-to-root prune (the login-at-root fix): a bare "navigate to <origin root>" once authed logs us out → prune.
ok('prunes a bare "navigate to https://www.saucedemo.com" when authed', pruneRedundantSteps([{ intent: 'navigate to https://www.saucedemo.com' }, { intent: 'click Add to cart' }], null, true, 'https://www.saucedemo.com').length === 1);
ok('prunes "go to /login" when authed', pruneRedundantSteps([{ intent: 'go to /login' }, { intent: 'click Add to cart' }], null, true, 'https://www.saucedemo.com').length === 1);
ok('does NOT prune navigate-to-root when auth did NOT pass', pruneRedundantSteps([{ intent: 'navigate to https://www.saucedemo.com' }], null, false, 'https://www.saucedemo.com').length === 1);
ok('does NOT prune a navigate to a REAL inner route (/reports)', pruneRedundantSteps([{ intent: 'navigate to https://admin.thedent.in/reports' }], null, true, 'https://admin.thedent.in').length === 1);
ok('does NOT prune a navigate that also does work (create)', pruneRedundantSteps([{ intent: 'navigate to the app and create an event' }], null, true, 'https://www.saucedemo.com').length === 1);
