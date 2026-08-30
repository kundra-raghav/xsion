/**
 * soaClient.ts — the ONE quarantined seam between Xsion (Node) and SoA (Python).
 * Spawns soa_gemini/xsion_bridge.py, sends args, parses its strict-JSON stdout.
 * SoA is the code-aware brain: plan() enumerates test flows from the repo; verify() triages
 * execution results against the repo (real_bug | flaky_selector | expected | unverified).
 */
import { spawn } from 'child_process';
import * as path from 'path';

const SOA_DIR =
  process.env.SOA_DIR || path.resolve(process.env.HOME || '', 'Desktop/Dev/Son_Of_Antonov/soa_gemini');
const PYTHON = process.env.SOA_PYTHON || 'python3';
const BRIDGE = path.join(SOA_DIR, 'xsion_bridge.py');

export interface IntentStep {
  intent: string;
  expectedOutcome?: string;
  skipIfFilled?: boolean;   // a VALID (happy-path) fill that should KEEP an existing non-empty value rather than overwrite a form default
}
export interface IntentFlow {
  name: string;
  role: string;
  steps: IntentStep[];
  expectedFinalState?: string;
}
export interface SoaFinding {
  stepIndex: number;
  verdict: 'real_bug' | 'flaky_selector' | 'expected' | 'unverified';
  reasoning: string;
  codeRef?: string | null;
}
export interface SoaVerification {
  flowCovered: boolean;
  findings: SoaFinding[];
}

/** Run the bridge with args; resolve its parsed JSON stdout. Rejects on spawn/parse/timeout. */
// RETRY DECISION (2026-08-30, extracted for hermetic testing): the SoA bridge is an LLM behind a python subprocess.
// It intermittently emits NO json or UNPARSEABLE json — a transient LLM/serialization hiccup that a fresh call almost
// always clears. This was the shared root of audit's 6/4/0 probe drift, bug-repro's "reply not valid JSON", and goal's
// occasional dead step. Retry ONLY those two shapes. NEVER retry a TIMEOUT (would double a 300s wait) or a spawn
// failure (an environment problem a retry can't fix). A VALID response with an empty array is NOT a hiccup — it's a
// legitimate "found nothing" (e.g. auditPlan returning 0 probes, which the audit guard correctly reports); retrying it
// would be wrong and would churn cost. So the decision keys on the ERROR shape, never on the parsed content.
export function bridgeErrorIsRetryable(errMessage: string): boolean {
  return /produced no JSON|JSON parse failed/i.test(errMessage) && !/timed out|Failed to spawn/i.test(errMessage);
}

// SECOND retry trigger (2026-08-30): the bridge can RESOLVE successfully with valid JSON that carries its OWN error
// field — the LLM output was empty/unparseable at the bridge's internal parse layer (`{probes: [], error: "SoA audit
// unparseable"}`). The subprocess didn't fail, so bridgeErrorIsRetryable never sees it; audit's silent zeros came from
// exactly here. Retry that shape. THE TRAP: match the error's SHAPE, not its mere presence — a legitimate result
// stated as an error string ("no vulnerabilities found") must NOT retry (it's a real finding, and retrying churns
// cost + could re-break the audit no-silent-clean-bill guard). And an empty result with NO error is a real "found
// nothing" — never retried. So key strictly on unparseable/empty-reply phrasing.
export function bridgePayloadIsRetryable(res: any): boolean {
  const e = String(res?.error || '');
  if (!e) return false;   // no error field ⇒ a valid (possibly empty) result ⇒ never retry
  return /unparseable|no json|empty (reply|response|output)|parse fail(ed|ure)?|malformed|could not parse/i.test(e);
}

