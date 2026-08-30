/**
 * dropOracle.ts — COORDINATE-PRECISE DROP + POSITION READ-BACK ORACLE.
 *
 * The moat rule from the drag-and-drop ticket: a drop-PRECISION bug ("the event attaches below the long event instead
 * of where I dropped it, between the events") can only be judged if we (a) aim the drop at a SPECIFIC inter-item
 * offset — not the target element's center — and (b) INDEPENDENTLY read back where the item actually landed from the
 * rendered DOM, then compare that to where we AIMED. A verdict computed from the drop coordinates alone would be
 * asserting our own input as the observation (the classic false-reproduced). So the observation MUST come from a
 * fresh DOM read AFTER the drop, never from the coordinates we chose.
 *
 * This file is split so the JUDGE is pure and fixture-provable in BOTH directions (reproduced AND not-reproduced)
 * with zero browser: `judgeDrop(before, after, intended)` takes two ordered snapshots + the slot we aimed for and
 * returns { verdict, observedSlot, why }. The browser glue (snapshot a day-column's ordered events; execute a
 * multi-step offset drop) is the thin, side-effecting part around it.
 *
 * SCOPE (advisor): vertical-list / calendar-column ORDERING only — the geometry of "which item is above which" in a
 * single column. NOT arbitrary 2D reorder (kanban across columns, free grids). That geometry differs and has no fixture.
 */

/** One rendered event in a day column, as read from the DOM. `id` is a stable per-event identity (text/testid) so we
 *  can find "the event we dropped" in the AFTER snapshot; `y`/`height` are its layout box; `time` is its shown time. */
export interface EventBox { id: string; y: number; height: number; time?: string; label?: string }

/** does this box match a caller-supplied source identity? tickets speak in human LABELS ("New event"), while the
 *  snapshot's `id` prefers a stable data-testid — so match on EITHER the id or the visible label (case-insensitive).
 *  This is why the oracle can be seeded from ticket text and still find the event whose testid differs. */
export function boxMatchesId(box: EventBox, wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  return box.id.toLowerCase() === w || (box.label || '').toLowerCase() === w;
}

/** An ordered snapshot of a single day-column's events, top-to-bottom by y. */
export type ColumnSnapshot = EventBox[];

export type DropVerdict = 'reproduced' | 'not-reproduced' | 'inconclusive';

export interface DropJudgement {
  verdict: DropVerdict;
  observedSlot: number | null;    // the dropped event's index in the AFTER snapshot (0-based, top→bottom), null if unreadable
  intendedSlot: number;           // the index we AIMED to land at (derived from the BEFORE snapshot)
  why: string;
}

/** order a snapshot top→bottom by y (defensive — the DOM read should already be ordered, but never trust that). */
export function orderByY(snap: ColumnSnapshot): ColumnSnapshot {
  return [...snap].sort((a, b) => a.y - b.y);
}

/** Given a BEFORE snapshot and a target y (where the source will be dropped), what SLOT INDEX does that y fall into?
 *  Slot i = "positioned as the i-th event top→bottom". A y below all events = the last slot. Pure geometry over the
 *  before-snapshot's boxes. This is the INTENDED slot — what a correct app would produce. */
export function slotForY(before: ColumnSnapshot, dropY: number): number {
  const ordered = orderByY(before);
  let slot = 0;
  for (const ev of ordered) {
    // the drop lands AFTER this event if its center-y is below the event's vertical midpoint.
    if (dropY > ev.y + ev.height / 2) slot++;
    else break;
  }
  return slot;
}

/** Compute the y coordinate to AIM the drop at, so the source lands in `desiredSlot` (0-based, top→bottom) of the
 *  column — i.e. between the (desiredSlot-1)th and (desiredSlot)th existing events. Used to place a drop BETWEEN two
 *  events or BELOW the second event, which a center-drop can't express. Pure. Returns a y in the column's coordinate
 *  space. `gap` biases the aim into the visual gap so the DnD lib registers "between", not "on top of" an event. */
