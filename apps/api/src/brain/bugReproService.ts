/**
 * bugReproService.ts — BUG REPLICATION. Paste a QA bug ticket → Xsion turns it into concrete browser steps, runs
 * them on the live app, and answers the QA engineer's real question HONESTLY:
 *   • reproduced     — it did the steps and OBSERVED the reported (buggy) behavior. The bug is live.
 *   • not-reproduced — it did the steps and saw the EXPECTED behavior instead (maybe already fixed).
 *   • cant-perform   — the ticket needs an interaction the executor couldn't perform (an honest "I couldn't do
 *                      the gesture", NOT a fake verdict).
 * Mode 1: SoA also reads the handler code and cross-checks whether the reported behavior MATCHES the code — which
 * answers a ticket's open question ("cross-check with Jason"). And it PRESERVES the ticket's own uncertainty: if
 * the ticket says "unclear if a real defect", Xsion carries that forward instead of flattening it into confidence.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { bugRepro, BugRepro } from './soaClient';
import { executeFlow } from './intentRunner';
import { makeFrameHook } from './liveFrame';
import { recordObservation, surfaceHints } from './projectKnowledge';

export type ReproVerdict = 'reproduced' | 'not-reproduced' | 'cant-perform' | 'inconclusive';

export type BugEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'bugrepro:verdict'; verdict: ReproVerdict; report: any }
  | { type: 'bugrepro:need-creds'; forUrl: string; message: string }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: BugEvent) { wsServer.broadcastToRun(runId, e as any); }

export interface BugOpts { repo: string; ticket: string; }

export function startBugRepro(projectId: string, baseUrl: string, opts: BugOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Bug repro` } as any);
  runBugRepro(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'test:think', message: `bug-repro error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Run failed', kind: 'bugrepro' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

async function runBugRepro(runId: string, projectId: string, baseUrl: string, opts: BugOpts) {
  const map = store.getProjectMap(projectId);
  const project = store.getProject(projectId);
  // in-memory creds set via the cred prompt (PUT /credentials) — stripped on persist, never logged.
  const creds = (project as any)?._defaultCreds as { email?: string; password?: string } | undefined;
  emit(runId, { type: 'test:phase', phase: 'start', label: 'Reading the bug ticket', kind: 'bugrepro' });
  // PROGRESS: SoA reading the ticket + (mode 1) the code takes ~30-60s. Say so, so the panel is never a dead READY.
  emit(runId, { type: 'test:think', message: `Reading the ticket${opts.repo ? ' and cross-checking the code' : ''} and turning it into concrete steps… (this takes ~30–60s)` });

  // FEED SoA THE CRAWL KNOWLEDGE (not just bare paths). The crawl already learned this app — its page PATHS (whose
  // URL templates reveal gates like /:portal/Teacher/...), how many interactive controls each page had, and the
  // FLOWS it identified (which literally name gates, e.g. "Select Demo/Doon portal"). Without this SoA re-guesses
  // steps from the ticket words alone and face-plants on gates the crawl already mapped (schooltalk "Choose Portal").
  // PROJECT LEARNING: feed SoA what PRIOR runs learned about navigating this app (gates, working routes/selectors) —
  // so it starts smart instead of re-discovering. NAVIGATIONAL only; never oracle (projectKnowledge.ts safety line).
  const priorKnowledge = surfaceHints(store.getProjectKnowledge(projectId));
  const surface = {
    baseUrl,
    pages: (map?.pages || []).map((p: any) => ({ path: p.path, interactives: p.interactives })).slice(0, 30),
    flows: (map?.flows || []).map((f: any) => ({ name: f.name, steps: (f.steps || []).map((s: any) => s.intent).slice(0, 6) })).slice(0, 8),
    learnedNavigation: priorKnowledge.map((h) => h.fact),   // "clicking 'Demo School' → /demo/Teacher/Dashboard", etc.
  };
  const authorized = !!(project as any)?.security?.authorized;
  let repro: any = null, error: string | undefined, raw: string | undefined;
  try {
    const r = await bugRepro(opts.repo, { ticket: opts.ticket, surface });
    repro = r.repro; error = r.error; raw = r.raw;
  } catch (e: any) {
    // an SoA timeout / spawn failure must surface honestly — not a frozen panel.
    emit(runId, { type: 'test:think', message: `The reproduction planner didn't respond in time (${String(e?.message || e).slice(0, 120)}). This is an Xsion/SoA issue, not your ticket — try again.` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Planner timed out', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
    return;
  }
  if (!repro) {
    // DISTINGUISH: a parse failure (SoA's fault, retry) is NOT "your ticket is vague". Say which, and show the raw.
    const isParseFail = /not valid json|unparseable|parse failed/i.test(error || '');
    emit(runId, { type: 'test:think', message: isParseFail
      ? `SoA's reply wasn't valid JSON even after a retry — this is a transient planner glitch on our side, not a problem with your ticket. Please run it again.${raw ? ` (raw: ${String(raw).slice(0, 160)})` : ''}`
      : `The ticket didn't contain enough to build runnable steps — add Steps to Reproduce / Expected / Actual so I can turn it into actions.${error ? ` (${error})` : ''}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: isParseFail ? 'Planner glitch — retry' : 'Not enough in the ticket', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', verdict: 'cant-perform', parseError: isParseFail, detail: isParseFail ? 'SoA reply was not valid JSON (retry it).' : 'The ticket lacked enough detail to build steps.', raw: raw ? String(raw).slice(0, 400) : undefined } as any] } as any);
    return;
  }

  // PRE-CHECK — the cred prompt: if the repro requires a login (the ticket/steps say so) and this project has NO
  // credentials, stop and ASK rather than silently running the whole repro against the sign-in page (the schooltalk
  // false-positive). The frontend shows a cred overlay → PUT /credentials stores _defaultCreds → re-run picks them up.
  const needsLogin = reproNeedsLogin(repro.steps, opts.ticket);
  if (needsLogin && !(creds?.email && creds?.password)) {
    emit(runId, { type: 'test:think', message: 'This reproduction needs a logged-in session (the ticket starts by logging in), but this project has no credentials. I won\'t run the steps against the sign-in page and hand you a false verdict.' });
    emit(runId, { type: 'bugrepro:need-creds', forUrl: baseUrl, message: 'To reproduce this bug I need to sign in first. Enter credentials for this app and I\'ll run the full reproduction.' });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Credentials needed', kind: 'bugrepro' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 1, total: 1 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', verdict: 'cant-perform', needsCreds: true, expectedBehavior: repro.expectedBehavior, actualBehavior: repro.actualBehavior, openQuestion: repro.openQuestion, detail: 'Paused before running — this reproduction requires a login and the project has no credentials. Add credentials and re-run.' } as any] } as any);
    return;
  }

  emit(runId, { type: 'test:think', message: `The ticket needs: ${repro.interaction || 'standard UI actions'}. Expected: “${repro.expectedBehavior}”. Reported (buggy): “${repro.actualBehavior}”.` });
  if (repro.openQuestion) emit(runId, { type: 'test:think', message: `⚠ The ticket itself is uncertain — I'll carry this forward, not override it: ${repro.openQuestion}` });
  if (repro.codeAssessment) emit(runId, { type: 'test:think', message: `Code cross-check: the reported behavior ${repro.codeAssessment === 'matches-code' ? 'MATCHES the code (likely a real defect)' : repro.codeAssessment === 'contradicts-code' ? 'CONTRADICTS the code (may be already fixed / stale ticket)' : 'is unclear from the code'}${repro.codeRef ? ` (${repro.codeRef})` : ''}.` });

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Reproducing the steps', kind: 'bugrepro' });

  // run the repro steps and watch for a step that COULDN'T perform its interaction (the honest cant-perform).
  const flow = { name: 'bug-repro', role: 'tester', steps: repro.steps };
  let stepResults: any[] = [];
  let authResult: any = null;   // the auth pre-step's own result (stepIndex -1) — DON'T discard it, it tells us if login worked
  let consoleErrors: string[] = [];
  let finalText = '';
  const frameHook = makeFrameHook(runId, emit as any);   // LIVE VIEW + PLAYBACK
  frameHook.caseIndex = 0; frameHook.caseTitle = 'Reproduction';   // one case: the repro sequence
  let learned = store.getProjectKnowledge(projectId);   // accumulate NAVIGATIONAL facts this run learns
  const learnNow = () => new Date().toISOString();
  try {
    if (creds?.email && creds?.password) emit(runId, { type: 'test:think', message: 'Signing in with the project credentials first, then running the reproduction from the authenticated app.' });
    const exec = await executeFlow(flow as any, baseUrl, {
      onStepStart: (i, intent) => emit(runId, { type: 'test:item-start', index: i, title: intent }),
      onStepResult: (sr) => emit(runId, { type: 'test:item-result', index: sr.stepIndex, status: sr.status === 'pass' ? 'pass' : 'fail', detail: sr.note || sr.attempts?.[0]?.error || '' }),
      onConsoleError: (m) => consoleErrors.push(m),
      onThink: (m) => emit(runId, { type: 'test:think', message: m }),   // SURFACE the on-stall recovery reasoning
      onLearn: (obs) => { learned = recordObservation(learned, obs, learnNow()); },   // ACCUMULATE navigational facts
      onFrame: frameHook,
    }, undefined, creds, { allowMutations: authorized });   // creds → login pre-step; mutations only if authorized
    stepResults = exec.stepResults.filter((s) => s.stepIndex >= 0);
    authResult = exec.stepResults.find((s) => s.stepIndex === -1) || null;   // the login pre-step's own outcome
    finalText = exec.finalText || '';
    // PERSIST what this run learned about navigating the app → next run starts smarter. Navigational only.
    if (learned.length) { store.setProjectKnowledge(projectId, learned); const n = surfaceHints(learned).length; if (n) emit(runId, { type: 'test:think', message: `Learned ${n} navigation fact(s) about this project — future runs will start smarter (how to reach pages, working selectors). This never affects bug verdicts, only navigation.` }); }
  } catch (e: any) {
    emit(runId, { type: 'test:think', message: `execution error: ${String(e?.message || e).slice(0, 100)}` });
  }

  // ── SSO DETECTION (the schooltalk case): the user gave correct creds, but the app signs in via Google/Microsoft
  // SSO — an identity-provider consent flow Xsion CANNOT (and must not) automate. The tells: the login pre-step
  // failed AND the console shows a 401 / Google-Sign-In (GSI_LOGGER) / FedCM / accounts.google.com abort. Reporting
  // this as `inconclusive` ("we tried and couldn't tell") is a false-neutral — the truth is "we never got in".
  const isSSO = detectSSO(!!(creds?.email && creds?.password), authResult, consoleErrors);
  // A failed PASSWORD login (form was present + filled, but sign-in didn't take) is DISTINCT from SSO — surface it
  // honestly so the user isn't told to "use a non-SSO account" for an app that has password login. authResult.note
  // is the self-diagnosing signal (persisted below): 'login did not persist' / 'form never appeared' / 'pre-step failed'.
  const passwordLoginFailed = !isSSO && creds?.email && creds?.password && authResult?.status === 'fail';
  if (passwordLoginFailed) {
    emit(runId, { type: 'test:think', message: `Sign-in didn't take — the app HAS an email/password login (not SSO-only), but this attempt stayed on the sign-in screen (${authResult?.note || 'reason unclear'}). It could be wrong credentials, a slow redirect, or the account being locked/rate-limited. Not an SSO problem.` });
  }

  // ── THE HONEST VERDICT ──
  let verdict = judgeRepro(repro, stepResults, consoleErrors, finalText);
  if (isSSO) verdict = 'cant-perform';   // never got in → not a bug verdict

  // LOGIN-WALL DETECTION: if the repro never got past a sign-in page (every failed step's candidates were login
  // controls, or the final page is a sign-in screen), the honest reason is "I need credentials" — NOT a bug verdict,
  // and NOT a generic "couldn't do the interaction". This is what happened on schooltalk (no creds in the server env,
  // no prompt) → say so plainly so the operator knows to provide creds, mirroring the crawl's need-creds behavior.
  const failedCandidates = stepResults.filter((s) => s.status === 'fail').map((s) => String(s.attempts?.[0]?.error || '')).join(' ').toLowerCase();
  const loginWall = (/sign\s?in|log\s?in|google|microsoft/.test(failedCandidates) && /candidates|no match|no input/.test(failedCandidates))
    || /sign in to (access|continue)|email address\s+password/i.test(finalText);
  const ssoDetail = 'Your credentials are correct, but this app signs you in through Google / Microsoft SSO — a third-party consent flow Xsion can\'t (and won\'t) automate. So I never reached the feature. To run this repro, use a non-SSO test account (email + password login), or supply a logged-in session cookie / storageState.';
  // POST-LOGIN INTERSTITIAL: logged in fine, but PARKED on an unexpected gate (a portal/workspace/school picker) the
  // ticket's steps never mention. This is what actually happened on schooltalk: it authenticated, then sat on a
  // "Choose Portal" school-selection screen for all 16 steps. Name it + quote the options; force cant-perform.
  const interstitial = (!isSSO && !loginWall) ? detectInterstitial(stepResults, finalText) : null;
  if (interstitial) verdict = 'cant-perform';
  // Don't duplicate the options if the heading already lists them (e.g. "Choose Portal: Demo School Doon School…").
  const headingHasOpts = interstitial ? interstitial.options.some((o) => interstitial.heading.includes(o)) : false;
  const interstitialDetail = interstitial
    ? `I signed in fine, but got stopped on a screen${interstitial.heading ? ` — "${interstitial.heading}"` : ''} your ticket's steps don't mention${(!headingHasOpts && interstitial.options.length) ? ` (it's offering: ${interstitial.options.join(', ')})` : ''}. Your steps assume the app is already past this. Add the step to get through it, or tell me which option to pick — I won't guess, since the wrong choice touches real data.`
    : '';
  if (isSSO) {
    emit(runId, { type: 'test:think', message: `I couldn't sign in — the app uses Google/Microsoft SSO (saw a 401 + Google Sign-In abort in the console). ${ssoDetail}` });
  } else if (interstitial) {
    emit(runId, { type: 'test:think', message: interstitialDetail });
  } else if (loginWall && verdict === 'cant-perform') {
    emit(runId, { type: 'test:think', message: 'I never got past the LOGIN screen — every step matched only sign-in controls (Google / Microsoft / Sign In). I have no credentials for this project, so I can\'t reach the feature to reproduce the bug. Add credentials for this project and re-run.' });
  }

  const report = {
    verdict,
    expectedBehavior: repro.expectedBehavior,
    actualBehavior: repro.actualBehavior,
    interaction: repro.interaction,
    codeAssessment: repro.codeAssessment,
    codeRef: repro.codeRef,
    openQuestion: repro.openQuestion,
    loginWall: (loginWall && verdict === 'cant-perform') || isSSO,
    ssoBlocked: isSSO,
    authResult: authResult ? { status: authResult.status, note: authResult.note } : undefined,   // persist the login outcome (self-diagnosing, not lossy)
    passwordLoginFailed: !!passwordLoginFailed,
    interstitial: interstitial ? { heading: interstitial.heading, options: interstitial.options } : undefined,
    detail: isSSO
      ? ssoDetail
      : interstitial
      ? interstitialDetail
      : loginWall && verdict === 'cant-perform'
      ? `I couldn't reproduce this — I never got past the LOGIN screen (every step matched only sign-in controls, and I have no credentials for this project). This is NOT a verdict on the bug; add credentials and re-run to actually reach the feature.${repro.codeAssessment === 'contradicts-code' || repro.openQuestion ? ` Separately, the code cross-check couldn't find this feature in the repo${repro.openQuestion ? `: ${repro.openQuestion}` : '.'}` : ''}`
      : verdictDetail(verdict, repro, stepResults, finalText),
    stepsRun: stepResults.map((s) => ({ intent: (flow.steps as any)[s.stepIndex]?.intent, status: s.status, note: s.note || s.attempts?.[0]?.error })),
    consoleErrors: consoleErrors.slice(0, 20),   // persist the console signal so a verdict is auditable (not lossy)
  };

  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'bug-repro', ...report, frames: frameHook.frames } as any] } as any);
  emit(runId, { type: 'bugrepro:verdict', verdict, report });
  emit(runId, { type: 'test:phase', phase: 'done', label: 'Reproduction complete', kind: 'bugrepro' });
  emit(runId, { type: 'test:think', message: `Verdict: ${verdict.toUpperCase()}. ${report.detail}` });
  emit(runId, { type: 'test:done', passed: verdict === 'not-reproduced' ? 1 : 0, failed: verdict === 'reproduced' ? 1 : 0, skipped: verdict === 'reproduced' || verdict === 'not-reproduced' ? 0 : 1, total: 1 });
}

/** Judge: could we perform the interaction? if a hard-interaction step failed to even execute → cant-perform.
 * Else compare what we OBSERVED against the ticket's expected vs actual. */
