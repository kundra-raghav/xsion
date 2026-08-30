/**
 * graphEdge.hermetic.ts — locks the CRAWL-b interaction-graph edge logic: how a (fromSig, action, toSig) edge is
 * derived from a Nav + the state signatures, deduped, and labeled new-vs-loop. Mirrors the inline logic in
 * crawlMapService (kept as a pure function here so the invariant is testable without a browser).
 */
import type { GraphEdge } from './crawlTypes';

// pure replica of the edge-derivation done inline at the crawl seam (parentSig → currentSig via the nav's last step)
function deriveEdge(
  nav: { url: string; clicks?: Array<string | { fill: string; value: string }>; _parentSig?: string },
  currentSig: string,
  toPath: string,
  seenSigs: Set<string>,
  collapsed: boolean,
): GraphEdge {
  const clicksArr = nav.clicks || [];
  const lastStep = clicksArr.length ? clicksArr[clicksArr.length - 1] : undefined;
  const action: GraphEdge['action'] = lastStep === undefined
    ? { kind: 'navigate', label: safePath(nav.url) }
    : (typeof lastStep === 'string' ? { kind: 'click', label: lastStep } : { kind: 'fill', label: `${lastStep.fill}=${lastStep.value}` });
  const toIsNew = !collapsed && !seenSigs.has(currentSig);
  return { fromSig: nav._parentSig || '', toSig: currentSig, action, toPath, toIsNew, toCollapsed: collapsed, count: 1 };
}
function safePath(u: string) { try { return new URL(u).pathname || '/'; } catch { return u; } }
function edgeKey(e: GraphEdge) { return `${e.fromSig || 'ROOT'}|${e.action.kind}:${e.action.label}|${e.toSig}`; }

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)); };

// a bare navigate from ROOT to a fresh state
const e1 = deriveEdge({ url: 'https://app/inventory.html' }, 'SIG_INV', '/inventory.html', new Set(), false);
ok('navigate edge: kind=navigate, from=ROOT(empty), toIsNew', e1.action.kind === 'navigate' && e1.fromSig === '' && e1.toIsNew);

// a click that leads to a NEW state
const e2 = deriveEdge({ url: 'https://app/inventory.html', clicks: ['Sauce Labs Backpack'], _parentSig: 'SIG_INV' }, 'SIG_PROD', '/inventory.html › Backpack', new Set(['SIG_INV']), false);
ok('click edge: kind=click, label=the click, from=parent', e2.action.kind === 'click' && e2.action.label === 'Sauce Labs Backpack' && e2.fromSig === 'SIG_INV');
ok('click edge to unseen sig → toIsNew', e2.toIsNew === true);

// a click that lands on an ALREADY-SEEN state (a second product → same product-detail state) = a loop, NOT new
const e3 = deriveEdge({ url: 'https://app/inventory.html', clicks: ['Sauce Labs Onesie'], _parentSig: 'SIG_INV' }, 'SIG_PROD', '/inventory.html › Onesie', new Set(['SIG_INV', 'SIG_PROD']), true);
ok('collapsed dest → toCollapsed, NOT toIsNew (the 6-products-one-state win)', e3.toCollapsed === true && e3.toIsNew === false);

// a fill step edge
const e4 = deriveEdge({ url: 'https://app/login', clicks: [{ fill: 'email', value: 'a@b.c' }], _parentSig: 'SIG_LOGIN' }, 'SIG_HOME', '/', new Set(['SIG_LOGIN']), false);
ok('fill edge: kind=fill, label=field=value', e4.action.kind === 'fill' && e4.action.label === 'email=a@b.c');

// DEDUP: same from+action+to collapses to one edge with count incremented
const m = new Map<string, GraphEdge>();
for (const e of [e2, e2]) { const k = edgeKey(e); const ex = m.get(k); if (ex) ex.count = (ex.count || 1) + 1; else m.set(k, { ...e }); }
ok('dedup: identical edge → one entry, count=2', m.size === 1 && [...m.values()][0].count === 2);
// but a DIFFERENT action from the same state is a distinct edge
const m2 = new Map<string, GraphEdge>();
for (const e of [e2, e3]) { const k = edgeKey(e); if (!m2.has(k)) m2.set(k, { ...e }); }
ok('distinct actions from same state → distinct edges', m2.size === 2);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
