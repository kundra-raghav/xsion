/**
 * siteModel.hermetic.ts — CRAWL-g. Proves the AMORTIZATION / compounding behavior: a state seen across crawls becomes
 * STABLE (trustworthy skeleton); a one-off state stays VOLATILE; and warm-start reports reconfirmed / new / disappeared
 * precisely. The efficiency claim ("gets better over time") is exactly: stableSigs grows and volatileSigs shrinks as
 * crawls accumulate, so more of the app is known-cheap-to-verify.
 */
import { buildSiteModel, warmStart } from './siteModel';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log(`  ✗ ${n} ${extra}`)); };

const page = (sig: string, url: string) => ({ sig, url });
const edge = (label: string, toSig: string) => ({ action: { label, kind: 'click' }, toSig });

// crawl 1: 3 states (home, users, a one-off "flash sale" banner state that won't recur)
const c1 = { crawledAt: 't1', pages: [page('HOME', '/#home'), page('USERS', '/#users'), page('FLASH', '/#promo')], edges: [edge('Users', 'USERS'), edge('Buy now', 'FLASH')] };
// crawl 2: home + users recur (→ stable), flash is gone, a NEW "reports" state appears
const c2 = { crawledAt: 't2', pages: [page('HOME', '/#home'), page('USERS', '/#users'), page('REPORTS', '/#reports')], edges: [edge('Users', 'USERS'), edge('Reports', '/#reports')] };
// crawl 3: home + users + reports all recur (reports now stable too)
const c3 = { crawledAt: 't3', pages: [page('HOME', '/#home'), page('USERS', '/#users'), page('REPORTS', '/#reports')], edges: [edge('Users', 'USERS'), edge('Reports', '/#reports')] };

// ── first crawl: NOTHING is stable yet (nothing to compare against) ──
{
  const m = buildSiteModel([c1]);
  ok('crawl 1: crawlCount=1', m.crawlCount === 1);
  ok('crawl 1: everything VOLATILE (no repeats yet)', m.stableSigs.length === 0 && m.volatileSigs.length === 3, JSON.stringify(m.volatileSigs));
  ok('crawl 1: no stable actions', m.stableActions.length === 0);
}

// ── after crawl 2: HOME + USERS repeated → STABLE; FLASH + REPORTS seen once → VOLATILE ──
{
  const m = buildSiteModel([c1, c2]);
  ok('crawl 2: HOME + USERS are STABLE (seen in ≥2 crawls)', m.stableSigs.includes('HOME') && m.stableSigs.includes('USERS'));
  ok('crawl 2: FLASH (one-off) is VOLATILE', m.volatileSigs.includes('FLASH') && !m.stableSigs.includes('FLASH'));
  ok('crawl 2: REPORTS (new, seen once) is VOLATILE', m.volatileSigs.includes('REPORTS'));
  ok('crawl 2: "Users" action is STABLE (in both crawls)', m.stableActions.includes('Users'));
  ok('crawl 2: sigFirstSeen tracks age', m.sigFirstSeen['FLASH'] === 0 && m.sigFirstSeen['REPORTS'] === 1);
}

// ── after crawl 3: REPORTS now STABLE too — the compounding: stable set GREW, volatile SHRANK ──
{
  const m2 = buildSiteModel([c1, c2]);
  const m3 = buildSiteModel([c1, c2, c3]);
  ok('COMPOUNDING: stable set grows crawl-over-crawl', m3.stableSigs.length > m2.stableSigs.length, `c2=${m2.stableSigs.length} c3=${m3.stableSigs.length}`);
  ok('crawl 3: REPORTS promoted to STABLE', m3.stableSigs.includes('REPORTS'));
  ok('crawl 3: FLASH stays volatile forever (never recurred)', m3.volatileSigs.includes('FLASH'));
}

// ── WARM-START: compare a new crawl against the prior model ──
{
  ok('warm-start on FIRST crawl → isFirstCrawl, all states new', (() => { const w = warmStart(null, c1); return w.isFirstCrawl && w.newStates === 3; })());
  // model built from c1+c2 (stable = HOME, USERS), then crawl c3 arrives:
  // prior model from [c1,c2]: everSeen = {HOME,USERS,FLASH,REPORTS}. c3 = {HOME,USERS,REPORTS}.
  const prior = buildSiteModel([c1, c2]);
  const w = warmStart(prior, c3);
  ok('warm-start: re-confirms the 3 KNOWN states present in c3 (HOME,USERS,REPORTS)', w.reconfirmed === 3, `reconfirmed=${w.reconfirmed}`);
  ok('warm-start: 0 genuinely-new (all of c3 was seen before)', w.newStates === 0, `new=${w.newStates}`);
  ok('warm-start: 1 disappeared (FLASH, seen before, not in c3)', w.disappeared === 1, `disappeared=${w.disappeared}`);
  ok('warm-start: NOT flagged as first-crawl (prior model has known states)', w.isFirstCrawl === false);
  // a crawl that ALSO drops USERS → 2 disappeared (FLASH + USERS), and a brand-new state → newStates=1
  const cDrop = { crawledAt: 't4', pages: [page('HOME', '/#home'), page('REPORTS', '/#reports'), page('BRANDNEW', '/#new')] };
  const w2 = warmStart(prior, cDrop);
  ok('warm-start: detects 2 disappeared (FLASH + USERS gone)', w2.disappeared === 2, `disappeared=${w2.disappeared}`);
  ok('warm-start: detects 1 genuinely-new state (BRANDNEW)', w2.newStates === 1, `new=${w2.newStates}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