/** Does this reproduction require a logged-in session? (the ticket/steps say "log in", "sign in", "as a Teacher",
 * etc.) — used to PROMPT for credentials before running, instead of silently testing the sign-in page. Pure. */
export function reproNeedsLogin(steps: Array<{ intent?: string }> | undefined, ticket?: string): boolean {
  const text = ((steps || []).map((s) => s.intent || '').join(' ') + ' ' + (ticket || '')).toLowerCase();
  return /\blog ?in\b|\bsign ?in\b|\bas an? (teacher|admin|user|owner|member|manager|staff)\b|\bauthenticated?\b|\blogged.?in\b/.test(text);
}

/** Did an authenticated repro get BLOCKED by SSO? True when the login pre-step failed AND the console shows a
 * third-party identity-provider signal (Google Sign-In / FedCM / MS login / OAuth / 401). Pure + exported so the
 * schooltalk case ("correct creds, but the app uses Google/Microsoft SSO") is locked by a test. */
export function detectSSO(hadCreds: boolean, authResult: { status?: string; attempts?: any[] } | null, consoleErrors: string[]): boolean {
  const authFailed = hadCreds && (!authResult || authResult.status === 'fail');
  // CRITICAL: if a PASSWORD FORM was present + filled, this is a FAILED PASSWORD LOGIN ("sign-in didn't take"), NOT
  // SSO — even though the page's background Google call logs a 401/FedCM. Only call it SSO when there was NO usable
  // email/password path. (Without this, schooltalk — which offers BOTH SSO and password — got a WRONG "use a non-SSO
  // account" verdict telling the user to get the thing they already have.)
  const hadPasswordForm = !!authResult?.attempts?.some((a: any) => a?.hadPasswordForm);
  if (hadPasswordForm) return false;
  const ssoSignal = /gsi_logger|fedcm|accounts\.google|login\.microsoftonline|oauth|\b401\b/i.test((consoleErrors || []).join(' '));
  return !!(authFailed && ssoSignal);
}

