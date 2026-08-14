# Xsion × SoA — the closed-loop brain (PLAN → EXECUTE → VERIFY)

**Idea (user):** Xsion uses SoA as its brain. SoA reads the target's code → produces the flows/steps to check →
Xsion executes them (Playwright) → SoA verifies what was tested: were the findings correct against the code and
the intended flow? A closed loop where SoA is the brain on both ends and Xsion is the hands.

---

## The three seams (all verified in Xsion's code)
| Phase | Who | Xsion integration point (exists today) |
|---|---|---|
| **PLAN** | SoA reads repo → flows | `TestCase { edgePath, name, kind }` + `TransitionEdge` graph. Today from mechanical discovery; SoA makes them intent-driven. |
| **EXECUTE** | Xsion (unchanged) | `startPlaywrightTestRun(projectId, runId)` → `StepResult[]` (pass/fail/attempts/screenshotKey per step). Xsion's hands — do NOT rebuild. |
| **VERIFY** | SoA reads results + code | `TestRun { stepResults, failedStepIndex, summary }`. SoA judges: real bug vs flaky selector; did it cover the intended flow. |

## The bridge (Node ⇄ Python)
Xsion is Node/TS, SoA is Python. Cleanest bridge = Xsion **shells out** to a thin SoA JSON script (no rewrite,
no HTTP server needed for v1). SoA already exposes `run_core(task, project_root)` + `split_task` + `soa_backend`.
- New file `soa_gemini/xsion_bridge.py`: `plan(repo, base_url) -> {flows:[...]}` and
  `verify(repo, flow, step_results) -> {verdict, real_bug|flaky, reasoning}`. Reuses soa_backend (1 key, all
  providers) + SoA's repo-reading tools. Emits STRICT JSON on stdout (Xsion parses).
- New Xsion module `apps/api/src/brain/soaClient.ts`: `spawn`s python, sends JSON on stdin, parses stdout,
  timeout + error-guard. ONE seam, quarantined (like SoA's own backend seam).

## PHASE 1 — PLAN (SoA as flow-generator). The provable first slice.
- `xsion_bridge.py plan`: SoA reads the repo (routes/components/mutations — its proven competence; it
  reverse-engineered sloxt's appointment flows by hand this session) → emits a flow list:
  `[{ name, role, steps:[{intent, expectedOutcome}], expectedFinalState }]`.
  Uses `split_task`-style decomposition ("what are the independent user journeys in this app").
- Xsion: `apps/api/src/brain/soaPlanner.ts` calls `soaClient.plan(repoPath, baseUrl)` → maps each flow to a
  Xsion `TestCase` (or a new richer `IntentTestCase` — see Data below). New route
  `POST /projects/:id/plan-with-soa`.
- **Proof gate:** run on sloxt → SoA prints correct flows (book/edit/cancel appointment as owner/employee/
  customer). This alone validates the thesis before any executor work. Cheap (~$0.10), sloxt flows already known.

## PHASE 2 — EXECUTE (Xsion, mostly unchanged)
- Xsion's Playwright runner drives each intent-step. GAP: today `edgePath` is edge-IDs from discovery; SoA's
  steps are INTENTS ("click 'Edit' on an appointment"). Bridge option A (v1, cheap): SoA's intent maps to
  Xsion's existing candidate/selector resolution (getCandidateActions already scores by role/text/testid — an
  intent like "click Edit button" resolves via role=button name=Edit). Option B (later): per-step SoA fallback
  when the selector fails — but per the model research, keep SoA OUT of the per-click loop by default (slow/$$).
- Reuse the DANGEROUS_LABELS guard + screenshots + stepResults. NO executor rewrite.

## PHASE 3 — VERIFY (SoA as oracle — the half that makes this novel)
- `xsion_bridge.py verify`: given (the flow SoA planned, the StepResult[] Xsion produced, the repo) → SoA reads
  the relevant code + trace → returns `{ flowCovered: bool, findings:[{step, verdict: real_bug|flaky_selector|
  expected, reasoning, codeRef}] }`. This answers the user's "was it correct on findings against code and
  intended flow." Xsion stores it on the TestRun as `soaVerification`.
- FAIL-SAFE (carry SoA's discipline): SoA must NOT fabricate a pass; a failure it can't explain → "unverified",
  never "flaky". Same floor as SoA's controlled eval.

## Data additions (Xsion `models.ts`, additive — don't break existing)
- `IntentFlow { name, role, steps: IntentStep[], expectedFinalState }`, `IntentStep { intent, expectedOutcome }`.
- `TestRun.soaVerification?: { flowCovered, findings: SoaFinding[], generatedAt }`.
- `SoaFinding { stepIndex, verdict:'real_bug'|'flaky_selector'|'expected', reasoning, codeRef? }`.

## What SoA contributes that Xsion lacks (verified):
soa_backend (kimi/claude/gemini via 1 key + routing + retry + spend-cap — Xsion has NO LLM), repo-reading
(flow enumeration + failure triage), fail-safe eval discipline. Xsion keeps: Playwright exec, graph/replay,
candidate scoring, ws, dangerous-label guard.

## Boundaries (advisor-shaped): SoA GENERATES + TRIAGES (code-reading, its lane); Xsion EXECUTES (per-click DOM,
its lane). SoA is NOT in the click loop. This is exactly "tests both code AND deployed UI": SoA = code side
(what flows SHOULD be / is a failure real), Xsion = runtime side (does the deployed app do it).

## Build order (smallest-provable-first):
1. `xsion_bridge.py plan` + prove on sloxt (SoA prints correct flows). ← START HERE, ~$0.10, validates thesis.
2. `soaClient.ts` spawn-bridge + `soaPlanner.ts` + `/plan-with-soa` route → flows become Xsion TestCases.
3. Wire EXECUTE (intent→selector resolution reusing candidates.ts).
4. `xsion_bridge.py verify` + store soaVerification + fail-safe floor.
5. End-to-end on a real deployed sloxt localhost.

## Risks: (a) scope creep — do NOT rebuild Xsion's executor or put SoA per-click. (b) intent→selector resolution
is the real technical gap (Phase 2/3 boundary) — prototype it early. (c) Python⇄Node bridge fragility — strict
JSON contract + timeout + the ONE quarantined seam. (d) cost — planning/verify are few big calls (cheap);
per-click SoA would be expensive (avoided by design).
