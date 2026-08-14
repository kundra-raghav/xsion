/**
 * stateSignature.ts — the SHARED MEASUREMENT SUBSTRATE for guided exploration.
 *
 * Every exploration strategy (BFS, curiosity, SoA-semantic, code-seeded) is scored on the SAME question: "is this
 * app-state one I've seen before?" The curiosity signal `1/√N(state)` is meaningless without it — and Xsion's
 * current node identity (normUrl = route template) collapses every in-place SPA view to one node, which is exactly
 * the state these target apps (schooltalk/sloxt) are built out of. So we need a CONTENT-based signature.
 *
 * DESIGN (grounded in the research, not invented):
 *  • COARSE / COMPACT, deliberately. The near-duplicate study (Yandrapally/Mesbah, 493k pairs) proved NO DOM/visual
 *    threshold cleanly separates functional-duplicate from distinct states — so a fine signature is a false promise.
 *    The abstraction-granularity finding says COMPACT abstraction wins for RL-shaped (curiosity) drivers because a
 *    large state space overfits. So we bias toward MERGING (fewer, coarser states), and we LOG the collapse rate so
 *    its misbehaviour is visible rather than silent.
 *  • STRUCTURAL, not textual. We sketch the page's SHAPE — its route, its landmark structure, the SET of interactive
 *    affordances (button/link/input labels, normalized) — not its prose. Two "user detail" pages for different users
 *    share a structure and SHOULD collapse; a list view vs a form view differ in structure and should NOT.
 *  • Content is captured page-side in ONE evaluate() (cheap), then hashed here (pure, unit-testable).
 *
 * This module is intentionally free of Playwright types in its core (sigFromShape/hashShape are pure) so it can be
 * unit-tested with no browser. captureShape() is the only page-touching function.
 */
import { createHash } from 'crypto';

/** The raw structural sketch captured from a live page (or constructed in a test). All fields coarse on purpose. */
export interface PageShape {
  /** route template — origin + normalized pathname (ids→:id). The spine of identity; a real route change is always
   *  a new state. */
  routeKey: string;
  /** the SET of interactive affordance labels on the page, normalized + deduped + sorted. This is the load-bearing
   *  signal for SPA view-swaps: the same route with a different action-set is a different state. */
  affordances: string[];
  /** coarse landmark/structure counts — how many of each structural region. Distinguishes list-vs-form-vs-detail
   *  without being so fine that cosmetic churn splits a state. */
  landmarks: { forms: number; tables: number; lists: number; headings: number; nav: number };
  /** the primary heading text, normalized — a cheap semantic anchor ("Users" vs "Settings"). Optional; absent on
   *  headless views. */
  heading?: string;
  /** CONTENT VOLUME — a coarse count of data-bearing rows/items + a text-length band. DELIBERATELY OUTSIDE the
   *  signature (sigFromShape can't see it — digits stripped, heading excluded). This is what separates two pages
   *  with the SAME structure but DIFFERENT data (an EMPTY dashboard vs one with 11 events). Used ONLY by the
   *  collapse decision (structural-duplicate vs data-divergent-variant), never by the signature itself. */
  contentVolume?: number;
}

/**
 * COLLAPSE DECISION (the crawl-budget fix): given a NEW page's shape and the shapes we've already visited, decide
 * whether this page is a STRUCTURAL DUPLICATE (collapse — record the variant, don't deep-crawl its subtree) or a
 * page WORTH ENTERING (a new structure, OR the same structure with materially different content = data behind it).
 * PURE + testable. GENERAL — it names nothing app-specific; it collapses BECAUSE signatures + content match, so a
 * genuinely-different tenant (different features OR different data volume) is always entered.
 *
 * ★ THE SAFETY the advisor demanded: a DEGENERATE capture (empty affordances + zero landmarks — an unhydrated SPA)
 * is NEVER comparable and NEVER collapses. Empty pages all hash the same → collapsing them would skip real subtrees
 * (the exact bug: /demo Calendar captured empty → would merge with everything). So degenerate ⇒ always 'enter'.
 */
