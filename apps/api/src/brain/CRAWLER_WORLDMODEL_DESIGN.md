# Xsion Crawler → the App World-Model (design + R&D)

> **Status: PLAN / R&D. No implementation until approved.** This document is the *input-grounded* design for
> rebuilding the crawler as Xsion's shared brain. Every stage traces to a **measured** defect (below), and every
> "coverage" claim is stated against a **ground-truth denominator**, not declared.

---

## ★ ARCHITECTURAL RULE (learned the hard way, 2026-08): SoA/LLM is NEVER on the critical path

Every reliability failure this project hit traces to an **awaited SoA (agentic LLM) call blocking a deterministic
path** — it hung, mis-parsed, or timed out, and everything downstream died with it. Fixed three separate times:
`flow-synth (map)` → hung >150s; `break-it (plan)` → 5-min timeout killed runs before the scaffold ran.

**The rule, for any engine that consumes SoA:**
1. The **deterministic layer is the spine** — flows come from a graph walk (`graphFlows`), attacks from the
   structural scaffold (`scaffoldMissing` over observed/learned fields). These never hang and are the same every run.
2. SoA is a **bonus enrichment** (naming a flow, proposing an extra attack), never the source of truth.
3. Any awaited SoA call gets a **fail-fast timeout (≤45s) + try/catch → empty result**, so a hang falls through to
   the deterministic path instead of blocking the engine. Never a long (minutes) await on the critical path.
4. SoA output is **validated + repaired** (one re-ask on parse failure), never trusted raw.

This is why the product is reliable *despite* a variance-prone LLM backend: the LLM can fail freely and the engine
still produces grounded results.

---

## 0. The reframe (what the crawler IS)

The crawler is **not a page/sitemap maker.** It is the **domain expert of the app under test** — a persistent
knowledge base that *every* other Xsion feature (api-test, break-it, bug-repro, mission) consults. It knows what the
app **is, has, can do, and cannot do**, grounded in what it actually observed.

Engines do not re-discover the app. They **ask the crawler.**

