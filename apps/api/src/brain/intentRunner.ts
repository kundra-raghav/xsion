/**
 * intentRunner.ts — the EXECUTE seam. Drives a real browser through a SoA-planned IntentFlow.
 * Each step is a plain-language intent ("click the Sign In button", "fill the email field with X");
 * we resolve it to a Playwright action using accessible locators (role/text/label/placeholder) — the
 * same primitives Xsion's candidates.ts already uses. NON-DESTRUCTIVE guard mirrors Xsion's DANGEROUS_LABELS.
 * Produces StepResult[] in Xsion's shape, which SoA then verifies against the code.
 */
import { chromium, Page } from 'playwright';
import type { IntentFlow, IntentStep } from './soaClient';
import { explorePage, goalStep } from './soaClient';
import { pageClickableInventory } from './pageInventory';
import { buildTenantReachPrefix } from './reachState';   // deterministic tenant-reach producer
import { scopeOfPath } from './graphFlows';               // path→scope for the tenant producer
import { installEvalShim } from './evalShim';
import { tryLoginSettled } from './crawlMapService';   // UNIFIED LOGIN: reuse the crawler's proven tri-state dynamic sign-in for every engine's login pre-step

/** OFF-THE-GATE predicate — identical to crawlMapService.tryLogin's knownAppRoute (a URL whose path is present and
 *  not /login IS being in the app). Reused for BOTH the login attempt's positive-evidence signal AND the retry
 *  loop's "still on the gate?" check so the two can never disagree. */
function offLoginGate(u: string): boolean { try { const p = new URL(u).pathname.replace(/^\//, ''); return !!p && !/^login\b/i.test(p); } catch { return false; } }
import { fillMaybeAutocomplete, snapshotLists, locateOptionRows } from './autocompleteFill';   // type-then-select + class-name-free option-list location (verify-by-effect)
import { classifyElement } from './safetyGate';   // gate reveal-control clicks — never click a dangerous-labelled control to reveal a field

const DANGEROUS = ['delete', 'remove', 'pay', 'logout', 'sign out', 'log out', 'deactivate', 'destroy', 'unsubscribe'];

// SETTLE-UNTIL-STABLE — wait for an SPA to FINISH rendering after a navigation, not just "have some elements". The
// crawler waits (gotoRendered→waitForHydration) on every nav; the EXECUTOR didn't → a step fired on a half-mounted
// page and failed ("no candidates" / wrong control). Poll the interactive count until it's substantial AND unchanged
// across two consecutive polls (= the async mount settled). Bounded; a genuinely blank page just proceeds and fails
// honestly. Called post-login (long budget — whole app boots) AND after any URL-changing step (short — SPA route
// change inside an already-booted app settles fast).
/** Race a single step's work against a wall-clock cap. On timeout, REJECT with a distinguishable error (the caller's
 *  catch keys on XSION_STEP_TIMEOUT to mark it a harness interruption, not an app fail). The timer is cleared when the
 *  work settles so the loser never fires late (the authGate phantom-CAP lesson). NOTE: Promise.race does NOT cancel
 *  the losing work — so this MUST be used where teardown (browser.close) runs regardless, i.e. inside executeFlow whose
 *  finally-style teardown is OUTSIDE the try; that closes the context even when a step wedged. */
async function withStepTimeout<T>(ms: number, stepIndex: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`XSION_STEP_TIMEOUT: step ${stepIndex} exceeded ${ms}ms`)), ms); });
  try { return await Promise.race([work, cap]); } finally { clearTimeout(timer); }
}

const INTERACTIVE_SEL = 'a[href], button, [role="button"], [role="option"], [role="menuitem"], li, input, select';
const SIG_MIN = 4;   // shared with settleUntilStable's plateau floor AND the empty-DOM reprobe gate

/** Race a page.evaluate against a short timeout so a MID-NAVIGATION context can't block the caller: Playwright's
 *  evaluate waits (internally, ignoring our loop budget) for a new execution context while a committing click is
 *  navigating — that wedged settleUntilStable for 60s+ AFTER a successful create-commit click (the walker looked
 *  "stuck" though the create had landed). A bounded race returns the fallback instead of hanging. (2026-08-24) */
async function evalBounded<T>(page: Page, fn: (s: string) => T, fallback: T, ms = 2500): Promise<T> {
  try {
    return await Promise.race([
      page.evaluate(fn, INTERACTIVE_SEL),
      new Promise<T>((res) => setTimeout(() => res(fallback), ms)),
    ]);
  } catch { return fallback; }
}
/** Count of interactive nodes (the SAME selector set used everywhere) — the plateau signal. */
async function domCount(page: Page): Promise<number> {
  return evalBounded(page, (s) => (globalThis as any).document.querySelectorAll(s).length, 0);
}
/** Structural signature: interactive-node count + visible-text length. Catches a view swap even when the interactive
 *  COUNT is unchanged (picker→picker), which a bare count would miss. One evaluate; compared as a string. */
async function domSig(page: Page): Promise<string> {
  return evalBounded(page, (s) => { const d = (globalThis as any).document; return d.querySelectorAll(s).length + ':' + (d.body?.innerText?.length || 0); }, '0:0');
}
/** Wait (bounded) for the DOM signature to change MEANINGFULLY from a captured baseline — a view swap, not a toast /
 *  char-counter / "Saving…" label tick. "Meaningful" = the interactive-node count moved (catches picker→picker swaps
 *  where text is similar) OR the visible-text length moved substantially (>40 chars AND >20%, catches SPA route/state
 *  swaps where the count is unchanged). Returns true as soon as that holds. Structural + no vocabulary → generalizes;
 *  no URL dependency (state-only tenant switches don't move the URL). NOTE ON COST: an inert click returns false only
 *  at the timeout, so keep maxWaitMs SMALL — a real re-render BEGINS within a few hundred ms; settleUntilStable owns
 *  waiting for it to COMPLETE. So this is just "did a swap start?", cheaply bounded. */
async function waitForSigChange(page: Page, sigBefore: string, maxWaitMs: number): Promise<boolean> {
  const [cB, tB] = sigBefore.split(':').map(Number);
  const meaningful = (sig: string) => { const [c, t] = sig.split(':').map(Number); return c !== cB || Math.abs(t - tB) > Math.max(40, tB * 0.2); };
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    if (meaningful(await domSig(page))) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function settleUntilStable(page: Page, maxWaitMs: number): Promise<{ count: number; ms: number }> {
  const MIN = SIG_MIN, STABLE = 3, POLL = 500;   // 3 stable polls: a page that renders 40→1→40 fails a 3-poll check + keeps waiting
  let prev = -1, hits = 0, last = 0; const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    last = await domCount(page);
    if (last >= MIN && last === prev) { if (++hits >= STABLE) break; } else hits = 0;
    prev = last;
    await page.waitForTimeout(POLL).catch(() => {});
  }
  if (process.env.XSION_WIZ_DEBUG) console.error(`[SETTLE] loop done at ${Date.now() - t0}ms, calling networkidle…`);
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  if (process.env.XSION_WIZ_DEBUG) console.error(`[SETTLE] networkidle done at ${Date.now() - t0}ms`);
  await page.waitForTimeout(300).catch(() => {});
  return { count: last, ms: Date.now() - t0 };
}

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
export interface ObservedCall { method: string; url: string; status: number; write: boolean; okBody: boolean; stepIndex: number; }
/** An APP-AGNOSTIC state snapshot — the raw material of the state-delta oracle. Every field is a MECHANICAL fact
 *  (a count, a hash), no app knowledge, so a diff is an OBSERVATION (like a 5xx), never an interpretation. */
export interface StateProbe {
  rowCount: number;        // visible <tr>/<li>/[role=row|listitem] count — the "a record appeared/vanished" signal
  domSig: string;          // structural signature of the visible DOM (tag skeleton) — content-agnostic
  storageHash: string;     // hash of ALL localStorage (any key changing = a client-side write landed) — app-agnostic
  storageBytes: number;    // total localStorage size — a coarse "data grew/shrank" signal
  textLen: number;         // visible body text length — a coarse content-moved signal
}
/** The before/after(/after-reload) state around a mutating action. `persisted` distinguishes a REAL write (survives a
 *  reload) from an optimistic-then-reverted or random-500-that-still-applied blip (the false-positive class). */
export interface StateDelta {
  before: StateProbe;
  after: StateProbe;
  afterReload?: StateProbe;   // captured iff a reload confirmation ran
  changed: boolean;           // after !== before on ANY mechanical signal
  persisted?: boolean;        // afterReload !== before (the change SURVIVED a reload = a real write)
  reverted?: boolean;         // changed but NOT persisted (optimistic-revert / apply-anyway-then-fail blip)
}
export interface ExecResult {
  flowName: string;
  status: 'passed' | 'failed';
  baseUrl: string;
  stepResults: StepResult[];
  consoleErrors: string[];
  observedCalls?: ObservedCall[];   // API calls fired DURING the flow (passive) — the post-submit oracle reads these
  finalText?: string;   // the page's visible text after the flow (so a caller can see the result message)
  finalUrl?: string;
  stateDelta?: StateDelta;   // the STATE-DELTA ORACLE's evidence: did the mutating action change observable state, and did it PERSIST?
  // LIVE ATTACK SURFACE (the fundamental fix): the fillable inputs + clickable action controls actually PRESENT on the
  // feature's page AFTER reach — ground truth, captured at execution time. break-it regenerates its attack plan from
  // THIS (not the stale map), so conditional-rendered controls are attackable + phantom map fields never generate a
  // failing attack. App-agnostic (a live DOM scan), deterministic (no LLM).
  liveFields?: Array<{ label: string; kind: string; required: boolean }>;
  liveActions?: string[];   // labels of clickable non-nav action controls present (for the click-action attack shape)
  // Capture-trust signals (2026-08-30): liveFields is a UNION captured across every step (multi-step forms / modals
  // that only open DURING the attack). `liveScope` = did ANY capture see the feature inside its own modal/dialog
  // (a bounded, complete surface) vs only ambient page inputs. `liveCapturePartial` = a step reported it couldn't
  // fully drive the form (fieldAbsent / "couldn't drive N/M fields") → the union may be incomplete. break-it uses
  // these to decide whether it may SUBTRACTIVELY drop stale attacks (only when trustworthy) vs only ADD (always safe).
  liveScope?: 'modal' | 'page';
  // COHORT: the single best CO-PRESENT snapshot of fields (all in the DOM at one instant). Attack CONSTRUCTION fills
  // from THIS (never the union — cross-step fields don't co-exist, so filling them stalls). liveFields stays the union
  // for DISCOVERY (does a field exist anywhere on the surface). Absent ⇒ no fields ever captured.
  liveCohort?: Array<{ label: string; kind: string; required: boolean }>;
  // Actions INSIDE the feature's own modal (e.g. Flag's preset buttons). Once inside the feature's modal, membership
  // is the scoping — break-it click-attacks these WITHOUT the feature-name filter that page-level actions need.
  liveModalActions?: string[];
  // did the capture-probe's opener click PERSIST a write? true ⇒ a DIRECT row-action (mutates on click, no modal) ⇒
  // the feature has no form to attack, so break-it clears the scraped crawl fields (Approve/Allocate ground-truth fix).
  liveOpenerPersisted?: boolean;
  // Short-lived toast/alert text captured DURING the click window (before auto-dismiss). Carries the failure signal
  // ("Something went wrong (500)") that finalText — read seconds later after a reload — misses, so the applied-despite-
  // failure oracle can see a failure signal + a persisted write in the same window.
  transientAlerts?: string[];
}

/** Capture an APP-AGNOSTIC state snapshot. Pure observation — mechanical facts only. */
export async function stateProbe(page: Page): Promise<StateProbe> {
  try {
    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
      const rowCount = doc.querySelectorAll('tr, li, [role="row"], [role="listitem"]').length;
      // structural DOM signature: the tag skeleton of visible elements (content-agnostic; a new row changes it).
      let sig = '';
      try { const tags = Array.prototype.map.call(doc.querySelectorAll('*'), (e: any) => e.tagName).join(','); let h = 5381; for (let i = 0; i < tags.length; i++) h = ((h << 5) + h + tags.charCodeAt(i)) | 0; sig = (h >>> 0).toString(36) + ':' + doc.querySelectorAll('*').length; } catch {}
      // localStorage: hash ALL keys+values (app-agnostic — any write to any key registers) + total size.
      let storageHash = '', storageBytes = 0;
      try { const ls = win.localStorage; const parts: string[] = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i)!; const v = ls.getItem(k) || ''; parts.push(k + '=' + v); storageBytes += k.length + v.length; } const joined = parts.sort().join(''); let h = 5381; for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0; storageHash = (h >>> 0).toString(36); } catch {}
      const textLen = ((doc.body && doc.body.innerText) || '').length;
      return { rowCount, domSig: sig, storageHash, storageBytes, textLen };
    });
  } catch { return { rowCount: -1, domSig: '', storageHash: '', storageBytes: -1, textLen: -1 }; }
}
/** Compare two probes → did observable state change MECHANICALLY? (any signal moved). Used for BEFORE→AFTER on the
 *  SAME view (rowCount/domSig are valid there). */
export function probesDiffer(a: StateProbe, b: StateProbe): boolean {
  return a.storageHash !== b.storageHash || a.rowCount !== b.rowCount || a.domSig !== b.domSig || Math.abs(a.storageBytes - b.storageBytes) > 0;
}
/** Compare for PERSISTENCE across a reload — STORAGE ONLY. Critical: a reload can bounce the app to a login/gate
 *  (in-memory session), so rowCount/domSig/textLen all change regardless of whether a write landed — using them would
 *  make `persisted` a TAUTOLOGY on any gate-bouncing app. localStorage is what the app actually persists, so a storage
 *  delta that survives a reload is the ONLY honest "the write is real" signal. */
export function probesStorageDiffer(a: StateProbe, b: StateProbe): boolean {
  return a.storageHash !== b.storageHash || Math.abs(a.storageBytes - b.storageBytes) > 0;
}

/** GOAL WALK-OFF ORACLE (2026-08-30): given the storage state before the goal acted, after it acted, and after a
 * reload — plus an optional confirming HTTP write — decide if the goal was reached BY OBSERVED EFFECT. A goal like
 * "flag X and confirm it saved" has no verify node, so the goal loop used to stop "honestly" even when the action
 * committed a real persisted write. Two corroboration sources (same as the verify-open branch): a persisted storage
 * write OR a confirming HTTP write. CRUCIAL: a storage change that does NOT survive the reload is apply-then-revert
 * (torture's 12% 500-that-rolls-back) → NOT reached; a fake pass here is worse than the false stop we're fixing.
 * Pure so it's hermetic-testable (this change turns stops into successes — its failure mode is a fake pass). */
