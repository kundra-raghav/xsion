/**
 * authSignals.ts — L0 of the crawler world-model: the shared AUTH primitive.
 *
 * ONE signal extractor, TWO thin deciders (per the design: share extraction, NOT the decision rule):
 *   • classifyLoginGate()  — L0-b: is THIS static page a login gate? (one-shot, SSO-vocabulary-aware)
 *   • settleLogin()        — L0-a: after submitting creds, POLL to a TERMINAL, tri-state verdict.
 *
 * WHY THIS EXISTS (measured, 2026-08-17):
 *  - dent: login SUCCEEDS (adminLogin→200, super_admin JWT) but the old tryLogin gave up after a FIXED 2500ms sleep
 *    → saw the password field still present → returned false → the crawl mapped 0 pages AND wiped the (correct) creds
 *    blaming the user. settleLogin polls for POSITIVE evidence of being in the app, and returns `indeterminate`
 *    (keep creds) vs `rejected` (clear creds) — never conflating "slow" with "wrong".
 *  - schooltalk: SSO-first (no password field until you pick a provider) → the old looksLikeLogin (password-only)
 *    returned false → the crawl mapped the LOGIN SCREEN as the app and reported `done`. classifyLoginGate scores the
 *    SSO vocabulary so a passwordless sign-in wall is still recognized as a gate.
 *
 * DESIGN GUARDRAILS (from review — do not regress):
 *  1. Success = POSITIVE evidence (an authed affordance, or url on a known non-login route), NOT merely "password
 *     field gone" — else the tick that lands in the form-unmount→dashboard-mount gap false-passes on a blank shell.
 *  2. Require the same positive verdict on TWO consecutive ticks (settle) before accepting.
 *  3. The auth-ERROR read is scoped to the form's vicinity AND only consulted while the password form is still
 *     present — else a dashboard label like "failed" + nav text "account" false-positives on the real app.
 */
import type { Page } from 'playwright';

/** Raw, decision-free signals read off the current DOM. Both deciders consume this; neither reads the DOM directly. */
export interface AuthSignals {
  url: string;
  /** did the in-page read SUCCEED? false = the evaluate threw (all other fields are then meaningless zeros, NOT a
   *  genuinely-empty page). Callers MUST distinguish "read failed" from "page has nothing" — an all-zeros result
   *  with ok=false must never be treated as evidence (of a login screen OR of a public app). */
  ok: boolean;
  hasPasswordField: boolean;
  /** visible controls whose label is login/SSO vocabulary ("Sign in", "Continue with Google", "Setup new password"…) */
  authVocabControls: string[];
  /** visible controls/links whose presence implies we're INSIDE the app (logout, account menu, primary nav to app routes) */
  authedAffordances: string[];
  /** an auth-failure phrase found NEAR the login form (scoped, not whole-body) — meaningful only pre-transition */
  errorNearForm: string | null;
}