export function collapseDecision(
  shape: PageShape,
  seen: Array<{ sig: string; contentVolume?: number }>,
): { action: 'enter' | 'collapse'; reason: string; sig: string } {
  const sig = sigFromShape(shape);
  const degenerate = (shape.affordances?.length || 0) === 0 &&
    !((shape.landmarks?.forms || 0) + (shape.landmarks?.tables || 0) + (shape.landmarks?.lists || 0) + (shape.landmarks?.headings || 0) + (shape.landmarks?.nav || 0));
  if (degenerate) return { action: 'enter', reason: 'degenerate/unhydrated capture — never collapse an empty DOM', sig };
  const cv = shape.contentVolume ?? 0;
  const match = seen.find((s) => s.sig === sig);
  if (!match) return { action: 'enter', reason: 'new structure (unseen signature)', sig };
  // same signature — collapse ONLY if content volume is also similar (a true duplicate). Materially different content
  // = same shell, different DATA (empty vs full) → ENTER, so we don't skip a data-bearing page.
  const seenCv = match.contentVolume ?? 0;
  const hi = Math.max(cv, seenCv), lo = Math.min(cv, seenCv);
  const materiallyDifferent = hi - lo >= 3 && (lo === 0 || hi / Math.max(lo, 1) >= 2);   // ≥3 apart AND ≥2× (or one empty)
  if (materiallyDifferent) return { action: 'enter', reason: `same structure but content differs (${seenCv}→${cv}) — data behind it`, sig };
  return { action: 'collapse', reason: `structural duplicate (sig seen, content ${cv}≈${seenCv})`, sig };
}

/** Normalize a label/heading for stable comparison: lowercase, collapse whitespace, strip digits+punctuation noise,
 *  cap length. Digits are stripped so "Order #1041" and "Order #2277" collapse to the same affordance. */