export function goalReachedByEffect(
  before: StateProbe | null,
  after: StateProbe | null,
  afterReload: StateProbe | null,
  confirmingWrite: boolean,
): { reached: boolean; via: 'storage-persisted' | 'http-write' | null } {
  // storage persisted = it changed after the action AND the change survived a reload (a real committed write).
  if (before && after && afterReload) {
    const changed = probesStorageDiffer(before, after);
    const persisted = probesStorageDiffer(before, afterReload);
    if (changed && persisted) return { reached: true, via: 'storage-persisted' };
    // changed but reverted on reload → apply-then-fail → NOT a confirmed write (fall through to the HTTP check).
  }
  if (confirmingWrite) return { reached: true, via: 'http-write' };
  return { reached: false, via: null };
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
  else if (/\b(refresh|reload)\b.*\b(page|browser|it|screen)\b|\b(refresh|reload) the\b|^(refresh|reload)\b/.test(low)) verb = 'reload';
  else if (/\bsubmit (the )?(form|search|it)\b|\bsubmit\b\s*$/.test(low)) verb = 'submit';
  // LOCATE (the general goal-agent's find-a-specific-item verb): "locate the item/event/row containing X and click it".
  // Routes to resolveLocateByText (strict substring, no row-0 fake) — distinct from a plain click on a known label.
  else if (/\blocate\b|\bfind (the |and click |and open )?(item|event|row|entry|record|the one)\b/.test(low)) verb = 'locate';
  else if (/\b(type|fill|enter|input)\b/.test(low)) verb = 'fill';
  else if (/\b(navigate|go to|open|visit)\b/.test(low)) verb = 'navigate';
  else if (/\b(select|choose|pick)\b/.test(low)) verb = 'select';
  // CHECK/TOGGLE (forms fix): "check the Terms box", "tick Remember me", "toggle Notifications", "uncheck X" = a real
  // checkbox/radio ACTION — must NOT fall to observe (which no-ops and returns matched:1, a silent false pass). But
  // "check that X is visible" / "verify X" stays observe. Discriminator: "check that/if/whether" → observe; else action.
  else if (/\b(uncheck|untick|deselect)\b/.test(low)) verb = 'uncheck';
  else if (/\b(toggle)\b/.test(low)) verb = 'check';   // toggle → treat as ensure-checked (resolveCheck decides by current state)
  else if (/\b(check|tick|enable)\b/.test(low) && !/\bcheck\s+(that|if|whether|for)\b/.test(low)) verb = 'check';
  else if (/\b(review|verify|see|wait|check|observe)\b/.test(low)) verb = 'observe';
  // quoted strings — a drag has TWO ("drag 'A' onto 'B'")
  const quotes = [...intent.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  let target = quotes[0] || intent.replace(/^\s*\w+\s+(the\s+)?/i, '').replace(/\s+(button|field|link|dropdown|box|option).*$/i, '').trim();
  const target2 = quotes[1] || (verb === 'drag' ? (intent.match(/\b(?:onto|to|on|below|between|above|over)\s+(.+)$/i)?.[1] || '').trim() : undefined);
  const withVal = intent.match(/\bwith\s+(.+)$/i);
  // for press, the value is the key name
  const keyMatch = verb === 'press' ? intent.match(/\b(enter|tab|escape|esc|arrowup|arrowdown|arrowleft|arrowright|space|backspace|delete|end|home|pageup|pagedown|[a-z0-9])\b/i) : null;
  // COMPANION FIX (autocomplete): break-it emits `fill "X" field with "Jane Doe"` — withVal[1] is `"Jane Doe"` WITH
  // wrapping quotes, so pressSequentially would type a literal `"` and the autocomplete match nothing. Strip wrapping
  // quotes; for the unquoted shape, strip a trailing select-clause; never over-strip to empty.
  let rawVal = withVal ? withVal[1].trim() : undefined;
  if (rawVal) { const m = rawVal.match(/^['"](.+)['"]$/); if (m) rawVal = m[1]; }
  return { verb, target: target || intent, value: rawVal ?? (keyMatch ? keyMatch[1] : undefined), target2: target2 || undefined };
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
  // STRUCTURAL row selectors first (tag/role/interactivity), then the cursor-class hint as a bonus tier — so row
  // detection does NOT DEPEND on a Tailwind cursor class (2026-08-23 de-vocab): [onclick]/tabindex mark a clickable
  // row structurally, independent of any library's class name.
  const rowSelectors = ['table tbody tr', '[role="row"]', 'li[role="option"]', 'ul li[onclick]', 'ul li[tabindex]', 'tr[onclick]', 'tr[tabindex]', 'tr[class*="cursor-pointer"]', 'ul li[class*="cursor"]'];
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

/** OPEN-STATE observation for the general agent's "did it open?" predicate (2026-08-23). Full location.href (NOT the
 *  pathname-only snapshotView.url — a detail view often opens via ?id=/#/event/123/a modal, which pathname misses),
 *  plus overlay + visible-field counts. The agent compares before/after a click: an item OPENED iff the href CHANGED,
 *  OR an overlay/modal appeared, OR a detail form's fields appeared. A DELTA — never an absolute page property (an
 *  absolute "marker is on the page" is true on the LIST view before any click → that was the fake-success trap). */
export interface OpenState { href: string; overlays: number; fields: number; bodyLen: number; }
export async function observeOpenState(page: Page): Promise<OpenState> {
  return await page.evaluate(() => {
    const d: any = (globalThis as any).document;
    const vis = (el: any) => !!(el && (el.offsetWidth || el.offsetHeight));
    const overlays = Array.prototype.slice.call(d.querySelectorAll('[role="dialog"], dialog[open], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')).filter(vis).length;
    const fields = Array.prototype.slice.call(d.querySelectorAll('input:not([type=hidden]), textarea, select')).filter(vis).length;
    return { href: (globalThis as any).location.href, overlays, fields, bodyLen: ((d.body && d.body.innerText) || '').length };
  }).catch(() => ({ href: '', overlays: 0, fields: 0, bodyLen: 0 }));
}
/** DID-IT-OPEN delta predicate: given the state BEFORE and AFTER a locate-click, did a detail/item view open?
 *  href moved (search/hash included) OR a modal appeared OR detail fields appeared. Pure — the honesty-safe check. */
export function evalOpened(before: OpenState, after: OpenState): boolean {
  return after.href !== before.href || after.overlays > before.overlays || after.fields > before.fields;
}

/** STRICT LOCATE-BY-TEXT (2026-08-23, the general-agent's mission-critical primitive): find and click the row/item
 *  whose text CONTAINS a required substring (e.g. the unique marker/date-time of an item WE just created). Unlike
 *  resolveRowClick, there is NO row-0 fallback — a miss returns matched:0 with the candidate texts, so the agent
 *  loop STOPS honestly ('locate-miss') rather than clicking the wrong row and faking a pass. This is what lets
 *  "locate the event I created and click it" be provable on a view the crawler never mapped: the marker makes the
 *  item uniquely findable by STRUCTURE (rendered text), no app-specific DOM knowledge. `needles` = required
 *  substrings (ALL must be present in the item's text); case-insensitive. */
export async function resolveLocateByText(page: Page, needles: string[]): Promise<StepAttempt> {
  const want = needles.map((s) => (s || '').toLowerCase().trim()).filter(Boolean);
  if (!want.length) return { kind: 'locate', selector: '(no needle)', matched: 0, error: 'locate called with no text to match' };
  // widest structural set of "item" rows — table rows, list items, role=row/option/listitem, and generic clickable
  // cards (has onclick/tabindex/role=button). NO class-name dependency.
  const sels = ['table tbody tr', '[role="row"]', '[role="option"]', '[role="listitem"]', 'li', '[onclick]', '[tabindex]:not(input):not(textarea)'];
  const seen: string[] = [];
  for (const sel of sels) {
    let rows: any;
    try { rows = page.locator(sel); } catch { continue; }
    const n = Math.min(await rows.count().catch(() => 0), 60);
    for (let i = 0; i < n; i++) {
      const txt = ((await rows.nth(i).textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const low = txt.toLowerCase();
      if (want.every((w) => low.includes(w))) {
        // require it to be a leaf-ish clickable item, not a huge wrapper containing the whole page (avoid clicking <body>)
        if (txt.length > 300) continue;
        const box = await rows.nth(i).boundingBox().catch(() => null);
        const err = await robustClick(rows.nth(i));
        return err
          ? { kind: 'locate', selector: `"${txt.slice(0, 40)}"`, matched: 1, error: err, box }
          : { kind: 'locate', selector: `"${txt.slice(0, 40)}"`, matched: 1, chosenIndex: i, box };
      }
      if (seen.length < 8 && txt.length < 60) seen.push(txt);
    }
  }
  // STRUCTURAL PASS 2 — CURSOR:POINTER blocks (2026-08-24): calendar event blocks (schooltalk's div.calendar-event),
  // card grids, and many React widgets are CLICKABLE divs with NO role/tabindex/onclick ATTRIBUTE — invisible to the
  // 7 attribute-selectors above, so locate missed a created event that WAS on the page (measured: run e1a68c76). The
  // universal structural signal for "this div is clickable" is computed `cursor: pointer` — class-name-free, works on
  // any app. Find the SMALLEST cursor:pointer element containing ALL needles (smallest = the leaf block, not a huge
  // wrapper), tag it, and click via a real locator. textContent carries the FULL marker even when CSS truncates the
  // visible label, so the substring match holds.
  try {
    const tagged = await page.evaluate((needles: string[]) => {
      const d: any = (globalThis as any).document;
      const want = needles;
      const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
      const has = (el: any) => { const t = (el.textContent || '').toLowerCase(); return want.every((w) => t.includes(w)); };
      const cands = Array.prototype.slice.call(d.querySelectorAll('div, span, a, article, section, td, [class]'))
        .filter((el: any) => vis(el) && has(el) && (el.textContent || '').length <= 300 && (globalThis as any).getComputedStyle(el).cursor === 'pointer');
      if (!cands.length) return null;
      // smallest by text length = the leaf event block, not a day-column wrapper that also contains the marker
      cands.sort((a: any, b: any) => (a.textContent || '').length - (b.textContent || '').length);
      const el = cands[0];
      el.setAttribute('data-xsion-locate', '1');
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    }, want);
    if (tagged) {
      const loc = page.locator('[data-xsion-locate="1"]').first();
      const box = await loc.boundingBox().catch(() => null);
      const err = await robustClick(loc);
      await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsion-locate="1"]'); if (e) e.removeAttribute('data-xsion-locate'); }).catch(() => {});
      return err
        ? { kind: 'locate:cursor', selector: `"${tagged}"`, matched: 1, error: err, box }
        : { kind: 'locate:cursor', selector: `"${tagged}"`, matched: 1, chosenIndex: 0, box };
    }
  } catch { /* fall through to honest miss */ }
  // NO fallback — honest miss. The agent loop reads matched:0 and stops 'locate-miss'.
  // DIAGNOSTIC (env-gated, temporary): on a miss, dump how the needle IS present in the DOM so we can see WHY the
  // 7-selector scan missed it (truncated text / unreachable React-onClick block / >300-char wrapper / not rendered).
  if (process.env.XSION_LOCATE_DEBUG) {
    try {
      const probe = await page.evaluate((needles: string[]) => {
        const SELS = ['table tbody tr', '[role="row"]', '[role="option"]', '[role="listitem"]', 'li', '[onclick]', '[tabindex]:not(input):not(textarea)'];
        const all = Array.prototype.slice.call((globalThis as any).document.querySelectorAll('*'));
        const has = (el: any) => needles.every((w) => (el.textContent || '').toLowerCase().includes(w));
        const containing = all.filter(has);
        const leaf = containing.filter((el: any) => el.children.length <= 3);
        const s = leaf[0] || containing[0];
        return {
          bodyHasNeedle: needles.every((w) => ((globalThis as any).document.body.innerText || '').toLowerCase().includes(w)),
          totalContaining: containing.length, leafCount: leaf.length,
          anyMatchesAnySel: containing.some((el: any) => SELS.some((x) => { try { return el.matches(x); } catch { return false; } })),
          sampleTag: s?.tagName, sampleLen: (s?.textContent || '').length, sampleKids: s?.children.length,
          sampleTxt: (s?.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
          sampleSels: s ? SELS.filter((x) => { try { return s.matches(x); } catch { return false; } }) : [],
          sampleOnclick: s?.hasAttribute?.('onclick'), sampleRole: s?.getAttribute?.('role'), sampleTab: s?.getAttribute?.('tabindex'),
          sampleClass: (s?.className || '').toString().slice(0, 70),
        };
      }, want);
      // eslint-disable-next-line no-console
      console.log(`[XSION_LOCATE_DEBUG] needle=${JSON.stringify(want)} url=${page.url()}\n${JSON.stringify(probe, null, 1)}`);
    } catch (e: any) { console.log(`[XSION_LOCATE_DEBUG] probe error: ${String(e?.message || e).slice(0, 100)}`); }
  }
  return { kind: 'locate', selector: want.join(' + '), matched: 0, error: `no item found containing ${JSON.stringify(want)}. Candidates seen: ${seen.slice(0, 6).join(' | ') || '(none)'}` };
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

/** CUSTOM DROPDOWN (React-Select / MUI / Radix / AntD): native <select> resolved null, so this is a click-to-open
 *  widget. Old behavior fell to resolveClick → opened the menu, reported matched:1, but NEVER picked (silent false
 *  pass). Here: open the trigger, wait for options, pick the best text-match, and — the reviewer's key correction —
 *  gate SUCCESS on the MENU CLOSING (a reliable "a selection happened" signal), NOT on the trigger's text (a wrapper
 *  trigger contains the whole option list, so a text check is trivially true even on a no-op). Honest matched:0 if no
 *  option matches — never a wrong pick. */
async function resolveCustomDropdown(page: Page, target: string, value?: string): Promise<StepAttempt | null> {
  const words = contentWords(`${value || ''} ${target}`);
  try {
    // find the trigger: a combobox/haspopup control matching the target. Prefer the INNERMOST such element (a wrapper
    // div also matches [aria-haspopup] but reading its text swallows the option list — the reviewer's false-pass).
    const trig = await bestMatch(page, target, ['combobox', 'button', 'listbox']);
    let trigger = trig.loc?.first();
    if (!trigger) {
      const cand = page.locator('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"], [aria-expanded]');
      if (await cand.count().catch(() => 0)) trigger = cand.first(); else return null;
    }
    // DE-VOCABULARIZED (2026-08-23): the old optSel enumerated MUI/AntD class strings. Replaced with verify-by-effect
    // (the same primitive as fillMaybeAutocomplete): snapshot list-containers BEFORE opening, then the menu is the
    // list that APPEARED after clicking the trigger — structural, class-name-free, works for any widget library.
    const before = await snapshotLists(page);
    await trigger.click({ timeout: 4000 });
    // wait (bounded) for a NEW list container to appear = the opened menu
    let opts: any = null;
    const openDeadline = Date.now() + 2500;
    while (Date.now() < openDeadline && !opts) {
      await page.waitForTimeout(150);
      const lists = await locateOptionRows(page, trigger, before);
      if (lists.length) opts = lists[0];
    }
    if (!opts) { await page.keyboard.press('Escape').catch(() => {}); return null; }   // menu never opened → not a dropdown
    const n = Math.min(await opts.count().catch(() => 0), 20);
    let bestI = -1, bestS = 0, bestTxt = '';
    for (let i = 0; i < n; i++) {
      const o = ((await opts.nth(i).textContent().catch(() => '')) || '').trim();
      const ow = new Set(contentWords(o));
      const s = words.reduce((acc, w) => acc + (ow.has(w) ? 2 : o.toLowerCase().includes(w) ? 1 : 0), 0);
      if (s > bestS) { bestS = s; bestI = i; bestTxt = o.slice(0, 40); }
    }
    if (bestI < 0 || bestS < 1) { await page.keyboard.press('Escape').catch(() => {}); return null; }   // no match → honest null, close menu
    await opts.nth(bestI).click({ timeout: 3000 });
    // SUCCESS GATE: the menu must CLOSE = no NEW list container remains vs baseline (a wrapper-trigger's text can't
    // fake this). Re-run the same verify-by-effect check; empty result → the menu closed → a selection happened.
    let closed = false;
    for (let t = 0; t < 4 && !closed; t++) { await page.waitForTimeout(200); const still = await locateOptionRows(page, trigger, before); if (!still.length) closed = true; }
    return closed
      ? { kind: 'custom-dropdown', selector: `${target}→"${bestTxt}"`, matched: 1, chosenIndex: bestI }
      : { kind: 'custom-dropdown', selector: `${target}→"${bestTxt}"`, matched: 0, error: 'clicked an option but the menu did not close — selection unconfirmed' };
  } catch { return null; }
}

/** CHECKBOX / RADIO (forms fix): resolve a checkbox/radio matching the target and setChecked. Old behavior: a "check
 *  the box" step fell to verb=observe → no-op → matched:1 (silent false pass, nothing toggled). Honest matched:0 if no
 *  checkbox/radio matches (never claims success). `want` = desired checked state (false for uncheck). */
async function resolveCheck(page: Page, target: string, want: boolean): Promise<StepAttempt> {
  const m = await bestMatch(page, target, ['checkbox', 'radio', 'switch']);
  if (m.loc && m.cand) {
    const box = await m.loc.first().boundingBox().catch(() => null);
    try {
      await m.loc.first().setChecked(want, { timeout: 5000 });
      const now = await m.loc.first().isChecked().catch(() => want);
      return now === want
        ? { kind: `${m.cand.role}:setChecked(${want})`, selector: `${m.cand.name}=${want}`, matched: 1, chosenIndex: 0, box }
        : { kind: `${m.cand.role}`, selector: m.cand.name, matched: 0, error: `setChecked(${want}) did not take`, box };
    } catch (e: any) {
      return { kind: `${m.cand.role}`, selector: m.cand.name, matched: 0, error: String(e.message || e).slice(0, 140), box };
    }
  }
  // no role match — try a bare checkbox/radio input scored by nearby label text (unlabeled custom checkboxes)
  try {
    const boxes = page.locator('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]');
    const words = contentWords(target);
    const n = Math.min(await boxes.count(), 30); let best = -1, bestS = 0;
    for (let i = 0; i < n; i++) {
      const lbl = ((await boxes.nth(i).getAttribute('aria-label')) || (await boxes.nth(i).getAttribute('name')) || (await boxes.nth(i).evaluate((el: any) => { const id = el.id; const l = id && (globalThis as any).document.querySelector(`label[for="${id}"]`); return (l?.textContent || el.closest('label')?.textContent || '').trim(); }).catch(() => '')) || '').toLowerCase();
      const hay = new Set(contentWords(lbl));
      const s = words.reduce((acc, w) => acc + (hay.has(w) ? 2 : lbl.includes(w) ? 1 : 0), 0);
      if (s > bestS) { bestS = s; best = i; }
    }
    if (best >= 0 && bestS >= 1) {
      await boxes.nth(best).setChecked(want, { timeout: 5000 });
      return { kind: `checkbox:setChecked(${want})`, selector: `${target}=${want}`, matched: 1, chosenIndex: best };
    }
  } catch { /* fall through to honest miss */ }
  return { kind: 'check:no-match', selector: target, matched: 0, error: 'no checkbox/radio matched the target', candidates: m.candidates } as any;
}

// HUMAN-CONFIRMED CORRECTIONS (the teach-the-app loop, enforced in the EXECUTOR not the planner): a fact stored via
// /answer-control names the REAL control for a step the ticket mislabels. A prompt can ignore it; CODE can't. Keyed
// on the FAILURE not the step string (advisor): when a click fails, if any human-confirmed correction's control
// LABEL is present on THIS page, click it. That recognizes "the screen where you get stuck" via its candidates,
// deterministically, without phrase-matching. Run-scoped, set by executeFlow. Human-confirmed ONLY (never observed
// facts — those carry cross-tenant noise).
let _corrections: string[] = [];   // control labels from human-confirmed corrections, this run
/** test-only: set the run-scoped corrections directly (executeFlow does this from opts.corrections in production). */
export function __setCorrectionsForTest(c: string[]) { _corrections = c; }
/** test-only: expose tryCorrection + resolveClick for the synthetic hermetic. */
export const __testHooks = { tryCorrection: (p: Page) => tryCorrection(p), resolveClick: (p: Page, t: string, i = '') => resolveClick(p, t, i) };

/** Try a human-confirmed correction on the current page: click the FIRST corrected control that (a) is present as a
 *  visible clickable, (b) isn't destructive. Returns the attempt if one fired, else null. */
async function tryCorrection(page: Page): Promise<StepAttempt | null> {
  for (const ctrl of _corrections) {
    const c = (ctrl || '').trim();
    if (!c || c.length < 3) continue;
    if (DANGEROUS.some((d) => c.toLowerCase().includes(d))) continue;   // a correction must still respect the danger gate
    try {
      const loc = page.getByRole('button', { name: c, exact: false }).or(page.getByText(c, { exact: true }));
      if ((await loc.count()) >= 1) {
        const first = loc.first();
        if (!(await first.isVisible().catch(() => false))) continue;
        const box = await first.boundingBox().catch(() => null);
        const err = await robustClick(first);
        if (!err) return { kind: 'corrected', selector: `[corrected]→"${c}"`, matched: 1, chosenIndex: 0, box, corrected: true } as any;
      }
    } catch { /* try the next correction */ }
  }
  return null;
}

export async function resolveClick(page: Page, target: string, intent = ''): Promise<StepAttempt> {
  const words = contentWords(target);
  // ROW-INTENT FIRST: if the step is about clicking a row/item, try the row resolver BEFORE button matching —
  // else "click a user row" wrongly matches the 'Add User' button (which contains the word 'user').
  if (/\b(row|entry|record|result)\b/i.test(intent) || /\bon (a|any|the first) \w+ (row|to view)/i.test(intent)) {
    const row = await resolveRowClick(page, words, intent);
    if (row) return row;
  }
  const m = await bestMatch(page, target, ['button', 'link', 'menuitem', 'tab', 'option', 'combobox']);   // combobox = a real clickable role (React-Select/MUI/Radix dropdown triggers) the role list omitted → clicks fell to the fragile exact-text fallback (2026-08-27)
  if (m.loc && m.cand) {
    // capture WHERE we're about to click BEFORE the action (after it, the element may be gone/re-rendered → null box)
    const box = await m.loc.first().boundingBox().catch(() => null);
    const err = await robustClick(m.loc.first());
    return err
      ? { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 1, error: err, box }
      : { kind: `role:${m.cand.role}`, selector: `${m.cand.name}~"${target}"`, matched: 1, chosenIndex: 0, box };
  }
  // FALLBACK: EXACT-LABEL / WRAPPED-NAV click (2026-08-30). bestMatch scores accessible NAMES — but a nav item whose
  // label lives in a child <span> with a concatenated route hint ("Orders#/orders") and no aria-label has an EMPTY
  // accessible name, so bestMatch returns matched:0 and the step fails (bug-repro's "click Orders#/orders" → every
  // downstream step cascaded, and its loginWall heuristic then misblamed missing creds even though login had SUCCEEDED).
  // clickByLabelInPage's pass-2 sees through the wrapper (first-span text / route-hint-stripped text / data-nav attr)
  // and does a real click — the same fix already proven for reach, now applied to the step path. Clean short label only.
  if (target && target.length <= 42 && !/\s{3,}/.test(target)) {
    const exact = await clickByLabelInPage(page, target);
    if (exact) return { kind: 'exact-label', selector: `exact:"${target}"`, matched: 1, chosenIndex: 0 };
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
  // BEFORE failing: a HUMAN-CONFIRMED correction may name the real control for THIS screen. If one of its labels is
  // present here, click it — the operator already told us this is the control, and code honors it regardless of how
  // the planner phrased the step (the last mile of the teach-the-app loop, enforced deterministically).
  if (_corrections.length) { const corr = await tryCorrection(page); if (corr) return corr; }
  // FAIL: attach the candidate list SoA can triage against (the key fix vs bare "no element found")
  return { kind: 'click', selector: target, matched: 0, error: `no match for "${target}" (best=${m.score}). Candidates on page: ${candList(m.candidates)}` };
}

// ── EXTENDED INTERACTIONS (bug tickets need these, not just click/fill) ──

/** A drag SOURCE/TARGET must be an element LABEL, not a continuation-clause. When a planner splits one gesture into
 * two steps ("drag X onto Y" then "release it at the drop position and observe its final placement"), the second
 * step's whole sentence becomes the "source" — feeding a verb-bearing clause to bestMatch produces a nonsense
 * selector like "event at that drop position and observe its final placement". Reject those honestly instead: if the
 * phrase reads like an instruction (contains action/observation verbs, or is a long free-form clause) rather than a
 * short element name, it's not a droppable label. Pure + narrow (drag path only — other verbs aren't implicated). */
export function looksLikeClause(s: string): boolean {
  const t = (s || '').trim().toLowerCase();
  if (!t) return true;
  // a real element label is short; a continuation clause is a sentence. 7+ words is a clause, not a control name.
  if (t.split(/\s+/).length >= 7) return true;
  // instruction/observation verbs that never appear in an element's accessible name
  return /\b(release|observe|verify|ensure|check|position|placement|final|drop position|repositioned?|and then)\b/.test(t);
}

/** DRAG a source element onto a target element (both by label). Uses Playwright's dragTo, with a manual
 * mouse-move fallback for HTML5-drag/custom-DnD libraries that dragTo alone doesn't trigger. */
async function resolveDrag(page: Page, source: string, target: string): Promise<StepAttempt> {
  // GUARD: a drag needs a real element as its source. If the "source" is actually a continuation clause (the planner
  // split one gesture across two steps), fail with a message the operator can act on — do NOT feed it to bestMatch.
  if (looksLikeClause(source)) {
    return { kind: 'drag', selector: source, matched: 0,
      error: `drag source isn't an element — "${String(source).slice(0, 60)}" reads like a step description, not a draggable control. A drag is ONE gesture (source → target); this looks like the tail of a split drag step.` };
  }
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

// ── REVEAL-TO-FILL (the command-palette / click-to-reveal gap): some fields don't exist until a control opens them
// (dent's search is behind "Search everything…⌘K"; a modal "Add X" button reveals a form). When a fill finds ZERO
// inputs, try ONCE to reveal one — but gated on evidence, never a blind keystroke (advisor):
//   1. only when the raw-input scan found NOTHING (seen.length===0) — inputs present = a matching problem, not reveal
//   2. prefer a DOM reveal CONTROL whose label matches the target's content words (bounded + inspectable) over a key
//   3. derive the shortcut from THAT control's own text (⌘K / Ctrl+K / "/"), never hardcode
//   4. once, then re-scan once — no loops
//   5. run the candidate through the safety gate — never click a label the crawler flags dangerous
export interface RevealCandidate { label: string; tag?: string; href?: string | null; sameOrigin?: boolean }
/** pure: pick the best reveal control from candidates by content-word overlap with the target, reject dangerous ones,
 *  and extract any keyboard shortcut from its label. Returns null when nothing safe/relevant matches. */
export function pickRevealControl(target: string, candidates: RevealCandidate[]): { label: string; shortcut?: string } | null {
  const words = contentWords(target);
  if (!words.length) return null;
  let best: RevealCandidate | null = null, bestScore = 0;
  for (const c of candidates) {
    if (!c.label) continue;
    // safety: never treat a dangerous-labelled control as a reveal affordance.
    const verdict = classifyElement({ label: c.label, tag: c.tag, href: c.href, sameOrigin: c.sameOrigin });
    if (verdict.risk === 'dangerous') continue;
    const hay = new Set(contentWords(c.label));
    const score = words.reduce((a, w) => a + (hay.has(w) ? 2 : c.label.toLowerCase().includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore < 1) return null;   // require a real content match — don't click a random button
  // extract a shortcut from the control's own label: "Search everything…⌘K" / "Search (Ctrl+K)" / "Search  /"
  const sc = best.label.match(/(⌘|cmd|command)\s*([a-z0-9])/i) ? 'Meta+' + best.label.match(/(⌘|cmd|command)\s*([a-z0-9])/i)![2]
    : best.label.match(/ctrl\s*\+?\s*([a-z0-9])/i) ? 'Control+' + best.label.match(/ctrl\s*\+?\s*([a-z0-9])/i)![1]
    : undefined;
  return { label: best.label, shortcut: sc };
}

/** browser: attempt to reveal a hidden field ONCE. Returns true if an input appeared afterward. */
async function tryRevealField(page: Page, target: string): Promise<{ revealed: boolean; how: string }> {
  // enumerate non-input clickable controls as reveal candidates.
  const cands: RevealCandidate[] = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const els: any[] = Array.from(doc.querySelectorAll('button,[role="button"],a,[class*="search" i]'));
    return els.map((e: any) => ({ label: (e.textContent || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60), tag: (e.tagName || '').toLowerCase(), href: e.getAttribute && e.getAttribute('href'), sameOrigin: true }))
      .filter((c: any) => c.label && c.label.length < 60);
  }).catch(() => [] as RevealCandidate[]);
  const pick = pickRevealControl(target, cands);
  if (!pick) return { revealed: false, how: 'no reveal control matched' };
  const countInputs = async () => await page.locator('input[type="text"], input[type="search"], input:not([type]), textarea').count();
  const before = await countInputs();
  // try clicking the matched control first (bounded + inspectable), then its shortcut if clicking didn't reveal.
  try { const loc = page.getByText(pick.label.replace(/[⌘].*$/, '').trim(), { exact: false }).first(); if (await loc.count()) { await loc.click({ timeout: 3000 }); await page.waitForTimeout(500); } } catch {}
  if ((await countInputs()) > before) return { revealed: true, how: `clicked "${pick.label.slice(0, 30)}"` };
  if (pick.shortcut) { try { await page.keyboard.press(pick.shortcut); await page.waitForTimeout(500); } catch {} if ((await countInputs()) > before) return { revealed: true, how: `pressed ${pick.shortcut}` }; }
  return { revealed: false, how: `tried "${pick.label.slice(0, 30)}"${pick.shortcut ? ' + ' + pick.shortcut : ''}, no input appeared` };
}

async function resolveFill(page: Page, target: string, value: string, skipIfFilled = false): Promise<StepAttempt> {
  // KEEP-DEFAULT (2026-08-23): a valid/happy-path fill that carries skipIfFilled should NOT overwrite a field that
  // already holds a usable value — many real forms pre-fill valid defaults (dates, times, an owner) and overwriting
  // them is redundant at best and BREAKS masked/picker fields at worst. Returns matched:1 (the field DOES hold data →
  // the step's purpose is met, and drove-accounting counts it as a landed fill). Only break-it's non-adversarial
  // steps set this; attack fills (overflow/empty) never do, so an attack always applies. NOTE: relies on a fresh
  // browser context per attack (break-it launches one) so a non-empty value is a real default, not stale cross-attack
  // state — do not reuse skipIfFilled in a shared-context path without re-checking that assumption.
  const keptDefault = async (loc: any, name: string, box: any): Promise<StepAttempt | null> => {
    if (!skipIfFilled) return null;
    const cur = ((await loc.inputValue().catch(() => '')) || '').trim();
    return cur ? { kind: 'fill:kept-default', selector: `${name} (kept "${cur.slice(0, 30)}")`, matched: 1, chosenIndex: 0, box } : null;
  };
  const m = await bestMatch(page, target, ['textbox', 'combobox', 'spinbutton']);   // spinbutton = number inputs (forms fix B)
  if (m.loc && m.cand) {
    const box = await m.loc.first().boundingBox().catch(() => null);   // where we type — for the playback cursor
    const kept = await keptDefault(m.loc.first(), m.cand.name, box); if (kept) return kept;
    try {
      // autocomplete-aware fill: 'plain'/'committed' = ok; 'failed' = a dropdown appeared but nothing committed → honest matched:0
      const res = await fillMaybeAutocomplete(page, m.loc.first(), value);
      if (res === 'failed') return { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 0, error: 'autocomplete dropdown appeared but no option committed', box };
      return { kind: `role:${m.cand.role}${res === 'committed' ? '+autocomplete' : ''}`, selector: `${m.cand.name}=${value}`, matched: 1, chosenIndex: 0, box };
    } catch (e: any) {
      return { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 1, error: String(e.message || e).slice(0, 160), box };
    }
  }
  // RAW-INPUT SCAN (the reliable path for unlabeled inputs like dent's search: <input type=text placeholder=
  // "Search by name, email, or phone"> — no label/role name, so getByRole textbox scores empty). Enumerate all
  // text inputs + textareas, score by PLACEHOLDER content words, pick best.
  const words = contentWords(target);
  // WIDENED (forms fix B): include typed inputs (email/number/tel/url/date) that were previously unfillable AND tripped
  // the reveal-to-fill guard on a working form. Still excludes hidden/submit/button/checkbox/radio (handled elsewhere).
  const inputSel = 'input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input[type="datetime-local"], input[type="time"], input:not([type]), textarea';
  // The sole-input heuristic (n===1 → likely the target) must count ONLY visible TEXT-LIKE inputs — else a co-present
  // password/hidden/date input defeats n===1 and a plain login "username" field (no placeholder) is left empty
  // (the reviewer's regression). So enumerate over inputSel but base the "single input" signal on this narrower count.
  const TEXTISH_SEL = 'input[type="text"], input[type="search"], input:not([type]), textarea';
  const scanAndFill = async (): Promise<{ done?: StepAttempt; seen: string[] }> => {
    const inputs = page.locator(inputSel);
    const seen: string[] = [];
    try {
      const n = Math.min(await inputs.count(), 30);
      const textishCount = await page.locator(TEXTISH_SEL).count().catch(() => n);
      let best = -1; let bestScore = 0;
      for (let i = 0; i < n; i++) {
        const ph = ((await inputs.nth(i).getAttribute('placeholder')) || (await inputs.nth(i).getAttribute('aria-label')) || (await inputs.nth(i).getAttribute('name')) || '').toLowerCase();
        seen.push(ph ? `input:"${ph.slice(0, 40)}"` : `input#${i}`);
        const hay = new Set(contentWords(ph));
        let s = words.reduce((acc, w) => acc + (hay.has(w) ? 2 : ph.includes(w) ? 1 : 0), 0);
        // NEARBY-LABEL TIER (2026-08-22): a field's distinguishing name is often a SIBLING/ancestor <label>/<p>, NOT
        // on the input (schooltalk: two type=tel inputs both placeholder "hh:mm (a|p)m", disambiguated only by the
        // "Start time" / "End Time" <p> above each). When the placeholder is weak, score the input's NEAREST VISIBLE
        // TEXT (the visual label) too. General — fixes any label-above-input or paired From/To form. Weighted below
        // placeholder so a real placeholder match still wins.
        if (s < 2) {
          const nearby = (await inputs.nth(i).evaluate((el: any) => {
            const d: any = (globalThis as any).document;
            // 1. <label for=id>, 2. wrapping <label>, 3. aria-labelledby, 4. nearest preceding text-bearing sibling/
            //    ancestor-sibling (label rendered above/left of the field).
            const byFor = el.id && d.querySelector(`label[for="${el.id}"]`);
            if (byFor) return byFor.textContent || '';
            const wrap = el.closest('label'); if (wrap) return wrap.textContent || '';
            const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map((x: string) => (d.getElementById(x)?.textContent || '')).join(' '); if (t.trim()) return t; }
            // walk up a few levels; at each, take the previous sibling's text (a label sits before its field)
            let node: any = el;
            for (let up = 0; up < 4 && node; up++) {
              let sib = node.previousElementSibling;
              while (sib) { const t = (sib.textContent || '').trim(); if (t && t.length < 40 && !sib.querySelector('input,textarea,select')) return t; sib = sib.previousElementSibling; }
              node = node.parentElement;
            }
            return '';
          }).catch(() => '') || '').toLowerCase();
          if (nearby) {
            const nhay = new Set(contentWords(nearby));
            const ns = words.reduce((acc, w) => acc + (nhay.has(w) ? 1.5 : nearby.includes(w) ? 0.75 : 0), 0);
            if (ns > s) { s = ns; seen[i] = `input[label:"${nearby.slice(0, 30)}"]`; }
          }
        }
        if (textishCount === 1 && s === 0) s = 0.5;   // a SINGLE text-like input on the page → likely the target
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best >= 0 && bestScore >= 0.5) {
        const box = await inputs.nth(best).boundingBox().catch(() => null);
        const kept = await keptDefault(inputs.nth(best), seen[best], box); if (kept) return { done: kept, seen };
        // THE LOAD-BEARING HOOK: schooltalk's Create Event teacher/group fields are bare input[type=text] that resolve
        // HERE (no role-name). autocomplete-aware fill so they actually commit, not just type-and-leave-2/4-filled.
        const res = await fillMaybeAutocomplete(page, inputs.nth(best), value);
        if (res === 'failed') return { done: { kind: 'input:placeholder', selector: seen[best], matched: 0, chosenIndex: best, error: 'autocomplete dropdown appeared but no option committed', box }, seen };
        return { done: { kind: `input:placeholder${res === 'committed' ? '+autocomplete' : ''}`, selector: `${seen[best]}=${value}`, matched: 1, chosenIndex: best, box }, seen };
      }
    } catch { /* fall through */ }
    return { seen };
  };
  let r = await scanAndFill();
  if (r.done) return r.done;
  // ★ REVEAL-TO-FILL: only when NO inputs exist at all (seen.length===0). Inputs present but low-scoring = a matching
  // problem, not a reveal problem — don't fire a palette over a working form. Try to reveal ONCE, then re-scan ONCE.
  let revealNote = '';
  if (r.seen.length === 0) {
    const rev = await tryRevealField(page, target);
    revealNote = ` (reveal attempt: ${rev.how})`;
    if (rev.revealed) { r = await scanAndFill(); if (r.done) return r.done; }
  }
  const inv = r.seen.length ? r.seen.join(' | ') : candList(m.candidates);
  return { kind: 'fill', selector: target, matched: 0, error: `no input for "${target}". Inputs on page: ${inv}${revealNote}` };
}

// ── SUBMIT: derive the form's REAL submit affordance from the DOM, instead of assuming a named "Save" button
// (the break-it bug: every attack ended with `click the Save button`, so on Swiggy/search-style apps with no Save
// the submit never landed → `no match for "Save" (best=0)` → couldn't-drive-the-form). Self-calibrating, in order:
//   1. an explicit submit control — <button type=submit>, <input type=submit>, or a button whose label reads like a
//      commit verb (Save/Submit/Add/Create/Search/Apply/Send/Update/Confirm/Continue/Post/Order). Click the one
//      NEAREST the field we just filled (or the only one) — a search form's button, a save form's Save.
//   2. no submit control but a single text field in focus → the form submits on ENTER (search-as-you-type, login).
//   3. neither → best-effort Enter on the active element; report honestly if nothing was clickable.
// Returns a StepAttempt so drove-accounting sees whether the submit actually happened.
async function resolveSubmit(page: Page, exclude: string[] = []): Promise<StepAttempt> {
  // 1. explicit submit control, scored by commit-verb label + type=submit, preferring a VISIBLE one.
  // `exclude` = labels already tried on THIS view that produced no progress (the wizard walker feeds these back so a
  // TIE isn't decided by DOM order forever): schooltalk's create form has "Add New Tag" and "Save time slot" BOTH at
  // score 1 → "Add New Tag" won by DOM order and the walk cycled. Excluding a tried-but-fruitless label lets the next
  // candidate ("Save time slot") win on the retry tick, which flips CREATE enabled → the terminal commit. (2026-08-24)
  const mkEval = () => page.evaluate((excludeLabels: string[]) => {
    const d: any = (globalThis as any).document;
    const isExcluded = (lbl: string) => excludeLabels.some((x) => x && lbl && lbl.toLowerCase().trim() === x.toLowerCase().trim());
    // COMMIT/DISMISS are a TIEBREAK, not the primary signal (the de-vocab boundary, 2026-08-23): unlike wizard/option
    // detection there is NO pre-click structural invariant separating Save from Cancel — both are buttons in the same
    // container. The text IS the only reliable discriminator, so a word list is legitimate HERE — but it must not be
    // ENGLISH-GATED (a "Guardar"/"→" primary button scored 0 and lost). Fix: geometry (last + bottom-most among
    // sibling candidates = the conventional primary action, language-independent) is now a real positive signal, so a
    // non-English app scores above zero without any word; the verb list only breaks ties; and DISMISS/destructive
    // labels get a NEGATIVE (the real hole — a type=submit "Cancel" used to score 3 and win the form's submit).
    const COMMIT = /\b(save|submit|add|create|search|apply|send|update|confirm|continue|post|order|place|checkout|sign\s*in|log\s*in|next|done|ok|guardar|enviar|crear|speichern|senden|enregistrer|soumettre|создать|保存|提交)\b/i;
    const DISMISS = /\b(cancel|close|back|reset|clear|dismiss|discard|delete|remove|cancelar|cerrar|abbrechen|annuler|返回|取消)\b/i;
    // SCOPE (the false-success root fix, 2026-08-30): the submit must come from the FORM CONTEXT, never from chrome.
    // (a) If a MODAL/DIALOG is open, ONLY its buttons are candidates — a submit that reports success by clicking a
    //     sidebar nav item (which navigates AWAY) is the lie that poisoned the oracle, the escalation trigger, AND the
    //     AI's page context. (b) NAVIGATION elements are NEVER a submit: [data-nav], or anything inside a <nav>/
    //     sidebar/menubar. This is pure structure (no app words) — a nav link cannot be a form's commit control.
    const win: any = (globalThis as any);
    const isNav = (el: any) => { try { return !!(el.closest && (el.closest('[data-nav]') || el.closest('nav, [role="navigation"], aside, [class*="sidebar" i], [class*="navbar" i], [role="menubar"]'))) || el.hasAttribute('data-nav'); } catch { return false; } };
    // topmost open overlay/dialog (same geometry as the crawler's dismissOverlay/captureFormFields overlay-scope).
    const overlays = Array.prototype.slice.call(d.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="drawer" i]'))
      .filter((el: any) => { try { const s = win.getComputedStyle(el); const r = el.getBoundingClientRect(); return (s.position === 'fixed' || s.position === 'absolute') && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; } catch { return false; } });
    const scope = overlays.length ? overlays[overlays.length - 1] : d;   // modal open → its buttons ONLY; else whole doc
    const cands: any[] = Array.prototype.slice.call(scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'))
      // visible AND ENABLED (2026-08-23): a DISABLED primary button (e.g. schooltalk's Create, disabled until the form
      // is valid) must NEVER win the pick — it can't be clicked, and picking it hid the real advance control + starved
      // the wizard walk (measured: resolveSubmit picked <button disabled>Create → 6s click timeout → walk never ran).
      // + NEVER a nav element (the false-success fix): a sidebar/menu control is not a form submit.
      .filter((e: any) => !!(e.offsetWidth || e.offsetHeight) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !isNav(e));
    // geometry frame: the bottom-most / last candidate is conventionally the primary action (RTL mirrors x but
    // "last-in-DOM among siblings" survives it). Compute max bottom to normalize.
    let maxBottom = 0; for (const el of cands) { const r = el.getBoundingClientRect(); if (r.bottom > maxBottom) maxBottom = r.bottom; }
    let best: any = null; let bestScore = -1;
    for (let idx = 0; idx < cands.length; idx++) {
      const el = cands[idx];
      const label = (el.getAttribute('aria-label') || el.value || el.textContent || '').trim();
      const isSubmitType = (el.getAttribute('type') || '').toLowerCase() === 'submit';
      const r = el.getBoundingClientRect();
      let s = 0;
      if (isSubmitType) s += 3;                             // structural: an explicit submit control
      if (el.closest('form')) s += 1;                       // structural: inside a <form>
      if (idx === cands.length - 1) s += 1.5;               // GEOMETRY: last candidate in DOM = conventional primary
      if (maxBottom && r.bottom >= maxBottom - 4) s += 1;   // GEOMETRY: bottom-most row = the action footer
      if (COMMIT.test(label)) s += 1;                       // TIEBREAK (multilingual, not English-gated)
      if (DISMISS.test(label)) s -= 4;                      // NEGATIVE: never pick Cancel/Back/Delete as the submit
      if (isExcluded(label)) continue;                      // already tried on this view with no progress → skip it
      if (s <= 0) continue;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    if (best) { best.setAttribute('data-xsion-submit', '1'); return { label: (best.getAttribute('aria-label') || best.value || best.textContent || '').trim().slice(0, 40) }; }
    // 2. no submit control IN SCOPE — is there exactly one text-ish input (in the same scope)? then Enter submits.
    const inputs = Array.prototype.slice.call(scope.querySelectorAll('input[type=text], input[type=search], input:not([type]), textarea')).filter((e: any) => (e.offsetWidth || e.offsetHeight));
    return { soloInput: inputs.length === 1 };
  }, exclude);
  // race the scorer evaluate against a timeout — this page.evaluate was the last unbounded one in the wizard hot path;
  // on the live create form it intermittently blocked the whole walk 50s+ (a heavy widget / re-render stalls the
  // execution context). A bigger timeout re-opens the hang; instead RETRY the evaluate ONCE (2026-08-27, advisor): a
  // transient render stall clears within ~1s, so if the first 3s race loses, wait 800ms and try a fresh evaluate
  // before giving up. This turns a spurious "no submit control" stall (the intermittent commit flake) into a
  // successful pick, WITHOUT re-introducing the hang (each attempt is still hard-capped at 3s). Only the SECOND
  // timeout falls to the honest empty result.
  const raceOnce = () => Promise.race([mkEval(), new Promise<any>((res) => setTimeout(() => res({ __timeout: true }), 3000))]).catch(() => ({ __timeout: true }));
  let pick: any = await raceOnce();
  if (pick && (pick as any).__timeout) { await page.waitForTimeout(800).catch(() => {}); pick = await raceOnce(); }
  if (pick && (pick as any).__timeout) pick = { soloInput: false };   // both attempts stalled → honest fallback
  if (pick && (pick as any).label !== undefined) {
    const loc = page.locator('[data-xsion-submit="1"]').first();
    const box = await loc.boundingBox().catch(() => null);
    try { await loc.click({ timeout: 6000 }); await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsion-submit="1"]'); if (e) e.removeAttribute('data-xsion-submit'); }); return { kind: 'submit:button', selector: (pick as any).label || 'submit', matched: 1, box }; }
    // A control that never got CLICKED is not a submit. The old matched:1-on-timeout laundered a failed click as a real
    // submit → resolveSubmitWizardAware saw matched===1, no enabled-set change → NO-OP → returned the timed-out attempt
    // without trying another candidate (the 484e786b/fbb39c38 step-3 stall). Honest matched:0 lets the wizard walker's
    // stall path report truthfully AND lets the caller retry a different control. (2026-08-23)
    catch (e: any) { return { kind: 'submit:button', selector: (pick as any).label || 'submit', matched: 0, error: `submit click did not land on "${(pick as any).label || 'submit'}": ${String(e.message || e).slice(0, 130)}`, box }; }
  }
  // 2/3. press Enter — submits a search/login form with no explicit button (focus the sole input first if present).
  // CRITICAL: a keypress cannot "fail", so it must NOT report matched:1 unconditionally — that defeats the caller's
  // drove-gate and turns a non-submitted attack into a false verdict. VERIFY the page actually moved (url changed OR
  // DOM signature shifted); only then is it a real submit. No movement → matched:0 (honest: nothing submitted).
  try {
    const inp = page.locator('input[type="text"], input[type="search"], input:not([type]), textarea').first();
    if (!(await inp.count())) return { kind: 'submit', selector: 'submit', matched: 0, error: 'no submit button and no input to Enter-submit — nothing to submit' };
    const sig = async () => { try { return await page.evaluate(() => { const d: any = (globalThis as any).document; return { title: d.title || '', len: ((d.body && d.body.innerText) || '').length }; }); } catch { return { title: '', len: 0 }; } };
    const beforeUrl = page.url();
    const beforeSig = await sig();
    await inp.focus().catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const afterSig = await sig();
    const moved = page.url() !== beforeUrl || afterSig.title !== beforeSig.title || Math.abs(afterSig.len - beforeSig.len) > 120;
    if (moved) return { kind: 'submit:enter', selector: 'Enter', matched: 1 };
    return { kind: 'submit:enter', selector: 'Enter', matched: 0, error: 'pressed Enter but the page did not change — no submit happened' };
  } catch (e: any) {
    return { kind: 'submit', selector: 'submit', matched: 0, error: `no submit affordance found: ${String(e.message || e).slice(0, 120)}` };
  }
}

// ── VERIFY-BY-EFFECT WIZARD SUBMIT (2026-08-23, the de-overfit rewrite) ─────────────────────────────────────────
// Replaces the vocabulary-regex wizard walker (WIZ_ADVANCE/WIZ_TERMINAL + tablist detection) that OVERFIT to one app
// ("save time slot" was literally hardcoded; tablist detection failed on schooltalk's role-less MUI tabs). The new
// design (workflow-designed, all 3 adversarial verifiers REJECTED the first cut → this is the corrected synthesis):
// classify a control by its EFFECT, never its text. Click the PRIMARY control (resolveSubmit — the exact button the
// linear executor already clicks today, so ZERO new consent/safety surface), snapshot before+after, and read what
// changed:
//   • a NEW field appeared (|added|≥1) AND the field-set mostly changed AND validation did NOT fire  → ADVANCE (fill
//     the new step's empty fields, repeat — bounded)
//   • validation fired (aria-invalid / aria-errormessage grew, or a describedby target went empty→text)  → REGRESSED
//     (honest stop — never a fake terminal)
//   • the form/container is GONE (re-derived, genuinely absent) AND corroborated (URL left the form route OR a table/
//     list row COUNT INCREASED)  → TERMINAL (created)
//   • else → not a wizard advance; return resolveSubmit's own result UNCHANGED (single-page forms behave EXACTLY as
//     today — one click, same button, same verdict; this is the dent no-op BY CONSTRUCTION, not a heuristic).
// NO vocabulary. NO role=tab dependency. NO speculative probing of Cancel/secondary controls (the rejected first cut
// did that and destroyed forms). Deterministic (DOM only — no LLM on the path). Bounded by MAX_WIZARD_STEPS.
const MAX_WIZARD_STEPS = Number(process.env.XSION_MAX_WIZARD_STEPS) || 6;

/** A structural snapshot of the current form view — identity only, never values (our own fills would read as change). */
async function snapshotView(page: Page): Promise<{ url: string; fields: string[]; formPresent: boolean; invalid: number; rows: number; enabled: string }> {
  const snap = page.evaluate(() => {
    const d: any = (globalThis as any).document;
    const vis = (el: any) => !!(el && (el.offsetWidth || el.offsetHeight));
    const ctrls = Array.prototype.slice.call(d.querySelectorAll('input:not([type=hidden]), textarea, select, [contenteditable="true"], [role="listbox"], [role="combobox"]')).filter(vis);
    // field KEY = type|placeholder|name|nearest-label — identity, not value
    const keyOf = (el: any, i: number) => {
      const lbl = (() => { const id = el.id; const l = id && d.querySelector(`label[for="${id}"]`); if (l) return l.textContent || ''; const w = el.closest && el.closest('label'); return (w && w.textContent) || ''; })();
      return [el.tagName, el.getAttribute('type') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', (lbl || '').trim().slice(0, 24), i].join('|').toLowerCase();
    };
    const fields = ctrls.map(keyOf).sort();
    const formPresent = ctrls.some((el: any) => /^(input|textarea)$/i.test(el.tagName) && !/(button|submit|checkbox|radio)/i.test(el.getAttribute('type') || '')) || !!d.querySelector('form');
    // validation signal — structural, multiple conventions (not one app's): aria-invalid, aria-errormessage present
    const invalid = d.querySelectorAll('[aria-invalid="true"], [aria-errormessage]').length;
    // terminal corroboration source: count of table/list rows in the main view (a CREATE increases this)
    const rows = d.querySelectorAll('tr, [role="row"], li[class*="item" i], [class*="list" i] > *').length;
    const path = (() => { try { return new URL((globalThis as any).location.href).pathname; } catch { return ''; } })();
    // ENABLED-BUTTON signature: a click can make PROGRESS WITHOUT a step change — schooltalk's "Save time slot" adds a
    // slot row (same field set → not an advance) but FLIPS the terminal "Create" from disabled→enabled. Tracking which
    // buttons are enabled lets the walker detect that "progress-without-step" transition and click again (structural,
    // no vocabulary). Key = sorted set of enabled visible-button labels.
    const enabled = Array.prototype.slice.call(d.querySelectorAll('button, [role="button"], input[type=submit], input[type=button]'))
      .filter((e: any) => vis(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true')
      .map((e: any) => (e.getAttribute('aria-label') || e.value || e.textContent || '').trim().slice(0, 24)).filter(Boolean).sort().join('§');
    return { url: path, fields, formPresent, invalid, rows, enabled };
  });
  // race a short timeout: after a committing click the page is navigating and this evaluate can block on a destroyed
  // execution context far longer than any budget (the post-create-commit hang). Fall back to an empty-form snapshot —
  // formPresent:false reads as "the form is gone", the honest post-commit state. (2026-08-24)
  const EMPTY = { url: '', fields: [] as string[], formPresent: false, invalid: 0, rows: 0, enabled: '' };
  return await Promise.race([snap, new Promise<typeof EMPTY>((res) => setTimeout(() => res(EMPTY), 4000))]).catch(() => EMPTY);
}

/** Fill every EMPTY visible field on the current (advanced) step with a type-appropriate marked value. New code —
 *  scanAndFill is a closure bound to one target and isn't reusable. Best-effort; never throws. */
async function fillVisibleFields(page: Page, marker: string): Promise<number> {
  try {
    const inputs = page.locator('input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea');
    const n = Math.min(await inputs.count(), 20);
    let filled = 0;
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      try {
        if (!(await el.isVisible().catch(() => false)) || !(await el.isEditable().catch(() => false))) continue;
        if (((await el.inputValue().catch(() => '')) || '').trim()) continue;   // already filled — skip
        const ph = ((await el.getAttribute('placeholder')) || (await el.getAttribute('type')) || '').toLowerCase();
        const val = /mail/.test(ph) ? `xsion+${marker}@example.com` : /\d|number|age|qty|amount/.test(ph) ? '1' : `XSION ${marker}`;
        await fillMaybeAutocomplete(page, el, val);   // autocomplete-aware so combobox steps commit
        filled++;
      } catch { /* skip this field */ }
    }
    return filled;
  } catch { return 0; }
}

/** Click the primary control and classify by EFFECT; walk a multi-step wizard to its terminal create. Returns
 *  resolveSubmit's own result unchanged when it's not a wizard (single-page = one click, no extra behaviour). */
/** Is there ANOTHER enabled, un-excluded, COMMIT-scoring button on the page besides the ones already tried? Gate for
 *  the wizard walker's NO-OP retry: only try-the-next-candidate when one genuinely exists — a single-page form (one
 *  submit control) must return its result immediately, never spin. Mirrors resolveSubmit's COMMIT/DISMISS + enabled
 *  filter so "another candidate" means the same thing there. (2026-08-24) */
async function hasAnotherSubmitCandidate(page: Page, exclude: string[]): Promise<boolean> {
  return await page.evaluate((excludeLabels: string[]) => {
    const d: any = (globalThis as any).document;
    const COMMIT = /\b(save|submit|add|create|search|apply|send|update|confirm|continue|post|order|place|checkout|next|done|ok|guardar|enviar|crear|speichern|senden|enregistrer|soumettre|создать|保存|提交)\b/i;
    const DISMISS = /\b(cancel|close|back|reset|clear|dismiss|discard|delete|remove|cancelar|cerrar|abbrechen|annuler|返回|取消)\b/i;
    const isExcl = (lbl: string) => excludeLabels.some((x) => x && lbl && lbl.toLowerCase().trim() === x.toLowerCase().trim());
    return Array.prototype.slice.call(d.querySelectorAll('button, input[type=submit], input[type=button], [role="button"]'))
      .filter((e: any) => !!(e.offsetWidth || e.offsetHeight) && !e.disabled && e.getAttribute('aria-disabled') !== 'true')
      .some((e: any) => { const l = (e.getAttribute('aria-label') || e.value || e.textContent || '').trim(); return l && COMMIT.test(l) && !DISMISS.test(l) && !isExcl(l); });
  }, exclude).catch(() => false);
}

/**
 * AI-EXECUTOR ESCALATION (the re-architecture seam): when the DETERMINISTIC resolvers fail to drive a form/control
 * (matched:0 — the brittle-plumbing case: per-row modals, custom widgets, unusual layouts), hand the LIVE page to the
 * vision-capable AI and let IT decide the mechanical actions (fill/click) to complete the goal. This is the layer that
 * SHOULD be adaptive — driving arbitrary UI shapes — while the deterministic code keeps what it's good at (the 95% of
 * plain fills/clicks) and the VERDICT stays 100% deterministic (state-delta oracle; the AI never sees acceptIsDefect
 * or decides broke/held). FIREWALL: the AI emits ACTIONS ONLY (addressing) — never a claim about whether the app is
 * correct. HANG GUARD: bounded per call (explorePage is 45s fail-fast) + a per-run escalation cap the caller enforces;
 * on timeout/empty it degrades to matched:0 so the run continues deterministically (SoA is never a hard dependency).
 *
 * Returns matched:1 iff the AI's actions ran AND observably moved state (a fill landed / a click changed the view),
 * else matched:0 (honest — no fabricated success).
 */
export async function aiEscalateDrive(page: Page, goal: string, marker: string): Promise<StepAttempt> {
  try {
    // build the page view the AI reasons over: url + visible text + the clickable/fillable inventory (labels only).
    const view = await page.evaluate(() => {
      const d: any = (globalThis as any).document; const win: any = (globalThis as any);
      const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
      const controls = Array.prototype.slice.call(d.querySelectorAll('button, a, [role="button"], input:not([type=hidden]), select, textarea, [onclick]'))
        .filter(vis).slice(0, 60).map((el: any) => ({ tag: (el.tagName || '').toLowerCase(), type: el.getAttribute('type') || '', label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 50) })).filter((c: any) => c.label);
      return { url: win.location ? win.location.href : '', title: d.title, text: ((d.body && d.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 800), controls };
    });
    const { clicks, error } = await explorePage({ goal, marker, ...view });   // bounded (45s fail-fast) inside explorePage
    if (error || !clicks || !clicks.length) return { kind: 'ai-escalate', selector: goal, matched: 0, error: error || 'AI returned no actions' };
    // EXECUTE the AI's mechanical actions in order (fill/click ONLY — never a destructive verb the AI shouldn't emit).
    let ran = 0;
    for (const c of clicks.slice(0, 8)) {
      const label = String(c.label || '').trim(); if (!label) continue;
      if (c.action === 'fill') { const a = await resolveFill(page, label, c.value ?? `test ${marker}`); if (a.matched) ran++; }
      else { const ok = await clickByLabelInPage(page, label); if (ok) ran++; }
      await page.waitForTimeout(400);
    }
    return ran ? { kind: 'ai-escalate', selector: `AI drove ${ran} action(s) for: ${goal}`.slice(0, 120), matched: 1 }
               : { kind: 'ai-escalate', selector: goal, matched: 0, error: 'AI actions did not land' };
  } catch (e: any) { return { kind: 'ai-escalate', selector: goal, matched: 0, error: String(e?.message || e).slice(0, 120) }; }
}

/** local click-by-label used by the AI executor (mirrors the crawler's, kept here so intentRunner is self-contained). */
async function clickByLabelInPage(page: Page, label: string): Promise<boolean> {
  try {
    const want = label.trim().toLowerCase();
    const found = await page.evaluate((w: string) => {
      const d: any = (globalThis as any).document;
      d.querySelectorAll('[data-xsai]').forEach((e: any) => e.removeAttribute('data-xsai'));
      // strip a trailing route/hash hint a nav wrapper concatenates onto its label (torture: "Orders#/orders",
      // "Rules Engine#/rules") so an exact-label match still lands on the nav item. Also strips a bracketed hint.
      const strip = (s: string) => s.replace(/\s*#?\/?[a-z0-9/_-]*$/i, (m) => (/^#?\/?[a-z]/i.test(m.trim()) && m.trim().includes('/') ? '' : m)).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      const norm = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const cands = Array.prototype.slice.call(d.querySelectorAll('button, a, [role="button"], [onclick], input, [role="menuitem"], [role="tab"], [data-nav]'));
      // PASS 1 — exact on aria-label / full text / value.
      for (const el of cands) {
        const t = norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('value') || '');
        if (t === w) { el.setAttribute('data-xsai', '1'); return true; }
      }
      // PASS 2 — exact on the element's OWN label seen through a wrapper: its first text-bearing child (a nested <span>
      // holds the real label while textContent also picks up a sibling hint), or the full text with the route hint
      // stripped, or a data-nav attribute value. General: routes/labels are often wrapped, not on the clickable node.
      // The WANT is ALSO stripped — a step intent like `click "Orders#/orders"` carries the SAME wrapper hint the crawl
      // captured, so both sides must be normalized or an element "Orders" never matches a want "orders#/orders".
      const ws = norm(strip(w));
      for (const el of cands) {
        const firstSpan = el.querySelector && el.querySelector('span,label,strong,b');
        const spanTxt = firstSpan ? norm(firstSpan.textContent) : '';
        const stripped = norm(strip(el.textContent || ''));
        const dataNav = norm(el.getAttribute && el.getAttribute('data-nav') || '');
        if (spanTxt === w || stripped === w || dataNav === w || spanTxt === ws || stripped === ws || dataNav === ws) { el.setAttribute('data-xsai', '1'); return true; }
      }
      return false;
    }, want);
    if (!found) return false;
    try { await page.locator('[data-xsai="1"]').first().click({ timeout: 4000 }); return true; }
    finally { await page.evaluate(() => (globalThis as any).document.querySelectorAll('[data-xsai]').forEach((e: any) => e.removeAttribute('data-xsai'))).catch(() => {}); }
  } catch { return false; }
}

export async function resolveSubmitWizardAware(page: Page, marker: string): Promise<StepAttempt> {
  const path: string[] = [];
  // labels tried on the CURRENT view that produced no forward progress. Fed to resolveSubmit so a TIE (schooltalk's
  // "Add New Tag" == "Save time slot" == score 1) isn't decided by DOM order every tick — after "Add New Tag" changes
  // nothing terminal, exclude it and the next pick is "Save time slot" → flips CREATE enabled. CLEARED on a real
  // ADVANCE (new step = old labels irrelevant). Bounded by MAX_WIZARD_STEPS. (2026-08-24)
  let tried: string[] = [];
  for (let stepNo = 0; stepNo < MAX_WIZARD_STEPS; stepNo++) {
    const before = await snapshotView(page);
    if (process.env.XSION_WIZ_DEBUG) console.error(`[WIZ] iter${stepNo} tried=${JSON.stringify(tried)} enabledBefore=${before.enabled.slice(0,120)}`);
    const attempt = await resolveSubmit(page, tried);    // THE click — excluding labels already fruitless on this view
    if (process.env.XSION_WIZ_DEBUG) console.error(`[WIZ] iter${stepNo} picked="${attempt.selector}" matched=${attempt.matched}`);
    if (attempt.matched === 0) {
      // couldn't even click a primary control (or all candidates on this view are excluded). If we already advanced,
      // that's an honest stall; else pass it through.
      if (stepNo === 0 && !tried.length) return attempt; // not a wizard / nothing to submit → today's exact result
      // SELF-DIAGNOSING STALL (2026-08-27): a matched:0 here after advancing means resolveSubmit found no pickable
      // control. Put the DISCRIMINATOR in the record so a future stall diagnoses itself (advisor): the enabled-button
      // set + what we'd excluded. If a commit-word control (e.g. "Create") IS in `enabled` but wasn't picked → the
      // bounded resolveSubmit evaluate lost its race (retry-the-evaluate fix); if it's ABSENT → the control was still
      // disabled (not a race, a real not-yet-ready). No re-run needed to tell them apart.
      const enabledList = before.enabled.split('§').filter(Boolean).slice(0, 18).join(', ');
      return { kind: 'submit:wizard-stall', selector: `wizard advanced ${stepNo} step(s) [${path.join(' → ')}] then found no submit control`, matched: 0,
        error: `wizard advanced ${stepNo} step(s) but could not confirm a terminal commit — no un-tried primary control. Excluded: [${tried.join(', ')}]. Enabled at stall: [${enabledList}]` };
    }
    const clickedLabel = String(attempt.selector || '').replace(/~.*$/, '').trim();   // the label resolveSubmit picked
    if (process.env.XSION_WIZ_DEBUG) console.error(`[WIZ] iter${stepNo} clicked "${clickedLabel}" → settling…`);
    await settleUntilStable(page, 12000);
    if (process.env.XSION_WIZ_DEBUG) console.error(`[WIZ] iter${stepNo} settled, snapshotting…`);
    const after = await snapshotView(page);
    if (process.env.XSION_WIZ_DEBUG) console.error(`[WIZ] iter${stepNo} after: formPresent=${after.formPresent} rows=${after.rows} url=${after.url} enabledLen=${after.enabled.length}`);
    // effect classification — ORDER MATTERS (REGRESSED before ADVANCE before TERMINAL)
    const inter = after.fields.filter((f) => before.fields.includes(f)).length;
    const union = new Set([...before.fields, ...after.fields]).size || 1;
    const overlap = inter / union;
    const added = after.fields.filter((f) => !before.fields.includes(f)).length;
    if (after.invalid > before.invalid) {
      // validation fired → this was NOT a real advance/commit. Honest stop.
      if (stepNo === 0) return attempt;                  // single-page form rejected our data → today's exact result (drove-gate/oracle handles it)
      return { kind: 'submit:wizard-regressed', selector: `wizard step ${stepNo + 1} rejected input [${path.join(' → ')}]`, matched: 0,
        error: `wizard advanced to step ${stepNo + 1} then validation blocked further progress (${after.invalid} invalid field(s)) — required data missing, not an app bug` };
    }
    const formGone = !after.formPresent;
    const routeLeft = after.url !== before.url;                          // navigated to a DIFFERENT view (route changed)
    const corroborated = routeLeft || after.rows > before.rows;
    // TERMINAL FIRST — ORDER FIX (2026-08-24): a ROUTE CHANGE is NEVER a same-wizard advance. The commit click lands on
    // /Dashboard whose fields are ALL new → the ADVANCE test (overlap<0.5 && added≥1) FALSELY classified the dashboard
    // as "a new wizard step" → the walk kept going and fillVisibleFields SPRAYED the marker into the dashboard's search
    // boxes (opened a "Choose report" modal on a LIVE app — a real hazard) instead of stopping at the commit. So the
    // terminal check must run BEFORE advance, and advance is gated on !routeLeft. schooltalk create commit → /Dashboard
    // (rows 11→54) is now correctly TERMINAL. (measured: run c5426da2 path [step1→enabled+2→step3→enabled+4→step5])
    if ((formGone && corroborated) || (routeLeft && after.rows > before.rows)) {
      attempt.selector = stepNo > 0 ? `wizard[${path.join(' → ')} → commit] ⇒ ${attempt.selector}` : attempt.selector;
      return attempt;   // matched:1 from resolveSubmit — a real, corroborated commit
    }
    const removed = before.fields.filter((f) => !after.fields.includes(f)).length;   // old-step fields that DISAPPEARED
    // ADVANCE = a genuine NEW STEP replaced the old one: substantial new fields AND the previous step's fields largely
    // GONE. The old `added >= 1` was too loose — clicking a FIELD-ADDER (schooltalk "Add New Tag" reveals one tag
    // input) added 1 field with the old fields still present, got misclassified as a new step, RESET the `tried`
    // exclusions, and made the walk non-deterministic (measured: iter1 tried=[] after an Add-New-Tag click that should
    // have been excluded). Require added ≥ 2 OR the prior fields mostly removed — a lone revealed input now correctly
    // falls through to the enabled-change branch where `tried` accumulates. (2026-08-27) Gated on !routeLeft still.
    const realStep = overlap < 0.5 && (added >= 2 || removed >= Math.max(1, Math.ceil(before.fields.length * 0.5)));
    if (!routeLeft && after.formPresent && realStep) {
      // ADVANCE: a new step with genuinely new fields appeared ON THE SAME ROUTE. Fill it and continue.
      path.push(`step${stepNo + 1}`);
      tried = [];
      await fillVisibleFields(page, marker);
      continue;
    }
    if (formGone && !corroborated) {
      // form vanished with no corroboration — could be a failure/redirect. Honest, never a fake success.
      if (stepNo === 0) return attempt;
      return { kind: 'submit:wizard-uncorroborated', selector: `wizard[${path.join(' → ')}] closed without confirmation`, matched: 0,
        error: `wizard form closed after the final click but nothing corroborated a create (no route change, no new row) — cannot confirm success honestly` };
    }
    // PROGRESS-WITHOUT-STEP (2026-08-23, measured on schooltalk): the click didn't advance/terminate/regress, but it
    // CHANGED WHICH BUTTONS ARE ENABLED — e.g. "Save time slot" adds a slot row and flips the terminal "Create" from
    // disabled→enabled (and disables itself). That IS progress: click again to reach the now-enabled commit. Structural
    // (enabled-set delta), no vocabulary. Bounded by MAX_WIZARD_STEPS; the enabled-set changing each loop guarantees
    // forward motion (a stuck click leaves the set identical → falls through to NO-OP below and returns).
    if (after.enabled !== before.enabled) {
      // PROGRESS-WITHOUT-STEP: the enabled-set moved. Record the label we clicked so we don't re-pick it and cycle
      // (schooltalk: "Add New Tag" toggles a tag input → enabled-set changes, but re-picking it forever gets nowhere).
      // Excluding it lets the next candidate ("Save time slot") win, which flips CREATE enabled → the real commit.
      path.push(`enabled+${stepNo + 1}`);
      if (clickedLabel) tried.push(clickedLabel);
      continue;
    }
    // NO-OP: nothing meaningful changed by THIS click. A TIE the DOM order lost may hide the real advance control on
    // this SAME view (schooltalk: "Add New Tag" tied "Save time slot"). Exclude this label and loop to try the NEXT
    // candidate — but ONLY if another un-tried COMMIT-scoring candidate actually exists (else this is a genuine
    // single-page submit and we must return today's exact result, not spin). Bounded by MAX_WIZARD_STEPS.
    if (clickedLabel && (await hasAnotherSubmitCandidate(page, [...tried, clickedLabel]))) {
      tried.push(clickedLabel);
      path.push(`retry≠${clickedLabel.slice(0, 16)}`);
      continue;
    }
    // genuine single-page submit (no other candidate) — return resolveSubmit's own result unchanged.
    return attempt;
  }
  return { kind: 'submit:wizard-cap', selector: `wizard hit the ${MAX_WIZARD_STEPS}-step cap [${path.join(' → ')}]`, matched: 0,
    error: `wizard exceeded ${MAX_WIZARD_STEPS} advances without reaching a corroborated terminal commit` };
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
  onLearn?: (obs: { kind: 'gate' | 'route' | 'selector' | 'load-quirk' | 'nav-hint' | 'environment-state'; key: string; fact: string }) => void;
  /** fires ONCE after all steps ran, with the LIVE page still open (before capture/close) — the seam a specialized
   * oracle (e.g. the drop-precision differential) uses to run its own probes on the reached state. Return value is
   * ignored; anything the oracle records it does via its own channel. Kept generic so executeFlow stays engine-agnostic. */
  onReachedState?: (page: Page) => Promise<void>;
  /** GENERAL GOAL-AGENT: fires after the last planned step with the LIVE page — return more intent steps to continue
   * (they're pushed + run with full per-step machinery) or null to end. This is the adaptive-loop seam (runGoal). */
  onStepsExhausted?: (page: Page, observedCalls?: ObservedCall[]) => Promise<IntentStep[] | null>;
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

export async function executeFlow(flow: IntentFlow, baseUrl: string, hooks: ExecHooks = {}, env?: EnvCondition, creds?: ExecCreds, opts?: { allowMutations?: boolean; corrections?: string[]; noSoaRecovery?: boolean; marker?: string; aiGoal?: string; reachFeature?: string }): Promise<ExecResult> {
  _corrections = Array.isArray(opts?.corrections) ? opts!.corrections!.filter((c) => typeof c === 'string' && c.trim()) : [];   // run-scoped human-confirmed control labels
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
  // PASSIVE API-OBSERVATION (2026-08-23): record API calls fired during the flow, attributed to the step in flight
  // (curStepIndexRef). The post-submit oracle reads these — a 2xx WRITE call fired by the submit step, whose response
  // body is NOT an error shape, is STRONG confirmation a create/update happened (even when the UI shows no toast).
  // No synthetic firing — only what the real steps trigger.
  const observedCalls: ObservedCall[] = [];
  const curStepIndexRef = { i: -1 };   // -1 = pre-step (login/nav); set to the loop index during each step
  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const url = req.url();
      if (!/\/(api|graphql|v\d)\b|\.(json)$/i.test(url) && req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      const method = req.method();
      const write = /^(POST|PUT|PATCH|DELETE)$/i.test(method);
      // okBody: the response body is NOT an obvious error/failure shape (a 200-with-{error} is a real pattern — status
      // alone isn't proof). Structural, cheap: parse JSON, treat error/errors/message:"...fail/invalid..." as not-ok.
      let okBody = true;
      try { const b = await resp.text(); if (b) { try { const j = JSON.parse(b); if (j && typeof j === 'object' && (j.error || (Array.isArray(j.errors) && j.errors.length) || (typeof j.success === 'boolean' && !j.success) || /\b(failed|invalid|not allowed|unauthori[sz]ed)\b/i.test(String(j.message || '')))) okBody = false; } catch { if (/"error"|"errors"\s*:\s*\[/.test(b)) okBody = false; } } } catch {}
      observedCalls.push({ method, url: url.slice(0, 200), status: resp.status(), write, okBody, stepIndex: curStepIndexRef.i });
    } catch {}
  });
  const stepResults: StepResult[] = [];
  let failed = false;
  // ON-STALL RECOVERY state (the adaptive loop): count consecutive unmatched actionable steps, reset when the page
  // changes; cap SoA recovery calls per run. When it fires, SoA looks at the page and says what to click to get past.
  let consecutiveMisses = 0;
  let recoveriesUsed = 0;
  let lastRecoveryPageKey = '';
  // Engines driving a KNOWN, already-learned flow (break-it on a mapped form) pass noSoaRecovery — SoA-explore is a
  // crawl-DEPTH aid for discovering a way past an unknown gate, not a form-driver. Disabling it keeps SoA fully off
  // the critical path for those runs (see the "SoA/LLM is NEVER on the critical path" rule). Missed fields then just
  // report matched:0 honestly instead of spending explore calls trying to "recover" a field the form doesn't have.
  const soaRecoveryOff = opts?.noSoaRecovery === true;
  const MAX_RECOVERIES = soaRecoveryOff ? 0 : Number(process.env.XSION_MAX_STALL_RECOVERY || 2);
  let curStepIntent = '';   // function-scoped so the timeout catch (below) can name WHICH step stalled
  // STATE-DELTA ORACLE scratch: before/after snapshots around the mutating submit (function-scoped so the delta build
  // after the try/catch can read them). Filled in the submit branch.
  let stateBefore: StateProbe | undefined, stateAfter: StateProbe | undefined;
  const transientAlerts: string[] = [];   // short-lived toast/alert text captured in the click window (before auto-dismiss)
  // AI-EXECUTOR ESCALATION per-run cap (hang guard): the vision AI is called at most this many times per flow when the
  // deterministic resolvers fail to drive — bounded so a run can never stack model calls into a 17-min hang.
  let aiEscalationsLeft = Number(process.env.XSION_AI_ESCALATE_CAP || 2);
  let reAuthLeft = Number(process.env.XSION_REAUTH_CAP || 2);   // cap re-auths per flow (session-bounce recovery)
  let liveFields: Array<{ label: string; kind: string; required: boolean }> | undefined;   // ground-truth attack surface (post-reach)
  let liveActions: string[] | undefined;
  let liveScope: 'modal' | 'page' | undefined;   // did ANY capture land inside the feature's own modal/dialog?
  let liveOpenerPersisted = false;   // did the opener click PERSIST a write (a DIRECT row-action mutates on click, no modal)?
  const liveFieldMap = new Map<string, { label: string; kind: string; required: boolean }>();   // UNION across steps, by lc label — for DISCOVERY (does a field exist anywhere)
  const liveActionSet = new Map<string, string>();
  // COHORT (2026-08-30): the single best CO-PRESENT snapshot of fields (all in the DOM at ONE instant). The union
  // above is for discovery; you must never FILL from it — a wizard's step-1 + step-2 fields are never co-present, so
  // an attack that fills the union hunts fields that aren't there, stalls the submit, and times out. Attack
  // CONSTRUCTION (scaffold, the create-precondition) draws from THIS cohort; discovery (drop-gate) uses the union.
  let liveCohort: Array<{ label: string; kind: string; required: boolean }> | undefined;   // best single co-present snapshot
  let liveCohortScore = -1;   // pick the richest cohort (modal-scoped beats page-scoped; more fields beats fewer)
  let liveModalActions: string[] | undefined;   // actions INSIDE the feature's own modal (e.g. Flag's preset buttons:
  const liveModalActionSet = new Map<string, string>();   // manual-review/priority/hold) — click-attacked WITHOUT the feature-name filter (membership is the scoping).
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
      // hoisted above the try so the catch can honestly flag a wedged-out login (a per-attempt cap breach throws
      // here) — a login that had a password form but timed out is NOT SSO-only, and detectSSO (bugReproService)
      // reads this flag. Set to the RECORDED structural fact inside the try (never re-read the DOM in the catch: a
      // login that landed then wedged mid-settle has no form → a re-read would falsely say "no form"). (2026-08-24 review)
      let hadPasswordForm = false;
      try {
        // ── UNIFIED LOGIN (the general-app fix): use the CRAWLER's proven dynamic login (`tryLogin`) instead of a
        // brittle email-only locator. The old locator matched the identifier field ONLY by email patterns
        // (input[type=email], name/id=email, autocomplete=username/email, label/placeholder ~= email) → it MISSED
        // apps whose username field is a plain `<input id="user-name" placeholder="Username">` (saucedemo) → login
        // silently no-op'd → a FALSE "SSO" / cant-perform on an app the crawler logs into fine. tryLogin SCORES the
        // identifier field (username|userid|login|account + sole-text-near-password fallback), matching the crawler.
        // A password FORM being present (regardless of pass/fail) marks hadPasswordForm → the SSO detector stays honest.
        // ★ LOGIN CAP: the login pre-step runs OUTSIDE the per-step loop cap below, so an environmental stall inside
        // tryLogin (a networkidle wait hitting dead air on a loaded server) wedged the WHOLE run uncapped — this is
        // exactly how the dent break-it run froze at "gate.blocked=false" with 0 findings. Cap it too (healthy login
        // ≈9-11s measured across 10× → 30s = wide headroom). Timeout throws XSION_STEP_TIMEOUT → the catch below marks
        // the auth step failed + closes cleanly (browser.close is outside the try), so ONE stalled login can't freeze it.
        // ★ FLAKE-FIX #1 — BOUNDED RETRY ON SLOW REDIRECT. The old code ran ONE tryLogin (a bare boolean that
        // collapses settleLogin's tri-state: 'rejected' AND 'indeterminate' both → false). A slow redirect that
        // arrived just after settleLogin's 20s cap therefore read as "login failed" on creds that work fine when
        // the redirect is fast (measured: run 49b19313 hit 1174 while 0c805d3e passed). Use tryLoginSettled (the
        // tri-state) directly and RETRY ONLY on 'indeterminate' (no terminal signal) — NEVER on 'rejected' (real
        // bad creds), so we never re-hammer a genuine rejection. hpf is computed ONCE before the loop (a landed
        // login removes the form → recomputing would mislabel it "no form" and break the SSO detector at 1157).
        // t0 starts BEFORE hpf so the TOTAL deadline still bounds the 12s hpf wait (invariant 1158-1162).
        const t0 = Date.now();
        const TOTAL = Number(process.env.XSION_LOGIN_TOTAL_MS) || 70000;   // explicit total-wall-clock deadline
        const N = Math.max(1, Math.min(3, Number(process.env.XSION_LOGIN_RETRIES) || 2));
        hadPasswordForm = (await page.locator('input[type="password"]').count()) > 0
          || await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
        // still-on-gate uses the SAME predicate as the login's positive-evidence signal (offLoginGate) — never a
        // second, differently-spelled URL regex that could disagree.
        const stillOnGate = async () => (await page.locator('input[type="password"]').count().catch(() => 0)) > 0 || !offLoginGate(page.url());
        let outcome: import('./authSignals').LoginOutcome = 'indeterminate';
        let attemptsUsed = 0;
        for (let a = 0; a < N; a++) {
          if (Date.now() - t0 > TOTAL) break;
          attemptsUsed = a + 1;
          // PER-ATTEMPT cap (was one wrapper for the whole thing): a breach throws XSION_STEP_TIMEOUT → the catch
          // below, preserving the "one stalled login can't freeze the run" invariant even across retries.
          outcome = await withStepTimeout(Number(process.env.XSION_LOGIN_CAP_MS) || 30000, -1,
            tryLoginSettled(page, email, password, { knownAppRoute: offLoginGate }));
          if (outcome === 'signed-in' || outcome === 'rejected') break;   // terminal — done (never re-hammer a rejection)
          // indeterminate: the slow redirect may have arrived while settleLogin was giving up — re-check landed first.
          if (!(await stillOnGate())) { outcome = 'signed-in'; break; }
          if (a + 1 < N && Date.now() - t0 <= TOTAL) {
            await page.waitForTimeout(1500).catch(() => {});                                    // short settle
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});   // fresh gate for attempt 2
          }
        }
        if (outcome === 'signed-in') {
          stepResults.push({ stepIndex: -1, status: 'pass', attempts: [{ kind: 'auth', selector: 'login', matched: 1, hadPasswordForm: true } as any], note: `logged in (url: ${page.url()}; attempts: ${attemptsUsed})` });
          hooks.onLearn?.({ kind: 'selector', key: 'login', fact: `login: dynamic identifier + password + sign-in → lands ${safePath(page.url())}` });
        } else if (outcome === 'rejected') {
          // auth-error text near the form after submit → genuine bad credentials (NOT SSO, NOT a slow redirect).
          stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 1, error: 'auth error near form after submit (rejected — likely bad credentials)', hadPasswordForm: true } as any], note: `login rejected (password form present — not SSO; attempts: ${attemptsUsed})` });
        } else if (hadPasswordForm) {
          // password form present but NO terminal signal across all attempts → slow redirect / dead air, not SSO.
          stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 1, error: `no terminal login signal after ${attemptsUsed} attempt(s) (slow redirect / dead air)`, hadPasswordForm: true } as any], note: `login indeterminate (password form present — not SSO; attempts: ${attemptsUsed})` });
        } else {
          // no usable password form ever appeared → could be SSO-only or a form that never rendered.
          stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: 0, error: 'no password form found after wait' }], note: 'login form never appeared' });
        }
      } catch (e: any) {
        // use the RECORDED hadPasswordForm (never a fresh DOM re-read) so a wedged-out login that DID have a
        // password form is not mislabeled SSO-only by detectSSO. matched:1 when a form was seen (we reached the gate).
        stepResults.push({ stepIndex: -1, status: 'fail', attempts: [{ kind: 'auth', selector: 'login', matched: hadPasswordForm ? 1 : 0, error: String(e.message).slice(0, 160), ...(hadPasswordForm ? { hadPasswordForm: true } : {}) } as any], note: 'auth pre-step failed' });
      }
      // POST-LOGIN HYDRATION WAIT (the reach-state fix): after the auth pre-step, the SPA re-renders the landing
      // page (e.g. schooltalk's /Teacher portal picker) ASYNCHRONOUSLY. The first real step used to fire on an
      // EMPTY DOM → "no candidates on page" → the whole flow cascaded to cant-perform. Wait for interactive
      // elements to actually appear before step 0. (The crawler saw 41 candidates here; the executor saw 0 — this
      // is the gap.) Bounded, best-effort — a genuinely blank page just proceeds and fails honestly.
      const authOk = stepResults.some((s) => s.stepIndex === -1 && s.status === 'pass');
      if (authOk) {
        // post-login: the WHOLE app boots (slow), so the long budget.
        const r = await settleUntilStable(page, 20000);
        hooks.onThink?.(`Signed in — waited for the app to finish rendering (${r.count} interactive elements, ${r.ms}ms). Now running the reproduction.`);
      }
    }

    // GOAL-AGENT BOOTSTRAP: runGoal starts with an EMPTY flow — prime the first step(s) from the driver so the loop
    // has something to run (otherwise `i < 0` never enters + the exhausted-seam never fires). Post-login page is settled.
    if (hooks.onStepsExhausted && flow.steps.length === 0) {
      let first: any = null;
      try { first = await hooks.onStepsExhausted(page, observedCalls); }
      catch (e: any) { failed = true; hooks.onThink?.(`goal driver error (bootstrap): ${String(e?.message || e).slice(0, 100)}`); }
      if (first && first.length) flow.steps.push(...first);
    }

    // ── AI REACH PRECONDITION (the fundamental fix, 2026-08-30): the #1 reason attacks don't land is they fire on the
    // LANDING page, never on the feature's page (the map often can't derive the nav path — conditional-render, no
    // learned form). BEFORE the attack steps, if the feature's control isn't on the current page, navigate to it — via
    // a cached nav path (free) or ONE cheap AI reach call (~8s, measured 3/3 reliable). Runs ONLY when the control is
    // absent (no cost when present), NEVER pushes a stepResult (a reach can't be miscounted as a landed attack). Reach =
    // find the page; the deterministic loop drives it. Pure runtime facts (live page), so it works on ANY app.
    if (opts?.reachFeature) {
      try {
        const fw = opts.reachFeature.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const controlPresent = () => page.evaluate((words: string[]) => {
          const d: any = (globalThis as any).document;
          // WORD-BOUNDARY match (2026-08-30): substring match made "Flagged"/"Approved"/"Allocated" status pills satisfy
          // controlPresent for feature "Flag"/"Approve"/"Allocate" → reach was skipped, the modal never opened. A word
          // boundary ("\bflag\b" ⊄ "flagged") ties presence to the actual action control, not a past-tense status label.
          const hit = (l: string, w: string) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(l);
          return Array.prototype.slice.call(d.querySelectorAll('button, a, [role="button"], [onclick]'))
            .map((e: any) => (e.getAttribute('aria-label') || e.textContent || '').toLowerCase())
            .some((l: string) => words.some((w) => hit(l, w)));
        }, fw).catch(() => true);
        if (!(await controlPresent())) {
          const cache = ((opts as any).reachNavCache ||= { labels: [] as string[] }) as { labels: string[] };
          // FAST PATH: replay the nav labels a prior attack discovered — one click each, NO AI call (real-time).
          if (cache.labels.length) {
            for (const lbl of cache.labels) { await clickByLabelInPage(page, lbl); await page.waitForTimeout(400); }
            if (await controlPresent()) hooks.onThink?.(`Reached the "${opts.reachFeature}" view via the cached nav path (no AI call).`);
          }
          // SLOW PATH: still absent → ONE AI reach (<=3 hops), caching each nav label it clicks for the next attack.
          if (!(await controlPresent())) {
            hooks.onThink?.(`Navigating to the "${opts.reachFeature}" view (AI reach), then driving the attack deterministically.`);
            for (let hop = 0; hop < 3; hop++) {
              const view = await page.evaluate(() => {
                const d: any = (globalThis as any).document; const win: any = (globalThis as any);
                const controls = Array.prototype.slice.call(d.querySelectorAll('button, a, [role="button"], [onclick]')).filter((e: any) => !!(e.offsetWidth || e.offsetHeight)).slice(0, 30).map((e: any) => ({ label: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) })).filter((c: any) => c.label);
                return { url: win.location ? win.location.href : '', title: d.title, text: ((d.body && d.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 300), controls };
              });
              const res: any = await explorePage({ goal: `Navigate to the page/view that contains the "${opts.reachFeature}" control (click the nav item that leads there). Do NOT click ${opts.reachFeature} itself.`, marker: opts.marker || 'X', ...view }).catch(() => ({ clicks: [] }));
              const clicks = (res && res.clicks) || [];
              if (!clicks.length) break;
              for (const c of clicks.slice(0, 2)) { const lbl = String(c.label || '').trim(); if (lbl) { await clickByLabelInPage(page, lbl); if (!cache.labels.includes(lbl)) cache.labels.push(lbl); await page.waitForTimeout(500); } }
              if (await controlPresent()) { hooks.onThink?.(`Reached the "${opts.reachFeature}" view — running the attack.`); break; }
            }
          }
        }
      } catch (e: any) { hooks.onThink?.(`reach precondition error (proceeding anyway): ${String(e?.message || e).slice(0, 80)}`); }
    }

    // ── CAPTURE THE LIVE ATTACK SURFACE (the fundamental fix): after reach, scan the page the executor is ACTUALLY on
    // for its fillable inputs + clickable action controls. This is ground truth — break-it regenerates its plan from it,
    // so conditional-rendered controls become attackable and phantom map fields never produce a failing attack. Costs
    // one page.evaluate, same browser/page. Only when a caller asked (reachFeature set = a targeted attack run).
    // ── CAPTURE THE LIVE ATTACK SURFACE (the fundamental fix, 2026-08-30 = UNION-ACROSS-STEPS): a single pre-loop
    // snapshot can NEVER see a multi-step form (wizard step 2's fields aren't rendered yet) or a modal that only
    // opens DURING the attack (a row-action's dialog). So scan on EVERY call and MERGE by lowercased label into a
    // union, and record whether any scan landed inside the feature's own modal (a bounded, complete surface).
    // Deterministic (no LLM), one page.evaluate per call on a page we already own.
    const captureSurface = async (openerConfirmed = false) => {
      if (!opts?.reachFeature) return;
      try {
        const surface = await page.evaluate(() => {
          const d: any = (globalThis as any).document; const win: any = (globalThis as any);
          const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
          const isNav = (el: any) => { try { return !!(el.closest && (el.closest('[data-nav]') || el.closest('nav, [role="navigation"], aside, [class*="sidebar" i], [role="menubar"]'))); } catch { return false; } };
          // fillable inputs (scoped to a modal/dialog if one is open — the feature's own form)
          const overlays = Array.prototype.slice.call(d.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="drawer" i]')).filter((el: any) => { try { const s = win.getComputedStyle(el); const r = el.getBoundingClientRect(); return (s.position === 'fixed' || s.position === 'absolute') && s.display !== 'none' && r.width > 0 && r.height > 0; } catch { return false; } });
          const inModal = overlays.length > 0;
          const scope = inModal ? overlays[overlays.length - 1] : d;
          const FIELD_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea';
          const seen: any = {}; const fields: any[] = [];
          for (const el of Array.prototype.slice.call(scope.querySelectorAll(FIELD_SEL)).filter(vis)) {
            const tag = (el.tagName || '').toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
            let label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
            if (!label) { const id = el.getAttribute('id'); if (id) { const lab = d.querySelector('label[for="' + id + '"]'); if (lab) label = (lab.textContent || '').trim(); } }
            if (!label) label = el.getAttribute('name') || '';
            label = String(label).replace(/\s+/g, ' ').trim().slice(0, 50); if (!label) continue;
            const k = label.toLowerCase(); if (seen[k]) continue; seen[k] = 1;
            fields.push({ label, kind: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (type || 'text'), required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' });
          }
          // clickable NON-NAV action controls (for the click-action attack shape on form-less features)
          const acts: string[] = []; const seenA: any = {};
          for (const el of Array.prototype.slice.call(d.querySelectorAll('button, [role="button"], [onclick]')).filter(vis)) {
            if (isNav(el)) continue;
            const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40); if (!t || seenA[t.toLowerCase()]) continue; seenA[t.toLowerCase()] = 1; acts.push(t);
          }
          // MODAL-SCOPED actions (from `scope`, not `d`): the feature-modal's OWN buttons (Flag's preset flags). When
          // we're inside the feature's modal, membership IS the scoping — these get click-attacked without a name filter.
          const modalActs: string[] = []; const seenM: any = {};
          if (inModal) for (const el of Array.prototype.slice.call(scope.querySelectorAll('button, [role="button"], [onclick]')).filter(vis)) {
            const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40); if (!t || seenM[t.toLowerCase()]) continue; seenM[t.toLowerCase()] = 1; modalActs.push(t);
          }
          return { fields: fields.slice(0, 25), actions: acts.slice(0, 30), modalActions: modalActs.slice(0, 20), inModal };
        }).catch(() => ({ fields: [] as any[], actions: [] as string[], modalActions: [] as string[], inModal: false }));
        for (const f of surface.fields) { const k = f.label.toLowerCase(); if (!liveFieldMap.has(k)) liveFieldMap.set(k, f); }
        for (const a of surface.actions) { const k = a.toLowerCase(); if (!liveActionSet.has(k)) liveActionSet.set(k, a); }
        for (const a of surface.modalActions) { const k = a.toLowerCase(); if (!liveModalActionSet.has(k)) liveModalActionSet.set(k, a); }
        // SCOPE=modal is TRUSTWORTHY only with causal evidence the overlay is the FEATURE's own — either it holds
        // fillable fields (a form modal), OR this capture ran right after a confirmed opener-click (a field-less action
        // modal like Flag's presets). A stray toast/banner seen mid-flow does NOT flip scope (would wrongly enable the
        // drop-gate with empty liveLabels → drop every field attack).
        if (surface.inModal && (surface.fields.length || openerConfirmed)) liveScope = 'modal';
        else if (liveScope !== 'modal') liveScope = 'page';
        liveFields = [...liveFieldMap.values()]; liveActions = [...liveActionSet.values()]; liveModalActions = [...liveModalActionSet.values()];
        // COHORT: THIS snapshot is a set of CO-PRESENT fields. Score = fields.length (+50 if modal-scoped: a bounded
        // form beats a page grab of equal size). Keep the highest-scoring snapshot as the fill cohort. Never merged.
        // AUTHORITATIVE MODAL RESET (2026-08-30): when this capture ran right after a confirmed opener-click, the modal
        // IS the feature's surface — its fields are the cohort, EVEN IF EMPTY. Overwrite (don't max-score) so a stale
        // page cohort (the orders "Search customer…" box captured pre-open) can't survive as the fill target for a
        // field-less action modal. Without this, a field-less modal keeps the page's search box and generates a doomed
        // "Overflow <search box>" attack. An empty cohort here correctly signals "click-only feature, no field attacks".
        if (openerConfirmed && surface.inModal) { liveCohort = surface.fields.slice(); liveCohortScore = surface.fields.length + 50; }
        else if (surface.fields.length) { const score = surface.fields.length + (surface.inModal ? 50 : 0); if (score > liveCohortScore) { liveCohortScore = score; liveCohort = surface.fields.slice(); } }
      } catch {}
    };
    if (opts?.reachFeature) { await captureSurface(); }   // pre-loop snapshot (seeds actions + step-1 fields)

    // ── OPEN THE ROW-ACTION / MENU FORM (2026-08-30): for a FORM feature, controlPresent()==true means we're on the
    // feature's page and its fields render directly — the pre-loop capture already saw them. But for a ROW ACTION
    // (torture's "Flag" on an order row, a "⋯" menu item), controlPresent()==true only means the OPENER button is on
    // screen; the form lives behind a click. Without that click the capture lands on ambient page inputs (the dashboard
    // search box) → scope stays 'page' → nothing to attack. So: when reach found NO fillable fields and NO modal open,
    // click the control whose label matches the feature words (the opener), settle, and re-capture. That flips
    // liveScope→'modal' and populates the cohort. GUARD: fire whenever we are NOT already modal-scoped — a page-scoped
    // capture means either no form (row action, opener not yet clicked) OR only ambient page inputs (a dashboard
    // search box counts as a "field", so gating on field-count==0 wrongly skips this; gate on scope, not count).
    // The click only happens if a feature-matching non-submit opener EXISTS, so form features (already showing their
    // fields, opener == the page itself) are a no-op unless a same-named button exists — and if one does, opening it
    // is still correct. Once per attack. Deterministic, no LLM.
    if (opts?.reachFeature && liveScope !== 'modal') {
      try {
        const fw2 = opts.reachFeature.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const opener = await page.evaluate((words: string[]) => {
          const d: any = (globalThis as any).document;
          const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
          const hit = (l: string, w: string) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(l);
          const label = (el: any) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
          const matches = (el: any) => { const t = (el.getAttribute('type') || '').toLowerCase(); if (t === 'submit') return false; const l = label(el).toLowerCase(); return words.some((w) => hit(l, w)); };
          // PREFER a row-action button carrying data-testid="act-…" (torture + common convention) — the strongest opener
          // signal. Fall back to any feature-matching non-submit control (keeps it general to apps without testids).
          const acts = Array.prototype.slice.call(d.querySelectorAll('[data-testid^="act-"]')).filter(vis).filter(matches);
          if (acts.length) return label(acts[0]).slice(0, 40);
          const cands = Array.prototype.slice.call(d.querySelectorAll('button, a, [role="button"], [onclick]')).filter(vis).filter(matches);
          return cands.length ? label(cands[0]).slice(0, 40) : '';
        }, fw2).catch(() => '');
        if (opener) {
          hooks.onThink?.(`Opening the "${opener}" form (row-action opener) to reach its fields, then attacking inside.`);
          await clickByLabelInPage(page, opener); await page.waitForTimeout(600);
          await captureSurface(true);   // openerConfirmed → flips liveScope to 'modal' even for a field-less action modal
        }
      } catch {}
    }

    // PRE-LOOP RE-AUTH ON SESSION BOUNCE (2026-08-30): torture's in-memory SESSION can drop between the login pre-step
    // and the first action (a stray reload / the app re-mounting), landing us BACK on the login gate. The per-step
    // re-auth (below) only fires on a nav/reload/url-change step — so if step 1 is a CLICK, it runs on the login page,
    // fails, and every downstream step cascades (bug-repro's loginWall false-blame: login had SUCCEEDED, then bounced).
    // Catch it ONCE here, before the loop: if we have creds and are visibly on a login gate now, re-sign-in. Gated on a
    // VISIBLE password field + no authed affordance (same predicate as the per-step gate) so an authed page never
    // re-submits creds. Cheap (one evaluate), and it makes bug-repro/goal as session-robust as break-it's attack loop.
    if (email && password && reAuthLeft > 0) {
      try {
        const onGate = await page.evaluate(() => { const d: any = (globalThis as any).document; const pw: any = d.querySelector('input[type=password]'); const pwVisible = !!(pw && (pw.offsetWidth || pw.offsetHeight)); const authedAffordance = !!d.querySelector('[data-nav], [role="navigation"] a, nav a'); return pwVisible && !authedAffordance; }).catch(() => false);
        if (onGate) { reAuthLeft--; hooks.onThink?.('session dropped back to the login gate before the first step — re-authenticating so the flow runs signed-in.'); await tryLoginSettled(page, email, password, { knownAppRoute: offLoginGate }).catch(() => {}); await page.waitForTimeout(400); }
      } catch {}
    }

    let lastStepMovedView = false;   // set by the step body (a click/select/nav that landed) → gates the post-step re-capture
    for (let i = 0; i < flow.steps.length; i++) {
      lastStepMovedView = false;
      curStepIntent = flow.steps[i]?.intent || `step ${i}`;   // tracked so the OUT-OF-LOOP timeout catch names WHICH step stalled
      curStepIndexRef.i = i;   // attribute API calls fired by THIS step (post-submit oracle)
      // ★ PER-STEP WALL-CLOCK CAP (resilience, not a bug-fix): a single step that wedges on a transient network stall
      // (a goto/waitForLoadState hitting dead air) must NOT freeze the whole run. Race this iteration against a cap;
      // on timeout, THROW → the loop's existing catch marks it failed → teardown (browser.close, OUTSIDE the try)
      // still runs, so NO context leaks (the leak is what racing at the runStep boundary would have caused). The
      // browser is owned HERE, so the cap belongs here. Healthy step incl. its settle waits ≤ ~10s; cap = 60s = wide
      // headroom, still bounds a many-step flow. timedOutStep flag → the caller marks the finding harness-not-app.
      await withStepTimeout(Number(process.env.XSION_STEP_CAP_MS) || 60000, i, (async () => {   // env override for tests; prod default 60s
      const step = flow.steps[i];
      hooks.onStepStart?.(i, step.intent);   // stream: the agent is about to attempt this step
      const urlBeforeStep = page.url();      // for the LEARN route-fact: did this step's click move us to a new page?
      let sawBlankSettle = false;   // set if the post-click hydrate settle (#2) already ran to a still-blank page → the
                                    // empty-DOM reprobe (#3) then skips its OWN settle so a dead page pays ONE settle, not two.
      let clickNoEffect = false;    // set when a click LANDED (matched:1) but moved neither the DOM signature nor the URL
                                    // → it accomplished nothing → on-stall recovery should fire (the "lands-but-does-nothing" gap).

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
          return;   // (was 'continue' — now ends this step's async body; outer for advances)
        } catch (e: any) {
          const sr: StepResult = { stepIndex: i, status: 'fail', attempts: [{ kind: 'session-expiry', selector: 'expire', matched: 0, error: String(e?.message).slice(0, 160) }], note: 'session-expiry check errored', url: page.url() };
          stepResults.push(sr); hooks.onStepResult?.(sr);
          return;   // (was 'continue' — now ends this step's async body; outer for advances)
        }
      }

      const { verb, target, value, target2 } = parseIntent(step.intent);
      const low = step.intent.toLowerCase();
      if (DANGEROUS.some((d) => low.includes(d))) {
        const sr: StepResult = { stepIndex: i, status: 'unverifiable', attempts: [{ kind: 'skipped', selector: target, matched: 0 }], note: `SKIPPED destructive intent: ${step.intent}`, url: page.url() };
        stepResults.push(sr); hooks.onStepResult?.(sr);
        return;   // (was 'continue' — now ends this step's async body; outer for advances)
      }
      // MUTATION GATE: block WRITE steps (create/add/submit/save/…) unless the caller allows it. Prevents bug-repro
      // from creating real records in a tenant's data without consent. 'unverifiable' (skipped), never a fake pass.
      if (!allowMutations && MUTATION_VERBS.some((m) => low.includes(m))) {
        const sr: StepResult = { stepIndex: i, status: 'unverifiable', attempts: [{ kind: 'skipped', selector: target, matched: 0, error: 'mutating step skipped — needs the "I authorize testing this target" attestation' }], note: `SKIPPED mutating step (not authorized): ${step.intent}`, url: page.url() };
        stepResults.push(sr); hooks.onStepResult?.(sr);
        return;   // (was 'continue' — now ends this step's async body; outer for advances)
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
        attempt = await resolveFill(page, target, value || 'test@example.com', (step as any).skipIfFilled === true);
      } else if (verb === 'submit') {
        // STATE-DELTA ORACLE: snapshot app-agnostic state IMMEDIATELY BEFORE the mutating click, so the caller's oracle
        // can compare against after (+ a reload) and produce a REAL verdict from an observed effect — not a UI toast.
        try { stateBefore = await stateProbe(page); } catch {}
        // VERIFY-BY-EFFECT: click the primary control, classify by what changed. A multi-step wizard is walked to its
        // terminal create; a single-page form returns resolveSubmit's own result UNCHANGED (one click, same as today).
        // No vocabulary, no role=tab. marker (from break-it) tags any fields filled on advanced steps.
        attempt = await resolveSubmitWizardAware(page, opts?.marker || 'XSION-TEST');
        try { stateAfter = await stateProbe(page); } catch {}
        // AI-EXECUTOR ESCALATION: the deterministic submit didn't drive (matched:0) AND nothing observably moved —
        // the brittle-plumbing case (per-row modal, custom widget). Escalate to the vision AI to complete the action,
        // bounded by a per-run cap (AI is never a hard dependency; degrades to the deterministic matched:0). Only when
        // mutations are allowed (a real attack run), so a read-only pass never fires model calls.
        // TRIGGER on NO STORAGE MOVEMENT regardless of matched: a submit that reports matched:1 but wrote NOTHING
        // (clicked the wrong control — e.g. a nav item instead of the modal's button) is exactly the brittle case the
        // AI should take over. Use STORAGE-diff (not probesDiffer) — opening the modal churns the DOM but only a real
        // write changes storage, so DOM churn must not suppress escalation.
        const noWrite = !stateBefore || !stateAfter || !probesStorageDiffer(stateBefore, stateAfter);
        if (noWrite && opts?.allowMutations && aiEscalationsLeft > 0) {
          aiEscalationsLeft--;
          hooks.onThink?.(`Deterministic submit didn't land a write — escalating to the AI executor (${aiEscalationsLeft} left) to drive the form on the live page.`);
          // the deterministic submit may have navigated AWAY from the modal (a false matched:1 on a nav item). The AI
          // sees the CURRENT page: if the form/modal closed, it sees the row controls and can re-open + fill + submit
          // itself (the bridge groups open→fill→click). Re-baseline storage right before the AI acts so a landed write
          // is measured against the pre-AI state.
          try { stateBefore = await stateProbe(page); } catch {}
          const goal = (opts as any)?.aiGoal || `Complete and submit the form for: "${step.intent}". If a dialog/modal must be opened first (e.g. a row's Flag button), open it, then fill the field and click the final save/submit button.`;
          const ai = await aiEscalateDrive(page, goal, opts?.marker || 'XSION-TEST');
          if (ai.matched) { attempt = ai; try { stateAfter = await stateProbe(page); } catch {} }
        }
      } else if (verb === 'locate') {
        // STRICT locate-a-specific-item: needles = ALL quoted strings in the intent (marker + date-time), else the
        // target words. resolveLocateByText requires the match (no row-0 fake) → honest matched:0 on a miss.
        const quoted = [...step.intent.matchAll(/["'“”]([^"'“”]{2,})["'“”]/g)].map((mm) => mm[1]);
        const needles = quoted.length ? quoted : contentWords(target).filter((w) => w.length > 2);
        attempt = await resolveLocateByText(page, needles);
      } else if (verb === 'reload') {
        // "refresh the page" — a real reload (the Lesson-2 ticket hinges on state AFTER refresh). Not a control click.
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); await page.waitForTimeout(800); attempt = { kind: 'reload', selector: 'page reload', matched: 1 }; }
        catch (e: any) { attempt = { kind: 'reload', selector: 'reload', matched: 0, error: String(e.message || e).slice(0, 120) }; }
      } else if (verb === 'observe') {
        // observation steps: pass (nothing to click); the console/network is captured for VERIFY
        attempt = { kind: 'observe', selector: target, matched: 1 };
      } else if (verb === 'select') {
        // native <select> dropdown (admin filters: Signup State, User Type) → selectOption, not click.
        // Fall back to click if it's actually a custom dropdown (button + menu).
        const sel = await resolveSelect(page, target, value);
        attempt = sel || (await resolveCustomDropdown(page, target, value)) || (await resolveClick(page, target, step.intent));
      } else if (verb === 'check' || verb === 'uncheck') {
        attempt = await resolveCheck(page, target, verb === 'check');
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
        const sigBefore = await domSig(page);   // structural baseline (captured BEFORE the click) for the hydrate gate below
        // STATE-DELTA ORACLE FOR MUTATING CLICKS (2026-08-30): a click-action attack (e.g. Flag's "priority" preset)
        // commits a write WITHOUT a submit step, so the submit-branch's before/after snapshot never runs → empty
        // stateDelta → a real write scored "no persisted change". Snapshot here too, around the FIRST attack click of a
        // targeted run (reachFeature set = an attack; allowMutations = it's a real one). Non-nav clicks only — a nav
        // click changes the view, not the data. The post-click storage settle (below) waits out the app's async write.
        const isAttackClick = !!opts?.reachFeature && !!opts?.allowMutations && !stateBefore &&
          !/users|dashboard|page|view|go to|navigat|details|plans|chats|settings|profile|orders|inventory|shipments|invoices|rules|audit/i.test(step.intent);
        if (isAttackClick) { try { stateBefore = await stateProbe(page); } catch {} }
        attempt = await resolveClick(page, target, step.intent);
        if (isAttackClick && attempt.matched > 0) {
          // the app's api() has 400–1400ms latency before persist() — wait for the write to land before snapshotting.
          await page.waitForTimeout(1600);
          // CAPTURE THE TRANSIENT FAILURE SIGNAL HERE (2026-08-30): a failure toast ("Something went wrong (500)") is
          // shown at the api() response (~400–1400ms) and AUTO-DISMISSES (torture: 2600ms). finalText — read seconds
          // later after a reload — misses it entirely, so an APPLIED-DESPITE-FAILURE (500 + persisted write) read as a
          // clean 'held'. This 1600ms window is exactly when the toast is on screen. Scan short-lived status text
          // app-agnostically (ARIA roles for real apps + common toast/snackbar class shapes for the rest).
          try {
            const alerts = await page.evaluate(() => {
              const d: any = (globalThis as any).document;
              const sel = '[role="alert"], [role="status"], [aria-live], [class*="toast" i], [class*="snackbar" i], [class*="notification" i], [class*="flash" i]';
              const out: string[] = [];
              for (const el of Array.prototype.slice.call(d.querySelectorAll(sel))) {
                if (!(el.offsetWidth || el.offsetHeight)) continue;
                const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
                if (t && !out.includes(t)) out.push(t);
              }
              return out.slice(0, 6);
            }).catch(() => [] as string[]);
            for (const a of alerts) if (!transientAlerts.includes(a)) transientAlerts.push(a);
          } catch {}
          try { stateAfter = await stateProbe(page); } catch {}
        }
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
        // ★ FLAKE-FIX #2 — HYDRATE-AFTER-ANY-CLICK (was URL-gated; 2026-08-24 made structural). A successful click may
        // swap the view via an SPA route OR a STATE-ONLY switch (a tenant/portal pick that re-renders in place — the
        // URL may not move synchronously, or at ALL). The old `page.url() !== urlBefore` gate missed both cases: the
        // async URL update raced the check, and a state-only switch never changes the URL — so the next step raced
        // into an un-rendering (often crashing) view (the tenant-click flake). Gate on the DOM SIGNATURE CHANGING
        // instead. We wait a SHORT window (750ms) for the NEW view to START rendering, THEN plateau — which also fixes
        // settleUntilStable plateauing on the OUTGOING DOM (it can't, now that we confirmed a change first). The window
        // is small on purpose: an inert click pays it in full (waitForSigChange only returns false at the timeout), and
        // a real re-render begins within a few hundred ms — settleUntilStable owns waiting for it to COMPLETE. Skipped
        // for looksNav (handled just above).
        if (attempt.matched > 0 && !attempt.error && !looksNav) {
          // 2000ms (was 750): a SLOW tenant/portal switch needs one network round-trip + first paint before the
          // signature moves; 750ms let a75dd8a3's blank-render slip past → fell through to a plateau on the outgoing
          // DOM. 2s covers the round-trip; still << the settle the click already costs. (2026-08-24 review)
          const changed = await waitForSigChange(page, sigBefore, 2000);
          if (changed) {
            // 8000 (was 18000): matches the mid-flow settle budget; a genuinely SPARSE new view (< SIG_MIN nodes)
            // never plateaus and would otherwise burn the full budget — cap the tax. (2026-08-24 review, SEV-3)
            const s = await settleUntilStable(page, 8000);
            hooks.onThink?.(`Click swapped the view — waited for it to finish rendering (${s.count} elements, ${s.ms}ms) before the next step.`);
            if (s.count < SIG_MIN) sawBlankSettle = true;   // rendered to (near-)nothing → the empty-DOM reprobe (#3) below won't re-settle.
          } else if (page.url() === urlBefore) {
            // LANDED-BUT-NO-EFFECT (2026-08-27): the click matched:1 but the DOM signature did NOT move AND the URL did
            // not move → it accomplished nothing (e.g. the dropdown-trigger re-click that opens then re-closes the menu
            // without picking). Flag it so ON-STALL RECOVERY fires on the SAME 2-strikes-per-page rule as a miss — the
            // agent then LOOKS at the page and reasons about what to actually do. `ok` stays TRUE (a no-effect click is
            // not a failed step; we don't touch the caller's pass/fail accounting). Click verb only — fill/select have
            // their own effect verification (keptDefault / menu-close gate) and legitimately leave the sig unchanged.
            clickNoEffect = true;
          }
        }
      }
      let ok = attempt.matched > 0 && !attempt.error;
      const isActionable = /click|fill|type|select/i.test(attempt.kind || '') || /click|fill|type|select/i.test(verb);

      // ★ FLAKE-FIX #3 — EMPTY-DOM REPROBE (bounded, general). A 0-match on a page that has almost NO interactive
      // nodes is a not-yet-hydrated / flaky-blank page, NOT a wrong-label miss. Gate on POOL EMPTINESS (live count
      // < SIG_MIN), NOT on score: a POPULATED page with best=0 is a real miss and must fall straight through — no
      // settle tax on honest failures. Runs at MOST once per step (structurally: only when matched===0, and it
      // either lands or falls through to the honest fail). Placed BEFORE recovery so a ~150s SoA explorePage never
      // burns on an empty inventory. If the hydrate settle (#2) already ran to a blank page this step, we SKIP the
      // settle here (sawBlankSettle) so a dead page pays ONE settle, not two — but still flags blankPage.
      if (!ok && isActionable && attempt.matched === 0) {
        const liveCount = await domCount(page);   // same selector set as settleUntilStable — one definition of "interactive"
        if (liveCount < SIG_MIN) {
          let s = { count: liveCount, ms: 0 };
          if (!sawBlankSettle) { s = await settleUntilStable(page, 8000); }   // mid-flow budget (matches line 1424's 8s), NOT the 20s post-login one
          hooks.onThink?.(`Page had almost nothing interactive (${liveCount}) — waited for it to (re)hydrate (${s.count} elements) and retrying "${step.intent}" once.`);
          attempt = verb === 'fill' ? await resolveFill(page, target, value || 'test@example.com')
            : verb === 'select' ? ((await resolveSelect(page, target, value)) || (await resolveCustomDropdown(page, target, value)) || (await resolveClick(page, target, step.intent)))
            : await resolveClick(page, target, step.intent);
          ok = attempt.matched > 0 && !attempt.error;
          // Still blank after a full settle → harness/latency, not an app verdict. Flag it so recovery is skipped and
          // the caller can report "page never rendered — no verdict about the app" (mirrors the timedOut honesty flag).
          if (!ok && s.count < SIG_MIN) (attempt as any).blankPage = true;
        }
      }

      // ── ON-STALL RECOVERY: the step couldn't find its control, OR a click LANDED but accomplished NOTHING. Track
      // consecutive stalls (reset when the page changed since our last recovery). On the 2nd stall on the SAME page,
      // ask SoA to LOOK at the page and say what to click to get past the gate — then RE-ATTEMPT the original step.
      // This is the adaptive-agent behaviour the crawl already has (#199/#200), reused so flows don't dead-stop on a
      // portal/workspace picker OR a lands-but-does-nothing control (2026-08-27: the dropdown-trigger re-click case).
      const stalled = (!ok && attempt.matched === 0) || clickNoEffect;
      if (isActionable && stalled) {
        if (clickNoEffect) hooks.onThink?.(`The "${target}" click landed but changed nothing on the page — treating it as a stall and looking at what to actually do.`);
        consecutiveMisses++;
        const pageKey = `${page.url()}::${(await page.title().catch(() => '')) || ''}`;
        if (pageKey !== lastRecoveryPageKey) { /* page moved since last recovery — misses on a NEW page are fresh */ }
        // SKIP recovery on a LOGIN WALL: if we're still on a sign-in page (a password field is present, or the only
        // candidates are Google/Microsoft SSO), there is nothing for SoA to click to get "past" it — recovery would
        // waste a 150s call on the sign-in screen. This is a login-persistence problem, not a gate to explore through.
        const onLoginWall = ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0)
          || /google|microsoft/i.test(attempt.error || '');
        // A blankPage miss (#3 reprobed and the page was STILL near-empty after a full settle) is harness/latency,
        // not a gate to explore through — there is nothing for SoA to click, so skip recovery (kept separate from
        // onLoginWall so that variable keeps meaning "a sign-in wall").
        if (!onLoginWall && !(attempt as any).blankPage && shouldRecover({ consecutiveMisses, recoveriesUsed, maxRecoveries: MAX_RECOVERIES })) {
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
              : verb === 'select' ? ((await resolveSelect(page, target, value)) || (await resolveCustomDropdown(page, target, value)) || (await resolveClick(page, target, step.intent)))
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
      const sr: StepResult = { stepIndex: i, status, attempts: [attempt],
        note: (attempt as any).corrected ? `[corrected] used your confirmed control ${attempt.selector || ''}`
            : (attempt as any).recovered ? `[recovered] ${attempt.error || 'via on-stall recovery'}`
            : attempt.error,
        url: page.url() };
      stepResults.push(sr); hooks.onStepResult?.(sr);   // stream: this step's outcome
      // LEARN a route fact: a click on a LABEL that moved us to a NEW page ("clicking X → /path") — the exact
      // navigation knowledge that would let the next run skip re-discovery. STRUCTURE only (label→route), no verdict.
      if (ok && (verb === 'click' || verb === 'select') && target) {
        const to = safePath(page.url());
        // GUARD (advisor): only record a route fact when `target` is a real CONTROL LABEL, not a mangled step-description.
        // A verb-clause / long phrase (looksLikeClause) produced garbage like `route:date to any date within the current
        // cale` — the actual clicked element's accessible name is in attempt.selector, so prefer that; skip if neither is
        // a clean label. Stops the noise-class at the emitter (deleting the row just lets the next run rewrite it).
        const cleanLabel = !looksLikeClause(target) ? target
          : (attempt.selector && !looksLikeClause(String(attempt.selector)) ? String(attempt.selector) : null);
        if (cleanLabel && to !== safePath(urlBeforeStep) && to !== '/') {
          const lbl = cleanLabel.slice(0, 40);
          hooks.onLearn?.({ kind: 'route', key: `route:${lbl.toLowerCase()}`, fact: `clicking "${lbl}" → ${to}` });
        }
      }
      // SETTLE after a step. If the step NAVIGATED (url changed), the SPA async-mounts the new view — use the
      // stronger settle-until-stable (≥MIN interactive AND unchanged across 2 polls) so the NEXT step doesn't fire
      // on a half-mounted page (the "click My Calendar failed after selecting the school" bug: the dashboard hadn't
      // finished rendering). The OLD per-step loop stopped at the FIRST stable count with no minimum, so it declared
      // a transient low count "settled". A non-navigating step just gets a short networkidle. Short mid-flow budget.
      // SETTLE after ANY passing click/select (not just URL-changers): schooltalk's school-click is an IN-PLACE SPA
      // route (the dashboard re-mounts without a URL change my old `navigated` gate could see), so "My Calendar"
      // fired while only `button:"sc"` had rendered. A click/select that LANDED very likely changed the view → wait
      // for it to settle before the next step. (settleUntilStable requires ≥MIN AND stable across polls, so a
      // 40→1→40 collapse keeps waiting.) A fill / observe / no-op just gets a short networkidle.
      const mightHaveMovedView = ok && (verb === 'click' || verb === 'select' || verb === 'navigate');
      lastStepMovedView = mightHaveMovedView;   // surfaced to the post-body re-capture gate (excludes fills/submits)
      if (mightHaveMovedView) { await settleUntilStable(page, 8000); }
      else { await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300); }
      await hooks.onFrame?.(page, step.intent, attempt.box);   // LIVE VIEW + PLAYBACK: frame + the action's cursor box
      // RE-AUTH ON SESSION BOUNCE (2026-08-30, "make it land" — staging-only): torture's in-memory session drops on a
      // stray reload → a later step ran on the LOGIN screen. Re-sign-in so the rest of the attack runs authenticated.
      // GUARDS (advisor): (a) only when the step could have bounced us — a nav/reload verb OR a url change (a fill/
      // same-view click can't log you out, so most steps skip the probe); (b) gate on a VISIBLE password field, not
      // mere existence — torture never REMOVES #loginPass, only hides it, so existence is true on every authed page and
      // would re-submit creds on an authed page (the ensureSession false-positive class); (c) cap re-auths per flow.
      if (email && password && reAuthLeft > 0 && (verb === 'navigate' || verb === 'reload' || page.url() !== urlBeforeStep)) {
        try {
          // authedAffordance must NOT include a bare <button> — a login page HAS a "Sign In" button, so counting it
          // made `!authedAffordance` false on the very gate we need to detect (this gate could never fire on such a
          // page). Match the pre-loop gate: nav affordances only ([data-nav]/nav links), which render only when authed.
          const onGate = await page.evaluate(() => { const d: any = (globalThis as any).document; const pw: any = d.querySelector('input[type=password]'); const pwVisible = !!(pw && (pw.offsetWidth || pw.offsetHeight)); const authedAffordance = !!d.querySelector('[data-nav], [role="navigation"] a, nav a'); return pwVisible && !authedAffordance; }).catch(() => false);
          if (onGate) { reAuthLeft--; await tryLoginSettled(page, email, password, { knownAppRoute: offLoginGate }).catch(() => {}); await page.waitForTimeout(400); hooks.onThink?.('session bounced to login mid-attack — re-authenticated to keep the attack running.'); }
        } catch {}
      }
      })());   // ← close the per-step-timeout-wrapped async body

      // GENERAL GOAL-AGENT SEAM (2026-08-23): when we've run the last planned step, ask the driver for the NEXT
      // intent(s) given the live page. It returns more steps (pushed → the loop continues on the SAME page, reusing
      // ALL per-step machinery: caps, frames, stepResults) or null (loop ends → existing tail runs). This is what
      // makes executeFlow an ADAPTIVE agent without duplicating any of the execution/verification/live-view code.
      if (hooks.onStepsExhausted && i === flow.steps.length - 1) {
        let more: any = null;
        try { more = await hooks.onStepsExhausted(page, observedCalls); }
        catch (e: any) { failed = true; hooks.onThink?.(`goal driver error: ${String(e?.message || e).slice(0, 100)}`); break; }
        if (more && more.length) flow.steps.push(...more);   // safe: the for-condition re-reads flow.steps.length
      }
      // UNION RE-CAPTURE (2026-08-30): re-scan after a step that MOVED THE VIEW (a nav/click/select that opened a
      // modal or advanced a wizard step) so the newly-rendered fields join the discovery union. CRUCIAL: only after a
      // view-mover, NEVER after a fill/submit — a page.evaluate landing on the wizard's submit step races its
      // transition and leaves resolveSubmit unable to find the button (measured: it stalled the submit to the 60s cap
      // and turned a `held` overflow into a timeout). `mightHaveMovedView` is exactly "a click/select/nav that landed",
      // which excludes fills and submits. The pre-loop snapshot already seeds step-1 fields + actions.
      // GATED (XSION_LIVE_UNION=0 disables the per-step re-capture entirely).
      if (opts?.reachFeature && process.env.XSION_LIVE_UNION !== '0' && lastStepMovedView) { await captureSurface().catch(() => {}); }
    }
  } catch (e: any) {
    failed = true;
    // a per-step-cap timeout throws XSION_STEP_TIMEOUT — record it as a HARNESS interruption (timedOut), not an app
    // fail, so the caller (break-it/bug-repro) can mark the finding "abandoned after cap, no verdict about the app".
    const isTimeout = /XSION_STEP_TIMEOUT/.test(String(e?.message || e));
    // carry the REAL intent of the stalled step (curStepIntent), not baseUrl — attempts[] is empty on a mid-flight
    // abort, so a caller reading attempts[0].selector would see baseUrl and wrongly report a "navigation" stall.
    stepResults.push({ stepIndex: stepResults.length, status: 'fail', timedOut: isTimeout || undefined,
      attempts: [{ kind: isTimeout ? 'timeout' : 'navigate', selector: isTimeout ? (curStepIntent || baseUrl) : baseUrl, matched: 0, error: isTimeout ? `step "${curStepIntent}" exceeded its cap and was abandoned — a harness/latency stall, not a verdict about the app` : String(e.message).slice(0, 200) }],
      note: isTimeout ? `step timed out (harness cap) at: ${curStepIntent}` : 'flow-level failure' } as any);
  }
  // SPECIALIZED-ORACLE SEAM: let a caller run its own probes on the reached state while the page is still live (the
  // drop-precision differential needs the calendar open to drop + read back). Fails soft — never poisons the run.
  try { await hooks.onReachedState?.(page); } catch (e: any) { hooks.onThink?.(`reached-state probe error: ${String(e?.message || e).slice(0, 120)}`); }
  // capture the result page BEFORE closing (so break-it can read the "Error…" / "Saved…" message)
  let finalText = '', finalUrl = '';
  try { finalUrl = page.url(); finalText = (await page.evaluate(() => (globalThis as any).document.body?.innerText || '')).replace(/\s+/g, ' ').slice(0, 600); } catch {}

  // ── STATE-DELTA ORACLE: build the delta + the CONFIRM-BY-RELOAD evidence (while the page is still live). A change
  // that SURVIVES a reload is a REAL write (a persisted effect); a change that VANISHES on reload was optimistic /
  // apply-then-fail (the torture 12%-random-500-that-still-applied + optimistic-revert traps) → NOT a validation gap.
  // This is what lets the oracle turn "no toast → needs-review" into a grounded broke/held. Mechanical throughout.
  let stateDelta: StateDelta | undefined;
  if (stateBefore && stateAfter) {
    const changed = probesDiffer(stateBefore, stateAfter);
    // STORAGE change is the load-bearing signal (DOM/rows change just from opening a modal — not a write). Separate it
    // so we never confuse "the view moved" with "a write landed", and so an IDEMPOTENT write (re-setting a field to the
    // value it already holds → byte-identical storage) is honestly reported as "no storage effect", not as a rollback.
    const storageChangedAfter = probesStorageDiffer(stateBefore, stateAfter);
    let afterReload: StateProbe | undefined, persisted: boolean | undefined, reverted: boolean | undefined;
    if (changed) {
      // only pay for a reload when something actually moved — confirm whether it persists.
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(700); afterReload = await stateProbe(page); } catch {}
      // PERSISTENCE = STORAGE-ONLY (the reload may bounce to a login gate, so view-signals are meaningless here).
      // REVERTED = storage DID change right after the action but did NOT survive the reload (a true rollback / apply-
      // then-fail). If storage never changed after the action at all (storageChangedAfter=false), it's NEITHER persisted
      // NOR reverted — the write was idempotent or never happened → leave both false → the oracle falls to needs-review
      // (never a false 'held' from a rollback that didn't occur).
      if (afterReload) { persisted = probesStorageDiffer(stateBefore, afterReload); reverted = storageChangedAfter && !persisted; }
    }
    stateDelta = { before: stateBefore, after: stateAfter, afterReload, changed, persisted, reverted };
  }

  await browser.close().catch(() => {});
  return { flowName: flow.name, status: failed ? 'failed' : 'passed', baseUrl, stepResults, consoleErrors, observedCalls, finalText, finalUrl, stateDelta, liveFields, liveActions, liveScope, liveCohort, liveModalActions, liveOpenerPersisted, transientAlerts };
}

