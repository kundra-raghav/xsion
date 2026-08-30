/**
 * comprehension/firewall.ts — §4 Layer 4: the ONLY firewall barrier that survives the LLM launder.
 *
 * THE THREAT (verified live in this codebase, design §4): the comprehension model's job is to inform WHAT to test —
 * so its output feeds the `surface` that reaches an LLM planner (breakItService → bugReproService.surfaceHints →
 * soaClient), and the LLM authors expectHeld/expectBroke prose that a regex converts into a mechanical verdict
 * (apiProber). If ANY Evidence-typed field (a rationale, an observedDelta, a `statusCodes:[403]` paraphrase) lands in
 * that prompt, the LLM paraphrases it into an oracle expectation → interpretation authoring a verdict. The leak is a
 * STRING IN A PROMPT, so branded types and import-lint (Layers 1–2) are inert against it.
 *
 * THE BARRIER: the comprehension model reaches a prompt through EXACTLY ONE serializer — `toPromptSurface` below —
 * which emits ONLY addressing (WHERE/WHAT/ORDER), by an explicit field ALLOWLIST, never a blanket JSON.stringify.
 * Evidence fields are structurally excluded before the prompt is built. firewall.hermetic.ts asserts no Evidence key
 * ever appears in the output. This does NOT trust the LLM not to repeat evidence — it removes the evidence first.
 *
 * SCOPE (design §4, explicit): this makes the COMPREHENSION channel clean. The pre-existing SoA `expect*` channel is a
 * separate, acknowledged interpretation channel (SoA's pre-declared oracle, re-verdicted by the answer-oracle loop);
 * closing it means editing production verdict code and is out of scope here. Honest position: clean on the
 * comprehension channel via this serializer; acknowledged-and-gated on the SoA channel.
 */

/** A test target the planner emits: pure ADDRESSING. By construction it carries NO proposition — no expected*, no
 *  shouldBe, no assertion, no oracle field — so even if it leaked past a cast, there is nothing verdict-shaped to
 *  leak. `kind` uses NEUTRAL TARGETING vocabulary (what to probe), never a bug-class name (a verdict). `why` is
 *  display-only and, being Evidence-natured, is NOT part of the prompt surface (see toPromptSurface). */
export interface TestTarget {
  /** resolvable element/route identity — WHERE. (Reuses the crawl's selector-identity shape; opaque string here.) */
  target: string;
  /** WHAT to do — a mechanical action, never an assertion. */
  action: 'click' | 'fill' | 'select' | 'navigate' | 'observe';
  /** WHEN — targeting/prioritization order. Lower = sooner. */
  order: number;
  /** the entity/scope this target concerns — an addressing NAME, never a claim about it. */
  entity?: string;
  scope?: string;
  /** NEUTRAL targeting kind — what surface to exercise. NEVER a bug-class name (no 'privilege-escalation'; use
   *  'cross-role-write-differential'). This is the address of a test, not its verdict. */
  kind:
    | 'cross-role-write-differential'   // (was 'privilege-escalation') probe whether a write by role A is enforced for role B
    | 'role-visibility-differential'    // a view/field one role reaches and another doesn't — probe server enforcement
    | 'state-transition'                // exercise an entity transition
    | 'unverified-capability'           // an affordance seen but never exercised
    | 'coverage-gap';                   // a route/view the crawl couldn't reach
  /** DISPLAY-ONLY rationale for humans. Evidence-natured — deliberately NOT emitted by toPromptSurface. */
  why?: string;
}

/** The fields of a TestTarget that are ADDRESSING and therefore safe to serialize into an LLM prompt. This allowlist
 *  is the firewall: anything not named here (notably `why`, and any future evidence field) is structurally excluded
 *  from the prompt surface. Adding an evidence-shaped field to TestTarget without adding it here keeps it OUT of
 *  prompts by default — the safe direction. */
const PROMPT_ALLOWLIST = ['target', 'action', 'order', 'entity', 'scope', 'kind'] as const;
type PromptField = typeof PROMPT_ALLOWLIST[number];

/** Fields that must NEVER reach a prompt (evidence). Enumerated so the hermetic test can assert their absence and so a
 *  reviewer sees exactly what the firewall blocks. Kept in sync with TestTarget's evidence-natured fields. */
export const EVIDENCE_FIELDS = ['why', 'rationale', 'observedDelta', 'statusCodes', 'evidence', 'reason'] as const;

/** THE ONE SERIALIZER. Turn a list of TestTargets into the plain object the LLM planner surface is built from —
 *  emitting ONLY the allowlisted addressing fields. This is the single seam the comprehension model uses to reach a
 *  prompt; nothing else in the layer may hand model data to an LLM. Returns plain data (not a string) so the caller's
 *  existing surface-assembly does the final stringify — but over an object that provably contains no evidence. */
export function toPromptSurface(targets: TestTarget[]): Array<Pick<TestTarget, PromptField>> {
  return targets.map((t) => {
    const out: any = {};
    for (const f of PROMPT_ALLOWLIST) if (t[f] !== undefined) out[f] = t[f];
    return out as Pick<TestTarget, PromptField>;
  });
}

/** Guard used by the hermetic test (and any defensive caller): does an arbitrary object graph contain any
 *  evidence-named key? A serializer output must return false here. Recursive, cycle-safe. */
export function containsEvidenceKey(obj: unknown, seen = new WeakSet<object>()): boolean {
  if (obj == null || typeof obj !== 'object') return false;
  if (seen.has(obj as object)) return false;
  seen.add(obj as object);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if ((EVIDENCE_FIELDS as readonly string[]).includes(k)) return true;
    if (containsEvidenceKey(v, seen)) return true;
  }
  return false;
}
