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
function runBridge(args: string[], timeoutMs = 240_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SOA_BACKEND: process.env.SOA_BACKEND || 'perplexity',
      SOA_PERPLEXITY: process.env.SOA_PERPLEXITY || '1',
      // kimi-as-driver (the routing fix) + a sane per-call spend cap for planning/verify
      SOA_V3_PROMOTE_ON_ANY_READ: process.env.SOA_V3_PROMOTE_ON_ANY_READ || '1',
      SOA_MAX_COST_USD: process.env.SOA_MAX_COST_USD || '0.60',
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
  const res = await runBridge(['breakit', repo || '-', JSON.stringify(input)], 300_000);
  return { plan: Array.isArray(res.plan) ? res.plan : [], error: res.error };
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

export async function explorePage(
  pageView: unknown
): Promise<{ clicks: ExploreClick[]; vision?: boolean; error?: string }> {
  const res = await runBridge(['explore', JSON.stringify(pageView)], 150_000);
  return { clicks: Array.isArray(res.clicks) ? res.clicks : [], vision: !!res.vision, error: res.error };
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