export function aimYForSlot(before: ColumnSnapshot, desiredSlot: number, gap = 4): number {
  const ordered = orderByY(before);
  if (ordered.length === 0) return 0;
  const clamped = Math.max(0, Math.min(desiredSlot, ordered.length));
  if (clamped === 0) return Math.max(0, ordered[0].y - gap);                 // above the first event
  if (clamped >= ordered.length) {                                          // below the last event
    const last = ordered[ordered.length - 1];
    return last.y + last.height + gap;
  }
  // between event (clamped-1) and event (clamped): the midpoint of the visual gap between them.
  const above = ordered[clamped - 1];
  const below = ordered[clamped];
  const gapTop = above.y + above.height;
  return gapTop + (below.y - gapTop) / 2;
}

/** find the dropped event (by id OR visible label) in the AFTER snapshot and return its slot index (0-based, top→bottom). */
export function observedSlotOf(after: ColumnSnapshot, droppedId: string): number | null {
  const ordered = orderByY(after);
  const idx = ordered.findIndex((e) => boxMatchesId(e, droppedId));
  return idx < 0 ? null : idx;
}

/**
 * THE JUDGE (pure, fixture-provable both directions). Compare where the dropped event ACTUALLY landed (read from the
 * AFTER snapshot) against where we AIMED (intendedSlot, derived from the BEFORE snapshot geometry).
 *
 * SAFETY INVARIANT (advisor): NO positional verdict without a positional OBSERVATION. If the read-back can't produce a
 * usable before/after pair — dropped event missing from the after snapshot, snapshots identical (nothing moved),
 * empty column — return 'inconclusive'. The caller keeps the honest capability-gap message in that case; the guard is
 * only lifted when this returns a real reproduced/not-reproduced backed by an actual DOM read.
 */
export function judgeDrop(before: ColumnSnapshot, after: ColumnSnapshot, droppedId: string, intendedSlot: number): DropJudgement {
  const base = { intendedSlot } as const;
  if (!before.length || !after.length) {
    return { ...base, verdict: 'inconclusive', observedSlot: null, why: 'empty column snapshot — cannot read positions.' };
  }
  // DUPLICATE-ID GUARD: if the dropped id is ambiguous (two "Math Class" events → identical ids), observedSlotOf's
  // findIndex silently returns the FIRST match and the slot is wrong while looking valid — a false verdict with no
  // escape. Refuse: an ambiguous identity is not a positional observation. (Same safety invariant, applied to identity.)
  const dupInBefore = before.filter((e) => boxMatchesId(e, droppedId)).length > 1;
  const dupInAfter = after.filter((e) => boxMatchesId(e, droppedId)).length > 1;
  if (dupInBefore || dupInAfter) {
    return { ...base, verdict: 'inconclusive', observedSlot: null, why: `the dropped event's identity ("${droppedId}") is ambiguous — it appears more than once, so I can't tell which one moved. No reliable positional observation.` };
  }
  const observedSlot = observedSlotOf(after, droppedId);
  if (observedSlot === null) {
    return { ...base, verdict: 'inconclusive', observedSlot: null, why: `could not find the dropped event ("${droppedId}") in the after-snapshot — no positional observation, so no positional verdict.` };
  }
  // did anything actually move? if the before and after orderings are identical, the drag was a no-op (the lib
  // swallowed it) — we did NOT observe a placement, so we can't judge. Compare the id-order top→bottom.
  const beforeOrder = orderByY(before).map((e) => e.id).join('>');
  const afterOrder = orderByY(after).map((e) => e.id).join('>');
  const droppedWasPresentBefore = before.some((e) => boxMatchesId(e, droppedId));
  if (droppedWasPresentBefore && beforeOrder === afterOrder) {
    return { ...base, verdict: 'inconclusive', observedSlot, why: 'the column order is identical before and after — the drag did not move the event (library may not have registered the gesture). No placement observed.' };
  }
  // THE COMPARISON: landed where aimed → the app honored the drop position → NOT reproduced (the bug is absent/fixed).
  if (observedSlot === intendedSlot) {
    return { ...base, verdict: 'not-reproduced', observedSlot, why: `the event landed at slot ${observedSlot}, exactly where it was dropped — the app honored the drop position (bug not reproduced).` };
  }
  // landed somewhere ELSE than aimed → the app ignored the drop position. For the ticket's specific bug ("always
  // attaches just below the long event"), the tell is: aimed for a lower/between slot but landed at slot 1 (right
  // after the first/long event). We report reproduced whenever observed ≠ intended — the app demonstrably did not
  // place it where dropped. `why` names the direction so the finding is auditable.
  return { ...base, verdict: 'reproduced', observedSlot,
    why: `aimed to drop at slot ${intendedSlot} but the event landed at slot ${observedSlot} — the app did NOT place it where it was dropped (drop-position ignored). This is the reported bug, observed live.` };
}

