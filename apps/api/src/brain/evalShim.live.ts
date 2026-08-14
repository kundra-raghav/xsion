/**
 * LIVE proof the __name shim fixes the 4 previously-broken evaluate bodies. Without installEvalShim, each throws
 * "ReferenceError: __name is not defined" under tsx and silently returns its catch-value. Requires :5188.
 * Run: npx tsx src/brain/evalShim.live.ts
 */
import { chromium } from 'playwright';
import { installEvalShim } from './evalShim';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } }

async function main() {
  const b = await chromium.launch();

  // WITHOUT shim: confirm the bug is real (a named helper throws).
  const ctxNo = await b.newContext();
  const pageNo = await ctxNo.newPage();
  await pageNo.goto('http://localhost:5188/portal.html', { waitUntil: 'domcontentloaded' });
  let threwNoShim = false;
  try { await pageNo.evaluate(() => { const f = (x: any): number => (x ? 1 : 0); return f(1); }); }
  catch { threwNoShim = true; }
  ok('WITHOUT shim: a named helper evaluate throws (bug confirmed)', threwNoShim);
  await ctxNo.close();

  // WITH shim: the same patterns as the 4 real broken bodies all work.
  const ctx = await b.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();
  await page.goto('http://localhost:5188/portal.html', { waitUntil: 'domcontentloaded' });

  let arrowOk = false, declOk = false, multiOk = false;
  try { arrowOk = (await page.evaluate(() => { const score = (el: any): number => (el ? 1 : 0); return score((globalThis as any).document.body); })) === 1; } catch {}
  try { declOk = (await page.evaluate(() => { function nearText(el: any) { return 'x'; } return nearText(null); })) === 'x'; } catch {}
  try { multiOk = (await page.evaluate(() => { const cssEsc = (s: string) => s; const labelFor = (el: any): string => ''; const sel = (el: any): string => 'ok'; return cssEsc('a') + labelFor(null) + sel(null); })) === 'aok'; } catch {}

  ok('WITH shim: const-arrow helper works (704 fillByLabel / 761 pageClickableInventory)', arrowOk);
  ok('WITH shim: function-declaration helper works (900 resolveIdentifierField)', declOk);
  ok('WITH shim: multiple helpers work (1000 extractFieldRequirements)', multiOk);
  await b.close();

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