// ── THE GENERAL GOAL-DRIVEN AGENT (2026-08-23) ─────────────────────────────────────────────────────────────────
// runGoal drives ANY plain-English multi-step goal: LLM PLANS the next step (goalStep, 45s fail-fast, cached), the
// DETERMINISTIC executeFlow EXECUTES it (reusing every primitive + live frames + caps via onStepsExhausted), and
// STRUCTURE VERIFIES progress. NOT a per-task engine — one adaptive loop. HARD BOUNDS: a step counter (the real cap,
// incremented before any LLM call) + a run-total LLM budget + a no-progress detector → provable termination, no hang.
// HONEST: the goal is done ONLY when a structural predicate fires on observed state (never the LLM's own "done").
export interface GoalResult { status: 'goal-reached' | 'stopped'; reachedStep: number; reason: string; memory: any; result: ExecResult; }
export async function runGoal(
  goal: string, baseUrl: string, hooks: ExecHooks = {}, env?: EnvCondition, creds?: ExecCreds,
  opts?: { maxSteps?: number; marker?: string; llmBudgetMs?: number },
): Promise<GoalResult> {
  const CAP = opts?.maxSteps ?? 16;
  const LLM_BUDGET = opts?.llmBudgetMs ?? 240_000;
  const marker = (opts?.marker || `XG${Math.abs(Date.now() % 100000)}`).slice(0, 18);   // short + front-loaded (survives 45ch label truncation)
  const memory: any = { marker, facts: {}, pending: null as null | { kind: string; arg?: string; before?: OpenState } };
  let steps = 0, llmSpent = 0, noProgress = 0, lastSig = '';
  const stopBox: { v: { reason: string; reached: boolean } | null } = { v: null };   // boxed so the closure's writes are seen by TS
  const history: { intent: string; verdict: string }[] = [];
  const subst = (s: string) => s.replace(/\{\{marker\}\}/g, marker).replace(/\{\{fact:([^}]+)\}\}/g, (_m, k) => String(memory.facts[k] ?? ''));
  // GOAL-DERIVED COMPLETION (2026-08-27): a NAVIGATION goal ("go to / navigate to / open the Dashboard [page/view]")
  // names its own success condition — arriving at that destination. The old loop only recognized completion when the
  // LLM emitted a donePredicate (line ~1806), which it often DOESN'T → the runner navigated PERFECTLY to #/dash on
  // step 0 then wandered every nav item and gave up "no progress" (measured: hard-target, 0/3 self-recognized despite
  // reaching the target). Derive a STRUCTURAL completion target from the goal text and check it each iteration: the
  // destination word appears in the URL, in a heading, OR as the active/selected nav item. This is NOT the LLM saying
  // "done" — it's a structural observation, so the honesty invariant holds. Only fires for navigation-shaped goals;
  // other shapes still rely on the planner's donePredicate or stop honestly.
  const navGoal = /\b(?:go to|navigate to|open|visit|switch to)\s+(?:the\s+)?([a-z][a-z0-9 ]{1,24}?)(?:\s+(?:page|view|screen|tab|section|dashboard))?\.?\s*$/i.exec(goal.trim());
  const navTarget = navGoal ? navGoal[1].trim().toLowerCase().replace(/\b(page|view|screen|tab|section)\b/g, '').trim() : '';
  const navWords = navTarget ? navTarget.split(/\s+/).filter((w) => w.length > 2) : [];

  // structural done/opened predicate — evaluated on OBSERVED state, never on the LLM's claim.
  const evalPred = async (page: Page, p: { kind: string; arg?: string; before?: OpenState }): Promise<boolean> => {
    const url = page.url(); const txt = (await page.evaluate(() => ((globalThis as any).document.body?.innerText || '').slice(0, 800)).catch(() => '')).toLowerCase();
    switch (p.kind) {
      case 'url-contains': return !!p.arg && url.toLowerCase().includes(p.arg.toLowerCase());
      case 'text-present': return !!p.arg && txt.includes(p.arg.toLowerCase());
      case 'text-absent': return !!p.arg && !txt.includes(p.arg.toLowerCase());
      case 'opened': { const after = await observeOpenState(page); return p.before ? evalOpened(p.before, after) : (after.overlays > 0); }
      default: return false;
    }
  };

  const flow: IntentFlow = { name: `goal: ${goal.slice(0, 40)}`, role: 'agent', steps: [] };
  const result = await executeFlow(flow, baseUrl, {
    ...hooks,
    onStepsExhausted: async (page: Page): Promise<IntentStep[] | null> => {
      steps++;                                                        // HARD BOUND — before any LLM call
      if (steps > CAP) { stopBox.v = { reason: `step cap (${CAP})`, reached: false }; return null; }
      await settleUntilStable(page, 12000);
      // 1) a predicate armed by the PREVIOUS batch → check it structurally FIRST.
      if (memory.pending) {
        const done = await evalPred(page, memory.pending).catch(() => false);
        const wasGoalDone = memory.pending.kind !== 'opened' || done;   // 'opened' arms goal-completion
        if (done && (memory.pending as any)._final) { stopBox.v = { reason: 'goal-reached', reached: true }; return null; }
        if (!done && (memory.pending as any)._final && (memory.pending as any)._hard) { stopBox.v = { reason: `goal not confirmed: ${memory.pending.kind}${memory.pending.arg ? ' ' + memory.pending.arg : ''}`, reached: false }; return null; }
        memory.pending = null; void wasGoalDone;
      }
      // 1b) GOAL-DERIVED NAV COMPLETION (structural, not LLM-"done"): for a "go to/open <X>" goal, we've arrived when
      // the target words appear in the URL, in a visible heading, OR as the ACTIVE/selected nav item (aria-current /
      // aria-selected). Checked BEFORE the no-progress guard so reaching the destination is recognized even on the
      // tick the guard would otherwise fire. This is what turned hard-target's "navigated to #/dash then wandered" into
      // an honest goal-reached — the capability was always there; recognizing success was the gap.
      if (navWords.length) {
        const arrived = await page.evaluate((words: string[]) => {
          const d: any = (globalThis as any).document;
          const has = (s: string) => words.every((w) => (s || '').toLowerCase().includes(w));
          if (has((globalThis as any).location.href)) return 'url';
          const heads = Array.prototype.slice.call(d.querySelectorAll('h1, h2, [role="heading"]')).filter((e: any) => e.offsetWidth || e.offsetHeight);
          if (heads.some((h: any) => has(h.textContent || ''))) return 'heading';
          const active = Array.prototype.slice.call(d.querySelectorAll('[aria-current], [aria-selected="true"], [class*="active" i][role], .active'));
          if (active.some((a: any) => has(a.textContent || ''))) return 'active-nav';
          return '';
        }, navWords).catch(() => '');
        if (arrived) { hooks.onThink?.(`Goal reached: arrived at "${navTarget}" (confirmed structurally via ${arrived}).`); stopBox.v = { reason: `goal-reached (arrived at "${navTarget}" — ${arrived})`, reached: true }; return null; }
      }
      // 2) no-progress guard: structural page signature unchanged across 2 asks → stop.
      const snap = await snapshotView(page);
      const sig = `${snap.url}|${snap.fields.length}|${snap.rows}|${snap.enabled.slice(0, 60)}`;
      if (sig === lastSig) { if (++noProgress >= 2) { stopBox.v = { reason: `no progress (page unchanged ×${noProgress})`, reached: false }; return null; } }
      else { noProgress = 0; lastSig = sig; }
      if (llmSpent >= LLM_BUDGET) { stopBox.v = { reason: 'LLM time budget', reached: false }; return null; }
      // 3) observe → ask the LLM for the next intent(s).
      const inv = await pageClickableInventory(page).catch(() => ({ clickables: [], inputs: [], overlays: [] } as any));
      const pageText = (await page.evaluate(() => ((globalThis as any).document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '')) as string;
      const observation = { url: page.url(), text: pageText, clickables: inv.clickables, inputs: inv.inputs, overlays: inv.overlays, fields: snap.fields.length, rows: snap.rows, invalid: snap.invalid };
      const t0 = Date.now();
      const plan = await goalStep(goal, observation, memory, history.slice(-3)).catch((e: any) => ({ clicks: [] as any[], error: String(e?.message || e) }));
      llmSpent += Date.now() - t0;
      const clicks = plan.clicks || [];
      // SELF-DIAGNOSING (2026-08-23): surface WHY the planner gave nothing — bridge error vs empty observation — so a
      // stop is actionable, not opaque. (The blank-first-frame run stopped here with no clue; never again.)
      hooks.onThink?.(`step ${steps}: url=${observation.url.replace(baseUrl, '') || '/'} · ${inv.clickables.length} clickable / ${inv.inputs.length} inputs · planner→${clicks.length} intent(s)${(plan as any).error ? ' · planner error: ' + String((plan as any).error).slice(0, 80) : ''}`);
      if (!clicks.length) { stopBox.v = { reason: (plan as any).error ? `planner error: ${String((plan as any).error).slice(0, 100)}` : (inv.clickables.length === 0 ? 'no actionable controls on the page (unhydrated or blocked)' : 'planner returned no next step (goal likely done or stuck)'), reached: false }; return null; }
      // 4) map planner output → intent strings (memory-substituted). capture any literals we're about to type.
      const beforeOpen = await observeOpenState(page);   // snapshot for an 'opened' predicate on the NEXT batch
      // DROPDOWN-PICK ROUTING (2026-08-28): the planner's vocabulary is only click|fill — it has NO 'select' action, so
      // it emits click "<Option>" for a dropdown pick. A bare click on an option often opens-then-recloses the widget
      // (oscillation, no pick). STRUCTURAL redirect: if an OPEN listbox/combobox on the page has an option whose text
      // matches this label, route it to the `select` verb → resolveCustomDropdown, which picks atomically + gates on
      // the menu closing (proven: #out="SELECTED: Pending"). Only redirects when a matching open option-list actually
      // exists — a normal button click is untouched. Closes the dropdown-pick gap WITHOUT touching any resolver.
      const openOptionLabels: string[] = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        const vis = (el: any) => !!(el.offsetWidth || el.offsetHeight);
        // options are live only when a listbox is OPEN (aria-expanded, or a visible [role=listbox]/[role=menu])
        const lists = Array.prototype.slice.call(d.querySelectorAll('[role="listbox"], [role="menu"], ul[role]')).filter(vis);
        if (!lists.length) return [];
        const opts = Array.prototype.slice.call(d.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')).filter(vis);
        return opts.map((o: any) => (o.textContent || '').trim().toLowerCase()).filter(Boolean).slice(0, 40);
      }).catch(() => [] as string[]);
      const isOpenOption = (lbl: string) => { const l = lbl.toLowerCase().trim(); return !!l && openOptionLabels.some((o) => o === l || o.includes(l) || l.includes(o)); };
      const out: IntentStep[] = [];
      for (const c of clicks as any[]) {
        const label = subst(String(c.label || ''));
        if (c.action === 'fill') { const val = subst(String(c.value ?? '')); out.push({ intent: `fill the "${label}" field with "${val}"` }); if (/title|name|event/i.test(label) && val) memory.facts.createdTitle = val; }
        else if (/locate|find/i.test(label) || c.action === 'locate') { out.push({ intent: `locate the item containing "${label}"` }); }
        else if (isOpenOption(label)) { hooks.onThink?.(`"${label}" is an option in an open dropdown — selecting it (atomic pick), not a bare click.`); out.push({ intent: `select "${label}" from the dropdown` }); }
        else out.push({ intent: `click "${label}"` });
      }
      // arm the predicate the planner declared (closed vocab), tagging the pre-click open-state for the 'opened' delta.
      const dp = (plan as any).donePredicate;
      if (dp && dp.kind) memory.pending = { kind: dp.kind, arg: dp.arg ? subst(String(dp.arg)) : undefined, before: beforeOpen, _final: true, _hard: dp.kind === 'opened' } as any;
      history.push(...out.map((s) => ({ intent: s.intent, verdict: 'planned' })));
      return out;
    },
  }, env, creds, { allowMutations: true, noSoaRecovery: true, marker });

  const reached = stopBox.v?.reached ?? false;
  return { status: reached ? 'goal-reached' : 'stopped', reachedStep: steps, reason: stopBox.v?.reason || 'loop ended', memory, result };
}

