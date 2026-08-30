import type { Page, Locator } from 'playwright';

// OPTION-ROW LOCATION (2026-08-23, de-vocabularized): the old PICK_SEL enumerated MUI/AntD class strings — pure
// overfit (a new widget lib meant adding more strings). Replaced by verify-by-effect: snapshotLists() before typing,
// then locateOptionRows() returns the container(s) whose CONTENT is NEW after typing (structural, class-name-free).
// See snapshotLists / locateOptionRows below. Value-match (bestOption) remains the final commit gate.
const NO_RESULT_RE = /^\s*(no (options|results|matches|data)|loading|searching|\.\.\.)\s*$/i;

const STOP = new Set(['the','a','an','of','for','and','or','with','to','in','on']);
function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 1 && !STOP.has(w));
}
function scoreText(optText: string, value: string): number {
  const a = optText.trim().toLowerCase(), v = value.trim().toLowerCase();
  if (!a || NO_RESULT_RE.test(a)) return -1;
  if (a === v) return 100;                          // exact wins
  if (a.startsWith(v) || v.startsWith(a)) return 60; // prefix beats scattered overlap → "Jane Doe" not "Janet"
  const have = new Set(words(a));
  return words(v).reduce((acc, w) => acc + (have.has(w) ? 2 : a.includes(w) ? 1 : 0), 0);
}
// Node-safe id guard — CSS.escape does NOT exist server-side. Only build a #id selector for a simple id.
function safeId(id: string | null): string | null {
  return id && /^[A-Za-z][\w-]*$/.test(id) ? id : null;
}
/** keystrokes meaningful? textarea + textual <input>. Gates out <select>, date/number/checkbox (where ArrowDown mutates). */
async function isTextish(input: Locator): Promise<boolean> {
  try {
    const tag = (await input.evaluate((el: any) => el.tagName)).toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = ((await input.getAttribute('type')) || 'text').toLowerCase();
    return ['text','search','email','tel','url',''].includes(t);
  } catch { return false; }
}

/**
 * Signature:
 *   fillMaybeAutocomplete(page: Page, input: Locator, value: string): Promise<'plain' | 'committed' | 'failed'>
 *
 *   'plain'     — no dropdown ever appeared; the .fill() already done IS the whole job. Zero extra mutation.
 *   'committed' — typed + an option selected + commit VERIFIED.
 *   'failed'    — a dropdown appeared but nothing committed (HONEST failure → caller reports matched:0).
 *
 * Worst-case wall time (all event-gated, ceilings not costs): fill 6000 + settle 150 + ArrowDown reprobe 250
 *   + open 1200 + N textContent reads (~12×~30ms) + keyboard commit 250 + verify poll 600 ≈ under 9s,
 *   well within the 60s XSION_STEP_CAP_MS step budget.
 */