export function normLabel(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[0-9]+/g, '#')          // any run of digits → a single placeholder (id/count-invariant)
    .replace(/[^\w #]+/g, '')         // drop punctuation/emoji noise
    .trim()
    .slice(0, 40);
}

/** Bucket a raw count into a coarse band so N vs N±1 rows never splits a state. 0 / 1 / few(2-4) / many(5+). */
function band(n: number): 0 | 1 | 2 | 3 { return n <= 0 ? 0 : n === 1 ? 1 : n <= 4 ? 2 : 3; }

/**
 * The canonical, order-independent structural key for a shape. Two shapes with the same routeKey, the same set of
 * (normalized) affordances, the same landmark BANDS, and the same heading hash to the SAME signature. Pure.
 */
export function sigFromShape(shape: PageShape): string {
  const affs = Array.from(new Set((shape.affordances || []).map(normLabel).filter(Boolean))).sort();
  // CAP the affordance set so a page that renders 200 near-identical rows doesn't get a unique signature per render
  // (it would defeat collapse). Keep the first N distinct normalized labels — enough to characterize the view.
  const cappedAffs = affs.slice(0, 24);
  const lm = shape.landmarks || { forms: 0, tables: 0, lists: 0, headings: 0, nav: 0 };
  // NOTE: the heading is DELIBERATELY EXCLUDED from the signature. The heading carries DATA identity (which school,
  // which order) not STRUCTURAL identity — including it makes every per-entity page unique (heading "Demo School
  // Dashboard" ≠ "Doon School Dashboard"), so distinctStates≈pagesVisited, collapseRate→0, curiosity 1/√N ties
  // everywhere → the guided arm degrades to BFS on exactly the per-entity apps we target. Same reasoning as normLabel
  // stripping digits so "Order #1041" ≡ "Order #2277": entity identity, even when it's words, is NOT structure. The
  // signature is NOT the frontier identity (navKey=routeKey+clicks still governs enqueue/dedup), so collapsing two
  // views never makes either unreachable — it only makes a re-visit of the same STRUCTURE score low, which is the
  // whole point of curiosity. Cost: same-route same-affordance-set but different-function views (Inbox vs Archive
  // both [Reply,Delete]) collapse; the click-path still separates them in the frontier.
  const parts = [
    'r:' + shape.routeKey,
    'l:' + [band(lm.forms), band(lm.tables), band(lm.lists), band(lm.headings), band(lm.nav)].join(','),
    'a:' + cappedAffs.join('|'),
  ];
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Capture the structural shape of the CURRENT page state, page-side, in one evaluate(). `routeKey` is passed in
 * (the caller already normalizes URLs). Playwright `Page` typed loosely to keep this module dependency-light.
 */
export async function captureShape(page: { evaluate: (fn: any) => Promise<any> }, routeKey: string): Promise<PageShape & { _captureError?: string }> {
  try {
    // IMPORTANT: NO named helper functions inside this evaluate. esbuild/tsx wraps named function/arrow expressions
    // with a `__name(...)` helper that does NOT exist in the browser context → the whole evaluate throws
    // "__name is not defined" and (previously) fell to the catch, yielding an EMPTY signature for every page — a
    // silent degeneracy that made all states collapse. Everything here is inlined, no helper closures.
    const raw = await page.evaluate(() => {
      const d: any = (globalThis as any).document;
      const interactiveSel = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, textarea';
      const els: any[] = Array.prototype.slice.call(d.querySelectorAll(interactiveSel)).slice(0, 300);
      const affordances: string[] = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
        if (!r || (r.width === 0 && r.height === 0)) continue;                 // skip invisible
        const t = ((el.getAttribute && el.getAttribute('aria-label')) || el.textContent || (el.getAttribute && el.getAttribute('placeholder')) || '').trim();
        if (t) affordances.push(t);
      }
      const hEl = d.querySelector('h1') || d.querySelector('h2') || d.querySelector('[role="heading"]');
      const heading = hEl ? ((hEl.getAttribute && hEl.getAttribute('aria-label')) || hEl.textContent || '').trim() : '';
      // CONTENT VOLUME: a coarse count of data-bearing ROWS/ITEMS (list items, table rows, cards, event-ish nodes)
      // — the signal that separates an EMPTY dashboard from one with 11 events. Deliberately NOT in the signature.
      // No named helpers inside (the tsx __name rule).
      const rowNodes: any[] = Array.prototype.slice.call(d.querySelectorAll('li, tr, [role="row"], [role="listitem"], [class*="item" i], [class*="card" i], [class*="event" i], [class*="row" i]'));
      let rows = 0;
      for (let i = 0; i < rowNodes.length; i++) {
        const el = rowNodes[i];
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
        if (r && (r.width > 0 || r.height > 0) && (el.textContent || '').trim()) rows++;
      }
      const textLen = ((d.body && d.body.innerText) || '').length;
      return {
        affordances,
        heading,
        landmarks: {
          forms: d.querySelectorAll('form').length,
          tables: d.querySelectorAll('table, [role="table"], [role="grid"]').length,
          lists: d.querySelectorAll('ul, ol, [role="list"], [role="listbox"]').length,
          headings: d.querySelectorAll('h1, h2, h3, [role="heading"]').length,
          nav: d.querySelectorAll('nav, [role="navigation"]').length,
        },
        contentVolume: rows + Math.floor(textLen / 500),   // rows dominate; text length is a coarse tiebreaker
      };
    });
    return { routeKey, affordances: raw.affordances || [], heading: raw.heading || undefined, landmarks: raw.landmarks, contentVolume: raw.contentVolume };
  } catch (e: any) {
    // capture failed (navigation mid-flight, detached frame, or an evaluate error). Degrade to a route-only shape,
    // but STAMP the error so a degenerate capture can never again masquerade as a real (all-collapsing) signature —
    // the caller/metrics can see captureError > 0 and know the run is invalid.
    return { routeKey, affordances: [], landmarks: { forms: 0, tables: 0, lists: 0, headings: 0, nav: 0 }, _captureError: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * Tracks visit counts per state signature AND the collapse rate — so we can SEE the equivalence misbehaving (the
 * research says it will). collapseRate = 1 - (distinct signatures / total observations): high = merging a lot
 * (maybe too coarse); near-0 = every observation is "new" (maybe too fine / normUrl-like). Report it, don't hide it.
 */
export class StateModel {
  private counts = new Map<string, number>();
  private observations = 0;
  /** record a visit to a state; returns the NEW visit count N for that state (≥1). Curiosity = 1/√N uses this. */
  visit(sig: string): number {
    this.observations++;
    const n = (this.counts.get(sig) || 0) + 1;
    this.counts.set(sig, n);
    return n;
  }
  count(sig: string): number { return this.counts.get(sig) || 0; }
  /** curiosity reward for (re)visiting `sig`: 1/√(N after the visit would be). Higher for unseen/rare states. */
  curiosity(sig: string): number { return 1 / Math.sqrt(this.count(sig) + 1); }
  distinctStates(): number { return this.counts.size; }
  totalObservations(): number { return this.observations; }
  /** 0 = every observation was a brand-new state (no collapse); →1 = heavy collapse. The health signal to log. */
  collapseRate(): number { return this.observations === 0 ? 0 : 1 - this.counts.size / this.observations; }
  snapshot(): { distinctStates: number; observations: number; collapseRate: number } {
    return { distinctStates: this.distinctStates(), observations: this.observations, collapseRate: this.collapseRate() };
  }
}