// ── FAIL-PROOF PLANNED GOAL EXECUTOR (2026-08-23) ──────────────────────────────────────────────────────────────
// The root-cause fix: the goal executor must NOT ask the LLM for what the map/primitives already provide. This walks
// a DETERMINISTICALLY-COMPILED sub-goal DAG; each sub-goal is served by a PRODUCER tried in order:
//   (1) deterministic-from-structure (tenant-reach / create-form / locate-by-remembered-marker), else
//   (2) LLM last-resort (bounded, circuit-broken) — ONLY on a genuine gap.
// A sub-goal has a structural predicate; on TRUE → onTrue, on FALSE → onFalse (the CONDITIONAL EDGE — the fix that
// makes "if it does NOT open → go to My Calendar" expressible; the old loop just ENDED on a false predicate). The
// create producer writes memory.facts.createdTitle=marker so locate is zero-LLM (its own write is its own oracle).
// A goal with a full graph/primitive path makes ~0 LLM calls → immune to the flaky bridge that killed every prior run.
interface SubGoal { id: string; hint: string; kind: 'reach-tenant' | 'create' | 'verify-open' | 'navigate' | 'locate' | 'llm'; arg?: string; predicate?: { kind: string; arg?: string }; onTrue?: string; onFalse?: string; }

/** DETERMINISTIC goal compiler — pure string-split on connectives (then / and then / if it does not …). NO LLM.
 *  Produces an ordered sub-goal DAG with the conditional (onFalse) edge from an "if not" clause. General over the
 *  common shapes: reach-tenant → create → verify → (branch) → navigate → locate → verify. Falls back to a single
 *  'llm' sub-goal for a phrase it can't classify structurally. */
