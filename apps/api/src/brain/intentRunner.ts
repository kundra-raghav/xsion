/**
 * intentRunner.ts — the EXECUTE seam. Drives a real browser through a SoA-planned IntentFlow.
 * Each step is a plain-language intent ("click the Sign In button", "fill the email field with X");
 * we resolve it to a Playwright action using accessible locators (role/text/label/placeholder) — the
 * same primitives Xsion's candidates.ts already uses. NON-DESTRUCTIVE guard mirrors Xsion's DANGEROUS_LABELS.
 * Produces StepResult[] in Xsion's shape, which SoA then verifies against the code.
 */
import { chromium, Page } from 'playwright';
import type { IntentFlow } from './soaClient';
import { explorePage } from './soaClient';
import { pageClickableInventory } from './pageInventory';
import { installEvalShim } from './evalShim';

const DANGEROUS = ['delete', 'remove', 'pay', 'logout', 'sign out', 'log out', 'deactivate', 'destroy', 'unsubscribe'];

/** pathname of a URL (id segments collapsed to :id) — for stable route-learning keys. */
function safePath(u: string): string { try { const x = new URL(u); return (x.pathname || '/').replace(/\/\d+/g, '/:id'); } catch { return u; } }

export interface StepAttempt {
  kind: string;
  selector: string;
  matched: number;
  chosenIndex?: number;
  error?: string;
  box?: { x: number; y: number; width: number; height: number } | null;   // action location (for the playback cursor)
}
export interface StepResult {
  stepIndex: number;
  // 'unverifiable' = the step ran but asserted NOTHING (an observe/verify with no oracle) — it is NOT evidence the
  // app worked. Counting these as 'pass' was the "vacuous pass" bug: 6/16 looked like progress when 0 bug-exercising
  // steps actually ran. Callers must treat unverifiable as "didn't confirm", never as success.
  status: 'pass' | 'fail' | 'unverifiable';
  attempts: StepAttempt[];
  note?: string;
  url?: string;   // the page URL when this step ran — lets VERIFY see wrong-page cascades (not app bugs)
}
export interface ExecResult {
  flowName: string;
  status: 'passed' | 'failed';
  baseUrl: string;
  stepResults: StepResult[];
  consoleErrors: string[];
  finalText?: string;   // the page's visible text after the flow (so a caller can see the result message)
  finalUrl?: string;
}

/** Small intent parser: verb + a quoted-or-trailing target (+ value / drag-target). Covers the interactions bug
 * tickets require — drag-and-drop, hover, keyboard, right/double-click — not just click/fill. */