/** Extract the raw auth signals from the page. Runs one page.evaluate; no decisions here. */
export async function authSignals(page: Page): Promise<AuthSignals> {
  let url = '';
  try { url = page.url(); } catch {}
  try {
    const sig = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const vis = (el: any) => !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
      const txt = (el: any) => ((el.innerText || el.textContent || el.value || '').trim()).slice(0, 60);

      // SHADOW-AWARE ONLY for the POSITIVE gate signals (password + auth-vocab) — so a login form inside a web
      // component is still detected as a gate. The NEGATIVE "authed affordance" signals stay LIGHT-DOM on purpose:
      // deep-querying them would let a persistent shadow app-shell button ("Settings"/"Profile", common in design-
      // system chrome) flip an SSO login WALL to "inside the app" — a NEW false-pass the reviewer caught. Positive
      // reads deep (find the gate), negative reads shallow (don't over-claim authed). Fallback if the shim is absent.
      const Q: any = (globalThis as any).__xsionQueryAllDeep;
      const qa = (sel: string) => Q ? Q(sel, doc) : Array.prototype.slice.call(doc.querySelectorAll(sel));

      const hasPasswordField = Array.prototype.some.call(qa('input[type="password"]'), (el: any) => vis(el));

      // controls that read as LOGIN / SSO vocabulary (a passwordless SSO wall still counts as a gate) — DEEP.
      const AUTH_VOCAB = /(sign[ -]?in|log[ -]?in|continue with|sign[ -]?up|setup (a )?new password|forgot password|back to login|single sign|sso|use (google|microsoft|apple|sso)|authenticate)/i;
      const authVocabControls: string[] = [];
      for (const el of qa('button, a[href], [role="button"], input[type="submit"]')) { if (!vis(el)) continue; const t = txt(el); if (t && AUTH_VOCAB.test(t)) authVocabControls.push(t); }

      // affordances implying we're INSIDE the app (negative gate signal) — LIGHT-DOM (see note above).
      const AUTHED_VOCAB = /(log[ -]?out|sign[ -]?out|my account|profile|dashboard|settings|notifications|logout)/i;
      const authedAffordances: string[] = [];
      const lightClickables = Array.prototype.slice.call(doc.querySelectorAll('button, a[href], [role="button"], input[type="submit"]'));
      for (const el of lightClickables) { if (!vis(el)) continue; const t = txt(el); if (t && AUTHED_VOCAB.test(t)) authedAffordances.push(t); }
      const navLinks = Array.prototype.slice.call(doc.querySelectorAll('nav a[href], [role="navigation"] a[href], aside a[href]')).filter(vis);
      if (navLinks.length >= 3) authedAffordances.push(`__nav:${navLinks.length}`);

      // auth ERROR — scoped to the form's vicinity, NOT the whole body. Find the password field's form/container.
      let errorNearForm: string | null = null;
      const pw = doc.querySelector('input[type="password"]');
      if (pw && vis(pw)) {
        const container = pw.closest('form') || pw.closest('section, div[class*="login" i], div[class*="auth" i], main') || doc.body;
        const near = (container.innerText || '').toLowerCase();
        const ERR = /(invalid|incorrect|wrong|failed to (log|sign)|unable to (log|sign)|not (found|recognized)|does ?n['’]?t match|bad credentials|authentication failed|invalid email or password|incorrect password|try again)/;
        const CTX = /(email|password|credential|login|sign ?in|account)/;
        if (ERR.test(near) && CTX.test(near)) {
          const m = near.match(ERR);
          errorNearForm = m ? m[0] : 'auth error';
        }
      }
      return { hasPasswordField, authVocabControls, authedAffordances, errorNearForm };
    });
    return { url, ok: true, ...sig };
  } catch (e) {
    // READ FAILED (e.g. the evaluate threw). Return ok:false so callers never mistake these zeros for a real
    // empty page — the ambiguity that hid the schooltalk regression root.
    return { url, ok: false, hasPasswordField: false, authVocabControls: [], authedAffordances: [], errorNearForm: null };
  }
}

// ── L0-b DECIDER: is this page a login gate? ─────────────────────────────────────────────────────────────────────
export interface GateVerdict { isLoginGate: boolean; why: string; score: number }

/**
 * Score a static page as a login gate. Password field is strong evidence; SSO vocabulary WITHOUT authed affordances
 * is ALSO a gate (schooltalk). Being inside the app (authed affordances present, no auth vocab) pushes score down.
 * routeRequiresAuth (Mode-1 routeManifest) is a corroborating boost when supplied.
 */
export function classifyLoginGate(s: AuthSignals, opts?: { routeRequiresAuth?: boolean }): GateVerdict {
  let score = 0;
  const reasons: string[] = [];
  if (s.hasPasswordField) { score += 3; reasons.push('password field'); }
  // SSO / login vocabulary present…
  if (s.authVocabControls.length) { score += Math.min(3, s.authVocabControls.length); reasons.push(`auth-vocab:${s.authVocabControls.length}`); }
  // …but if we ALSO see clear "inside the app" affordances, this is probably the app, not a gate.
  const insideApp = s.authedAffordances.filter((a) => !a.startsWith('__nav')).length > 0;
  if (insideApp && !s.hasPasswordField) { score -= 3; reasons.push('authed-affordances (likely inside app)'); }
  if (opts?.routeRequiresAuth) { score += 1; reasons.push('routeManifest requiresAuth'); }
  // an SSO-first wall: no password field, but auth vocab AND no inside-app affordances → still a gate
  const ssoWall = !s.hasPasswordField && s.authVocabControls.length > 0 && !insideApp;
  if (ssoWall) { score += 2; reasons.push('SSO-first wall'); }
  return { isLoginGate: score >= 3, why: reasons.join(', ') || 'no auth signals', score };
}