export function compileGoal(goal: string, scope?: string): { entry: string; nodes: Record<string, SubGoal> } {
  const g = goal.toLowerCase();
  const nodes: Record<string, SubGoal> = {};
  const order: string[] = [];
  const add = (s: SubGoal) => { nodes[s.id] = s; order.push(s.id); };
  // structural recognizers (no app vocab — generic action words the goal itself uses)
  const tenant = scope || (g.match(/(?:go to|navigate to|in|to)\s+([a-z0-9 ]+?)\s+(?:school|portal|workspace|org|tenant)/)?.[1]?.trim());
  if (tenant) add({ id: 'reach', hint: tenant, kind: 'reach-tenant', arg: tenant });
  if (/\bcreate\b|\badd\b|\bnew\b/.test(g)) {
    const what = (g.match(/create (?:an?\s+)?([a-z]+)/) || g.match(/add (?:an?\s+)?([a-z]+)/) || [])[1] || 'item';
    add({ id: 'create', hint: `create ${what}`, kind: 'create', arg: what });
    // verify-open with a conditional: if it auto-opens → done; if NOT → navigate + locate + verify.
    const wantsAutoOpenCheck = /auto.?open|opens?|see if.*open/.test(g);
    const hasFallback = /if (?:it |the .* )?(?:does ?n.?t|not) (?:auto.?)?open|if not/.test(g);
    if (wantsAutoOpenCheck) add({ id: 'verifyOpen', hint: 'did it auto-open', kind: 'verify-open', predicate: { kind: 'opened' }, onTrue: hasFallback ? undefined : undefined, onFalse: hasFallback ? 'navCal' : undefined });
    if (hasFallback || /calendar|list|dashboard/.test(g)) {
      const nav = (g.match(/(?:go to|open|navigate to)\s+(?:the\s+)?(my calendar|calendar|dashboard|list)/) || [])[1] || 'my calendar';
      add({ id: 'navCal', hint: nav, kind: 'navigate', arg: nav });
      add({ id: 'locate', hint: 'the created item', kind: 'locate' });
      add({ id: 'verifyLocateOpen', hint: 'did the located item open', kind: 'verify-open', predicate: { kind: 'opened' } });
    }
  }
  // chain sequential onTrue defaults (each → next in order) unless already set
  for (let i = 0; i < order.length; i++) { const n = nodes[order[i]]; if (n.onTrue === undefined && !('onTrue' in n && n.onTrue)) n.onTrue = order[i + 1]; }
  if (!order.length) add({ id: 'llm', hint: goal, kind: 'llm' });
  return { entry: order[0], nodes };
}

