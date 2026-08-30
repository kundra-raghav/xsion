/**
 * securityAuditService.ts — the CODE-GROUNDED SECURITY AUDIT (Mode 1 only).
 *
 * The novel seam applied to security: SoA READS the guard/validator/config code and hands back a code-cited
 * PROBE PLAN; Xsion EXECUTES the probes safely against the live app and judges each against the code's own
 * oracle. A finding is only ever "vulnerable" when a probe MECHANICALLY OBSERVED the exact response SoA said
 * would prove it — so a finding is always (a) cited to a code line and (b) reproducible from the recorded
 * request/response artifact. Devs get a real audit they can act on and replay.
 *
 * TIERS (all opt-in, nothing default-on):
 *   T1 read+probe       — always available in Mode 1. Safe read-only probes (GET/HEAD/OPTIONS), no payloads.
 *   T2 proof-of-vuln    — unlocks with repo + project.security.authorized. Non-destructive proof probes.
 *   T3 destructive      — unlocks with T2 + an explicit per-RUN acknowledgment. Mutating probes.
 *
 * FAIL-SAFE FLOOR (non-negotiable): 'vulnerable' REQUIRES an observed match of the probe's expectIfVulnerable;
 * 'safe' only on an observed match of expectIfSafe; everything else → 'needs-review' (NEVER silently "safe").
 * No volumetric/DDoS here by design (see the memory note) — this is an application-layer audit.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { isAuthorized, isDestructiveAcked } from './runtimeGuards';   // staging-autonomy authorization + ack defaults
import { auditPlan, AuditProbe } from './soaClient';

// only these methods ever fire without the destructive tier — reads can't mutate the app
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuditVerdict = 'vulnerable' | 'safe' | 'needs-review' | 'skipped';

export interface AuditFinding {
  cls: string;
  title: string;
  severity: string;
  codeRef: string;
  why: string;
  verdict: AuditVerdict;
  detail: string;
  // the REPRODUCIBLE artifact — everything a dev needs to replay the probe and confirm the fix
  reproduce?: {
    method: string;
    url: string;
    withAuth: boolean;
    status?: number;
    responseSample?: string;   // truncated + redacted
    curl: string;
  };
}

export type AuditEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'audit:finding'; index: number; finding: AuditFinding }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: AuditEvent) { wsServer.broadcastToRun(runId, e as any); }

export interface AuditOpts {
  repo: string;
  tier: 1 | 2 | 3;             // requested tier
  destructiveAck?: boolean;    // per-run ack, required for tier 3
}

/** Kick off a security-audit run. Enforces the consent gate BEFORE any probe fires. Returns runId immediately. */
export function startSecurityAudit(projectId: string, baseUrl: string, opts: AuditOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Security audit · ${baseUrl}` } as any);
  runAudit(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'test:think', message: `audit error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Audit failed', kind: 'security' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

/** Resolve the effective tier: a requested tier is clamped down to what the project's consent actually permits. */
export function effectiveTier(project: any, requested: 1 | 2 | 3, destructiveAck?: boolean): { tier: 1 | 2 | 3; reason: string } {
  const authorized = isAuthorized(project);   // staging-autonomy default ON (explicit project flag still wins)
  if (requested >= 2 && !authorized) {
    return { tier: 1, reason: 'exploit tiers need the per-project "I own/authorize this target" attestation — running read-only probes only' };
  }
  if (requested >= 3 && !isDestructiveAcked(destructiveAck)) {
    return { tier: 2, reason: 'destructive tier needs an explicit per-run acknowledgment — running non-destructive proof probes only' };
  }
  return { tier: requested, reason: '' };
}

async function runAudit(runId: string, projectId: string, baseUrl: string, opts: AuditOpts) {
  const project = store.getProject(projectId);
  const map = store.getProjectMap(projectId);

  emit(runId, { type: 'test:phase', phase: 'start', label: 'Reading the security-relevant code', kind: 'security' });

  if (!opts.repo) {
    emit(runId, { type: 'test:think', message: 'The security audit is code-grounded — it needs the codebase (Mode 1). No repo attached, so nothing to audit safely.' });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'No codebase', kind: 'security' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString() });
    return;
  }

  // ── THE CONSENT GATE — resolve the tier we're actually allowed to run ──
  const { tier, reason } = effectiveTier(project, opts.tier, opts.destructiveAck);
  if (reason) emit(runId, { type: 'test:think', message: reason });
  emit(runId, { type: 'test:think', message: `Running at tier ${tier}: ${tier === 1 ? 'read-only probes' : tier === 2 ? 'non-destructive proof-of-vulnerability' : 'destructive (authorized + acknowledged)'}. Every finding will be cited to a code line and recorded so you can replay it.` });

  // ── SoA reads the code → the probe plan ──
  const surface = { baseUrl, routes: (map?.routeManifest || []), api: (map?.api || []).slice(0, 40).map((e: any) => ({ method: e.method, url: e.url, graphql: e.graphql, op: e.gqlOperation })) };
  const { probes, error } = await auditPlan(opts.repo, surface);
  if (error) emit(runId, { type: 'test:think', message: `Audit-plan note: ${error}` });
  // NO-SILENT-CLEAN-BILL (2026-08-30): the audit plan is code-read by SoA (an LLM bridge) — it can return ZERO probes
  // on a bridge timeout/error/empty response. Reporting 0 findings then is INDISTINGUISHABLE from "the code is clean"
  // — the exact false-negative that burns trust. If no probes were planned, the audit did NOT run; say so explicitly
  // (a needs-review finding + failed status), never a green 0. A real audit with real coverage is the only clean bill.
  if (!probes.length) {
    const notRun: AuditFinding = { cls: 'audit-coverage', title: 'Security audit could not run', severity: 'high',
      codeRef: null as any, why: 'the code-reading planner returned no checks', verdict: 'needs-review',
      detail: `The audit produced NO probes${error ? ` (planner error: ${error})` : ' (the code-reading step returned an empty plan — likely a bridge timeout or transient failure)'}. This is NOT a clean bill of health — no checks actually ran. Re-run the audit; if it persists, the code bridge/repo access needs attention.` };
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'security-audit', tier, findings: [notRun] } as any] } as any);
    emit(runId, { type: 'audit:finding', index: 0, finding: notRun });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Audit could not run', kind: 'security' });
    emit(runId, { type: 'test:think', message: 'Audit produced no checks — reported as needs-review (NOT a clean pass). Re-run to retry the code-reading step.' });
    emit(runId, { type: 'test:done', passed: 0, failed: 0, skipped: 0, total: 0 });
    return;
  }
  emit(runId, { type: 'test:think', message: `SoA read the code and proposed ${probes.length} code-grounded checks to run.` });

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Running probes', kind: 'security' });
  const findings: AuditFinding[] = [];
  let vulnerable = 0, safe = 0, review = 0, skipped = 0;

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    emit(runId, { type: 'test:item-start', index: i, title: `[${p.cls}] ${p.title}` });
    const finding = await runProbe(baseUrl, p, tier, project);
    findings.push(finding);
    if (finding.verdict === 'vulnerable') vulnerable++;
    else if (finding.verdict === 'safe') safe++;
    else if (finding.verdict === 'skipped') skipped++;
    else review++;

    // map audit verdict → the generic test-item status the UI already renders, + a rich audit:finding event
    const status = finding.verdict === 'vulnerable' ? 'fail' : finding.verdict === 'safe' ? 'pass' : finding.verdict === 'skipped' ? 'skipped' : 'unverifiable';
    emit(runId, { type: 'test:item-result', index: i, status, detail: `${finding.verdict.toUpperCase()} — ${finding.detail}`, evidence: finding.codeRef });
    emit(runId, { type: 'audit:finding', index: i, finding });
  }

  // persist findings on the run for the record + replay
  store.updateTestRun(runId, { status: 'passed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'security-audit', tier, findings } as any] } as any);

  emit(runId, { type: 'test:phase', phase: 'done', label: 'Audit complete', kind: 'security' });
  emit(runId, { type: 'test:think', message: `Audit done — ${vulnerable} vulnerable, ${safe} safe, ${review} needs-review, ${skipped} skipped (tier ${tier}). Findings are code-cited and reproducible.` });
  emit(runId, { type: 'test:done', passed: safe, failed: vulnerable, skipped: skipped + review, total: probes.length });
}

/** Classify what a probe ACTUALLY does, which decides the tier it needs — NOT the HTTP method alone. An
 * auth-bypass GET is still an EXPLOIT (it attempts unauthorized access), so it needs the consent tier even
 * though GET is "safe". This is the gate that Scenario-A proved was missing when we keyed only on the method.
 *   observation — a normal, authorized request we merely INSPECT (cookie flags, security headers). Tier 1.
 *   exploit     — attempts unauthorized access / sends test input (sendWithoutAuth, or an injection-shape send). Tier 2.
 *   destructive — mutates state (non-safe method). Tier 3.
 */
function probeTier(p: AuditProbe): { needs: 1 | 2 | 3; kind: 'observation' | 'exploit' | 'destructive' } {
  const method = (p.probe.method || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) return { needs: 3, kind: 'destructive' };
  // an attempt to reach a protected resource without a session, or an input-validation send, is an exploit
  if (p.probe.sendWithoutAuth || p.cls === 'input-validation' || p.cls === 'access-control') return { needs: 2, kind: 'exploit' };
  return { needs: 1, kind: 'observation' };
}

/** Execute one probe under the tier's safety rules and judge it against the code's own oracle (fail-safe). */
async function runProbe(baseUrl: string, p: AuditProbe, tier: 1 | 2 | 3, _project: any): Promise<AuditFinding> {
  const base: AuditFinding = { cls: p.cls, title: p.title, severity: p.severity, codeRef: p.codeRef, why: p.why, verdict: 'needs-review', detail: '' };

  const method = (p.probe.method || 'GET').toUpperCase();

  // ── TIER SAFETY: gate on what the probe DOES, not just its HTTP method. Anything above the running tier is
  // recorded as a finding-to-run (SoA's code reason stands, cited) rather than silently fired or silently dropped.
  const { needs, kind } = probeTier(p);
  if (needs > tier) {
    const unlock = needs === 2 ? 'the proof-of-vulnerability tier (needs the "I own/authorize this target" attestation)' : 'the destructive tier (needs authorization + a per-run acknowledgment)';
    return { ...base, verdict: 'needs-review', detail: `this is an ${kind} probe — it needs ${unlock} to run live. SoA's code-grounded reason stands: ${p.why} (${p.codeRef}). Enable the tier to confirm it against the running app.` };
  }

  // resolve a concrete URL from the path template (param routes get a probe id)
  const path = (p.probe.pathTemplate || '/').replace(/:([A-Za-z_]\w*)/g, '1');
  let url: string;
  try { url = new URL(path, baseUrl).href; } catch { return { ...base, verdict: 'needs-review', detail: `could not resolve probe path "${p.probe.pathTemplate}"` }; }

  const withAuth = !p.probe.sendWithoutAuth; // most access-control probes deliberately send WITHOUT a session
  const headers: Record<string, string> = { 'user-agent': 'Xsion-Security-Audit' };

  let status: number | undefined;
  let responseSample = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(url, { method, headers, redirect: 'manual', signal: ctrl.signal });
    clearTimeout(timer);
    status = resp.status;
    const text = await resp.text().catch(() => '');
    responseSample = redactBody(text).slice(0, 400);
  } catch (e: any) {
    return { ...base, verdict: 'needs-review', detail: `probe request failed: ${String(e?.message || e).slice(0, 100)}` };
  }

  const reproduce = {
    method, url, withAuth, status, responseSample,
    curl: `curl -i -X ${method} '${url}'${p.probe.sendWithoutAuth ? '   # sent WITHOUT a session token' : ''}`,
  };

  // ── FAIL-SAFE JUDGEMENT: match the OBSERVED response against SoA's explicit oracles. Ambiguous → needs-review ──
  const verdict = judge(status, responseSample, p);
  const detail = verdictDetail(verdict, status, p);
  return { ...base, verdict, detail, reproduce };
}