// ── L0-c HONESTY INVARIANT: the terminal status decision ─────────────────────────────────────────────────────────
export type CrawlTerminalStatus = 'done' | 'blocked';
/**
 * THE invariant (pure, unit-testable, independent of whether auth works). Two guards, and CRUCIALLY both inputs are
 * OBSERVED, never derived from the login detector — so a DETECTOR FALSE-NEGATIVE cannot disable the guard meant to
 * catch a detector false-negative (the exact hole a regressed schooltalk run exposed: `sessionEstablished` used to be
 * `!landingWasLoginGated`, so a miss set it true and the tripwire could never fire):
 *
 *  (1) DETECTOR-BASED: landed on a login-gated app + never established a session → blocked.
 *  (2) DETECTOR-INDEPENDENT TRIPWIRE: the crawl mapped only a HANDFUL of pages, never logged in, and NOT ONE authed
 *      affordance was observed on ANY page → we only ever saw the login screen, regardless of the detector's verdict.
 *      `sessionEstablished` = login-success-only; `everSawAuthedAffordance` = observed per-page in the crawl loop.
 *      Needs NO live DOM read (the old `everyPageHasAuthVocab` re-read re-introduced the hydration race into the guard
 *      itself — removed).
 *
 * A genuinely public app sets `everSawAuthedAffordance` from its own nav/app affordances on page 1 → completes.
 */
export function crawlTerminalStatus(input: {
  landingWasLoginGated: boolean;
  sessionEstablished: boolean;
  // run-level OBSERVED aggregates (optional so existing callers/tests keep working):
  pagesMapped?: number;
  everSawAuthedAffordance?: boolean;
}): CrawlTerminalStatus {
  if (input.landingWasLoginGated && !input.sessionEstablished) return 'blocked';   // (1)
  // (2) detector-independent tripwire — tiny map, never authed, never saw an app affordance = login-screen-only
  const tinyMap = (input.pagesMapped ?? Infinity) <= 3;
  if (tinyMap && input.sessionEstablished === false && input.everSawAuthedAffordance === false) return 'blocked';
  return 'done';
}

// ── L0-a DECIDER: after submitting creds, poll to a terminal tri-state ────────────────────────────────────────────
export type LoginOutcome = 'signed-in' | 'rejected' | 'indeterminate';
export interface SettleResult { outcome: LoginOutcome; why: string; url: string; ticks: number }

/** One settle "tick" verdict from a snapshot: are we positively in the app, still on a rejecting form, or unclear? */
export function judgeTick(s: AuthSignals, urlBefore: string, opts?: { knownAppRoute?: (url: string) => boolean }): 'in-app' | 'rejected' | 'pending' {
  const insideApp = s.authedAffordances.length > 0;                    // POSITIVE evidence
  const urlMovedToApp = s.url !== urlBefore && !!opts?.knownAppRoute?.(s.url);
  // POSITIVE-evidence success: an authed affordance is present, or the URL moved to a known non-login route.
  if ((insideApp || urlMovedToApp) && !s.hasPasswordField) return 'in-app';
  // REJECTED: the form is STILL here AND an error is shown near it (error only trusted while the form is present).
  if (s.hasPasswordField && s.errorNearForm) return 'rejected';
  // otherwise we don't yet have a terminal signal (form gone but app not confirmed = the dangerous gap → pending)
  return 'pending';
}

/**
 * Poll the page after a credential submit until a TERMINAL, settled verdict or the cap. Tri-state:
 *   signed-in     — POSITIVE app evidence on TWO consecutive ticks (settle; guards the unmount→mount gap).
 *   rejected      — form present + error near it on two consecutive ticks (wrong creds → caller clears them).
 *   indeterminate — cap reached with no settled terminal signal (slow app / unknown shape → caller KEEPS creds,
 *                   and on a login-gated app this becomes `blocked`, never `done`).
 */
export async function settleLogin(
  page: Page,
  urlBefore: string,
  opts?: { capMs?: number; tickMs?: number; knownAppRoute?: (url: string) => boolean },
): Promise<SettleResult> {
  const capMs = opts?.capMs ?? 20000;
  const tickMs = opts?.tickMs ?? 700;
  const started = Date.now();
  let ticks = 0;
  let prev: 'in-app' | 'rejected' | 'pending' | null = null;
  while (Date.now() - started < capMs) {
    ticks++;
    const s = await authSignals(page);
    const v = judgeTick(s, urlBefore, opts);
    // SETTLE: require the same non-pending verdict twice in a row before accepting it.
    if (v !== 'pending' && v === prev) {
      if (v === 'in-app') return { outcome: 'signed-in', why: 'authed affordance / app route (settled x2)', url: s.url, ticks };
      return { outcome: 'rejected', why: `auth error near form: ${s.errorNearForm} (settled x2)`, url: s.url, ticks };
    }
    prev = v;
    await page.waitForTimeout(tickMs).catch(() => {});
  }
  return { outcome: 'indeterminate', why: `no terminal signal within ${capMs}ms`, url: (await authSignals(page)).url, ticks };
}