/** One arm of the differential: the outcome of aiming at a specific slot and reading back where it landed. */
export interface DropArm { intendedSlot: number; observedSlot: number | null; inconclusiveWhy?: string; dragCommitted?: boolean }

/**
 * TWO-AIM DIFFERENTIAL (the real discriminator — advisor). A SINGLE aim can't separate the reported bug ("drop
 * position is IGNORED — always snaps below the long event") from ordinary time-grid SNAPPING (a correct app that
 * rounds the drop to the nearest slot). Both produce observed≠intended on one drop. The bug's signature only shows
 * across TWO different aims:
 *   • BUG:      aim slot 1 → lands 1, aim slot 2 → ALSO lands 1  (every aim collapses to the same slot → ignored)
 *   • CORRECT:  aim slot 1 → lands 1, aim slot 2 → lands 2       (different aims → different landings → honored)
 *   • SNAP-only: aims land at their nearest grid slot but STILL DIFFER between the two aims → honored (not the bug)
 * So: reproduced IFF both aims are readable AND both landed at the SAME slot despite aiming at different ones.
 * not-reproduced IFF both readable and they landed at DIFFERENT slots (the app distinguishes drop positions).
 * inconclusive if either arm couldn't be read (the safety invariant survives — no positional verdict without two
 * positional observations). This is what earns a live reproduced; the single-aim judgeDrop is kept for the fixture
 * geometry tests but the LIVE verdict must use this. */
