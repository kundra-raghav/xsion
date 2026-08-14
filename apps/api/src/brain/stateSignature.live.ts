/**
 * LIVE captureShape test — exercises the page.evaluate I/O boundary that pure hermetics + tsc are BLIND to.
 * This is the test that would have caught the tsx `__name is not defined` bug: captureShape silently caught the
 * throw and returned an EMPTY signature for every page, so every state collapsed to one constant. Requires the
 * fixture server on :5188. Run: npx tsx src/brain/stateSignature.live.ts
 */
import { chromium } from 'playwright';
import { captureShape, sigFromShape } from './stateSignature';

function normUrl(u: string): string { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } }

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

async function main() {
  const b = await chromium.launch();
  const page = await b.newPage();
  try {
    await page.goto('http://localhost:5188/portal.html', { waitUntil: 'networkidle' });
    const baseShape = await captureShape(page, normUrl(page.url()));

    // THE bug-catcher: a successful capture has NO error and REAL content.
    ok('captureShape does not error (catches the __name/evaluate class of bug)', !(baseShape as any)._captureError, (baseShape as any)._captureError || '');
    ok('captureShape returns non-empty affordances on a real page', baseShape.affordances.length >= 3, JSON.stringify(baseShape.affordances));
    ok('captureShape reads the portal buttons', baseShape.affordances.includes('Demo School'));

    // in-place SPA swap: click a portal, capture again — structure changes (nav appears, affordances change).
    await page.click('text=Demo School');
    await page.waitForTimeout(400);
    const demoShape = await captureShape(page, normUrl(page.url()));
    ok('post-swap capture is non-empty', demoShape.affordances.length >= 1 && !(demoShape as any)._captureError);
    ok('SPA swap produces a DIFFERENT signature (base vs dashboard)', sigFromShape(baseShape) !== sigFromShape(demoShape));

    // the two dashboards (Demo vs Doon) are STRUCTURALLY identical → SAME signature (heading excluded).
    await page.goto('http://localhost:5188/portal.html', { waitUntil: 'networkidle' });
    await page.click('text=Doon School'); await page.waitForTimeout(400);
    const doonShape = await captureShape(page, normUrl(page.url()));
    ok('structurally-identical dashboards collapse to ONE state (Demo ≡ Doon)', sigFromShape(demoShape) === sigFromShape(doonShape), `${sigFromShape(demoShape)} vs ${sigFromShape(doonShape)}`);
  } finally {
    await b.close();
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