// PER-TASK MODEL ROUTING (2026-08-30): each SoA task (the bridge's args[0]: 'audit' / 'breakit' / 'bugrepro' /
// 'explore' / …) can be routed to a DIFFERENT model, because a measured A/B shows the models have opposite strengths
// (Kimi: fast plans that fit the 45s breakit cap; Claude Sonnet: better at the code-grounded audit but slower). The
// model for a task is `XSION_MODEL_<TASK>` (e.g. XSION_MODEL_AUDIT=anthropic/claude-sonnet-4-5), falling back to a
// global SOA_PPLX_MODEL pin, else the bridge's own turn-type router (today's behavior). ALL UNSET BY DEFAULT → routing
// is opt-in and behavior is unchanged until an env var is set; a winning A/B flips one var, not code. Exported for test.
// SHIPPED DEFAULT ROUTING TABLE: data-backed per-task model defaults. audit→sonnet is justified by an A/B on the REAL
// crawl surface (Kimi 2/4 non-empty with 3/4 UNPARSEABLE; Sonnet 3/4 non-empty, avg 3.3, ZERO unparseable — parse
// reliability is the load-bearing metric for a security engine). Everything else stays '' = the bridge's own router
// (Kimi strong-tier), which the same A/B showed is fast enough for breakit's cap and fine elsewhere. An env var
// (XSION_MODEL_<TASK>) overrides the default; setting it to '' forces back to the router.
const _MODEL_DEFAULTS: Record<string, string> = {
  audit: 'anthropic/claude-sonnet-4-5',
};
export function modelForTask(task: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `XSION_MODEL_${String(task || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  // an env var — even set to empty — is authoritative (empty ⇒ force the router, overriding any shipped default).
  if (key in env) return String(env[key] || '').trim();
  return (env.SOA_PPLX_MODEL || _MODEL_DEFAULTS[String(task || '').toLowerCase()] || '').trim();
}

// A pinned model can become UNPROVISIONED (the bridge's soa_backend documents claude-sonnet-5 → 400). If a pinned call
// fails that way, fall back to the router (unpinned) rather than fail every call — the pin is advisory, not a hard dep.
export function bridgeErrorIsProvisioning(errMessage: string): boolean {
  return /unprovisioned|not provisioned|not enabled|does not have access|not authorized to use|invalid[_ ]request|unrecognized|400/i.test(errMessage);
}

// forceUnpinned: the provisioning-fallback attempt clears the pin so the bridge's router picks a live model.
function runBridgeOnce(args: string[], timeoutMs: number, forceUnpinned = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const pinned = forceUnpinned ? '' : modelForTask(args[0]);
    const env = {
      ...process.env,
      SOA_BACKEND: process.env.SOA_BACKEND || 'perplexity',
      SOA_PERPLEXITY: process.env.SOA_PERPLEXITY || '1',
      // kimi-as-driver (the routing fix) + a sane per-call spend cap for planning/verify
      SOA_V3_PROMOTE_ON_ANY_READ: process.env.SOA_V3_PROMOTE_ON_ANY_READ || '1',
      SOA_MAX_COST_USD: process.env.SOA_MAX_COST_USD || '0.60',
      // per-task model pin (empty ⇒ bridge's own router decides, i.e. today's default). SOA_PPLX_MODEL bypasses the router.
      ...(pinned ? { SOA_PPLX_MODEL: pinned } : {}),
    };
    const proc = spawn(PYTHON, [BRIDGE, ...args], { cwd: SOA_DIR, env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`SoA bridge timed out after ${timeoutMs}ms (args: ${args[0]})`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn SoA bridge: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // the bridge prints exactly one JSON object on stdout; take the last {...} line to be safe
      const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) {
        return reject(new Error(`SoA bridge produced no JSON (exit ${code}). stderr: ${err.slice(-400)}`));
      }
      try {
        resolve(JSON.parse(line));
      } catch (e: any) {
        reject(new Error(`SoA bridge JSON parse failed: ${e.message}. Got: ${line.slice(0, 300)}`));
      }
    });
  });
}

// RETRY WRAPPER: one extra attempt on an empty/unparseable reply (see bridgeErrorIsRetryable), with a short backoff.
// 2 attempts total. Every other failure (timeout, spawn error) propagates immediately — no wasted second wait.
async function runBridge(args: string[], timeoutMs = 240_000): Promise<any> {
  const MAX_ATTEMPTS = 2;
  const hasPin = !!modelForTask(args[0]);   // is this task routed to a specific model?
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await runBridgeOnce(args, timeoutMs);
      // RESOLVED but the payload's OWN error says the LLM output was empty/unparseable → retry (subprocess was fine).
      if (attempt < MAX_ATTEMPTS && bridgePayloadIsRetryable(res)) {
        console.log(`[XSION][soa] "${args[0]}" resolved with an unparseable/empty payload (error: ${String(res.error).slice(0, 60)}) — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return res;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      // PROVISIONING FALLBACK: a pinned model can be unprovisioned (400). Retry ONCE UNPINNED so the router picks a
      // live model — the pin is advisory, never a hard dependency that fails every call. Only when a pin was in effect.
      if (attempt < MAX_ATTEMPTS && hasPin && bridgeErrorIsProvisioning(msg)) {
        console.log(`[XSION][soa] "${args[0]}" pinned model failed (${msg.slice(0, 50)}) — falling back to the router (unpinned)`);
        try { return await runBridgeOnce(args, timeoutMs, true); } catch (e2: any) { throw e2; }
      }
      if (attempt < MAX_ATTEMPTS && bridgeErrorIsRetryable(msg)) {
        console.log(`[XSION][soa] "${args[0]}" returned empty/unparseable — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** PLAN: SoA reads `repo` → returns intent-flows for the app deployed at `baseUrl`. */
export async function plan(repo: string, baseUrl: string): Promise<{ flows: IntentFlow[]; error?: string }> {
  const res = await runBridge(['plan', repo, baseUrl]);
  return { flows: Array.isArray(res.flows) ? res.flows : [], error: res.error };
}

export interface RouteEntry {
  path: string;          // as declared in the router, e.g. '/users/:id'
  requiresAuth: boolean;
  role: string;
}
/** ROUTES (Mode-1 completeness): SoA reads the repo's ROUTER → the complete declared route manifest, so the
 * crawler can seed its frontier with SPA routes that aren't <a href> anchors. Zero clicks, no live-app mutation. */
export async function routeManifest(repo: string): Promise<{ routes: RouteEntry[]; error?: string }> {
  const res = await runBridge(['routes', repo]);
  return { routes: Array.isArray(res.routes) ? res.routes : [], error: res.error };
}

export interface FieldReqAugment {
  selector: string;
  codeNote?: string | null;
  accepts?: string[] | null;
  pattern?: string | null;
  maxSize?: string | null;
  required?: boolean | null;
}
/** FIELDREQS (Mode-1): SoA reads the code to augment DOM-observed field requirements with server-side
 * constraints the DOM under-declares (file-size caps, allowed MIME, API-enforced regex). Returns ONLY citable
 * augmentations, matched back by selector. Never fabricates uncitable rules. */
export async function fieldReqs(
  repo: string,
  observed: unknown
): Promise<{ requirements: FieldReqAugment[]; error?: string }> {
  const res = await runBridge(['fieldreqs', repo, JSON.stringify(observed)]);
  return { requirements: Array.isArray(res.requirements) ? res.requirements : [], error: res.error };
}

export interface ExploreClick { action?: 'click' | 'fill'; label: string; value?: string; why: string; }
/** EXPLORE (SoA-on-stall, the brain in the loop): the mechanical crawl is STUCK on a page — it followed links +
 * clicked the obvious nav but found no way deeper. Hand SoA the page (url/title/text + the clickable inventory)
 * and it returns an ORDERED list of labels to click to reach new sections, with reasoning. Never proposes a
 * destructive action or a label not on the page. Black-box: no repo needed. */
export interface BreakField { name: string; mode: 'literal' | 'empty' | 'long' | 'omit'; value: string; }
export interface BreakStep {
  phase: 'happy' | 'crud' | 'adversarial' | 'api';
  title: string;
  intent: string;
  fields: BreakField[];
  /** true = the app ACCEPTING this input is itself the bug (validation it owes); false = acceptance is fine, only a
   * crash/exception/5xx is a bug. Fail-safe default is false so a missing flag never manufactures a finding. */
  acceptIsDefect: boolean;
  value: string;   // human-readable summary of `fields` (telemetry/back-compat)
  apiHint: string;
  expectHeld: string;
  expectBroke: string;
  codeRef: string | null;
}
/** BREAKIT (the adversarial QA brain): SoA plans happy→CRUD→adversarial→API for a feature, each attack carrying a
 * PRE-DECLARED oracle (expectHeld=pass / expectBroke=finding). The executor matches observation vs the oracle —
 * never post-hoc — so a finding is mechanically checkable + code-cited. */
export async function breakItPlan(
  repo: string,
  input: unknown
): Promise<{ plan: BreakStep[]; error?: string }> {
  // FAIL-FAST (45s, was 300s): the SoA breakit plan is an agentic LLM call that is variance-prone — it either plans
  // quickly or hangs the whole engine (measured: 5-min waits killed the run before the DETERMINISTIC scaffold — which
  // now has the crawler's learned form fields — ever ran). The scaffold is the reliable coverage; SoA's plan is a
  // bonus. On timeout, return an empty plan gracefully so the engine falls through to the scaffold, not a dead run.
  try {
    // Cap env-tunable (XSION_BREAKIT_PLAN_CAP_MS): default 45s keeps the SoA plan off the critical path (a slow plan
    // used to hang the run before the deterministic scaffold ran). A SLOWER-but-stronger model (Claude) exceeds 45s
    // 4/4 in the A/B — raise the cap ONLY when running XSION_PLAN_SOURCE=both with such a model; it's a `both`-mode
    // knob, not a default-path change (default is scaffold-only, which skips this call entirely).
    const cap = Number(process.env.XSION_BREAKIT_PLAN_CAP_MS) || 45_000;
    const res = await runBridge(['breakit', repo || '-', JSON.stringify(input)], cap);
    return { plan: Array.isArray(res.plan) ? res.plan : [], error: res.error };
  } catch (e: any) {
    return { plan: [], error: `SoA plan skipped (${String(e?.message || e).slice(0, 60)}) — using the deterministic scaffold from the learned form fields.` };
  }
}

export interface BugRepro {
  steps: { intent: string }[];
  expectedBehavior: string;
  actualBehavior: string;
  interaction: string;
  codeAssessment: 'matches-code' | 'contradicts-code' | 'unclear' | null;
  codeRef: string | null;
  openQuestion: string | null;
}
/** BUGREPRO: turn a QA bug ticket into concrete repro steps + an oracle (expected vs actual) + a code cross-check.
 * The executor runs the steps → reproduced / not-reproduced / cant-perform. Preserves the ticket's uncertainty. */
export async function bugRepro(
  repo: string,
  input: unknown
): Promise<{ repro: BugRepro | null; error?: string; raw?: string }> {
  const res = await runBridge(['bugrepro', repo || '-', JSON.stringify(input)], 300_000);
  return { repro: res.repro || null, error: res.error, raw: res.raw };
}

export interface MissionStep { engine: 'break-it' | 'bug-repro' | 'api' | 'audit' | 'env-matrix' | 'flow'; feature: string; ticket: string; flowName: string; why: string; }
export interface MissionPlan { summary: string; steps: MissionStep[]; }
/** MISSION (the prompt-agent router): parse a plain-English mission → an ordered plan of engine-calls the runtime
 * executes in sequence (break-it / bug-repro / api / audit / env-matrix / flow). SoA routes, does not execute. */
export async function missionPlan(
  repo: string,
  input: unknown
): Promise<{ mission: MissionPlan | null; error?: string }> {
  const res = await runBridge(['mission', repo || '-', JSON.stringify(input)], 180_000);
  return { mission: res.mission || null, error: res.error };
}

/** GOAL-STEP (2026-08-23): the general goal-agent's per-step planner. Reuses the EXPLORE bridge verb (cmd_explore
 *  dumps the whole pageView into the prompt — so goal/memory/lastActions carried as fields REACH the LLM with NO
 *  cross-repo Python edit) at the SAME 45s fail-fast discipline. Returns the next intent(s) as {clicks}; the runGoal
 *  loop maps click→'click "label"', fill→'fill "label" with "value"'. Empty/timeout → [] → the loop stops honestly. */
export async function goalStep(
  goal: string, observation: any, memory: any, lastActions: any[],
): Promise<{ clicks: ExploreClick[]; vision?: boolean; error?: string }> {
  // prepend the goal + memory into a `text` the explore prompt reads, and pass them as fields too (belt + braces).
  const pageView = {
    ...observation,
    goal,
    memory,
    lastActions,
    text: `GOAL: ${goal}\nMEMORY: ${JSON.stringify(memory?.facts || {})}\nLAST: ${(lastActions || []).map((a: any) => `${a.intent}→${a.verdict}`).join('; ')}\n\n${observation?.text || ''}`,
  };
  return explorePage(pageView);
}

export async function explorePage(
  pageView: unknown
): Promise<{ clicks: ExploreClick[]; vision?: boolean; error?: string }> {
  // FAIL-FAST (2026-08-22): explore is an ON-STALL crawl-depth AID, never a critical-path dependency (see the
  // "SoA/LLM is NEVER on the critical path" rule in CRAWLER_WORLDMODEL_DESIGN.md). It used to block 150s/call and,
  // with stall+plateau caps of 3+4, could stack to ~17.5 min and HANG a run. Cap at 45s and degrade to an empty
  // action list on timeout/error so the crawl loop simply continues deterministically instead of blocking.
  try {
    const res = await runBridge(['explore', JSON.stringify(pageView)], 45_000);
    return { clicks: Array.isArray(res.clicks) ? res.clicks : [], vision: !!res.vision, error: res.error };
  } catch (e: any) {
    return { clicks: [], vision: false, error: `explore skipped (${e?.message || 'timeout'})` };
  }
}

export interface AuditProbe {
  cls: string;                 // access-control | session/cookie | input-validation | cors/headers | secrets | other
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  codeRef: string;             // path:line — REQUIRED; a probe with no citation is dropped by the bridge
  why: string;
  probe: {
    method: string;
    pathTemplate: string;
    sendWithoutAuth: boolean;
    expectIfVulnerable: string;
    expectIfSafe: string;
  };
}
/** AUDIT (Mode-1 security): SoA reads the security-relevant code → a code-cited PROBE PLAN the executor runs
 * safely. SoA fires nothing. Every probe carries a codeRef + explicit vulnerable/safe oracles so the executor
 * can't fabricate a verdict. */
export async function auditPlan(
  repo: string,
  surface: unknown
): Promise<{ probes: AuditProbe[]; error?: string }> {
  const res = await runBridge(['audit', repo, JSON.stringify(surface)], 300_000);
  return { probes: Array.isArray(res.probes) ? res.probes : [], error: res.error };
}

export interface TestProposal {
  type: 'flow' | 'api' | 'fe-api' | 'generate' | 'security' | 'env-matrix';
  title: string;
  why: string;
  priority: 'P0' | 'P1' | 'P2';
  target: string;
}
/** TESTPLAN (SOA-steer): SoA reasons over the mapped app + code → a prioritized list of test proposals the
 * operator approves item by item. This is the "SoA decides what to test" surface. */
export async function testPlan(
  repo: string,
  map: unknown
): Promise<{ proposals: TestProposal[]; error?: string }> {
  const res = await runBridge(['testplan', repo || '-', JSON.stringify(map)], 300_000);
  return { proposals: Array.isArray(res.proposals) ? res.proposals : [], error: res.error };
}

/** VERIFY: SoA reads `repo` + the executed result → triages each step against the code. */
export async function verify(
  repo: string,
  flow: IntentFlow,
  results: unknown
): Promise<SoaVerification & { error?: string }> {
  // write flow + results to temp files (the bridge accepts a path or a JSON string; strings are simpler here)
  const res = await runBridge(['verify', repo, JSON.stringify(flow), JSON.stringify(results)]);
  return {
    flowCovered: !!res.flowCovered,
    findings: Array.isArray(res.findings) ? res.findings : [],
    error: res.error,
  };
}
