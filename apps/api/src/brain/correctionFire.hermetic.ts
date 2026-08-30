/**
 * SYNTHETIC (real browser, deterministic) proof that a HUMAN-CONFIRMED correction FIRES in the executor — the
 * teach-the-app loop's last mile, code-enforced (immune to LLM planner wording). Uses a data: URL fixture so it
 * needs no server. Proves: (1) a click that fails to match the intent's label DOES fire the correction control;
 * (2) with NO corrections it fails (no accidental clicks); (3) a DANGEROUS correction is NOT auto-clicked.
 * Run: npx tsx src/brain/correctionFire.hermetic.ts
 */
import { chromium } from 'playwright';
import { __setCorrectionsForTest, __testHooks } from './intentRunner';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

// a page with exactly two real controls + one dangerous one — none labeled "Recurring" (the intent will miss).
const FIXTURE = 'data:text/html,' + encodeURIComponent(`
  <button id="a">Set Learning &amp; Schedule</button>
  <button id="b">Select Teachers</button>
  <button id="d">Delete Everything</button>
  <script>for (const el of document.querySelectorAll('button')) el.addEventListener('click', () => el.setAttribute('data-clicked','1'));</script>
`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(FIXTURE);

  // 1. correction FIRES: intent "Recurring" doesn't match any label, but the correction "Set Learning & Schedule" is present.
  __setCorrectionsForTest(['Set Learning & Schedule']);
  const r1 = await __testHooks.resolveClick(page, 'Recurring', 'click "Recurring"');
  ok('correction fires: kind=corrected', (r1 as any).kind === 'corrected', JSON.stringify(r1).slice(0, 120));
  ok('correction fires: matched=1 on the corrected control', r1.matched === 1 && /Set Learning/.test(r1.selector || ''));
  ok('correction actually CLICKED the control', await page.locator('#a').getAttribute('data-clicked') === '1');

  // 2. NO corrections → the same miss FAILS (no accidental click of anything).
  await page.goto(FIXTURE);   // reset
  __setCorrectionsForTest([]);
  const r2 = await __testHooks.resolveClick(page, 'Recurring', 'click "Recurring"');
  ok('no corrections → the miss FAILS (matched=0)', r2.matched === 0);
  ok('no corrections → nothing was clicked', await page.locator('#a').getAttribute('data-clicked') === null);

  // 3. a DANGEROUS correction is NOT auto-clicked (respects the danger gate).
  await page.goto(FIXTURE);
  __setCorrectionsForTest(['Delete Everything']);
  const r3 = await __testHooks.resolveClick(page, 'Recurring', 'click "Recurring"');
  ok('dangerous correction is NOT auto-clicked (matched=0)', r3.matched === 0);
  ok('the Delete button was NOT clicked', await page.locator('#d').getAttribute('data-clicked') === null);

  await browser.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