/** Detect an UNEXPECTED INTERSTITIAL (a tenant/workspace/portal/school picker, a consent gate, an onboarding wall)
 * that the ticket's steps never accounted for — the repro logged in but got PARKED on a screen it can't get past.
 * GENERALIZABLE signal (not a schooltalk-specific rule): ≥3 actionable steps all failed to match (matched:0) AND
 * the page never changed across them (same candidates each time). Returns the interstitial's heading + a few of its
 * options, quoted from the step errors, so the verdict names the real blocker. null when it's not an interstitial. */
export function detectInterstitial(steps: any[], finalText: string): { heading: string; options: string[] } | null {
  const actionFails = steps.filter((s) => s.status === 'fail' && /click|fill|select|type/i.test(s.attempts?.[0]?.kind || ''));
  if (actionFails.length < 3) return null;
  // pull the "Candidates on page: ..." lists from the failed steps; if they're stable across steps, we're parked.
  const candLines = actionFails.map((s) => {
    const m = String(s.attempts?.[0]?.error || '').match(/candidates on page:\s*(.+)$/i);
    return m ? m[1].trim() : '';
  }).filter(Boolean);
  if (candLines.length < 3) return null;
  const uniqueCandSets = new Set(candLines);
  if (uniqueCandSets.size > 2) return null;   // the page CHANGED across steps → not a single stuck interstitial
  // a heading, if the finalText carries one (e.g. "Choose Portal:", "Select a workspace"). Grab a longer tail so the
  // options that follow the picker prompt are captured (e.g. "Choose Portal: Demo School Doon School …").
  const headMatch = (finalText || '').match(/\b(choose|select|pick)\b[^.\n]{0,20}(portal|workspace|organi[sz]ation|school|tenant|account|team)\b[^.\n]{0,120}/i);
  const heading = headMatch ? headMatch[0].replace(/\s+/g, ' ').trim() : '';
  // OPTIONS: the candidate buttons are noisy (they include the avatar "sc"), so prefer the picker options carried in
  // the heading tail; fall back to candidate labels only when the heading has none. Drop 1-2 char noise like "sc".
  const fromHeading = heading.split(/:|\bportal\b|\bworkspace\b|\bschool\b/i).pop() || '';
  const headingOpts = (fromHeading.match(/[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*/g) || []).filter((o) => o.length > 3);
  const candOpts = Array.from(new Set((candLines[0].match(/"([^"]+)"/g) || []).map((q) => q.replace(/"/g, '')))).filter((o) => o && o.length > 2);
  const options = (headingOpts.length ? headingOpts : candOpts).slice(0, 6);
  return { heading, options };
}