export async function fillMaybeAutocomplete(
  page: Page, input: Locator, value: string,
): Promise<'plain' | 'committed' | 'failed'> {
  const one = input.first();
  await one.scrollIntoViewIfNeeded().catch(() => {});

  // BASELINE the page's list-containers BEFORE any typing (AntD/react-select fire the dropdown on .fill(), so a
  // post-fill baseline is already contaminated). A container is "this input's dropdown" iff its content fingerprint
  // is NEW after typing — this is what makes a plain title fill (whose 4 static lists don't change) return NOTHING.
  const before = await snapshotLists(page);

  // ── FAST PATH: the ordinary fill every non-autocomplete field needs. ──
  try { await one.fill(value, { timeout: 6000 }); }
  catch {                                             // readonly widgets (some AntD): clear via select-all
    await one.click({ timeout: 3000 }).catch(() => {});
    await one.press('ControlOrMeta+A').catch(() => {});
    await one.pressSequentially(value, { delay: 40 }).catch(() => {});
  }

  if (!(await isTextish(one))) return 'plain';        // <select>/date/etc — .fill already did the right thing

  const ariaControls = safeId((await one.getAttribute('aria-controls').catch(() => null))
                          || (await one.getAttribute('aria-owns').catch(() => null)));
  const ariaTrigger = (await one.getAttribute('aria-autocomplete').catch(() => null)) != null || ariaControls != null
                   || (await one.getAttribute('role').catch(() => null)) === 'combobox';
  // SEARCH-LIKE heuristic: MUI/AntD search fields fire their debounce on per-CHARACTER input events, which a one-shot
  // .fill() never triggers (MEASURED: schooltalk .fill()→no dropdown; pressSequentially→the option appears).
  const nameHint = (((await one.getAttribute('placeholder').catch(() => null)) || '') + ' '
                 + ((await one.getAttribute('aria-label').catch(() => null)) || '') + ' '
                 + ((await one.getAttribute('name').catch(() => null)) || '')).toLowerCase();
  const searchLike = ariaTrigger || /search|find|lookup|type to|start typing|autocomplete/i.test(nameHint);

  // ── VALUE-MATCH DETECTION over THIS input's dropdown, located class-name-free (verify-by-effect: the list whose
  //    content is NEW after typing). aria-controls is the authoritative fast lane WHEN populated; else structural. ──
  //    hitIn(): resolve the candidate row-lists, run bestOption over each (ranked) until one scores. Returns {list,hit}.
  const hitIn = async (): Promise<{ list: Locator; hit: { index: number; text: string } } | null> => {
    // fast lane: aria-controls target, but only when it actually has rows (MUI sets aria-controls while CLOSED).
    if (ariaControls) {
      const ariaList = page.locator(`#${ariaControls} [role="option"], #${ariaControls} li`);
      if (await ariaList.count().catch(() => 0) > 0) { const h = await bestOption(ariaList, value); if (h) return { list: ariaList, hit: h }; }
    }
    // structural: ranked list of containers whose fingerprint is NEW vs `before`. value-match disambiguates among them
    // (kills the concurrent-SignalR-push case: a pushed unrelated list scores 0 for our value → skipped).
    const lists = await locateOptionRows(page, one, before);
    for (const list of lists) { const h = await bestOption(list, value); if (h) return { list, hit: h }; }
    return null;
  };

  let found = await hitIn();

  // Not found on the one-shot .fill(). For search-like fields, RE-TYPE char-by-char so the debounce fires, then re-check.
  if (!found && searchLike) {
    await one.click().catch(() => {});
    await one.press('ControlOrMeta+A').catch(() => {});
    await one.pressSequentially(value, { delay: 80 }).catch(() => {});
    // POLL up to 3s (schooltalk's dropdown renders ~2.5s after typing). `before` is FIXED — never re-baselined mid-poll
    // (a SignalR push would poison a moving baseline); `fingerprint ∉ before` is monotonic so a late-populate is caught.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !found) { await page.waitForTimeout(300); found = await hitIn(); }
  }

  if (!found) {
    // no matching option → genuinely plain (or below min-query length). Confirm the value is actually typed, else honest fail.
    const cur = ((await one.inputValue().catch(() => '')) || '').trim();
    return cur === value.trim() ? 'plain' : 'failed';
  }

  // ── PICK: click the best-scoring option, verify commit, keyboard-fallback. ──
  try { await found.list.nth(found.hit.index).click({ timeout: 3000 }); }
  catch { return keyboardCommit(page, one, value); }
  return (await verifyCommit(page, one, found.hit.text)) ? 'committed' : keyboardCommit(page, one, value);
}

/** Fingerprint the page's visible list-shaped containers (content, not identity) so we can tell which list is NEW/
 *  CHANGED after typing. fingerprint = childCount|textContent — a React-replaced-but-identical static list keeps its
 *  fingerprint (→ correctly NOT new); a dropdown that populates gains rows (→ new). No class names. */