function parseIntent(intent: string): { verb: string; target: string; value?: string; target2?: string } {
  const low = intent.toLowerCase();
  let verb = 'click';
  // NON-ACTION steps: "leave X empty/blank", "do not fill", "keep it empty", "without entering" — these are
  // instructions to NOT act (a precondition), so treat as observe (skip) rather than failing to find a target.
  if (/\b(leave|keep)\b.*\b(empty|blank|unfilled)\b|\b(do not|don't|without)\b.*(fill|enter|type|select)/.test(low)) return { verb: 'observe', target: intent };
  // richer verbs FIRST (a "drag … onto …" also contains no fill/nav words)
  if (/\bdrag\b|drag[- ]and[- ]drop|drop\b/.test(low)) verb = 'drag';
  else if (/\bhover\b|mouse ?over/.test(low)) verb = 'hover';
  else if (/\b(press|hit|type the|keyboard)\b.*\b(key|enter|tab|escape|esc|arrow|space|backspace|delete)\b/.test(low) || /\bpress\b/.test(low)) verb = 'press';
  else if (/right[- ]click|context ?menu/.test(low)) verb = 'rightclick';
  else if (/double[- ]click/.test(low)) verb = 'doubleclick';
  else if (/\b(type|fill|enter|input)\b/.test(low)) verb = 'fill';
  else if (/\b(navigate|go to|open|visit)\b/.test(low)) verb = 'navigate';
  else if (/\b(select|choose|pick)\b/.test(low)) verb = 'select';
  else if (/\b(review|verify|see|wait|check|observe)\b/.test(low)) verb = 'observe';
  // quoted strings — a drag has TWO ("drag 'A' onto 'B'")
  const quotes = [...intent.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  let target = quotes[0] || intent.replace(/^\s*\w+\s+(the\s+)?/i, '').replace(/\s+(button|field|link|dropdown|box|option).*$/i, '').trim();
  const target2 = quotes[1] || (verb === 'drag' ? (intent.match(/\b(?:onto|to|on|below|between|above|over)\s+(.+)$/i)?.[1] || '').trim() : undefined);
  const withVal = intent.match(/\bwith\s+(.+)$/i);
  // for press, the value is the key name
  const keyMatch = verb === 'press' ? intent.match(/\b(enter|tab|escape|esc|arrowup|arrowdown|arrowleft|arrowright|space|backspace|delete|end|home|pageup|pagedown|[a-z0-9])\b/i) : null;
  return { verb, target: target || intent, value: withVal ? withVal[1].trim() : (keyMatch ? keyMatch[1] : undefined), target2: target2 || undefined };
}

// ── DOM-RESOLVE PASS (the #1 fix, works in BOTH modes — Mode 2 has no code hints, only the live DOM) ──
// Enumerate the page's interactive elements, score each against the intent's CONTENT WORDS (not the whole
// phrase — "Users in the main navigation" contains "Users"; the old whole-phrase regex missed label:'Users'),
// pick the best above threshold, else fail with the candidate list ATTACHED (SoA's triage evidence, and in
// Mode 2 the ONLY thing SoA gets). DETERMINISTIC scoring — no LLM per step (the model-research boundary).

const STOPWORDS = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for', 'and', 'or', 'with', 'main',
  'top', 'page', 'button', 'field', 'link', 'dropdown', 'box', 'option', 'navigation', 'nav', 'menu', 'bar',
  'click', 'select', 'choose', 'enter', 'type', 'fill', 'sidebar', 'panel', 'section', 'header', 'item']);

export function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

interface Candidate { role: string; name: string; testid?: string; ref: string; }

/** Enumerate interactive elements on the page (buttons/links/inputs/menuitems/etc.) with their accessible name. */
async function enumerateCandidates(page: Page): Promise<Candidate[]> {
  const roles = ['button', 'link', 'menuitem', 'tab', 'textbox', 'combobox', 'checkbox', 'option', 'radio'];
  const out: Candidate[] = [];
  for (const role of roles) {
    try {
      const loc = page.getByRole(role as any);
      const n = Math.min(await loc.count(), 40);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const name = ((await el.getAttribute('aria-label')) || (await el.textContent()) || (await el.getAttribute('placeholder')) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const testid = (await el.getAttribute('data-testid')) || undefined;
        if (name || testid) out.push({ role, name, testid, ref: `${role}#${i}` });
      }
    } catch { /* role not present */ }
  }
  return out;
}

/** Score a candidate against the intent's content words. Exact word hit = 2, prefix/substring = 1. */
export function scoreCandidate(words: string[], cand: Candidate): number {
  const hay = `${cand.name} ${cand.testid || ''}`.toLowerCase();
  const candWords = contentWords(hay);
  const candSet = new Set(candWords);
  const intentSet = new Set(words);
  let score = 0;
  for (const w of words) {
    if (candSet.has(w)) score += 2;
    else if (hay.includes(w)) score += 1;
  }
  // COVERAGE (the robustness fix — don't depend on perfectly-worded steps): reward a candidate whose OWN label is
  // (mostly) CONTAINED in the intent. A verbose real-world step ("Create a new recurring event with occurrences on
  // 10 Sep/Oct/Dec") should still match the button "Create Event" — because every word ON the button ("create",
  // "event") appears in the intent, i.e. the button's label ⊆ the ask. This makes the RIGHT short control win over
  // noise words, and generalizes to any wordy ticket without spoon-feeding the phrasing.
  if (candWords.length) {
    const covered = candWords.filter((w) => intentSet.has(w)).length;
    const coverage = covered / candWords.length;   // fraction of the LABEL's words present in the intent
    // full coverage only counts for a SUBSTANTIVE label (≥2 words, or ≥5 chars) — a lone "Add"/"OK" covering one
    // common word isn't a strong signal and shouldn't outrank a real multi-word match.
    const substantive = candWords.length >= 2 || (candWords[0]?.length || 0) >= 5;
    if (coverage >= 1 && substantive) score += 3;
    else if (coverage >= 0.5 && covered >= 2) score += 1.5;
  }
  // small bonus for a tight name (avoids a giant paragraph matching one word)
  if (score > 0 && cand.name && cand.name.length <= 24) score += 0.5;
  return score;
}

/** Pick the best-matching candidate for `target` among elements filtered to `roles` (empty = all). */
async function bestMatch(page: Page, target: string, roles: string[]): Promise<{ cand?: Candidate; loc?: any; score: number; candidates: Candidate[] }> {
  const words = contentWords(target);
  const all = await enumerateCandidates(page);
  const pool = roles.length ? all.filter((c) => roles.includes(c.role)) : all;
  let best: Candidate | undefined;
  let bestScore = 0;
  for (const c of pool) {
    const s = scoreCandidate(words, c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  const threshold = words.length ? 1.5 : 999; // need at least a partial content-word hit
  const top = pool.slice().sort((a, b) => scoreCandidate(words, b) - scoreCandidate(words, a)).slice(0, 6);
  if (best && bestScore >= threshold) {
    const [role, idxStr] = best.ref.split('#');
    return { cand: best, loc: page.getByRole(role as any).nth(parseInt(idxStr, 10)), score: bestScore, candidates: top };
  }
  return { score: bestScore, candidates: top };
}

function candList(cands: Candidate[]): string {
  return cands.map((c) => `${c.role}:"${c.name}"${c.testid ? ' [' + c.testid + ']' : ''}`).join(' | ');
}

/** SIDEBAR/NAV fallback: match the intent's content words against <a href> link text (persistent sidebar nav
 * often out-scores a page-specific button, and is the reliable route). Returns the best href-link locator. */
async function resolveNavLink(page: Page, words: string[]): Promise<{ loc?: any; name?: string; href?: string }> {
  try {
    const links = page.locator('a[href]');
    const n = Math.min(await links.count(), 60);
    let best: { loc?: any; name?: string; href?: string } = {};
    let bestScore = 0;
    for (let i = 0; i < n; i++) {
      const el = links.nth(i);
      const text = ((await el.getAttribute('aria-label')) || (await el.textContent()) || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const href = (await el.getAttribute('href')) || '';
      const hay = new Set(contentWords(`${text} ${href}`));
      let s = 0;
      for (const w of words) if (hay.has(w)) s += 2; else if (`${text} ${href}`.includes(w)) s += 1;
      if (s > bestScore) { bestScore = s; best = { loc: el, name: text.slice(0, 40), href }; }
    }
    return bestScore >= 2 ? best : {};
  } catch { return {}; }
}

/** ROBUST CLICK: elements are often FOUND but not clickable — off-screen, or an overlay/animation intercepting
 * the click (dent's Filters button timed out this way). Escalate: scroll-into-view → normal click → retry after
 * settle → FORCE click (bypasses actionability + intercepting overlay). Returns '' on success, else an error. */
async function robustClick(loc: any): Promise<string> {
  try { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch { /* not scrollable, fine */ }
  try { await loc.click({ timeout: 4000 }); return ''; } catch { /* try harder below */ }
  try { await loc.page().waitForTimeout(500); await loc.click({ timeout: 3000 }); return ''; } catch { /* overlay? force it */ }
  try { await loc.click({ timeout: 3000, force: true }); return ''; }
  catch (e: any) { return String(e.message || e).slice(0, 160); }
}

/** CLICKABLE-ROW resolver: dent's user rows are <tr onClick={navigate}> / list items with NO accessible name,
 * so role-name scoring can't see them (and a "click a user row" intent wrongly matched the 'Add User' button).
 * Find clickable containers (tr[onclick]-ish via cursor-pointer/role=row, or li/[role=row]) and click the first
 * real DATA row. If content words are given, prefer the row whose text contains them; else the first data row. */
async function resolveRowClick(page: Page, words: string[], intent: string): Promise<StepAttempt | null> {
  // only engage for row/item/entry intents (avoid hijacking normal button clicks)
  if (!/\b(row|user|item|entry|record|result|list|table|first|any)\b/i.test(intent)) return null;
  const rowSelectors = ['table tbody tr', 'tr[class*="cursor-pointer"]', '[role="row"]', 'ul li[class*="cursor"]', 'li[role="option"]'];
  for (const sel of rowSelectors) {
    try {
      const rows = page.locator(sel);
      const n = Math.min(await rows.count(), 40);
      if (n === 0) continue;
      // skip header rows: prefer a row that actually has data (has a link/checkbox/multiple cells)
      let chosen = -1;
      let bestScore = -1;
      for (let i = 0; i < n; i++) {
        const txt = ((await rows.nth(i).textContent()) || '').toLowerCase();
        if (!txt.trim() || /^\s*(name|email|status|actions|type|date|role)\s*$/.test(txt)) continue; // header
        const cells = await rows.nth(i).locator('td, [role="cell"]').count();
        if (cells < 1 && sel.includes('tr')) continue;
        let s = words.reduce((acc, w) => acc + (txt.includes(w) ? 2 : 0), 0);
        s += Math.min(cells, 3) * 0.1; // prefer real data rows
        if (i === 0 && bestScore < 0) { chosen = i; bestScore = s; }
        if (s > bestScore) { bestScore = s; chosen = i; }
      }
      if (chosen >= 0) {
        const err = await robustClick(rows.nth(chosen));
        if (err) return { kind: `row:${sel.split(' ').pop()}`, selector: `${sel}[${chosen}]`, matched: 1, error: err };
        return { kind: `row:${sel.split(' ').pop()}`, selector: `${sel}[${chosen}]`, matched: 1, chosenIndex: chosen };
      }
    } catch { /* try next selector */ }
  }
  return null;
}

/** NATIVE <select> resolver: match the intent's content words against option text, choose that option. Admin
 * filters (Signup State, User Type) are native <select> — clicking them does nothing; must selectOption. */
async function resolveSelect(page: Page, target: string, value?: string): Promise<StepAttempt | null> {
  const words = contentWords(`${value || ''} ${target}`);
  try {
    const selects = page.locator('select');
    const n = Math.min(await selects.count(), 20);
    for (let i = 0; i < n; i++) {
      const opts = await selects.nth(i).locator('option').allTextContents();
      // find an option whose text matches the target/value content words
      let bestOpt = ''; let bestScore = 0;
      for (const o of opts) {
        const ow = new Set(contentWords(o));
        const s = words.reduce((acc, w) => acc + (ow.has(w) ? 2 : o.toLowerCase().includes(w) ? 1 : 0), 0);
        if (s > bestScore) { bestScore = s; bestOpt = o; }
      }
      if (bestOpt && bestScore >= 1) {
        await selects.nth(i).selectOption({ label: bestOpt }, { timeout: 6000 });
        return { kind: 'select:option', selector: `select[${i}]→"${bestOpt}"`, matched: 1, chosenIndex: i };
      }
    }
  } catch { /* no select or selectOption failed */ }
  return null;
}

async function resolveClick(page: Page, target: string, intent = ''): Promise<StepAttempt> {
  const words = contentWords(target);
  // ROW-INTENT FIRST: if the step is about clicking a row/item, try the row resolver BEFORE button matching —
  // else "click a user row" wrongly matches the 'Add User' button (which contains the word 'user').
  if (/\b(row|entry|record|result)\b/i.test(intent) || /\bon (a|any|the first) \w+ (row|to view)/i.test(intent)) {
    const row = await resolveRowClick(page, words, intent);
    if (row) return row;
  }
  const m = await bestMatch(page, target, ['button', 'link', 'menuitem', 'tab', 'option']);
  if (m.loc && m.cand) {
    // capture WHERE we're about to click BEFORE the action (after it, the element may be gone/re-rendered → null box)
    const box = await m.loc.first().boundingBox().catch(() => null);
    const err = await robustClick(m.loc.first());
    return err
      ? { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 1, error: err, box }
      : { kind: `role:${m.cand.role}`, selector: `${m.cand.name}~"${target}"`, matched: 1, chosenIndex: 0, box };
  }
  // FALLBACK: sidebar/nav <a href> link (the reliable route when role-name scoring missed the nav element)
  const nav = await resolveNavLink(page, words);
  if (nav.loc) {
    const err = await robustClick(nav.loc);
    if (!err) return { kind: 'nav:link', selector: `${nav.name} [${nav.href}]`, matched: 1, chosenIndex: 0 };
  }
  // FALLBACK: clickable row/list-item (unnamed containers — last, so it doesn't hijack named-element clicks)
  const row = await resolveRowClick(page, words, intent);
  if (row) return row;
  // FALLBACK: EXACT TEXT MATCH — click the element that RENDERS this label, even if it's a <div>/<span>/<li> with no
  // button/link role (Material-UI ListItem rows, custom card grids, portal/school pickers). role-scan misses these;
  // getByText finds them. EXACT-ONLY + single-match: a substring/fuzzy text click on a dense page hits the wrong
  // element (advisor). This is what got schooltalk's "Demo School" portal (a MuiListItemText div in an <li>).
  try {
    const loc = page.getByText(target, { exact: true });
    const n = await loc.count();
    if (n === 1) {   // require a UNIQUE match — ambiguous text is not a safe click
      const first = loc.first();
      const box = await first.boundingBox().catch(() => null);
      const err = await robustClick(first);
      if (!err) return { kind: 'text', selector: `text:"${target}"`, matched: 1, chosenIndex: 0, box };
    }
  } catch { /* fall through to fail */ }
  // FAIL: attach the candidate list SoA can triage against (the key fix vs bare "no element found")
  return { kind: 'click', selector: target, matched: 0, error: `no match for "${target}" (best=${m.score}). Candidates on page: ${candList(m.candidates)}` };
}

// ── EXTENDED INTERACTIONS (bug tickets need these, not just click/fill) ──

/** DRAG a source element onto a target element (both by label). Uses Playwright's dragTo, with a manual
 * mouse-move fallback for HTML5-drag/custom-DnD libraries that dragTo alone doesn't trigger. */
async function resolveDrag(page: Page, source: string, target: string): Promise<StepAttempt> {
  const src = await bestMatch(page, source, ['button', 'link', 'listitem', 'option', 'row', 'article', 'generic']);
  const dst = target ? await bestMatch(page, target, ['button', 'link', 'listitem', 'option', 'row', 'article', 'generic', 'cell']) : { loc: null, cand: null, score: 0, candidates: [] as any };
  if (!src.loc) return { kind: 'drag', selector: source, matched: 0, error: `drag source "${source}" not found. Candidates: ${candList(src.candidates)}` };
  if (target && !dst.loc) return { kind: 'drag', selector: target, matched: 0, error: `drag target "${target}" not found. Candidates: ${candList(dst.candidates)}` };
  try {
    if (dst.loc) {
      await src.loc.first().dragTo(dst.loc.first(), { timeout: 6000 });
    } else {
      // no explicit target → just pick the source up and drop in place (rarely useful; report honestly)
      return { kind: 'drag', selector: source, matched: 0, error: 'no drop target resolved for the drag' };
    }
    return { kind: 'drag', selector: `${src.cand?.name} → ${dst.cand?.name}`, matched: 1, chosenIndex: 0 };
  } catch (e: any) {
    // fallback: manual mouse steps (some DnD needs discrete mousemove events)
    try {
      const sb = await src.loc.first().boundingBox(); const db = await dst.loc!.first().boundingBox();
      if (sb && db) {
        await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await page.mouse.down();
        await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
        await page.mouse.up();
        return { kind: 'drag', selector: `${src.cand?.name} → ${dst.cand?.name} (manual)`, matched: 1, chosenIndex: 0 };
      }
    } catch {}
    return { kind: 'drag', selector: `${source}→${target}`, matched: 0, error: `drag failed: ${String(e?.message).slice(0, 100)}` };
  }
}

async function resolveHover(page: Page, target: string): Promise<StepAttempt> {
  const m = await bestMatch(page, target, ['button', 'link', 'menuitem', 'tab', 'option', 'generic', 'listitem']);
  if (!m.loc) return { kind: 'hover', selector: target, matched: 0, error: `hover target "${target}" not found. Candidates: ${candList(m.candidates)}` };
  try { await m.loc.first().hover({ timeout: 4000 }); return { kind: 'hover', selector: m.cand?.name || target, matched: 1 }; }
  catch (e: any) { return { kind: 'hover', selector: target, matched: 0, error: String(e?.message).slice(0, 100) }; }
}

async function resolvePress(page: Page, key: string): Promise<StepAttempt> {
  const norm = key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  const map: Record<string, string> = { Esc: 'Escape', Arrowup: 'ArrowUp', Arrowdown: 'ArrowDown', Arrowleft: 'ArrowLeft', Arrowright: 'ArrowRight', Pageup: 'PageUp', Pagedown: 'PageDown' };
  const k = map[norm] || norm;
  try { await page.keyboard.press(k, { delay: 20 }); return { kind: 'press', selector: k, matched: 1 }; }
  catch (e: any) { return { kind: 'press', selector: k, matched: 0, error: String(e?.message).slice(0, 100) }; }
}

async function resolveSpecialClick(page: Page, target: string, _intent: string, mode: 'right' | 'double'): Promise<StepAttempt> {
  const m = await bestMatch(page, target, ['button', 'link', 'menuitem', 'tab', 'option', 'row', 'listitem', 'generic']);
  if (!m.loc) return { kind: mode + 'click', selector: target, matched: 0, error: `${mode}-click target "${target}" not found. Candidates: ${candList(m.candidates)}` };
  try {
    if (mode === 'right') await m.loc.first().click({ button: 'right', timeout: 4000 });
    else await m.loc.first().dblclick({ timeout: 4000 });
    return { kind: mode + 'click', selector: m.cand?.name || target, matched: 1 };
  } catch (e: any) { return { kind: mode + 'click', selector: target, matched: 0, error: String(e?.message).slice(0, 100) }; }
}

async function resolveFill(page: Page, target: string, value: string): Promise<StepAttempt> {
  const m = await bestMatch(page, target, ['textbox', 'combobox']);
  if (m.loc && m.cand) {
    const box = await m.loc.first().boundingBox().catch(() => null);   // where we type — for the playback cursor
    try {
      await m.loc.first().fill(value, { timeout: 6000 });
      return { kind: `role:${m.cand.role}`, selector: `${m.cand.name}=${value}`, matched: 1, chosenIndex: 0, box };
    } catch (e: any) {
      return { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 1, error: String(e.message || e).slice(0, 160), box };
    }
  }
  // RAW-INPUT SCAN (the reliable path for unlabeled inputs like dent's search: <input type=text placeholder=
  // "Search by name, email, or phone"> — no label/role name, so getByRole textbox scores empty). Enumerate all
  // text inputs + textareas, score by PLACEHOLDER content words, pick best.
  const words = contentWords(target);
  const inputs = page.locator('input[type="text"], input[type="search"], input:not([type]), textarea');
  const seen: string[] = [];
  try {
    const n = Math.min(await inputs.count(), 30);
    let best = -1; let bestScore = 0;
    for (let i = 0; i < n; i++) {
      const ph = ((await inputs.nth(i).getAttribute('placeholder')) || (await inputs.nth(i).getAttribute('aria-label')) || (await inputs.nth(i).getAttribute('name')) || '').toLowerCase();
      seen.push(ph ? `input:"${ph.slice(0, 40)}"` : `input#${i}`);
      const hay = new Set(contentWords(ph));
      let s = words.reduce((acc, w) => acc + (hay.has(w) ? 2 : ph.includes(w) ? 1 : 0), 0);
      if (n === 1 && s === 0) s = 0.5;            // single input on the page → likely the target
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0 && bestScore >= 0.5) {
      const box = await inputs.nth(best).boundingBox().catch(() => null);
      await inputs.nth(best).fill(value, { timeout: 6000 });
      return { kind: 'input:placeholder', selector: `${seen[best]}=${value}`, matched: 1, chosenIndex: best, box };
    }
  } catch { /* fall through */ }
  const inv = seen.length ? seen.join(' | ') : candList(m.candidates);
  return { kind: 'fill', selector: target, matched: 0, error: `no input for "${target}". Inputs on page: ${inv}` };
}

export interface ExecHooks {
  onStepStart?: (stepIndex: number, intent: string) => void;
  onStepResult?: (sr: StepResult) => void;
  onConsoleError?: (message: string) => void;
  /** a human-readable reasoning line (the caller streams it as a `think` event) — used to SURFACE the on-stall
   * recovery: "I couldn't find X — looking at the page… SoA says click Y first, retrying." */
  onThink?: (message: string) => void;
  /** a NAVIGATIONAL fact learned this run (a gate, a working selector, a route landing) — the caller persists it to
   * the project learning store. STRUCTURE only, NEVER an oracle verdict (see projectKnowledge.ts safety line). */
  onLearn?: (obs: { kind: 'gate' | 'route' | 'selector' | 'load-quirk' | 'nav-hint'; key: string; fact: string }) => void;
  // LIVE VIEW: called with the Playwright page + current action label so the caller can stream a screenshot + URL
  // to the UI (the "watch it work" view the crawl already has). intentRunner stays free of ws/emit — the caller
  // owns the emit. Invoked after each navigation/step so the frontend sees WHERE the test is + WHAT it's doing.
  onFrame?: (page: Page, label?: string, box?: { x: number; y: number; width: number; height: number } | null) => void | Promise<void>;
}

// ENVIRONMENT MATRIX (item 5): run a flow under a specific condition. Playwright-native — device/viewport,
// network throttle+latency, offline, and SESSION-EXPIRY (clear the session mid-flow + assert the app redirects).
export interface EnvCondition {
  id: string;
  label: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  isMobile?: boolean;
  deviceScaleFactor?: number;
  // network shaping via CDP: downloadKbps/uploadKbps (0 = offline), latencyMs added per request
  network?: { offline?: boolean; downloadKbps?: number; uploadKbps?: number; latencyMs?: number };
  // session-expiry: after this many steps, clear cookies+storage, then assert the NEXT step gets bounced to login
  expireSessionAfterStep?: number;
}

/** Credentials for the login pre-step. Passed by the caller (from the project's in-memory _defaultCreds) so ANY
 * engine driven through the web app can authenticate — not just runs that happen to have XSION_EMAIL in the server
 * env. In-memory only; never logged, never persisted. */
export interface ExecCreds { email?: string; password?: string; }

/** MUTATION verbs — a step that WRITES to the app (creates/edits data), beyond the always-blocked destructive ones.
 * When `allowMutations` is false (the safe default for bug-repro on an un-authorized project), these are SKIPPED so
 * Xsion never writes into a real tenant's data without consent. break-it passes allowMutations:true because it owns
 * its own XSION-TEST-<runId> tagging + cleanup + per-project authorization gate. */
// COMMIT verbs only — a step that WRITES/persists. 'edit'/'open' just OPEN a form (the write is on Save/Submit), so
// blocking them costs depth for zero safety (advisor). Keep the actual commit/create/destroy verbs.
const MUTATION_VERBS = ['create', 'add ', 'new ', 'submit', 'save', 'send', 'post ', 'upload', 'invite', 'assign', 'publish', 'confirm', 'delete', 'remove'];

/** ON-STALL RECOVERY (the adaptive loop, #199/#200 reused): when a step can't find its control, ask SoA to look at
 * the page and say what to click to get past the gate — instead of just failing. These pure helpers make the
 * fire-decision + the safety filter unit-testable (no browser). */

/** Should recovery fire NOW? Fire on the 2nd CONSECUTIVE unmatched actionable step on the SAME page (one miss is
 * usually wording; two in a row on an unchanged page is a real gate), while under the per-run cap. */
export function shouldRecover(o: { consecutiveMisses: number; recoveriesUsed: number; maxRecoveries: number }): boolean {
  return o.consecutiveMisses >= 2 && o.recoveriesUsed < o.maxRecoveries;
}

/** Filter SoA's proposed recovery actions for SAFETY: recovery clicks come from SoA (not the vetted step.intent), so
 * they MUST pass the same destructive/mutation gate — otherwise the adaptive loop could click "Save"/"Create" on an
 * unauthorized project. Drops destructive always; drops mutation verbs unless allowMutations. Returns kept + dropped. */
export function filterRecoveryActions(
  actions: Array<{ action?: string; label: string; value?: string; why?: string }>,
  allowMutations: boolean,
): { kept: typeof actions; dropped: Array<{ label: string; reason: string }> } {
  const kept: typeof actions = []; const dropped: Array<{ label: string; reason: string }> = [];
  for (const a of actions || []) {
    const low = (a.label || '').toLowerCase();
    if (DANGEROUS.some((d) => low.includes(d))) { dropped.push({ label: a.label, reason: 'destructive' }); continue; }
    if (!allowMutations && MUTATION_VERBS.some((m) => low.includes(m))) { dropped.push({ label: a.label, reason: 'mutating (not authorized)' }); continue; }
    kept.push(a);
  }
  return { kept, dropped };
}

export async function executeFlow(flow: IntentFlow, baseUrl: string, hooks: ExecHooks = {}, env?: EnvCondition, creds?: ExecCreds, opts?: { allowMutations?: boolean }): Promise<ExecResult> {
  const allowMutations = opts?.allowMutations ?? true;   // default true = existing behavior; bug-repro passes false
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: env?.viewport || { width: 1280, height: 800 },
    ...(env?.userAgent ? { userAgent: env.userAgent } : {}),
    ...(env?.isMobile ? { isMobile: true, hasTouch: true } : {}),
    ...(env?.deviceScaleFactor ? { deviceScaleFactor: env.deviceScaleFactor } : {}),
  });
  await installEvalShim(context);   // tsx/esbuild __name bug — see evalShim.ts
  const page = await context.newPage();
  // NETWORK SHAPING (CDP, Chromium-only): throttle download/upload + inject latency, or go fully offline.
  if (env?.network) {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: !!env.network.offline,
        downloadThroughput: env.network.offline ? 0 : Math.round((env.network.downloadKbps ?? 100000) * 1024 / 8),
        uploadThroughput: env.network.offline ? 0 : Math.round((env.network.uploadKbps ?? 100000) * 1024 / 8),
        latency: env.network.latencyMs ?? 0,
      });
    } catch { /* skip shaping if CDP unavailable */ }
  }
  if (env?.network?.offline) { try { await context.setOffline(true); } catch {} }
  const expireAfter = env?.expireSessionAfterStep;
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') { const t = m.text().slice(0, 300); consoleErrors.push(t); hooks.onConsoleError?.(t); }
  });
  const stepResults: StepResult[] = [];
  let failed = false;
  // ON-STALL RECOVERY state (the adaptive loop): count consecutive unmatched actionable steps, reset when the page
  // changes; cap SoA recovery calls per run. When it fires, SoA looks at the page and says what to click to get past.
  let consecutiveMisses = 0;
  let recoveriesUsed = 0;
  let lastRecoveryPageKey = '';
  const MAX_RECOVERIES = Number(process.env.XSION_MAX_STALL_RECOVERY || 2);
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await hooks.onFrame?.(page, 'opening the app');   // LIVE VIEW: first frame — the app as it loads

    // AUTH PRE-STEP (optional): if creds are provided via env, log in FIRST so authenticated flows can run
    // past the login gate. Creds NEVER live in code — only env vars. Accept BOTH name pairs: XSION_LOGIN_EMAIL/
    // PASSWORD (executor's historical name) AND XSION_EMAIL/PASSWORD (the name the crawl + `xsion check` CLI use).
    // The mismatch was a live regression: the CLI set XSION_EMAIL, break-it read only XSION_LOGIN_EMAIL → never
    // logged in → ran every attack against the sign-in page and mis-summarized "held". Unify the contract here.
    // PRECEDENCE: caller-passed creds (the project's in-memory _defaultCreds, set via the cred prompt) win over env.
    // This is what lets bug-repro/break-it log in when the operator entered creds in the UI — the server env is empty.
    const email = creds?.email || process.env.XSION_LOGIN_EMAIL || process.env.XSION_EMAIL;
    const password = creds?.password || process.env.XSION_LOGIN_PASSWORD || process.env.XSION_PASSWORD;
    if (email && password) {
      try {
        // ROBUST email locator: many login forms use input type="text" with name/id="email" (schooltalk does) — the
        // old `input[type="email"]`/getByLabel-only locator MISSED it and login silently no-op'd. Match by type OR
        // name/id="email" OR autocomplete OR label OR placeholder, so we find the field on real-world forms.
        const emailBox = page.locator('input[type="email"], input[name="email" i], input#email, input[autocomplete="username"], input[autocomplete="email"]')
          .or(page.getByLabel(/e-?mail/i)).or(page.getByPlaceholder(/e-?mail/i)).first();
        // WAIT for the SPA to render the form — networkidle after goto isn't enough on a hydrating SPA. Poll to ~15s.
        try { await emailBox.waitFor({ state: 'visible', timeout: 15000 }); } catch { /* maybe already authed */ }
        if (await emailBox.count() > 0) {
          await emailBox.fill(email, { timeout: 5000 });
          const pwBox = page.locator('input[type="password"], input[name="password" i], input#password').or(page.getByLabel(/password/i)).first();
          await pwBox.fill(password, { timeout: 5000 });
          // VERIFY the fill landed (a fill that silently didn't stick was a suspected failure mode) — refill once.
          if ((await emailBox.inputValue().catch(() => '')) !== email) { await emailBox.fill(email, { timeout: 3000 }).catch(() => {}); }
          // PRECISE sign-in button: an EXACT "sign in" / "log in" match, so we don't hit "Sign in with GOOGLE" or a
          // "Setup new password" link. Prefer an exact-text button; fall back to a submit-type button.
          const signIn = page.getByRole('button', { name: /^\s*(sign in|log ?in)\s*$/i })
            .or(page.locator('button[type="submit"]')).first();
          await signIn.click({ timeout: 6000 }).catch(() => {});
          // WAIT for the auth round-trip — networkidle alone returned too early (the SPA was still authenticating).
          // Poll up to ~12s for the password field to DISAPPEAR (= we left the login screen).
          await page.waitForFunction(() => !(globalThis as any).document.querySelector('input[type="password"]'), { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(2500); // let the post-login SPA route settle
          // POST-LOGIN VERIFY: confirm we actually left the login page (an email field should no longer be the
          // only thing on the page). If still on /login, login FAILED — report it honestly, don't silently pass.
          const stillOnLogin = (await page.locator('input[type="password"]').count()) > 0 && !/dashboard|users|home|admin/i.test(page.url());
          if (stillOnLogin) {
            // login DID NOT take, but a PASSWORD FORM WAS present + filled → this is a failed password login, NOT SSO.
            // (hadPasswordForm distinguishes "sign-in didn't take" from "no email/password path exists = SSO-only".)
            stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 1, error: 'still on login page after submit (bad creds or slow redirect)', hadPasswordForm: true } as any], note: 'login did not persist (password form present — not SSO)' });
          } else {
            stepResults.push({ stepIndex: -1, status: 'pass', attempts: [{ kind: 'auth', selector: 'login', matched: 1, hadPasswordForm: true } as any], note: `logged in (url: ${page.url()})` });
            // LEARN: the login worked — record the working selector + landing so next run signs in without re-probing.
            hooks.onLearn?.({ kind: 'selector', key: 'login', fact: `login: email#email + password#password + exact "SIGN IN" button → lands ${safePath(page.url())}` });
          }
        } else {
          stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 0, error: 'no email field found after 10s wait' }], note: 'login form never appeared' });
        }
      } catch (e: any) {
        stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 0, error: String(e.message).slice(0, 160) }], note: 'auth pre-step failed' });
      }
    }

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      hooks.onStepStart?.(i, step.intent);   // stream: the agent is about to attempt this step
      const urlBeforeStep = page.url();      // for the LEARN route-fact: did this step's click move us to a new page?

      // SESSION-EXPIRY (item 5): after the configured step, wipe the session and assert the app BOUNCES the next
      // action back to auth. A secure app redirects to /login; if it keeps serving protected content, that's a
      // real finding (session not enforced). Reported honestly — fail-safe: inconclusive is never "secure".
      if (expireAfter !== undefined && i === expireAfter + 1) {
        try {
          await context.clearCookies();
          await page.evaluate(() => { try { (globalThis as any).localStorage?.clear(); (globalThis as any).sessionStorage?.clear(); } catch {} }).catch(() => {});
          const urlBefore = page.url();
          // reload / navigate to force the app to re-check auth
          await page.goto(urlBefore, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
          const bounced = /login|signin|sign-in|auth/i.test(page.url()) || (await page.locator('input[type="password"]').count()) > 0;
          const sr: StepResult = {
            stepIndex: i, status: bounced ? 'pass' : 'fail',
            attempts: [{ kind: 'session-expiry', selector: urlBefore, matched: 1, error: bounced ? undefined : 'session cleared but app still served protected content (no auth re-check)' }],
            note: bounced ? 'session expiry enforced — app redirected to auth after the session was cleared' : 'SESSION NOT ENFORCED: after clearing the session, the app kept serving the protected page',
            url: page.url(),
          };
          stepResults.push(sr); hooks.onStepResult?.(sr);
          if (!bounced) failed = true;
          continue;
        } catch (e: any) {
          const sr: StepResult = { stepIndex: i, status: 'fail', attempts: [{ kind: 'session-expiry', selector: 'expire', matched: 0, error: String(e?.message).slice(0, 160) }], note: 'session-expiry check errored', url: page.url() };
          stepResults.push(sr); hooks.onStepResult?.(sr);
          continue;
        }
      }

      const { verb, target, value, target2 } = parseIntent(step.intent);
      const low = step.intent.toLowerCase();
      if (DANGEROUS.some((d) => low.includes(d))) {
        const sr: StepResult = { stepIndex: i, status: 'unverifiable', attempts: [{ kind: 'skipped', selector: target, matched: 0 }], note: `SKIPPED destructive intent: ${step.intent}`, url: page.url() };
        stepResults.push(sr); hooks.onStepResult?.(sr);
        continue;
      }
      // MUTATION GATE: block WRITE steps (create/add/submit/save/…) unless the caller allows it. Prevents bug-repro
      // from creating real records in a tenant's data without consent. 'unverifiable' (skipped), never a fake pass.
      if (!allowMutations && MUTATION_VERBS.some((m) => low.includes(m))) {
        const sr: StepResult = { stepIndex: i, status: 'unverifiable', attempts: [{ kind: 'skipped', selector: target, matched: 0, error: 'mutating step skipped — needs the "I authorize testing this target" attestation' }], note: `SKIPPED mutating step (not authorized): ${step.intent}`, url: page.url() };
        stepResults.push(sr); hooks.onStepResult?.(sr);
        continue;
      }
      let attempt: StepAttempt;
      if (verb === 'navigate') {
        // "Navigate to Users page" → the target is prose, not a URL. Resolve the nav NOUN to a real route
        // (Users→/users) instead of falling back to baseUrl (the dashboard) which caused wrong-page cascades.
        let dest = baseUrl;
        if (target.startsWith('http')) dest = target;
        else {
          const noun = contentWords(step.intent).find((w) => /^(users?|dashboard|plans?|chats?|settings?|profile|notifications?|analytics|reports?|home)$/.test(w));
          if (noun && !/dashboard|home/.test(noun)) dest = `${baseUrl.replace(/\/$/, '')}/${noun === 'user' ? 'users' : noun}`;
        }
        try { await page.goto(dest, { waitUntil: 'networkidle', timeout: 20000 }); attempt = { kind: 'navigate', selector: dest.replace(baseUrl, '') || '/', matched: 1 }; }
        catch (e: any) { attempt = { kind: 'navigate', selector: dest, matched: 0, error: String(e.message).slice(0, 200) }; }
      } else if (verb === 'fill') {
        attempt = await resolveFill(page, target, value || 'test@example.com');
      } else if (verb === 'observe') {
        // observation steps: pass (nothing to click); the console/network is captured for VERIFY
        attempt = { kind: 'observe', selector: target, matched: 1 };
      } else if (verb === 'select') {
        // native <select> dropdown (admin filters: Signup State, User Type) → selectOption, not click.
        // Fall back to click if it's actually a custom dropdown (button + menu).
        const sel = await resolveSelect(page, target, value);
        attempt = sel || (await resolveClick(page, target, step.intent));
      } else if (verb === 'drag') {
        attempt = await resolveDrag(page, target, target2 || '');
      } else if (verb === 'hover') {
        attempt = await resolveHover(page, target);
      } else if (verb === 'press') {
        attempt = await resolvePress(page, value || 'Enter');
      } else if (verb === 'rightclick' || verb === 'doubleclick') {
        attempt = await resolveSpecialClick(page, target, step.intent, verb === 'rightclick' ? 'right' : 'double');
      } else {
        // click resolves the target label. Capture the URL before, so we can wait for an SPA route change
        // after (the fix: "View All Users" click passed but the next step ran before /users loaded).
        const urlBefore = page.url();
        attempt = await resolveClick(page, target, step.intent);
        // NAV-COMPLETION WAIT: if this looked like a navigation intent OR the url changed, let the route settle.
        const looksNav = /users|dashboard|page|view|go to|open|navigat|details|plans|chats|settings|profile/i.test(step.intent);
        if (attempt.matched > 0 && !attempt.error && looksNav) {
          try { await page.waitForFunction((u) => (globalThis as any).location.href !== u, urlBefore, { timeout: 4000 }); } catch { /* SPA may render in place, not a URL change */ }
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
          let urlAfter = page.url();
          // ROUTE ASSERTION: a nav click that didn't move the URL → the SPA route didn't take. Navigate the
          // expected path DIRECTLY (from the intent's nav noun, e.g. "Users"→/users) so downstream steps don't
          // cascade-fail on the wrong page. This is the deterministic cure for wrong-page cascades.
          if (urlAfter === urlBefore) {
            const noun = contentWords(step.intent).find((w) => /^(users?|dashboard|plans?|chats?|settings?|profile|notifications?|analytics|reports?)$/.test(w));
            if (noun) {
              const guess = `${baseUrl.replace(/\/$/, '')}/${noun.replace(/s$/, '') === 'user' ? 'users' : noun}`;
              try { await page.goto(guess, { waitUntil: 'networkidle', timeout: 12000 }); urlAfter = page.url(); attempt.selector += ` (route-asserted ${urlAfter.replace(baseUrl, '')})`; } catch { /* keep original */ }
            }
          }
          if (urlAfter !== urlBefore) attempt.selector += ` → ${urlAfter.replace(baseUrl, '') || '/'}`;
        }
      }
      let ok = attempt.matched > 0 && !attempt.error;
      const isActionable = /click|fill|type|select/i.test(attempt.kind || '') || /click|fill|type|select/i.test(verb);

      // ── ON-STALL RECOVERY: the step couldn't find its control. Track consecutive misses (reset when the page
      // changed since our last recovery). On the 2nd miss on the SAME page, ask SoA to LOOK at the page and say what
      // to click to get past the gate — then RE-ATTEMPT the original step. This is the adaptive-agent behaviour the
      // crawl already has (#199/#200), reused here so bug-repro/flows don't dead-stop on a portal/workspace picker. ──
      if (!ok && isActionable && attempt.matched === 0) {
        consecutiveMisses++;
        const pageKey = `${page.url()}::${(await page.title().catch(() => '')) || ''}`;
        if (pageKey !== lastRecoveryPageKey) { /* page moved since last recovery — misses on a NEW page are fresh */ }
        // SKIP recovery on a LOGIN WALL: if we're still on a sign-in page (a password field is present, or the only
        // candidates are Google/Microsoft SSO), there is nothing for SoA to click to get "past" it — recovery would
        // waste a 150s call on the sign-in screen. This is a login-persistence problem, not a gate to explore through.
        const onLoginWall = ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0)
          || /google|microsoft/i.test(attempt.error || '');
        if (!onLoginWall && shouldRecover({ consecutiveMisses, recoveriesUsed, maxRecoveries: MAX_RECOVERIES })) {
          recoveriesUsed++; lastRecoveryPageKey = pageKey; consecutiveMisses = 0;
          hooks.onThink?.(`I couldn't find "${target}" on this page. Looking at what's actually here and asking SoA how to get past it…`);
          try {
            const inv: any = await pageClickableInventory(page);
            try { const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }); inv.screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`; } catch {}
            const { clicks: actions } = await explorePage(inv);
            // SAFETY: recovery clicks come from SoA, NOT the vetted step.intent — filter them through the same gate.
            const { kept, dropped } = filterRecoveryActions(actions as any, allowMutations);
            for (const d of dropped) hooks.onThink?.(`(skipping SoA's suggested "${d.label}" — ${d.reason})`);
            let pendingFill: { label: string; value: string } | null = null;
            for (const a of kept.slice(0, 4)) {
              if (a.action === 'fill') { pendingFill = { label: a.label, value: a.value || 'test' }; continue; }
              hooks.onThink?.(`SoA: click "${a.label}"${a.why ? ` — ${a.why}` : ''}`);
              if (pendingFill) { await resolveFill(page, pendingFill.label, pendingFill.value); pendingFill = null; }
              const rc = await resolveClick(page, a.label, a.label);
              await page.waitForTimeout(800);
              await hooks.onFrame?.(page, `recovery: ${a.label}`, rc.box);
            }
            // RE-ATTEMPT the original step now that we've (hopefully) gotten past the gate.
            hooks.onThink?.(`Retrying "${step.intent}" after getting past the gate.`);
            attempt = verb === 'fill' ? await resolveFill(page, target, value || 'test@example.com')
              : verb === 'select' ? ((await resolveSelect(page, target, value)) || (await resolveClick(page, target, step.intent)))
              : await resolveClick(page, target, step.intent);
            ok = attempt.matched > 0 && !attempt.error;
            (attempt as any).recovered = true;
          } catch (e: any) { hooks.onThink?.(`Recovery couldn't help: ${String(e?.message || e).slice(0, 80)}`); }
        }
      } else if (ok) {
        consecutiveMisses = 0;   // a step landed → not stuck anymore
      }
      if (!ok) failed = true;
      // VACUOUS-PASS FIX: an `observe`/`verify` step asserts NOTHING (no oracle), so it must NOT score 'pass' — that
      // made no-op steps look like the app worked. 'unverifiable': ran, but not evidence. Real actions keep pass/fail.
      const isObserve = verb === 'observe';
      const navDidntMove = verb === 'navigate' && ok && !/→/.test(attempt.selector || '');
      const status: StepResult['status'] = !ok ? 'fail' : (isObserve || navDidntMove) ? 'unverifiable' : 'pass';
      const sr: StepResult = { stepIndex: i, status, attempts: [attempt], note: (attempt as any).recovered ? `[recovered] ${attempt.error || 'via on-stall recovery'}` : attempt.error, url: page.url() };
      stepResults.push(sr); hooks.onStepResult?.(sr);   // stream: this step's outcome
      // LEARN a route fact: a click on a LABEL that moved us to a NEW page ("clicking X → /path") — the exact
      // navigation knowledge that would let the next run skip re-discovery. STRUCTURE only (label→route), no verdict.
      if (ok && (verb === 'click' || verb === 'select') && target) {
        const to = safePath(page.url());
        if (to !== safePath(urlBeforeStep) && to !== '/') {
          hooks.onLearn?.({ kind: 'route', key: `route:${target.toLowerCase().slice(0, 40)}`, fact: `clicking "${target.slice(0, 40)}" → ${to}` });
        }
      }
      // let the SPA SETTLE — a fixed 700ms photographed a "Loading calendar" spinner mid-load (interactives:0). Wait
      // for networkidle (short cap) AND poll until the DOM stops growing, so the next step + the frame see the real
      // rendered page, not a loading state. Affects every engine on every SPA. Bounded so a busy page can't hang us.
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      try {
        let prev = -1;
        for (let s = 0; s < 6; s++) {
          const n = await page.evaluate(() => (globalThis as any).document.querySelectorAll('button,a,input,[role]').length).catch(() => prev);
          if (n === prev) break;   // DOM stabilized
          prev = n;
          await page.waitForTimeout(400);
        }
      } catch { await page.waitForTimeout(700); }
      await hooks.onFrame?.(page, step.intent, attempt.box);   // LIVE VIEW + PLAYBACK: frame + the action's cursor box
    }
  } catch (e: any) {
    failed = true;
    stepResults.push({ stepIndex: stepResults.length, status: 'fail', attempts: [{ kind: 'navigate', selector: baseUrl, matched: 0, error: String(e.message).slice(0, 200) }], note: 'flow-level failure' });
  }
  // capture the result page BEFORE closing (so break-it can read the "Error…" / "Saved…" message)
  let finalText = '', finalUrl = '';
  try { finalUrl = page.url(); finalText = (await page.evaluate(() => (globalThis as any).document.body?.innerText || '')).replace(/\s+/g, ' ').slice(0, 600); } catch {}
  await browser.close().catch(() => {});
  return { flowName: flow.name, status: failed ? 'failed' : 'passed', baseUrl, stepResults, consoleErrors, finalText, finalUrl };
}
