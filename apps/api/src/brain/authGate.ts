/**
 * authGate.ts — the shared PRE-FLIGHT AUTH GATE every live-browser engine must run before doing work.
 *
 * The bug it prevents (caught on dent): an engine runs its whole plan against the `/login` screen because it never
 * authenticated, then dresses up login-screen failures as code-cited "findings" / "status drift" — authoritative-
 * looking garbage. bug-repro already refused honestly; break-it/env-matrix did not. This centralizes the refusal:
 * probe the app once, and if it's login-gated and we can't get in, the engine emits ONE honest credentials record
 * and does zero work.
 *
 * CRITICAL: installEvalShim(context) MUST run before looksLikeLogin/resolveIdentifierField — those read the DOM via
 * page.evaluate with named helpers, which throw `ReferenceError: __name is not defined` under tsx UNLESS the shim
 * defined __name in the page first. Without it the login-detector silently returns false → the gate false-passes.
 */
import { chromium } from 'playwright';
import { installEvalShim } from './evalShim';
import { looksLikeLogin, tryLogin } from './crawlMapService';

export interface GateResult { blocked: boolean; message: string }

/** Probe the app once; blocked = login-gated AND we couldn't get in (no creds, or creds don't sign in). Hard-capped
 *  at 45s and fail-OPEN on any error/timeout (never wedge or block a real run on a flaky probe — the engine's own
 *  executed-something gate is the backstop). */
export async function preflightAuth(baseUrl: string, creds?: { email?: string; password?: string }): Promise<GateResult> {
  console.log(`[XSION][gate] preflightAuth START url=${baseUrl} hasCreds=${!!(creds?.email && creds?.password)}`);
  const probe = (async (): Promise<GateResult> => {
    let browser: any = null;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext();
      await installEvalShim(context);   // ★ define __name in-page BEFORE any DOM-reading evaluate
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e: any) => console.log(`[XSION][gate] goto err: ${String(e?.message || e).slice(0, 60)}`));
      await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      const isLogin = await looksLikeLogin(page);
      console.log(`[XSION][gate] landed url=${page.url()} looksLikeLogin=${isLogin}`);
      if (!isLogin) { console.log('[XSION][gate] NOT login-gated → PROCEED'); return { blocked: false, message: '' }; }
      if (!(creds?.email && creds?.password)) {
        console.log('[XSION][gate] login-gated + NO creds → BLOCKED (credentials)');
        return { blocked: true, message: 'This app requires a login and the project has no credentials, so it would only ever run against the sign-in screen. Add credentials for this project and re-run. (No work was done; this is not a verdict on the app.)' };
      }
      console.log('[XSION][gate] login-gated + have creds → attempting tryLogin…');
      const ok = await tryLogin(page, creds.email, creds.password).catch(() => false);
      console.log(`[XSION][gate] tryLogin result=${ok} url=${page.url()}`);
      if (!ok) {
        console.log('[XSION][gate] login FAILED → BLOCKED (credentials)');
        return { blocked: true, message: 'The project credentials didn\'t sign in (wrong credentials, or the app uses an SSO / third-party consent flow Xsion can\'t automate), so it can\'t get past the login screen. Fix the credentials and re-run. (No work was done; this is not a verdict on the app.)' };
      }
      console.log('[XSION][gate] login OK → PROCEED');
      return { blocked: false, message: '' };
    } catch (e) {
      console.log(`[XSION][gate] probe ERROR (fail-open): ${String((e as any)?.message || e).slice(0, 80)}`);
      return { blocked: false, message: '' };
    } finally {
      try { await browser?.close(); } catch {}
    }
  })();
  // CLEAR the cap timer once the race settles — else the loser's setTimeout fires 45s LATER and logs a phantom
  // "45s CAP hit" even when the probe already won, poisoning every future hang-diagnosis (it sent a real debug 3
  // checks down the wrong path). The timer must not outlive the race.
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<GateResult>((resolve) => { capTimer = setTimeout(() => { console.log('[XSION][gate] 45s CAP hit → fail-open'); resolve({ blocked: false, message: '' }); }, 45000); });
  const result = await Promise.race([probe, cap]);
  clearTimeout(capTimer);
  console.log(`[XSION][gate] preflightAuth DONE blocked=${result.blocked}`);
  return result;
}
