/**
 * scrollReveal.hermetic.ts — locks the CRAWL-c termination LOGIC (the two research-grounded stall tests) as pure
 * functions, testable without a browser. The live `revealByScroll` inlines this; here we verify the decision rule:
 *   • growing page → terminate after STALL_ROUNDS scrolls with no scrollHeight growth
 *   • virtualized list → terminate after STALL_ROUNDS scrolls with no NEW stable-key
 *   • both signals must be satisfied (the key test is skipped if the page never exposed keys)
 */
const STALL_ROUNDS = 3;

// pure replica of the per-iteration stall bookkeeping + terminate decision
function normKind(s: string) { return (s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 40); }
function step(state: any, obs: { after: number; keys: string[]; labels?: string[] }): { done: boolean } {
  if (obs.keys.length) { state.sawKeys = true; for (const k of obs.keys) state.keys.add(k); }
  const labels = obs.labels || [];
  if (labels.length) state.sawLabels = true;
  let newKind = false;
  for (const l of labels) { const k = normKind(l); if (k && !state.kinds.has(k)) { state.kinds.add(k); newKind = true; } }
  if (newKind) state.kindStall = 0; else state.kindStall++;
  if (obs.after > state.lastHeight + 4) { state.grew = true; state.heightStall = 0; state.lastHeight = obs.after; }
  else state.heightStall++;
  if (state.keys.size > state.lastKeyCount) { state.keyStall = 0; state.lastKeyCount = state.keys.size; }
  else state.keyStall++;
  const heightDone = state.heightStall >= STALL_ROUNDS;
  const keyDone = state.sawKeys ? state.keyStall >= STALL_ROUNDS : true;
  // kind-saturation is AUTHORITATIVE when the page has row-labels (stop even if height/keys still grow); else fall
  // back to the mechanical height/key stalls.
  if (state.sawLabels) return { done: state.kindStall >= STALL_ROUNDS };
  return { done: heightDone && keyDone };
}
// seed lastHeight from the page's INITIAL height (matches the live helper — the first observation isn't "growth").
function fresh(initialHeight = 0) { return { lastHeight: initialHeight, heightStall: 0, keys: new Set<string>(), lastKeyCount: 0, keyStall: 0, sawKeys: false, grew: false, kinds: new Set<string>(), kindStall: 0, sawLabels: false }; }

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)); };

// GROWING page: height keeps increasing → never done; then stalls → done after 3 no-growth rounds
{
  const s = fresh(500);   // starts 500px, then grows as infinite-scroll loads more
  ok('growing: not done while height grows', !step(s, { after: 1000, keys: [] }).done && !step(s, { after: 2000, keys: [] }).done && !step(s, { after: 3000, keys: [] }).done);
  ok('growing: done after 3 no-growth rounds', !step(s, { after: 3000, keys: [] }).done && !step(s, { after: 3000, keys: [] }).done && step(s, { after: 3000, keys: [] }).done);
  ok('growing: grew flag set', s.grew === true);
}

// VIRTUALIZED list: scrollHeight fixed (recycled rows) but NEW keys keep appearing → not done; then keys stall → done
{
  const s = fresh();
  ok('virtualized: not done while new keys appear', !step(s, { after: 800, keys: ['a', 'b'] }).done && !step(s, { after: 800, keys: ['c', 'd'] }).done && !step(s, { after: 800, keys: ['e'] }).done);
  ok('virtualized: done after 3 no-new-key rounds', !step(s, { after: 800, keys: ['a'] }).done && !step(s, { after: 800, keys: ['b'] }).done && step(s, { after: 800, keys: ['c'] }).done);
  ok('virtualized: dedup — total unique keys = 5 (a-e), recycled dups ignored', s.keys.size === 5);
}

// SHORT page: height stable at its initial value from the start, no keys ever → done after 3 flat rounds, never grew
{
  const s = fresh(500);   // page is already 500px tall; scrolling reveals nothing new
  ok('short page: done after 3 flat rounds, no keys', !step(s, { after: 500, keys: [] }).done && !step(s, { after: 500, keys: [] }).done && step(s, { after: 500, keys: [] }).done);
  ok('short page: never marked grew', s.grew === false);
}

// ── THE ADAPTIVE WIN (the user's infinite-scroll insight): a feed that GROWS FOREVER (height + new keys every scroll)
// but is all ONE KIND ("Item #N") must terminate on KIND-saturation after ~3 rounds — NOT scroll to the bottom of
// 10k rows. This is the case a fixed MAX_SCROLLS or a pure height/key stall would get catastrophically wrong.
{
  const s = fresh(500);
  let n = 500, done = false, iters = 0;
  for (let i = 0; i < 50 && !done; i++) {
    iters++;
    n += 25;   // height keeps growing
    const labels = [];                         // 25 fresh rows, all the SAME kind
    for (let r = 0; r < 25; r++) labels.push('Item #' + (n + r));
    const keys = labels.map((_, r) => 'row-' + (n + r));   // fresh keys every scroll (virtualized-recycled)
    done = step(s, { after: n * 10, keys, labels }).done;
  }
  ok('infinite 1-kind feed: terminates EARLY on kind-saturation (not 50 scrolls)', done && iters <= 6, );
  ok('infinite 1-kind feed: learned exactly 1 kind', s.kinds.size === 1);
}
// a HETEROGENEOUS feed (new kinds keep appearing) must NOT saturate early — keep scrolling while new kinds surface.
{
  const s = fresh(500);
  let done = false, iters = 0;
  const kindsSeen = ['Users', 'Orders', 'Invoices', 'Reports', 'Settings', 'Alerts'];
  for (let i = 0; i < 10 && !done; i++) {
    iters++;
    const labels = [kindsSeen[Math.min(i, kindsSeen.length - 1)] + ' #' + i];   // a NEW kind each scroll (until they run out)
    done = step(s, { after: 500 + i * 200, keys: [], labels }).done;
  }
  ok('heterogeneous feed: keeps scrolling while new kinds appear', iters >= 6);
  ok('heterogeneous feed: captured multiple distinct kinds', s.kinds.size >= 5);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
