/** Hermetic for buildFeatureReachPrefix — the crawl-derived reach-the-feature navigation prefix for break-it. */
import { buildFeatureReachPrefix } from './breakItService';
let pass=0,fail=0; const ok=(n:string,c:boolean)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n));};

const map = { flows: [
  { name: 'Browse inventory and add product to cart', steps: [
    { intent: 'click "Sauce Labs Backpack"' },
    { intent: 'view product detail' },
    { intent: 'click "Add to cart"' },   // the final mutating step — must be DROPPED
  ]},
  { name: 'Checkout and pay', steps: [{ intent: 'click Checkout' }, { intent: 'fill card' }] },
]};

const p = buildFeatureReachPrefix(map, 'Add product to cart');
ok('matches the cart flow (word overlap)', p.length >= 1);
ok('drops the final mutating step (no "Add to cart" in prefix)', !p.some(s => /add to cart/i.test(s.intent)));
ok('keeps a navigation lead-in (click product)', p.some(s => /backpack|product/i.test(s.intent)));
ok('excludes fill steps from the lead-in', !p.some(s => /\bfill\b/i.test(s.intent)));
ok('no flows → empty', buildFeatureReachPrefix({ flows: [] }, 'x').length === 0);
ok('no feature match → empty', buildFeatureReachPrefix(map, 'zzzzz nonexistent').length === 0);
ok('single-step flow → empty (nothing to lead with after dropping last)', buildFeatureReachPrefix({ flows: [{ name: 'add product cart', steps: [{ intent: 'click x' }] }] }, 'add product cart').length === 0);

console.log(`\n${pass}/${pass+fail} passed`); process.exit(fail?1:0);