export function judgeRepro(repro: BugRepro, steps: any[], consoleErrors: string[], finalText: string): ReproVerdict {
  // ORDERED-SEQUENCE INTEGRITY (the schooltalk false-positive fix): a repro is a SEQUENCE — if ANY actionable step
  // (click/fill/select/navigate/type — not just the hard drag/hover ones) matched NOTHING, everything after it ran
  // against the wrong page, so we did NOT actually perform the reproduction → cant-perform. This is what caught the
  // real bug: every step reported `matched:0` with candidates "Google | Microsoft | Sign In" (the LOGIN PAGE, no
  // creds), yet the old gate — scoped to drag/hover/press only — let ordinary click/fill failures through and the
  // verdict became a false 'reproduced'. A bug is only reproduced if the STEPS THAT SHOW IT actually executed.
  const actionableUnmatched = steps.some((s) =>
    s.status === 'fail' &&
    /click|fill|type|select|navigate|check|press|drag|hover|rightclick|doubleclick/i.test(s.attempts?.[0]?.kind || '') &&
    s.attempts?.[0]?.matched === 0);
  const interactionIsHard = /drag|drop|hover|keyboard|right[- ]?click|double[- ]?click|gesture/i.test(repro.interaction || '');
  if (actionableUnmatched || (interactionIsHard && steps.some((s) => s.status === 'fail'))) return 'cant-perform';
  // did the repro actually EXECUTE? (≥1 actionable step landed with status 'pass' — NOT 'unverifiable', which is a
  // no-op observe/verify). A verdict of reproduced/not-reproduced requires this — otherwise a console error, a
  // polarity guess, or stray word-overlap on an un-reached page can manufacture a false verdict. This gates ALL the
  // signal branches below (polarity + word-overlap + console), so an all-observe / never-acted run is inconclusive.
  const anyStepExecuted = steps.some((s) => s.status === 'pass' && /click|fill|type|select|navigate|check|press|drag|hover/i.test(s.attempts?.[0]?.kind || ''));
  if (!anyStepExecuted) return 'inconclusive';   // nothing was actually done → we can't judge the bug, honestly

  const hay = (finalText + ' ' + consoleErrors.join(' ')).toLowerCase();
  const actualWords = contentSig(repro.actualBehavior);
  const expectedWords = contentSig(repro.expectedBehavior);
  // overlap: how many distinctive words of each behavior appear in what we saw. A behavior "matches" if ≥2
  // distinctive words hit (tolerant of phrasing differences), taking the stronger of the two.
  const actualHits = actualWords.filter((w) => hay.includes(w)).length;
  const expectedHits = expectedWords.filter((w) => hay.includes(w)).length;
  // POLARITY signal: many bugs are "shows an error / rejects" vs "no error / saves silently / accepts". Classify
  // each behavior's expected page-state, NEGATION-AWARE ("no error" / "without error" = SILENT, not error).
  const polarity = (txt: string): 'error' | 'silent' | 'neutral' => {
    const t = txt.toLowerCase();
    if (/\bsilent|\bno\s+error|\bwithout\b[^.]*\berror|\baccept|\bsaves?\b|\bstored?\b|\ballows?\b/.test(t) && !/\bshows?\b[^.]*\berror|\bvalidation error|\breject/.test(t)) return 'silent';
    if (/\bshows?\b[^.]*\berror|\bvalidation|\brequired\b|\breject|\berror message|\bnot\s+save/.test(t)) return 'error';
    return 'neutral';
  };
  const pageHasError = /\berror\b|\binvalid\b|\brequired\b|\bcannot\b|\bnot allowed\b|\bfailed\b/i.test(finalText) || consoleErrors.length > 0;
  const expPol = polarity(repro.expectedBehavior);
  const actPol = polarity(repro.actualBehavior);

  // decide by polarity when the two behaviors DIFFER on error-ness (the common, decisive case)
  if (expPol !== 'neutral' && actPol !== 'neutral' && expPol !== actPol) {
    const pageState: 'error' | 'silent' = pageHasError ? 'error' : 'silent';
    if (pageState === actPol) return 'reproduced';       // page matches the REPORTED (buggy) behavior
    if (pageState === expPol) return 'not-reproduced';   // page matches the EXPECTED behavior → not a bug (fixed?)
  }
  // else fall back to word-overlap, taking the clearly-stronger match
  if (actualHits >= 2 && actualHits > expectedHits) return 'reproduced';
  if (expectedHits >= 2 && expectedHits > actualHits) return 'not-reproduced';
  // a console error only supports 'reproduced' when the repro STEPS ACTUALLY RAN — an unhandled error DURING the
  // reproduction is itself the bug. Standalone (no actionable step executed) it's just page noise (an SPA login page
  // reliably emits 401s) and must NOT manufacture a verdict — that was half of the schooltalk false positive.
  if (consoleErrors.length > 0 && anyStepExecuted) return 'reproduced';
  return 'inconclusive';                                // couldn't observe either signal — honest, not a false verdict
}