export async function snapshotLists(page: Page): Promise<Set<string>> {
  const arr = await page.evaluate(() => {
    const d: any = (globalThis as any).document;
    const rendered = (el: any) => { const s = (globalThis as any).getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetWidth || el.offsetHeight); };
    const cands = new Set<any>();
    Array.prototype.slice.call(d.querySelectorAll('ul, ol, [role="listbox"], [role="menu"], [role="grid"]')).forEach((e: any) => cands.add(e));
    // class-free "repeated rows": any element with ≥2 element children sharing a tagName
    Array.prototype.slice.call(d.querySelectorAll('*')).forEach((e: any) => {
      const kids = e.children; if (kids && kids.length >= 2) { const t = kids[0].tagName; let same = 0; for (let i = 0; i < kids.length; i++) if (kids[i].tagName === t) same++; if (same >= 2) cands.add(e); }
    });
    const out: string[] = [];
    cands.forEach((e: any) => { if (rendered(e)) out.push(e.children.length + '|' + ((e.textContent || '').trim().slice(0, 400))); });
    return out;
  }).catch(() => [] as string[]);
  return new Set(arr);
}

/** Locate THIS input's option-row lists, class-name-free: containers whose content fingerprint is NEW vs `before`,
 *  list-shaped, yielding ≥1 row. Returns a RANKED array (adjacency to the input orders but NEVER rejects — schooltalk's
 *  inline list can be far from the field). Caller runs bestOption over each in order; value-match is the final gate. */
export async function locateOptionRows(page: Page, input: Locator, before: Set<string>): Promise<Locator[]> {
  const rect = await input.boundingBox().catch(() => null);
  const paths = await page.evaluate((args: { before: string[]; ir: { x: number; y: number; w: number; h: number } | null }) => {
    const d: any = (globalThis as any).document;
    const beforeSet = new Set(args.before);
    const rendered = (el: any) => { const s = (globalThis as any).getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetWidth || el.offsetHeight); };
    const fp = (e: any) => e.children.length + '|' + ((e.textContent || '').trim().slice(0, 400));
    // recompute candidates identically to snapshotLists
    const cands = new Set<any>();
    Array.prototype.slice.call(d.querySelectorAll('ul, ol, [role="listbox"], [role="menu"], [role="grid"]')).forEach((e: any) => cands.add(e));
    Array.prototype.slice.call(d.querySelectorAll('*')).forEach((e: any) => { const k = e.children; if (k && k.length >= 2) { const t = k[0].tagName; let s = 0; for (let i = 0; i < k.length; i++) if (k[i].tagName === t) s++; if (s >= 2) cands.add(e); } });
    const inputEl = args.ir ? d.elementFromPoint(args.ir.x + 2, args.ir.y + 2) : null;
    // qualify: rendered, fingerprint NEW vs before, does not contain the input, ≥1 child row
    let qualified: any[] = [];
    cands.forEach((e: any) => {
      if (!rendered(e)) return;
      if (beforeSet.has(fp(e))) return;                          // unchanged content → not this input's dropdown
      if (inputEl && e.contains(inputEl)) return;                // the field's own wrapper, not its options
      if (!e.children || e.children.length < 1) return;
      qualified.push(e);
    });
    // drop ancestors of other qualifiers, EXCEPT descend only through pure single-qualifying-child wrappers (portal
    // wrapper → its one child is the ul → keep the ul). Keep the OUTERMOST list whose children ARE the rows.
    qualified = qualified.filter((e: any) => !qualified.some((o: any) => o !== e && e.contains(o) && (() => {
      // e is an ancestor of o. Drop e ONLY if e is a thin wrapper (single element child chain down to o).
      let n: any = e; let hops = 0; while (n && n !== o && n.children && n.children.length === 1) { n = n.children[0]; hops++; if (hops > 4) break; }
      return n === o;   // e collapses to o through single-child wrappers → e is a wrapper, drop it
    })()));
    // rank by adjacency to the input (vertical edge gap); adjacency ORDERS, never rejects
    const gap = (e: any) => { if (!args.ir) return 0; const r = e.getBoundingClientRect(); const below = r.top - (args.ir.y + args.ir.h); const above = args.ir.y - r.bottom; return Math.abs(below >= 0 ? below : above >= 0 ? above : 0); };
    qualified.sort((a: any, b: any) => gap(a) - gap(b));
    // return a stable structural path per winner (nth-of-type chain — no class names)
    const pathOf = (el: any) => { const seg: string[] = []; let n: any = el; while (n && n.nodeType === 1 && n.tagName !== 'BODY') { const tag = n.tagName.toLowerCase(); let i = 1, s = n; while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++; seg.unshift(`${tag}:nth-of-type(${i})`); n = n.parentElement; } return seg.length ? 'body > ' + seg.join(' > ') : ''; };
    return qualified.map(pathOf).filter(Boolean).slice(0, 6);
  }, { before: [...before], ir: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null }).catch(() => [] as string[]);
  // build a row locator per container: [role=option] children if present, else direct-child rows (descend uniform
  // single-child wrappers). Filtering of no-result rows happens in bestOption.
  const out: Locator[] = [];
  for (const p of paths) {
    const root = page.locator(p);
    const opts = root.locator('[role="option"]');
    out.push((await opts.count().catch(() => 0)) > 0 ? opts : root.locator(':scope > *'));
  }
  return out;
}

