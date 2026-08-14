# Xsion — AI-brain features (two testing modes)

Xsion now has a code-aware AI brain (SoA). This is the feature architecture for the two fundamentally
different testing modes the user identified. Written as a spec (advisor-reviewed); build order at the end.

## The shared substrate (both modes use it)
Xsion already captures, per crawl: a TransitionEdge/StateNode **graph** (deterministic replay), **click context**
(nav/dialog/main + role/label/testid), **fingerprints**, **NetworkCall** (method/url/status), **ConsoleEvent**
(level/message), **screenshots**. This observation stream is the raw material the brain reasons over. Plus the
**intent-runner** (Playwright drives SoA-planned flows) + **soaClient** bridge (Node↔Python).

---

## MODE 1 — CODE-AWARE (repo + deployed URL/localhost). *Partially proven tonight.*
The oracle is THE CODE. SoA reads the repo → plans flows → Xsion executes on the live app → SoA verifies each
step AGAINST the code (real_bug | flaky_selector | expected | unverified). Verdicts are FACT-CHECKABLE (tonight:
0 fabrication, every claim true; dependency-aware; fail-safe "unverified" when a prior step blocked it).
HONEST STATUS: every step that EXECUTED was verified correctly — but most steps did NOT land (intent→selector
misses), so SoA has NOT yet verified genuine app behavior end-to-end, only its harness's misses. → intent→
selector resolution is the PREREQUISITE (shared, see build order), not Mode-1 polish.

### Mode 1 features (the code oracle unlocks these):
- **Spec-driven flow generation** — flows from routes/components/mutations (proven: named real PUSH/SMS/EMAIL
  channels, Paid-Users filter, etc.).
- **Code-grounded triage** — real-bug vs flaky-vs-test-limitation WITH a code citation (proven, fact-checked).
- **Regression oracle** — after a code change (e.g. our dent editAppointment work), SoA knows what SHOULD change
  → generates targeted flows + verifies the diff's intent landed in the UI. (Ties back to SoA's edit work.)
- **Coverage gap report** — SoA compares the executed flows against the code's routes/mutations → "these
  endpoints/screens were never exercised."

---

## MODE 2 — CODE-LESS / BLACK-BOX (deployed URL ONLY, no repo). *The novel, harder product. NOT built.*
SoA has NO repo → its filesystem tools (Read/Grep) don't apply, and NO tool touches the live app. So the
architecture INVERTS: **Xsion observes, SoA reasons over the observation as TEXT.** SoA becomes the curious
explorer — decides where to go, builds a map, forms hypotheses, judges behavior — from UX convention + what
Xsion actually observed.

### The one new bridge verb (the real build):
`explore(observation) → {map, flows, findings}` — NO repo arg. Xsion passes a JSON payload: the a11y/DOM tree of
current + visited states, the graph-so-far, network calls, console events, screenshots-as-refs. SoA returns:
what the app appears to DO (a semantic map), candidate user flows, and anomalies. **BATCHED, not per-click**
(the model-research boundary: per-click LLM = slow/$$; Xsion crawls MECHANICALLY, SoA reasons over the
ACCUMULATED map in a few big calls). Keeps SoA as generator/triager, same boundary as Mode 1.

### ⚠ THE ORACLE PROBLEM (the defining risk — fail-safe or bust):
Mode 1's verdicts are fact-checkable because the code is ground truth. **Mode 2 has NO ground truth** — SoA
judges "should this work?" from convention alone = exactly where a model FABRICATES confident-wrong findings.
So Mode 2's verdict vocabulary is DELIBERATELY WEAKER:
- **`real_bug`** — RESERVED for MECHANICALLY-OBSERVED facts Xsion actually saw: an HTTP 5xx, an uncaught JS
  exception/console error, a broken/404 link, a form that submits → error response, a dead-end/blank state.
  These need NO code and are HONEST. Evidence (the console line / status code) is ATTACHED.
- **`anomaly` / `suspicious`** — looks off by UX convention (a button that does nothing visible, a form with no
  feedback) but not mechanically proven. Flagged for HUMAN review, never asserted as a bug.
- **`unverifiable`** — can't judge without the spec. The default when in doubt. (Mode 2 leans on this heavily —
  that's correct, not a weakness.)

### Mode 2 features (black-box, code-free):
- **Autonomous site map** — SoA explores the deployed app → a semantic map ("this is a login → dashboard →
  users/plans/chats admin panel"), no code needed. (Xsion's mechanical graph + SoA's semantic layer.)
- **Convention-based flow discovery** — SoA infers the intended journeys from the UI alone → runnable flows.
- **Mechanical bug surfacing** — the honest half: 5xx/console-exception/broken-link/dead-end detection with
  attached evidence. This is real, code-free, non-fabricatable.
- **FE + BE probing** — FE via the DOM/interaction; BE via the NetworkCall stream (SoA sees the API calls each
  action fires → flags 4xx/5xx, slow calls, error payloads) WITHOUT the backend code.
- **Diff-over-time** — re-explore later → SoA diffs the map → "this flow changed / this page is now broken."

---

## BUILD ORDER (recommendation, not a menu):
1. **intent→selector resolution** (SHARED PREREQUISITE — both modes need SoA's decisions to actually LAND on
   elements). Tonight's flaky_selector failures are OUR parser missing, not app bugs. Fix: SoA emits richer
   selector hints per step (role/label/testid, not a descriptive phrase), OR a read_page→resolve pass in the
   runner. Until this works, neither mode verifies REAL behavior. Cheapest, unblocks everything.
2. **Mode 1 completion** — with (1), get ONE flow to fully execute + SoA verify genuine app behavior end-to-end.
   Small, proves the whole Mode-1 claim (currently "verified its own misses").
3. **Mode 2 `explore` verb** — the inverted bridge + batched observation-reasoning + the WEAK verdict vocab.
   The novel build. Start with the mechanical-bug half (5xx/console/broken-link) — honest + non-fabricatable —
   before the convention-based judgment half.
4. Wire both into Xsion routes/store/FE (a mode toggle: "I have the code" vs "URL only") = product not script.

## Why this is the right shape: Mode 1 = code oracle = strong verdicts (proven). Mode 2 = no oracle = fail-safe
weak verdicts + mechanical facts (honest by design). Both share the graph substrate + intent-runner. SoA stays
generator/triager (batched), never in the per-click loop. This matches the whole session's discipline: fail-safe
over confident-wrong, and the boundary the model research established.