**The canonical query (the user's own acceptance test):**

> "Test the complete event functionality on NZCurriculum school."

The crawler decomposes this strategically, from what it already modelled:
does this project *have* that school? → does the school *have* events? → *where/how* to access events → what an event
*does* → how to *see all* events → how to reach the *Calendar* → how to *create* an event (which **requires** knowing
groups / teachers / progress-identifiers / date / repeats) → *verify* it was created → how to *access* the created
event → *CRUD* it → *drag/move* it.

All of that is already inside the model. The engine just executes the plan the crawler hands it.

### Three locked design decisions (confirmed with the user, 2026-08-17)

1. **Output = model + planner (both).** *Layer 1* = the semantic model (entities, capabilities, edges, scopes),
   persisted. *Layer 2* = `ask(scope, goal) → strategic decomposed plan`. Engines use whichever layer they need. The
   query/plan interface is itself a product surface.
2. **Action depth = two-phase, confidence-gated.** The crawler **first learns the shape** (access path, required
   fields, prerequisites, flows) read-only; **then, once confident, it actually performs CRUD to verify** — create,
   confirm it landed, edit / drag / delete. Capability knowledge is *inferred* → escalated to *proven-by-doing* only
   after a confidence threshold is met.
3. **Scope is first-class.** The model is organized *by scope*: `project → schools/tenants → per-scope entities +
   capabilities + roles`. A capability can exist in one scope and not another, recorded explicitly. "Events on
   NZCurriculum" is a natural query, not a post-hoc filter.

---

## 1. Measured evidence (the R&D pass, 2026-08-17)

Ran the **current** crawler against both real targets with real creds (harness dumped the full map + interaction
graph + captured network). Both failed **at the altitude that matters — authentication — and then lied about it.**

### 1a. schooltalk (`qa.schooltalkapp.com`, Mode-2 / URL-only)

| Observation | Value |
|---|---|
| `looksLikeLogin` | **`false`** (false negative) |
| Result | crawled the **login screen** as if it were the app |
| "pages mapped" | 3 — `/`, "Setup new password", "Google" (these are the SSO buttons) |
| Reported status | **`done`, `frontier: 0`, `reachedLimit: false`** — i.e. *"fully mapped, nothing left"* |
| Captured API (direct proof) | **`POST https://qa-auth.schooltalkapp.com/Token → 401`** + Google FedCM/GSI calls |

**Two distinct defects.** (i) **Detector defect:** `looksLikeLogin` returns false when there is no
`input[type=password]` on the page — but schooltalk is **SSO-first** (Continue with Google / Microsoft / Setup new
password; no password field until you pick a path), so login is *never even attempted*. (ii) **Honesty defect:** the
crawl reported `done / frontier:0` on a login-screen-only map — **confidently claiming complete coverage having seen
0% of the app.** This is the failure the user *felt* ("failed poorly"). **Fixing auth does not fix this** — the same
code path will over-claim for any future reason.

> ⚠ **Open risk (needs a cheap probe before schooltalk can be the demo target):** login to schooltalk was never
> *attempted*, so those creds are **untested**. "Setup new password" implies an email/password path exists behind a
> click — but if the only real path is Google/Microsoft **consent**, that is a flow Xsion *cannot* automate → the
> honest verdict is a **capability-gap**, not a bug. Must be settled by Stage L0's schooltalk auth probe.

### 1b. dent (`admin.thedent.in`, Mode-1 / code + creds)

| Observation | Value |
|---|---|
| `looksLikeLogin` | `true` (correct) |
| Form | textbook: `#email` + `#password` + "Sign In" — filled & clicked **correctly** |
| Crawler's `tryLogin` | returns **FAIL** → `login result=false` → **0 pages** |
| **Network capture (the settling measurement)** | **`POST /graphql adminLogin → 200`**, real JWT (`role: super_admin`), password field gone, URL → `/` dashboard, then fires `trendingItems` + `planStats` |

**Defect: timing, not auth.** Login **actually succeeds** in ~3s. `tryLogin` fails only because its **fixed
`waitForTimeout(2500)`** gives up *before* the auth round-trip + dashboard hydration complete, then sees the password
field still present and declares failure. **Fix = poll for a terminal signal** (URL change / password-gone /
authenticated-app affordance appears), never a fixed sleep. **dent is fully reachable** — creds good, role
`super_admin`.

> ⚠ **Process lesson (recorded so it isn't repeated):** I first asserted "dent = timing" from **button text alone**,
> with no network capture. Slow-200 and 401 are *opposite* plan inputs (reachable vs blocked). Only the response
> capture settled it. **No durable claim from inference where a measurement is one command away.**

---

## 2. Ground truth per target (the denominator every stage is proven against)

Without a denominator, "3 pages mapped" is unprovable — it can only be *declared*, which is the exact failure mode
this rebuild exists to escape. So:

### dent — authoritative (pulled from code)
- **13 routes:** `/` (Dashboard), `/users`, `/users/:userId`, `/users/:userId/workout-plan`,
  `/users/:userId/meal-plan`, `/plans`, `/notifications`, `/monitoring`, `/chats`, `/chats/:conversationId`,
  `/settings`, `/explore` (+ `/login`, + `*`→`/`).
- **8 nav sections:** Dashboard, Users, Plans, AI Chats, Explore, Notifications, Monitoring, Settings.
- **148 GraphQL operations** = the capability vocabulary (`ActivateUser`, `DeleteUser`, `Generate/Regenerate/Delete
  WorkoutPlan`+`MealPlan`, `Create/Publish Challenge/NutritionTip/Resource`, `BroadcastNotification`, …).
- **Entities:** users, workout-plans, meal-plans, challenges, nutrition-tips, resources, chats, notifications, plan-stats.
- Crawler reaches **0 / 13 routes, 0 / 148 capabilities** today (quits at login).

### schooltalk — PROVISIONAL (no code; establishable only on first authenticated crawl)
- Ground truth is **unknown until auth works** and is not hand-enumerable (creds are for programmatic use only, and
  the app is multi-tenant/multi-school). The user's NZCurriculum paragraph (§3.3) is the *shape* of what a correct
  model must contain; the concrete list per school is a **Stage-L0 deliverable**, not an assumption.

**No stage is "verified" until measured against the denominator above. Declaring ≠ proving.**

---

## 3. Capability audit — current model vs the four named asks (code-proven)

| # | Capability | Verdict | Evidence / gap |
|---|---|---|---|
| 1 | Every element mapped (honest denominator) | **EXISTS** | `affordancesPresent` uncapped (`stateSignature.ts:154-159`); stored `crawlTypes.ts:44`. Minor: denominator is the standard interactive selector set, not `cursor:pointer` divs. |
| 2 | Interaction graph (state nodes, `(element,action)→dest` edges, persisted) | **EXISTS, weak identity** | `GraphEdge{fromSig,toSig,action,toPath,…}` (`crawlTypes.ts:115-133`). **Element identity = a ≤40-char text label, not a selector** → same-text buttons collapse; a relabeled button splits. |
| 3 | **One button → multiple actions/flows** | **ABSENT in practice** | Schema *permits* it (`toSig` in the edge key), but three **load-bearing** guards collapse every control to one destination: visited-dedup (`crawlMapService.ts:517`), permutation guard (`:705`), known-sig gate (`:1152`). No outcome-set, no context dimension. |
| 4 | Multi-role / multi-tenant traversal | **PARTIAL** | Real per-role *re-crawl* (`:353`) + real exclusivity *diff* (`routes/projects.ts:148-152`) exist. But the role loop is **external/manual** (one `roleId` per POST; nothing iterates `project.roles`), and **`GraphEdge` has no role field** → the graph cannot answer "which role can click X". |

**MEASURED on the complete dent crawl (2026-08-18):** edges = `{navigate: 17, click: 14}` — click edges DO exist
(the `›` click-paths). Element identity in them is the ≤40-char text label, and the collision is visible live: two
distinct controls both labelled `Users` (one in the Explore tab-bar → `/explore › Users`, one in the Progress view →
`/progress › Users`) are separable ONLY because their `fromSig` differs; two same-label controls in the SAME state
would collapse. The selector already EXISTS at the click site (`safeClickExplore` tags each candidate
`data-xsclk-N`, crawlMapService.ts:1096) but is EPHEMERAL and discarded — `safeClickExplore` returns only strings
(`{urlNavs, viewLabels, …}`), destroying identity BEFORE edge emission. So L1-a = capture a DURABLE selector at the
click site + widen the return type to carry it through; NOT a field-add on `GraphEdge`. (NB: `CAP-3: 0` in the crawl
summary is a spanning-tree artifact — the harness keys `(fromSig,label)→set(toSig)` and a tree has no such collision
by construction — NOT evidence dent's buttons are single-outcome. Do not cite it as a dent measurement.)

**Two orderings this forces (not negotiable):**
- **Cap-2's selector identity is a *prerequisite* for Cap-3.** Outcome-sets keyed on a fuzzy text label are
  unreliable; fix element identity first.
- **The Cap-3 guards are load-bearing for *termination*** (they are why the crawl halts — click-path explosion was
  caught once before). The fix is **not** "relax the guards"; it is a **bounded outcome-set** (§4.3).

---

## 4. The formal model (states, edges, entities, scopes, capabilities)

The model is layered. Each layer is a strict dependency of the one above it.

```
L3  PLANNER          ask(scope, goal) → ordered, prerequisite-aware TestPlan        ← what engines call
L2  SEMANTIC MODEL   Scope → { Entities, Capabilities } with prerequisite edges     ← "what the app is/has/can do"
L1  INTERACTION GRAPH  States (nodes) + Transitions (edges) with selector identity  ← "what leads where"
L0  SESSION / AUTH   authenticated? which scope? which role?                        ← the gate everything rides on
```

### 4.1 L0 — Session / Auth (the foundation; both live failures live here)
- **`authState(page): {authenticated, scope?, role?}`** — a **scored judgment over unitless signals**, *not* one
  selector (the schooltalk lesson). Signals: presence of auth-vocabulary controls ("Continue with…", "Sign in",
  "Setup new password", "Back to login"); *absence* of any authenticated-app affordance; Mode-1 `routeManifest`
  declaring the landing route `requiresAuth`. Ranked/relative, never a fixed threshold constant (see §5, confidence).
- **`establishSession()`** — replaces the fixed-sleep login with **poll-to-terminal-signal** (url change / password
  gone / an authenticated affordance appears), with an honest cap. Handles SSO-first (must *click a path* before a
  password field exists) and returns **capability-gap** when the only path is third-party consent.
- **Honesty invariant (its own defect, testable without auth working) — TWO independent guards:**
  > (1) *Detector-based:* a crawl that never established an authenticated session on a login-gated app MUST NOT
  > report `done` — it reports `blocked`.
  > (2) *Detector-independent tripwire:* even if the detector said "not a gate", a crawl that mapped only a handful
  > of pages, where every page shows auth/SSO vocabulary and no authed affordance was seen anywhere, is `blocked`.
  > This second guard is what would have caught the ORIGINAL schooltalk failure (the detector false-negatived for two
  > runs). Together they mean a login-screen-only map cannot leave as `done` regardless of the detector's verdict.
  >
  > **Both tripwire inputs MUST be detector-independent** (learned the hard way — a regression run showed
  > `sessionEstablished = !detectorResult` let a detector miss disable the guard meant to catch it). Now:
  > `sessionEstablished` = login-success-only; `everSawAuthedAffordance` = observed per-page in the crawl loop; a
  > failed in-page read (`AuthSignals.ok === false`) is never counted as "no affordance".
  >
  > **KNOWN LIMITATIONS (documented, not yet fixed):** (a) `pagesMapped <= 3` is a hardcoded ruler — a login wall
  > with ≥4 clickable paths could slip the tripwire; should become rank-relative (§5). (b) The public-app escape
  > valve rests on the authed-affordance heuristic (`AUTHED_VOCAB` label or `__nav:≥3`), which MEASURED 0 on a real
  > authenticated schooltalk dashboard once — so a small public site with a thin nav is a false-`blocked` risk. Both
  > are L0-hardening follow-ups, tracked, not blockers for L1.

### 4.2 L1 — Interaction graph (states + transitions)
- **Node = abstracted state signature** (keep the Crawljax SFG approach already in place).
- **Edge = `(fromState, element, action) → toState`**, where **`element` carries a stable selector**, not just a
  text label (closes Cap-2). Edge also carries the **role** and the **scope** under which it was observed (closes
  Cap-4's graph gap).

### 4.3 L1.5 — Bounded outcome-sets (closes Cap-3 without breaking termination)
A single control may map to a **set** of outcomes — but re-probing the same control is **licensed only when a *named
context dimension* differs**, giving a finite set with an explicit stop condition:

```
outcomes(state, element) : Set<{ context, toState, effect }>
  context ∈ { role, formValidity(valid|invalid), dataPresence(empty|nonempty), gateChoice(schoolX|schoolY), … }
```

The three load-bearing guards stay **on** *within a fixed context*; a new edge for the same element is allowed **only
across a declared context change** (e.g. Submit-with-invalid-form → validation-error state vs Submit-with-valid-form
→ navigate-away). Termination: the context dimensions are a *finite, declared* set, so the outcome-set per control is
bounded. This is the real mathematical content — a finite product of `(control × named-context)`, not a
combinatorial revisit of raw click-paths.

### 4.4 L2 — Semantic model (entities, capabilities, scopes)
```
Scope        = { id, kind: project|tenant|school, parent?, children[] }
Entity       = { name, scope, fields[], accessPath: State-path, listPath?, instances?: sampled }
Capability   = { verb: view|list|create|edit|delete|move|…, entity, scope, role,
                 accessPath, requiredFields[], prerequisites: Capability[]|Entity[],
                 status: inferred | proven | failed | capability-gap,     ← the two-phase axis
                 verify: how success is detected, evidence?: run-ref }
```
- **Prerequisite edges** are the spine of the NZCurriculum example: `create(event)` depends on
  `list(group) ∧ list(teacher) ∧ knowledge(progress-identifier, date, repeats)`. The planner walks these.
- Every Entity/Capability is **scoped**; the same verb can be `proven` in one school and `capability-gap` in another.

### 4.5 L3 — Planner (`ask`)
`ask(scope, goal)` returns an ordered, prerequisite-resolved **TestPlan**. **The central artifact of this whole
design is the concrete return value of `ask('NZCurriculum', 'test event functionality')`** — written field-by-field
in §3.3's shape. *If we can write that object precisely from the model, the model is well-formed; if we cannot, the
model is underspecified* — and we learn that at design time, not build time.

---

## 5. Confidence (the two-phase gate) — relative, never a constant

The gate that licenses escalating a capability from **inferred → proven-by-doing** (i.e. actually mutating) must be
a **rank-relative / unitless** judgment over observations — because *fixed constants faking app-dependent judgments*
was the documented generalization defect of the old crawler. A capability is confident-enough-to-verify when, e.g.:
- all `requiredFields` resolved to concrete, observed inputs;
- the `accessPath` replayed **twice** to the same destination state (stable, not flaky);
- all `prerequisites` are **bound to observed entities** (real group ids, teacher ids, etc.), not guessed.

**Failed-verify semantics (must be explicit, or two-phase rots):** a verify attempt that does not confirm success
sets the capability to `failed` **or** `capability-gap` (drag-not-committable, consent-required, …), lowers
confidence, records the evidence, and **emits a finding** — it never silently downgrades to "inferred" and never
reports the capability as working.

---

## 6. Mutation on production (must be decided before any verify-mode run)

`admin.thedent.in` is **production**. Phase-2 verify *creates / edits / deletes real data* there. Non-negotiables:
- **Per-scope mutation authorization** — verify-mode is opt-in per target, gated on the existing project
  `security.authorized` flag *plus* an explicit "allow data mutation" acknowledgement.
- **Probe-data hygiene** — mutations use a recognizable prefix (e.g. `xsion-probe-…`), and every create is paired
  with its cleanup delete; a verify run leaves no residue.
- **Safety-gate composition** — the existing gate *maps but never clicks* destructive controls (Delete/Send/Pay).
  Verify-mode *must* click Save and Delete on **its own probe data only**. Define the seam: the gate stays hard for
  everything except a capability the crawler is verifying against data it just created.

---

## 7. Staged plan (each stage: the defect it closes + how it is proven)

Ordered by dependency. **L0 → L1 → L2 → L3.** Nothing below implemented until this doc is approved.

| Stage | Closes (measured defect) | Proof (against ground truth) |
|---|---|---|
| **L0-a** Poll-to-terminal-signal login | dent timing-fail (§1b) | dent crawl authenticates → reaches `/` dashboard, `>0` authed pages. |
| **L0-b** Scored `authState` (SSO-aware) | schooltalk detector false-negative (§1a-i) | schooltalk correctly classified *not-authenticated* on the SSO landing (no false "in the app"). |
| **L0-c** Honesty invariant | schooltalk `done`-while-blocked (§1a-ii) | a login-gated crawl with no session reports **`blocked`**, never `done/frontier:0`. *Testable without auth working.* |
| **L0-d** schooltalk auth probe | the open risk (§1a) | verdict: email/password path exists **or** consent-only capability-gap — settles whether schooltalk can be the demo. |
| **L1-a** Selector-based edge identity | Cap-2 weak identity | two same-text buttons produce two edges; a relabeled button stays one. |
| **L1-b** Role + scope on every edge | Cap-4 graph gap | graph answers "which role/scope can fire X". |
| **L1.5** Bounded outcome-sets | Cap-3 absent | one control yields a *set* across named contexts (e.g. Submit valid vs invalid) — with proven termination. |
| **L2** Entities / capabilities / scopes | (new capability) | dent: model contains ≥N of the 148 ops as capabilities with access paths; scope tree present. |
| **L3** `ask(scope, goal)` planner | (new capability) | `ask('NZCurriculum','test event functionality')` returns the §3.3 field-by-field object; dent equivalents resolve. |
| **L-role** Internal role loop | Cap-4 manual loop | one crawl iterates `project.roles`; per-role/per-scope diff emitted. |

---

## 8. What is reused vs rebuilt
- **Reused:** state-signature / SFG node abstraction, `affordancesPresent` denominator (Cap-1, works),
  per-role re-crawl + exclusivity diff (Cap-4 partials), the safety gate (recomposed in §6), persisted site-model.
- **Rebuilt / new:** L0 auth (scored detector + poll login + honesty invariant), selector-based edge identity,
  role/scope on edges, bounded outcome-sets, the L2 semantic layer, the L3 planner, two-phase confidence + verify.

---

## 9. Open questions for the user (before implementation)
1. **schooltalk auth path** — is there a real email/password login, or is it Google/Microsoft consent only? (L0-d
   settles it empirically, but if you already know, it re-sequences the demo target.)
2. **Verify-mode on dent prod** — OK to have the crawler create/edit/delete **its own probe-prefixed data** on
   `admin.thedent.in` during the proven-by-doing phase (§6), or keep dent **inferred-only** and reserve verify-mode
   for a staging/QA target?
3. **First scope to model end-to-end** — dent (rich code ground truth, 148 caps, but single-tenant) or schooltalk
   (true multi-school scope, the NZCurriculum example, but Mode-2 and auth-risky)?
```
```