/** VALUE-MATCH: scan the option list, return the best-scoring option ({index,text}) or null. Immune to a static
 *  baseline node (a persistent non-matching li scores 0 → ignored) — the fix for count-delta's blindness. Skips
 *  no-results/loading rows. Bounded to 12 reads. */
async function bestOption(list: Locator, value: string): Promise<{ index: number; text: string } | null> {
  const n = Math.min(await list.count().catch(() => 0), 12);
  let bestI = -1, bestS = 0, bestTxt = '';
  for (let i = 0; i < n; i++) {
    const txt = ((await list.nth(i).textContent().catch(() => '')) || '').trim();
    if (NO_RESULT_RE.test(txt)) continue;
    const s = scoreText(txt, value);
    if (s > bestS) { bestS = s; bestI = i; bestTxt = txt; }
  }
  return bestI >= 0 && bestS > 0 ? { index: bestI, text: bestTxt } : null;
}

// ArrowDown/Enter — widget-agnostic commit when an option node can't be found/clicked.
async function keyboardCommit(page: Page, input: Locator, value: string): Promise<'committed' | 'failed'> {
  try {
    await input.press('ArrowDown'); await page.waitForTimeout(120); await input.press('Enter');
    return (await verifyCommit(page, input, value)) ? 'committed' : 'failed';
  } catch { return 'failed'; }
}

// DISJUNCTIVE commit check (mirrors resolveSubmit's "verify it actually moved", intentRunner.ts:600-614).
// Accepts ALL THREE successful shapes because libraries express commit differently. Tight 600ms poll.
async function verifyCommit(page: Page, input: Locator, chosen: string): Promise<boolean> {
  const deadline = Date.now() + 600;
  const want = chosen.trim().toLowerCase();
  const firstWord = chosen.trim().split(/\s+/)[0] || chosen;
  while (Date.now() < deadline) {
    const val = ((await input.inputValue().catch(() => '')) || '').trim().toLowerCase();
    // (a) input holds the committed text (MUI single, plain custom combobox)
    if (val && want && (val === want || want.includes(val) || val.includes(want))) return true;
    // (b) input EMPTIED and a chip/tag carrying the text appeared (react-select, AntD, MUI multiple)
    if (!val) {
      const chip = await page.locator('[class*="chip" i], [class*="tag" i], [class*="MuiChip" i], [data-selected="true"]')
        .filter({ hasText: firstWord }).count().catch(() => 0);
      if (chip > 0) return true;
    }
    // (c) listbox collapsed after a non-empty selection (weakest — gated on non-empty val to avoid empty-input false pass)
    if (val && (await input.getAttribute('aria-expanded').catch(() => null)) === 'false') return true;
    await page.waitForTimeout(80);
  }
  return false;
}