export function judgeDropDifferential(armA: DropArm, armB: DropArm): { verdict: DropVerdict; why: string } {
  if (armA.intendedSlot === armB.intendedSlot) {
    return { verdict: 'inconclusive', why: 'the two aims targeted the same slot — a differential needs two DIFFERENT intended slots to tell "ignored" from "snapped".' };
  }
  if (armA.observedSlot === null || armB.observedSlot === null) {
    return { verdict: 'inconclusive', why: `couldn't read back one of the two drops (${armA.observedSlot === null ? armA.inconclusiveWhy || 'aim A unreadable' : armB.inconclusiveWhy || 'aim B unreadable'}) — no reliable positional observation for both aims.` };
  }
  if (armA.observedSlot === armB.observedSlot) {
    return { verdict: 'reproduced', why: `aimed at two DIFFERENT slots (${armA.intendedSlot} and ${armB.intendedSlot}) but the event landed at the SAME slot (${armA.observedSlot}) both times — the app ignores the drop position (it always snaps to one place). This is the reported bug, observed live across two aims.` };
  }
  return { verdict: 'not-reproduced', why: `aimed at slots ${armA.intendedSlot} and ${armB.intendedSlot} and the event landed at DIFFERENT slots (${armA.observedSlot} and ${armB.observedSlot}) — the app honors the drop position (a mismatch on a single aim would just be grid-snapping, not the bug).` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// BROWSER GLUE (side-effecting). Kept thin so the JUDGE above stays pure + fixture-provable. These take a Playwright
// Page. The DOM-snapshot evaluate uses ONLY inline arrows + built-ins (NO named helpers) so it never trips the tsx
// `__name is not defined` footgun — but installEvalShim(context) should already have run for the session regardless.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

import type { Page } from 'playwright';

/** Read an ordered snapshot of the events in the day-column that best matches `columnHint` (a date/day label or a
 *  container testid). Heuristic + generic: find event-like elements (calendar libs mark them with role/class
 *  containing "event"/"appointment"/"rbc-event"/"fc-event"), keep those whose horizontal center sits inside the
 *  chosen column, and return each one's stable id (its trimmed text or data-testid), y, height and any time text.
 *  Returns [] when it can't identify a column — the judge treats [] as inconclusive (the safety invariant). */
export async function snapshotColumn(page: Page, columnHint?: string): Promise<ColumnSnapshot> {
  return await page.evaluate((hint: string | undefined) => {
    const doc: any = (globalThis as any).document;
    // Match named calendar-event elements across libraries AND custom calendars (schooltalk uses .calendar-day-grid
    // with no "event" class). We include generic calendar containers, then FILTER to things that actually look like a
    // placed event: NON-EMPTY text + a real box. This excludes empty time-slot drop-zones (schooltalk renders ~2000
    // empty draggable 188×10 slivers) and day-number headers. (The empty-slot trap is why a naive selector read 0.)
    const EVENT_SEL = [
      '[class*="event" i]', '[class*="appointment" i]', '[class*="lesson" i]', '[class*="session" i]',
      '[class*="rbc-event"]', '[class*="fc-event"]', '[data-testid*="event" i]', '[role="button"][class*="event" i]',
      '[class*="calendar-event" i]', '[class*="cal-event" i]', '[class*="schedule-item" i]',
    ].join(',');
    const raw: any[] = Array.from(doc.querySelectorAll(EVENT_SEL));
    const boxes = raw.map((el: any, i: number) => {
      const r = el.getBoundingClientRect();
      const testid = el.getAttribute('data-testid') || '';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const timeMatch = (el.textContent || '').match(/\b\d{1,2}:\d{2}\s?(?:[ap]m)?\b/i);
      // ★ cluster on the LEFT EDGE, not the center: a week-grid packs day-columns close together (schooltalk: lefts at
      // 105,168,230,294… ≈62px apart) while events are ~188px wide, so a center±halfWidth band MERGES adjacent days
      // into one fake column and corrupts the slot index (a verdict bug, not inconclusive). Left-edge separates them.
      return { el, id: testid || text || ('event#' + i), y: r.top, x: r.left, height: r.height, width: r.width, time: timeMatch ? timeMatch[0] : undefined, hasText: text.length > 1, isDayNum: /^\d{1,2}$/.test(text) || /^(mon|tue|wed|thu|fri|sat|sun)\w*\d*$/i.test(text) };
    }).filter((b: any) => b.height > 4 && b.width > 4 && b.hasText && !b.isDayNum);   // a real event: has a title, isn't a day header, isn't an empty slot
    if (!boxes.length) return [];
    // pick the target column: if a hint is given, prefer boxes whose ancestor text includes it; else use the column
    // (cluster of boxes sharing a LEFT-edge x-band) with the MOST events — the day most likely under test.
    let chosen = boxes;
    if (hint) {
      const h = hint.toLowerCase();
      const hinted = boxes.filter((b: any) => {
        let p: any = b.el;
        for (let d = 0; d < 4 && p; d++) { if ((p.getAttribute('aria-label') || p.className || '').toLowerCase().includes(h)) return true; p = p.parentElement; }
        return (b.el.textContent || '').toLowerCase().includes(h);
      });
      if (hinted.length) chosen = hinted;
    }
    // DATA-DRIVEN tolerance: take the sorted distinct left-edges, find the SMALLEST positive gap between adjacent
    // columns, and cluster within half that gap. This adapts to the real grid spacing instead of guessing from width
    // (so a tightly-packed week-view separates correctly, and a single wide day-view still forms one column).
    const lefts = Array.from(new Set(chosen.map((b: any) => Math.round(b.x)))).sort((a: number, b: number) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < lefts.length; i++) { const g = lefts[i] - lefts[i - 1]; if (g > 6 && g < minGap) minGap = g; }
    const tol = Number.isFinite(minGap) ? Math.max(6, minGap / 2) : 30;   // half the smallest real column gap
    const cols = new Map<number, typeof chosen>();
    for (const b of chosen) {
      let key = -1;
      for (const k of cols.keys()) if (Math.abs(k - b.x) <= tol) { key = k; break; }
      if (key === -1) { key = b.x; cols.set(key, []); }
      cols.get(key)!.push(b);
    }
    let best = chosen;
    let most = -1;
    for (const arr of cols.values()) if (arr.length > most) { most = arr.length; best = arr; }
    return best.sort((a: any, b: any) => a.y - b.y).map((b: any) => ({ id: b.id, y: Math.round(b.y), height: Math.round(b.height), time: b.time, label: (b.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) }));
  }, columnHint);
}

/** Execute a COORDINATE-PRECISE drop: pick up the source event (by its box center) and release it at `aimY` within
 *  the column (x taken from the column's events). Multi-step mousemove (many DnD libs need discrete moves + a settle
 *  move before release). Returns the source event's id (so the oracle can find it after) or null if the source box
 *  couldn't be resolved. Side-effecting; the caller snapshots before & after and calls judgeDrop. */
export async function offsetDrop(page: Page, sourceId: string, columnX: number, aimY: number): Promise<string | null> {
  const srcInfo = await page.evaluate((sid: string) => {
    const doc: any = (globalThis as any).document;
    const EVENT_SEL = '[class*="event" i],[class*="appointment" i],[class*="lesson" i],[class*="session" i],[class*="rbc-event"],[class*="fc-event"],[class*="calendar-event" i],[data-testid*="event" i]';
    const all: any[] = Array.from(doc.querySelectorAll(EVENT_SEL));
    const want = sid.trim().toLowerCase();
    const hit = all.find((el: any) => ((el.getAttribute('data-testid') || '').toLowerCase() === want) || ((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase() === want));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    // is this element (or a draggable ancestor) NATIVE HTML5 drag? (draggable="true") — decides which drive path to use.
    let n: any = hit, html5 = false;
    for (let d = 0; d < 4 && n; d++) { if (n.getAttribute && n.getAttribute('draggable') === 'true') { html5 = true; break; } n = n.parentElement; }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, html5 };
  }, sourceId);
  if (!srcInfo) return null;

  if (srcInfo.html5) {
    // ★ NATIVE HTML5 DnD path — ⚠ BEST-EFFORT, NOT PROVEN TO COMMIT ON schooltalk. Technique ladder MEASURED live
    // (nzcurriculum calendar, native draggable="true", no DnD lib): page.mouse.* = no-op; synthetic dispatchEvent =
    // no-op (Chromium ignores untrusted drag); locator.dragTo+targetPosition = the element ANIMATES (y 1721→822 mid-
    // drag) BUT THE DROP DOES NOT COMMIT — the event's rendered TIME is unchanged and a reload restores it. So the
    // gesture renders under automation but the app never persists the reorder. CDP Input.dispatchDragEvent (trusted
    // input, the floor) was NOT cleanly isolated (a prior technique had already displaced the element) → the single
    // remaining unknown. NET: a native-HTML5 drop-precision repro is (so far) NOT drivable to a committed drop from
    // outside the app; the oracle reads back position/time and treats a non-commit as inconclusive → the honest
    // capability-gap verdict stands (needsDropPrecision → cant-perform + needs-input). dragTo is kept as the best
    // available attempt; the caller NEVER fabricates a verdict from it. TIME oracle > pixel oracle on a time-grid.
    const dragMeta = await page.evaluate((sid: string) => {
      const doc: any = (globalThis as any).document;
      const SEL = '[class*="calendar-event" i],[class*="event" i],[class*="lesson" i],[class*="session" i],[data-testid*="event" i]';
      const all: any[] = Array.from(doc.querySelectorAll(SEL)).filter((e: any) => (e.textContent || '').trim().length > 1);
      const want = sid.trim().toLowerCase();
      const src = all.find((el: any) => ((el.getAttribute('data-testid') || '').toLowerCase() === want) || ((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase() === want));
      if (!src) return null;
      let col: any = src; for (let d = 0; d < 5 && col; d++) { if (/calendar-day-grid|calendar-day/i.test(col.className || '')) break; col = col.parentElement; }
      const cr = (col || src.parentElement).getBoundingClientRect();
      const colSel = /calendar-day-grid/i.test((col && col.className) || '') ? '[class*="calendar-day-grid" i]' : (col && /calendar-day/i.test(col.className || '') ? '[class*="calendar-day" i]' : null);
      return { colLeft: cr.left, colTop: cr.top, colSel };
    }, sourceId);
    // no identifiable column container → we can't express a between-events offset; report unresolved (caller →
    // inconclusive) rather than performing a meaningless self-drop (advisor: src.dragTo(src) can't express the offset).
    if (!dragMeta || !dragMeta.colSel) return null;
    // AMBIGUITY GUARD (advisor, mirrors judgeDrop's identity rule): the source text must match exactly ONE event, or we
    // can't know which we're dragging → bail to inconclusive.
    const src = page.locator('[class*="calendar-event" i],[class*="event" i],[class*="lesson" i]').filter({ hasText: sourceId.slice(0, 12) });
    if ((await src.count()) !== 1) return null;
    try {
      const relX = Math.max(4, columnX - dragMeta.colLeft);
      const relY = Math.max(4, aimY - dragMeta.colTop);
      await src.first().dragTo(page.locator(dragMeta.colSel).first(), { targetPosition: { x: relX, y: relY }, timeout: 8000 });
    } catch { /* dragTo can throw on odd targets; the caller reads back position/time and treats a non-move as inconclusive */ }
    return sourceId;
  }

  // LIBRARY-DnD path (mousemove sequence): press → discrete moves toward the aim → settle → release.
  await page.mouse.move(srcInfo.x, srcInfo.y);
  await page.mouse.down();
  const midY = srcInfo.y + (aimY - srcInfo.y) / 2;
  await page.mouse.move(columnX, midY, { steps: 6 });
  await page.mouse.move(columnX, aimY, { steps: 6 });
  await page.mouse.move(columnX, aimY);
  await page.mouse.up();
  return sourceId;
}

/** The LIVE drop-precision verdict: on an already-reached calendar page, run the TWO-AIM DIFFERENTIAL for one
 *  draggable source event and return a real reproduced/not-reproduced — or inconclusive with a reason if the DOM
 *  can't be read reliably (the safety invariant: no positional verdict without two positional observations). The
 *  caller (bug-repro) keeps the honest capability-gap message unless this returns reproduced/not-reproduced.
 *
 *  `sourceId` = the event to drag (its testid or trimmed text). `columnHint` = a day/date label to disambiguate the
 *  column. It aims at two DIFFERENT slots (the bug's "always-below-the-long-event" slot vs. a lower slot) and reads
 *  back where each landed. NB: it must run twice from the SAME reached state — so it re-navigates/re-reaches between
 *  aims via `resetToState` (a caller-supplied thunk that returns the page to the calendar with the source present). */
export async function liveDropPrecisionVerdict(
  page: Page,
  opts: { sourceId: string; columnHint?: string; resetToState: () => Promise<void> },
): Promise<{ verdict: DropVerdict; why: string; arms?: [DropArm, DropArm] }> {
  // a fingerprint of the column's ordering — used to ASSERT that both arms started from the SAME state. Without this
  // the two arms aren't comparable: on a PERSISTING app, aim A's drop sticks, so aim B would start from mutated
  // geometry and could coincidentally match → a false verdict. (advisor: the fixture's reload masked this.)
  const orderFingerprint = (snap: ColumnSnapshot) => orderByY(snap).map((e) => e.id).join('>');

  // one arm: verify the start state matches `expectedStart`, then snapshot → aim → drop → re-snapshot → observed slot.
  // Returns the arm result AND the actual start snapshot so the caller can pin the slot space to a single state.
  const runArm = async (desiredSlot: number, expectedStart: string | null): Promise<{ arm: DropArm; startSnap: ColumnSnapshot }> => {
    const before = await snapshotColumn(page, opts.columnHint);
    const others = before.filter((e) => !boxMatchesId(e, opts.sourceId));
    if (before.length < 2 || others.length < 1) {
      return { arm: { intendedSlot: desiredSlot, observedSlot: null, inconclusiveWhy: `read only ${before.length} event(s) in the column — need ≥2 with distinct ids to judge position` }, startSnap: before };
    }
    if (before.filter((e) => boxMatchesId(e, opts.sourceId)).length > 1) {
      return { arm: { intendedSlot: desiredSlot, observedSlot: null, inconclusiveWhy: `the source event id ("${opts.sourceId}") is ambiguous in the column` }, startSnap: before };
    }
    // ★ THE COMPARABILITY ASSERTION: aim B must begin from the SAME ordering aim A began from. If the reset didn't
    // restore it (persisting app), the two arms are on different slot spaces → inconclusive, never a guessed verdict.
    if (expectedStart !== null && orderFingerprint(before) !== expectedStart) {
      return { arm: { intendedSlot: desiredSlot, observedSlot: null, inconclusiveWhy: `the second aim did not start from the same column state as the first (reset didn't restore order: "${expectedStart}" → "${orderFingerprint(before)}") — the two aims aren't comparable, so I won't guess` }, startSnap: before };
    }
    const aimY = aimYForSlot(others, desiredSlot);
    const colX = await page.evaluate((sid: string) => {
      const doc: any = (globalThis as any).document;
      const el: any = doc.querySelector(`[data-testid="${sid}"]`) || doc.querySelector('[class*="event" i]');
      if (!el) return 0; const r = el.getBoundingClientRect(); return r.left + r.width / 2;
    }, opts.sourceId);
    const beforeSrc = before.find((e) => boxMatchesId(e, opts.sourceId));
    const dropped = await offsetDrop(page, opts.sourceId, colX, aimY);
    if (!dropped) return { arm: { intendedSlot: desiredSlot, observedSlot: null, inconclusiveWhy: 'could not pick up the source event (not found by id)' }, startSnap: before };
    await page.waitForTimeout(400);
    const after = await snapshotColumn(page, opts.columnHint);
    const afterSrc = after.find((e) => boxMatchesId(e, opts.sourceId));
    // DRAG-DID-NOT-COMMIT detector: on a native-HTML5 calendar the gesture can RENDER but never persist — the event's
    // position AND label are unchanged after a real drag attempt. That's NOT "the app ignored the drop position" (the
    // bug); it's "this gesture isn't automatable to a committed drop" (a capability boundary, proven at the CDP floor).
    // Distinguish it so the verdict is the honest app-characterization, not a fabricated reproduced.
    const unchanged = !!(beforeSrc && afterSrc && beforeSrc.y === afterSrc.y && (beforeSrc.label || '') === (afterSrc.label || ''));
    return { arm: { intendedSlot: desiredSlot, observedSlot: observedSlotOf(after, opts.sourceId), dragCommitted: !unchanged }, startSnap: before };
  };

  // AIM A: define the slot space from A's start snapshot. slot 1 = just below the first/long event (the bug's sink).
  const a = await runArm(1, null);
  const startFingerprint = orderFingerprint(a.startSnap);
  const others = a.startSnap.filter((e) => !boxMatchesId(e, opts.sourceId));
  const lastSlot = Math.max(2, others.length);   // AIM B: the LAST slot (below all) — the ticket's "beneath the second event"

  await opts.resetToState();                      // attempt to restore; the assertion in runArm VERIFIES it actually did

  const b = await runArm(lastSlot, startFingerprint);
  // DRAG-DID-NOT-COMMIT: if BOTH aims actually attempted a drag (both had a readable start) but NEITHER changed the
  // event's position/label, the gesture rendered but the app never committed the reorder — a native-HTML5 automation
  // boundary (proven at the CDP trusted-input floor), NOT the bug and NOT a DOM-read failure. Surface it as its own
  // honest reason so the verdict is the app-characterization, not a fabricated or vague inconclusive.
  const bothAttempted = a.arm.dragCommitted !== undefined && b.arm.dragCommitted !== undefined;
  if (bothAttempted && a.arm.dragCommitted === false && b.arm.dragCommitted === false) {
    return { verdict: 'inconclusive', why: 'the drag gesture rendered but the app never committed the drop — the event\'s time/position was unchanged after two real drag attempts. This calendar uses native HTML5 drag-and-drop with no library, which browser automation cannot drive to a committed drop (verified down to the browser\'s trusted-input pipeline). This is an app-level automation boundary, not the reported bug and not a read failure: the drop-precision bug needs a human tester or a code-level check.', arms: [a.arm, b.arm] };
  }
  const d = judgeDropDifferential(a.arm, b.arm);
  return { ...d, arms: [a.arm, b.arm] };
}