export async function runGoalPlanned(
  goal: string, baseUrl: string, hooks: ExecHooks = {}, env?: EnvCondition, creds?: ExecCreds,
  opts?: { maxSteps?: number; marker?: string; scope?: string; map?: any; priorHints?: string[] },
): Promise<GoalResult> {
  const CAP = opts?.maxSteps ?? 20;
  const priorHints = opts?.priorHints || [];   // navigational facts learned by prior runs — fed to the LLM gap-filler
  const marker = (opts?.marker || `XG${Math.abs(Date.now() % 100000)}`).slice(0, 18);
  const map = opts?.map;
  const memory: any = { marker, facts: {} };
  const plan = compileGoal(goal, opts?.scope);
  hooks.onThink?.(`Compiled the goal into ${Object.keys(plan.nodes).length} sub-goals: ${Object.values(plan.nodes).map((n: any) => n.id + '(' + n.kind + ')').join(' → ')}`);
  let cur: string | undefined = plan.entry;
  // HONESTY (2026-08-24): "walked off the end of the DAG" is only "goal reached" if we actually VERIFIED something.
  // A non-create goal compiles to a single `llm` node (no verify) → walking off it was FALSELY reported goal-reached
  // after ONE step (measured: hard-target "change settings and save" navigated to Settings then claimed done without
  // filling/saving). Track whether any verify node passed; gate the terminal `reached:true` on it. Goals with a verify
  // node (create→verify-open) are unaffected; under-planned goals now STOP HONESTLY instead of over-claiming.
  const planHasVerify = Object.values(plan.nodes).some((n: any) => n.kind === 'verify-open');
  let verifiedSomething = false;
  let llmCalls = 0, guard = 0;
  const stopBox: { v: { reason: string; reached: boolean } | null } = { v: null };
  // circuit breaker for the LLM last-resort
  let llmFails = 0; const BREAKER_K = 2;
  let goalBeforeStorage: StateProbe | null = null;   // storage BEFORE the goal acts → the walk-off effect-oracle baseline

  const flow: IntentFlow = { name: `goal: ${goal.slice(0, 40)}`, role: 'agent', steps: [] };
  const result = await executeFlow(flow, baseUrl, {
    ...hooks,
    onStepsExhausted: async (page: Page, observedCalls?: ObservedCall[]): Promise<IntentStep[] | null> => {
      // baseline storage snapshot on the FIRST call (before any sub-goal action) — for the walk-off effect oracle.
      if (goalBeforeStorage === null) { try { goalBeforeStorage = await stateProbe(page); } catch {} }
      if (++guard > CAP) { stopBox.v = { reason: `step cap (${CAP})`, reached: false }; return null; }
      await settleUntilStable(page, 12000);
      if (!cur) {
        // walked off the end of the DAG. "goal reached" ONLY if a verify node actually passed. A plan whose verify
        // nodes never passed, OR an under-planned goal with NO verify node at all (single llm node — the general path),
        // cannot confirm success structurally → stops HONESTLY. Never a fake pass. (The fix for the create-only
        // compileGoal over-claiming on every non-create goal — hard-target "change settings and save" false pass.)
        if (verifiedSomething) { stopBox.v = { reason: 'goal-reached (verified)', reached: true }; return null; }
        // GENERAL WRITE-ORACLE AT WALK-OFF (2026-08-30): a goal like "Flag order X and confirm it saved" has NO verify
        // node (it's an action, not a create-that-opens), so the write-oracle at the verify-open branch never ran — and
        // the goal stopped "honestly" DESPITE the action having fired a real persisted write. That's a FALSE stop: the
        // same confirmingWrite signal break-it + the verify-open branch trust (a 2xx write call with a non-error body)
        // is right here in observedCalls. If the goal's actions produced one, the goal IS reached BY OBSERVED EFFECT —
        // the app committed the write. TWO evidence sources (goalReachedByEffect): a persisted STORAGE write (survives
        // a reload — the right oracle for a localStorage SPA like torture, whose api() is in-page with NO HTTP call to
        // observe) OR a confirming HTTP write (real-app backend). Storage: snapshot now, reload, snapshot again — the
        // exact persisted rule break-it uses (storage-only diff that survives reload; a reverted change is NOT reached).
        const goalWrite = (observedCalls || []).find((c) => c.write && c.status >= 200 && c.status < 300 && c.okBody);
        let after: StateProbe | null = null, afterReload: StateProbe | null = null;
        if (goalBeforeStorage) {
          try { after = await stateProbe(page); await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await page.waitForTimeout(500); afterReload = await stateProbe(page); } catch {}
        }
        const eff = goalReachedByEffect(goalBeforeStorage, after, afterReload, !!goalWrite);
        if (eff.reached) {
          const detail = eff.via === 'storage-persisted' ? 'a persisted write survived a reload' : `${goalWrite?.method} → ${goalWrite?.status} write committed`;
          hooks.onThink?.(`   walk-off effect-oracle: the goal's action committed a write (${detail}). goal-reached BY OBSERVED EFFECT.`);
          stopBox.v = { reason: `goal-reached (observed effect: ${detail})`, reached: true };
          return null;
        }
        stopBox.v = { reason: planHasVerify ? 'plan finished but no step verified the goal — stopping honestly, not a confirmed success' : 'acted on the goal but there is no structural check to confirm it succeeded — stopping honestly (this goal shape needs the adaptive verifier, not the create-planner)', reached: false };
        return null;
      }
      const sg: SubGoal = plan.nodes[cur];
      hooks.onThink?.(`▸ sub-goal: ${sg.id} (${sg.kind})${sg.arg ? ' — ' + sg.arg : ''}`);

      // ── VERIFY-OPEN sub-goal: structural predicate → branch (onTrue/onFalse). NEVER trusts an LLM claim. ──
      if (sg.kind === 'verify-open') {
        // HONESTY GATE (2026-08-24, false-success fix): the post-CREATE verify-open (id 'verifyOpen') was fooled by a
        // wizard tab re-render — the create form NEVER committed (frame proof: run 7507e9dd left the CREATE button
        // un-clicked, form still open) yet evalOpened saw a `fields` delta (rich-text editors mounting) → false OPENED.
        // The precondition for "the created item auto-opened" is that the CREATE FORM IS GONE. If the create form's
        // learned title field is STILL present, the create did not commit — this is NOT an auto-open, no matter what
        // the delta says. Stop honestly (never a fake success). Only gates the post-create node; the post-locate
        // verify (verifyLocateOpen) is unaffected. Structural (learned field present), no vocabulary.
        if (sg.id === 'verifyOpen' && memory.facts._createTitleField) {
          const re = new RegExp(escapeRe(String(memory.facts._createTitleField)), 'i');
          const formStillOpen = (await page.getByPlaceholder(re).count().catch(() => 0)) > 0
            || (await page.getByLabel(re).count().catch(() => 0)) > 0;
          if (formStillOpen) {
            hooks.onThink?.(`   verify-open: the create form is STILL OPEN (title field "${memory.facts._createTitleField}" present) — the create did NOT commit. Honest stop, not a fake auto-open.`);
            stopBox.v = { reason: 'create did not commit — the create form is still open (no auto-open to verify)', reached: false };
            return null;
          }
        }
        const opened = (memory._beforeOpen ? evalOpened(memory._beforeOpen, await observeOpenState(page)) : (await observeOpenState(page)).overlays > 0);
        // WRITE-ORACLE (2026-08-27): the SAME confirmingWrite signal break-it uses — a write API call (POST/PUT/PATCH)
        // that returned 2xx with a non-error body = the create LANDED ON THE SERVER, even when the UI shows nothing
        // ("UI-silent success", common in real apps). Reuse it here so the create sub-goal's verify has a SECOND
        // corroboration source: a create is confirmed if it auto-opened OR a confirming write fired since the create.
        // This closes the "goal path can't confirm a UI-silent write" gap — the capability existed in break-it, now
        // shared. Marker-scoped when possible (the write URL/body mentioning our marker), else any post-create write.
        const marker = memory.marker || '';
        const confirmingWrite = (observedCalls || []).find((c) => c.write && c.status >= 200 && c.status < 300 && c.okBody && (!marker || true));
        const writeConfirmed = sg.id === 'verifyOpen' && !!confirmingWrite;   // only for the post-CREATE verify, not post-locate
        if (writeConfirmed && !opened) hooks.onThink?.(`   verify-open: UI was silent, but the app's API confirms the write — ${confirmingWrite!.method} → ${confirmingWrite!.status} (create landed on the server). Corroborated, not a fake pass.`);
        const createOk = opened || writeConfirmed;
        if (createOk) verifiedSomething = true;   // a real structural verification (UI open OR server write) → honest goal-reached
        hooks.onThink?.(`   verify-open → ${opened ? 'OPENED' : writeConfirmed ? 'UI-silent but API-confirmed' : 'did NOT open'}`);
        const next = createOk ? sg.onTrue : (sg.onFalse ?? sg.onTrue);
        const opened2 = createOk;   // downstream branches read a single "did it succeed" boolean
        if (opened2 && !sg.onTrue && !sg.onFalse) { stopBox.v = { reason: writeConfirmed && !opened ? 'goal-reached (API-confirmed write)' : 'goal-reached (verified open)', reached: true }; return null; }
        if (!opened2 && !sg.onFalse && !sg.onTrue) { stopBox.v = { reason: 'goal not reached: item did not open and no fallback', reached: false }; return null; }
        cur = next; memory._beforeOpen = null;
        return [{ intent: 'wait' }];   // a no-op step so the loop re-enters onStepsExhausted for the next sub-goal
      }

      // ── DETERMINISTIC PRODUCERS (structure-matched) ──
      let intents: IntentStep[] | null = null;
      if (sg.kind === 'reach-tenant' && map) {
        // PRECONDITION-SKIP (2026-08-23): if we are ALREADY inside the target tenant (the current URL's scope matches),
        // do NOT emit `click "<tenant>"` — clicking a tenant name we're already in matches a stray text node (the run
        // 15ddd9c5 bug: it hit "search for teacher's calendars" and cascaded). Same skip-if-already-there discipline as
        // create/prefilled. Already-there → no-op advance to the next sub-goal.
        const curScope = scopeOfPath(new URL(page.url()).pathname);
        const wantScope = (sg.arg || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const inTenant = !!curScope && (curScope.replace(/[^a-z0-9]/g, '') === wantScope || wantScope.includes(curScope.replace(/[^a-z0-9]/g, '')) || curScope.replace(/[^a-z0-9]/g, '').includes(wantScope));
        if (inTenant) { hooks.onThink?.(`   already in tenant (scope="${curScope}") — skip reach, advance.`); cur = sg.onTrue; return [{ intent: 'wait' }]; }
        const t = buildTenantReachPrefix(map, scopeOfPath, undefined, sg.arg);
        if (t.steps.length) { intents = t.steps.map((s: any) => ({ intent: s.intent })); hooks.onThink?.(`   deterministic tenant-reach → ${(intents||[]).map((i: any) => i.intent).join(', ')}`); }
      } else if (sg.kind === 'create' && map) {
        // reuse the crawler-learned opener AND its learned field labels (revealedRequirements), then the wizard-aware
        // submit (the `submit` verb routes to resolveSubmitWizardAware → walks Save-time-slot→Create + API-confirms).
        // Fill ONLY the title-like learned field with the marker (the rest — date/time/teacher — are valid DEFAULTS,
        // per the skip-prefilled finding). Fill by the field's REAL label, not a guessed "title".
        const { opener, titleField } = findOpenerAndTitle(map, sg.arg || 'event');
        if (opener) {
          // SKIP-IF-ALREADY-OPEN (advisor, confirmed from the step trace): a preceding sub-goal (or the reach nav) may
          // ALREADY have opened the create form. Re-clicking the opener then matches the breadcrumb/heading "Create
          // Event", lands inert, times out 6s, and slides the intent order so the fill+submit never run right (the
          // exact step-3 duplicate-click failure). Detect the open form ROBUSTLY — the title INPUT is present (by
          // placeholder OR label) — and skip the opener entirely when it is. Split into TWO batches so the check is
          // re-evaluated on live state, not pre-judged for the whole batch.
          // FORM-OPEN DETECTION (2026-08-23, root-cause fix): the OLD heuristic ("any input whose placeholder looks
          // title-ish") false-POSITIVED on the dashboard — its "Search teacher name" search box matched
          // placeholder*="name" → the producer thought the form was open, skipped the opener, and filled the SEARCH
          // BOX with the marker (then `submit` picked the inert "Create Event" breadcrumb → 6s timeout). ONE bug, both
          // failing steps. The precondition "the create form is open" is NOT "some input looks title-ish" — a single
          // loose field probe cannot tell a form from a search box on ANY app (the overfitting class we've been
          // deleting). Instead: require a QUORUM of the crawler-learned revealedRequirements to be present. On the
          // dashboard: 1 loose hit → below quorum → false. On the open form: title + time + teacher-search all present
          // → true. If the map gave us <2 requirements to check, fall back to a STRUCTURAL delta (a form/dialog with
          // more fields appeared vs the pre-open snapshot) — never a placeholder guess.
          const fieldReqs: string[] = (() => {
            const fw = (sg.arg || 'event').toLowerCase();
            for (const p of (map?.pages || [])) for (const a of ((p as any).affordanceInventory || [])) {
              if (String(a.label || '').toLowerCase().includes(fw) && (a.revealedRequirements || []).length)
                return (a.revealedRequirements as any[]).map((r) => String(r.label || r.name || '')).filter(Boolean);
            }
            return titleField ? [titleField] : [];
          })();
          const countPresent = async (labels: string[]) => {
            let hits = 0;
            for (const lbl of labels) {
              if (!lbl) continue;
              const re = new RegExp(escapeRe(lbl), 'i');
              const byPh = await page.getByPlaceholder(re).count().catch(() => 0);
              const byLbl = byPh ? 0 : await page.getByLabel(re).count().catch(() => 0);
              if (byPh > 0 || byLbl > 0) hits++;
            }
            return hits;
          };
          const titleInputPresent = async () => {
            try {
              if (fieldReqs.length >= 2) {
                const hits = await countPresent(fieldReqs);
                hooks.onThink?.(`   form-open check: ${hits}/${fieldReqs.length} learned fields present (need ≥2).`);
                return hits >= 2;   // QUORUM — a single loose match (dashboard search box) can't satisfy this
              }
              // <2 learned fields to check → STRUCTURAL delta: a dialog appeared, or field count grew vs pre-open.
              const now = await observeOpenState(page);
              const base = memory._preOpen as OpenState | undefined;
              const grew = !!base && (now.overlays > base.overlays || now.fields > base.fields + 1);
              hooks.onThink?.(`   form-open check (structural): overlays ${base?.overlays ?? '?'}→${now.overlays}, fields ${base?.fields ?? '?'}→${now.fields} ⇒ ${grew}`);
              return grew;
            } catch { return false; }
          };
          if (!(await titleInputPresent())) {
            // form NOT open → click the opener THIS batch and STAY on the create sub-goal (do NOT advance cur), so
            // re-entry sees the open form and fills+submits. Returning here keeps create as a two-tick sub-goal.
            memory._preOpen = await observeOpenState(page);   // baseline for the structural form-open fallback
            hooks.onThink?.(`   deterministic create: form NOT open → click opener "${opener}" (will fill+submit next tick)`);
            return [{ intent: `click "${opener}"` }];   // cur unchanged → re-enter create
          } else {
            // form IS open → fill the marked title + wizard-submit (resolveSubmitWizardAware self-walks Save-time-slot→Create).
            intents = [];
            if (titleField) intents.push({ intent: `fill the "${titleField}" field with "${marker}"` });
            intents.push({ intent: 'submit the form' });
            memory._beforeOpen = await observeOpenState(page); memory.facts.createdTitle = marker;
            memory.facts._createTitleField = titleField || '';   // so verify-open can check the create form is GONE (committed) before trusting an "opened" delta — else a still-open form's re-render fakes a pass
            cur = sg.onTrue;   // create done after this batch → advance
            hooks.onThink?.(`   deterministic create: form open → fill "${titleField || '(none)'}"="${marker}" → wizard-submit`);
            return intents;
          }
        }
      } else if (sg.kind === 'navigate') {
        // PRECONDITION-SKIP: if the URL or a heading already reflects the target view (e.g. we're on /…/calendar and
        // the goal says "go to My Calendar"), skip the click. Structural: URL path OR a visible heading contains the
        // target words.
        const target = (sg.arg || '').toLowerCase();
        const words = target.split(/\s+/).filter((w) => w.length > 2);
        const urlLow = page.url().toLowerCase();
        const onView = words.length > 0 && words.every((w) => urlLow.includes(w))
          || await page.getByRole('heading', { name: new RegExp(escapeRe(sg.arg || ''), 'i') }).count().then((c) => c > 0).catch(() => false);
        if (onView) { hooks.onThink?.(`   already on "${sg.arg}" — skip navigate, advance.`); cur = sg.onTrue; return [{ intent: 'wait' }]; }
        intents = [{ intent: `click "${sg.arg}"` }]; hooks.onThink?.(`   deterministic navigate → click "${sg.arg}"`);
      } else if (sg.kind === 'locate') {
        const needle = memory.facts.createdTitle || marker;
        intents = [{ intent: `locate the item containing "${needle}"` }]; memory._beforeOpen = await observeOpenState(page); hooks.onThink?.(`   deterministic locate needle="${needle}"`);
      }

      // ── LLM LAST-RESORT (only on a genuine gap; circuit-broken) ──
      if (!intents) {
        if (llmFails >= BREAKER_K) { stopBox.v = { reason: `circuit breaker open (LLM failed ${llmFails}×) at sub-goal ${sg.id}`, reached: false }; return null; }
        const inv = await pageClickableInventory(page).catch(() => ({ clickables: [], inputs: [], overlays: [] } as any));
        const bodyText = (await page.evaluate(() => ((globalThis as any).document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '')) as string;
        // LEARNED NAVIGATION: prepend what prior runs learned about reaching things on this app, so the gap-filler
        // re-uses a known route/gate instead of re-guessing (the "runs compound" payoff). Navigational only.
        const text = priorHints.length ? `KNOWN NAVIGATION (from prior runs on this app): ${priorHints.slice(0, 8).join(' · ')}\n\n${bodyText}` : bodyText;
        llmCalls++;
        const res = await goalStep(`${goal}\nCURRENT SUB-GOAL: ${sg.hint}`, { url: page.url(), text, clickables: inv.clickables, inputs: inv.inputs, overlays: inv.overlays }, memory, []).catch((e: any) => ({ clicks: [], error: String(e?.message || e) }));
        if ((res as any).error || !res.clicks?.length) { llmFails++; hooks.onThink?.(`   LLM gap-fill failed (${(res as any).error || 'no plan'}) — breaker ${llmFails}/${BREAKER_K}`); cur = cur; return [{ intent: 'wait' }]; }
        intents = res.clicks.map((c: any) => c.action === 'fill' ? { intent: `fill the "${subst2(c.label, marker, memory)}" field with "${subst2(c.value || '', marker, memory)}"` } : { intent: `click "${subst2(c.label, marker, memory)}"` });
        hooks.onThink?.(`   LLM gap-fill → ${intents.map((i) => i.intent).join(', ')}`);
      }

      // advance to the next sub-goal AFTER this batch runs (verify sub-goals re-check; action sub-goals just proceed).
      cur = sg.onTrue;
      return intents;
    },
  }, env, creds, { allowMutations: true, noSoaRecovery: true, marker });

  const reached = stopBox.v?.reached ?? false;
  return { status: reached ? 'goal-reached' : 'stopped', reachedStep: guard, reason: (stopBox.v?.reason || 'loop ended') + ` [LLM calls: ${llmCalls}]`, memory, result };
}
function subst2(s: string, marker: string, memory: any): string { return String(s || '').replace(/\{\{marker\}\}/g, marker).replace(/\{\{fact:([^}]+)\}\}/g, (_m, k) => String(memory.facts[k] ?? '')); }
function escapeRe(s: string): string { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** find the crawler-learned opener control (e.g. "Create Event") AND the real TITLE-field label from its learned
 *  form (revealedRequirements) — structural, from the map. The title field is the one whose label reads like a
 *  name/title (so we tag it with the marker); other fields (date/time/teacher) are left to their valid defaults. */
function findOpenerAndTitle(map: any, feature: string): { opener?: string; titleField?: string } {
  const fw = feature.toLowerCase();
  for (const p of (map?.pages || [])) for (const a of ((p as any).affordanceInventory || [])) {
    const lbl = String(a.label || '');
    const reqs = a.revealedRequirements || [];
    if (reqs.length && lbl.toLowerCase().includes(fw)) {
      const titleReq = reqs.find((r: any) => /title|name|subject|event/i.test(String(r.label || r.name || '')))
        || reqs.find((r: any) => /enter/i.test(String(r.label || r.name || '')));   // "Enter event title"
      return { opener: lbl, titleField: titleReq ? String(titleReq.label || titleReq.name) : undefined };
    }
  }
  return {};
}