function verdictDetail(v: ReproVerdict, repro: BugRepro, steps: any[], finalText: string): string {
  if (v === 'cant-perform') return `Couldn't perform the “${repro.interaction}” interaction the ticket requires, so I can't confirm the bug live. ${repro.codeAssessment ? `But the code cross-check says the reported behavior ${repro.codeAssessment}.` : 'Attach the repo so I can cross-check against the code.'}${repro.openQuestion ? ` (Ticket's own open question stands: ${repro.openQuestion})` : ''}`;
  if (v === 'reproduced') return `I ran the steps and observed the reported buggy behavior. The bug reproduces on the live app.${repro.openQuestion ? ` NOTE — the ticket flags this as unconfirmed: ${repro.openQuestion}` : ''}`;
  if (v === 'not-reproduced') return `I ran the steps and saw the EXPECTED behavior — the reported bug did not reproduce (it may be fixed, or environment-specific).`;
  return `Ran the steps but couldn't clearly observe either the expected or the buggy behavior — needs human review.${repro.codeAssessment ? ` Code cross-check: ${repro.codeAssessment}.` : ''}`;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'of', 'on', 'in', 'at', 'and', 'or', 'be', 'was', 'get', 'gets', 'event', 'events', 'should', 'always', 'just', 'below', 'where', 'that', 'this', 'user']);
function contentSig(s: string): string[] { return [...new Set((s.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 10); }