/** The core fail-safe judge. 'vulnerable' ONLY on a positive match of the vulnerable-oracle; 'safe' ONLY on the
 * safe-oracle; everything else is 'needs-review'. We never infer "safe" from the absence of a vuln signal. */
function judge(status: number | undefined, body: string, p: AuditProbe): AuditVerdict {
  if (status === undefined) return 'needs-review';
  const vuln = p.probe.expectIfVulnerable.toLowerCase();
  const safe = p.probe.expectIfSafe.toLowerCase();

  // access-control style: "200 with another user's data" vs "401/403/redirect"
  const is2xx = status >= 200 && status < 300;
  const isAuthBlock = status === 401 || status === 403 || (status >= 300 && status < 400);

  // strong, mechanical signals first
  if (mentions(safe, ['401', '403']) && isAuthBlock) return 'safe';
  if (mentions(safe, ['redirect', '302', 'login']) && (status >= 300 && status < 400)) return 'safe';
  if (mentions(vuln, ['200', 'data', 'other user', "another user", 'without auth', 'unauthorized access']) && is2xx) {
    // a protected resource returning 2xx to an unauthenticated request is the classic bypass signal
    return 'vulnerable';
  }
  // status-code cross-check: vuln oracle names a 2xx and we got 2xx, safe oracle names a block and we got a block
  if (namesStatus(vuln, status)) return 'vulnerable';
  if (namesStatus(safe, status)) return 'safe';

  return 'needs-review';
}
function mentions(s: string, needles: string[]): boolean { return needles.some((n) => s.includes(n)); }
function namesStatus(oracle: string, status: number): boolean {
  const m = oracle.match(/\b([1-5]\d\d)\b/g);
  return !!m && m.includes(String(status));
}
function verdictDetail(v: AuditVerdict, status: number | undefined, p: AuditProbe): string {
  const got = status !== undefined ? `HTTP ${status}` : 'no response';
  if (v === 'vulnerable') return `${got} matched the vulnerable signal ("${p.probe.expectIfVulnerable}"). ${p.why}`;
  if (v === 'safe') return `${got} matched the safe signal ("${p.probe.expectIfSafe}") — protection confirmed present.`;
  return `${got} was inconclusive against the oracles — needs human review, NOT assumed safe. (${p.why})`;
}

function redactBody(s: string): string {
  return (s || '')
    .replace(/("?(?:password|token|secret|authorization|apikey|api_key|jwt|session)"?\s*[:=]\s*)"?[^",}\s]+/gi, '$1"***"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***jwt***');
}
