# XSION — Sequential Feature Audit & Fix Log
_The system of record. Every Xsion feature, crawler → last, audited ONE AT A TIME. Each gets: current behavior, live-test data, root cause, fix, re-test proof. Nothing skipped. Discipline: one change → live-test on a REAL app → record → next._

**Autonomy mandate (user, 2026-08-14):** lead dev+test to a WORKING product, loop till success, record every failure's learning, reiterate. Audit EVERY feature sequentially. No stopping until it works.

**★ GOVERNING PRINCIPLE — THE ENTREPRENEUR LENS (user, 2026-08-14):** "'needs review' is not a product. Where's the button where I approve and it gets to work? Think like an entrepreneur — how will people USE this feature, when and why — then redesign it." → EVERY feature's output must be a NEXT ACTION, never a dead-end verdict. This governs the whole audit, not just break-it. The three laws (from the v2 plan): (1) every finding → a next action; (2) leave a durable artifact (ticket / failing spec / passing spec); (3) hard-signal-only auto-findings.
- **RESOLUTION SURFACE (the ONE thing all engines flow into — BUILT for break-it):** every finding carries `resolution: {kind, question?}`. kinds: `file-ticket` (broke → ticket + failing spec), `none` (held/pass → keep passing spec), `authorize` (→ authorize-target toggle), `credentials` (→ add-creds prompt), `answer-oracle` (→ the ONE yes/no that re-verdicts it, wired to acceptIsDefect = the teach-the-oracle "approve button"), `unreachable` (feature not reached → why + help-it-reach affordance). deriveResolution() pure, resolution.hermetic 17/17. Because today's work made needs-review causes DISTINGUISHABLE, the UI can now show the RIGHT control per finding.
- NEXT: expose acceptIsDefect on a route (answer flows back → re-verdict); then the UI control; then same treatment for bug-repro + mission. Per feature below, record "WHAT THE USER DOES WITH THE OUTPUT" alongside technical status.

**Standing constraints:**
- Self-calibrating, never per-app hardcoded. No LLM in traversal loop.
- Every change deletes a constant OR adds a real capability. Prove live.
- Third-party prod sites (Swiggy) = read-only, mutation gate ON. Swiggy homepage is BOT-WALLED (bodyLen=0 headless) → bad verify target; use local fixture (localhost:5188) + dent + schooltalk.
- Verify targets I control: `breakit-fixture` (b04d1764, localhost:5188/event.html, authorized), `exp-fixture` (localhost:5188/index.html), dent, schooltalk-m2.

---

## FEATURE INVENTORY (audit order — crawler first, toward last) — STATUS
1. **Crawler / feature-mapping** — ✅ dedup fix proven (3→6 slugs); ⏳ self-calibration redesign + reach-state coverage open
2. **State signature / collapse / content-volume** — ✅ substrate proven (24/24 hermetic); ⏳ contentVolume-blind-to-calendar-grid open (trap pinned)
3. **Login / auth handling** (multi-role) — ✅ works; HYDRATION FLAKINESS iterated (each fix caught a real seam): (a) post-login settle-until-stable (≥4 interactive AND stable across polls); (b) per-navigating-step settle (the crawler waits on every nav, the EXECUTOR didn't — asymmetry); (c) settle on ANY passing click/select — schooltalk's school-click is an IN-PLACE SPA route (dashboard re-mounts with NO url change my `navigated` gate missed → "My Calendar" fired while only `button:"sc"` rendered) + STABLE=3 (survives a 40→1→40 collapse). date-nav REJECTED (advisor). MEASURING (3rd time): schooltalk 2× must pass `click "My Calendar"`. Also: `settleUntilStable` extracted as a shared helper (one fn, both nav seams).
4. **Break-it engine** — ✅ WORKING (FP floor + login + API prober + resolution surface + deterministic coverage 3/3)
5. **Bug-repro engine** — 🔧 reach-state WORKING (drives deep); precondition-create + date-nav = current live thread
6. **Intent runner** — the execute seam — ✅ verbs: fill/click/submit/drag/hover/press/select/reload/rightclick/doubleclick; ⏳ audit not formalized
7. **API prober** (#207 break-it's api phase) — ✅ BUILT + PROVEN (observed-only, same-app, verb-gated, 24/24)
7b. **API TESTING engine (the menu's "API testing · CONTRACT" — SEPARATE from #207)** — ✅ BATTLE-TESTED + FIXED. Was writing results to stepResults/replay but NOT artifacts[0] → every reader (UI + /record) saw BLANK `{}`. FIXED: results now in artifacts[0]. LIVE on schooltalk (45 observed endpoints): **17 passed · 26 failed · 2 skipped** — honest per-endpoint verdicts (GET ServiceDiscovery → status-drift 200→401 unauthenticated; gsi/fedcm → pass 200 JSON; POST Token/Login → skipped safe-by-default mutating). Engine WORKS: replays observed read-only endpoints, safe-by-default, honest status-drift detection. (26 "fails" = 401s from replaying protected endpoints without the auth session = correct honest behavior.)
8. **Mission / prompt-agent** — plain-English → route to engines — ✅ AUDITED: aggregates real sub-run outcomes (never invents); ADDED actions-rollup (mission ends with "next actions" from every sub-run's resolution, not a dead-end summary; missionRollup.hermetic 8/8)
9. **map-diff / xsion check CLI** — ✅ AUDITED: already embodies the laws (retest-set not everything, silent-when-clean, honest exit codes, PURE coverage decision). mapDiff 26/26, CLI 21/21. No change needed.
10. **Project knowledge / learning store** — ✅ AUDITED: navigational-only + provenance + demote-on-contradiction + surfaceHints sorts confidence-desc (human-confirmed=1.0 leads) — all the "never learn a bug as correct" guardrails. ADDED `POST /answer-control` → stores needs-input answer human-confirmed → surfaced-first → passed to planner. Machinery PROVEN end-to-end; planner-applies-it is the ceiling (see loop section). LOGGED (knowledge-hygiene, worth doing someday, NOT chasing now): `observed` route-facts accumulate CROSS-TENANT (/demo,/qa learned while testing /nzcurriculum are wrong for the current target) → should be scoped per route-template + capped. 12/12.
11. **Runs history / frame playback / live view** — ✅ AUDITED: resolution wired to record; ADDED `actionsPending` count per run in the /runs list (history tells the user WHICH runs still need them).
12. **Security / mutation gate / consent** — ✅ AUDITED: verb-gated (UI fills + HTTP prober); bug-repro now marks created data (XSION-BUGREPRO-<runId>) — the last owed piece, DONE.

## ★ THE TEACH-THE-APP LOOP — the "magical sauce" — DEMONSTRATED LIVE (2026-08-15)
The full entrepreneur-lens loop, end-to-end on the real Lesson-2 ticket:
- Run reaches the event-PLANNING form (2/2 after settle fix), a step `select "Recurring" option` doesn't match → `needs-input` resolution with **5 REAL candidates** (Set Learning & Schedule / Select Teachers / Select Learners / Planning / Add New Tag). Degenerate 1-candidate cases (`button:"sc"` avatar) correctly suppressed → unreachable.
- STEP 1 ✅ user answers: `POST /answer-control {chosenControl:"Set Learning & Schedule"}` → `{ok:true, learned:"for 'select Recurring option' → 'Set Learning & Schedule'"}`.
- STEP 2 ✅ STORED in projectKnowledge: `for "select "Recurring" option", click "Set Learning & Schedule" | provenance:human-confirmed` (confidence 1).
- STEP 3 (loop close) — HONEST RESULT after 3 runs + 2 fixes: **the correction is STORED, LIVE (isLive passes human-confirmed), and SURFACED FIRST (surfaceHints already sorts confidence-desc → human-confirmed=1.0 leads), and passed to the planner in learnedNavigation. But SoA still doesn't APPLY it.** Root (advisor): (a) knowledge-quality noise — 3 cross-tenant `observed` recurrence route-facts (/demo,/qa learned while testing /nzcurriculum) compete with the 1 correction; (b) FORMAT/PHRASING mismatch — the correction is keyed to step `select "Recurring" option` but SoA re-plans the step as `set event to recur on 10 Sep/Oct/Dec` (different words), so it never matches its own step to the correction. Added bridge-prompt handling for step→control corrections (helps but insufficient). **CEILING BROKEN — the fix (user: "fix the planner applying the stored correction"):** the planner-quality gap is BYPASSED by enforcing the correction in the EXECUTOR, not the planner (advisor: "a fact applied by CODE can't be ignored; a fact in a prompt can"). NEW: when a click FAILS, `tryCorrection(page)` checks if any HUMAN-CONFIRMED correction's control label is present on THIS page → clicks it (keyed on the FAILURE + the page's candidates, NOT the step string → immune to SoA's phrasing drift). Constraints: human-confirmed ONLY (never observed cross-tenant noise — correction.hermetic 5/5 proves the extraction excludes them), respects DANGEROUS gate, marks the attempt `[corrected]`+recovered. Wired: bugReproService extracts control labels from human-confirmed selector facts → executeFlow(opts.corrections) → module `_corrections` → resolveClick failure path. ✅ PROVEN. Live run abaadf0a got the DEEPEST yet (7+ steps, full recurrence 10-Sep/Oct/Dec all PASS) — the correction didn't need to fire because the step SUCCEEDED via on-stall recovery that run (variance). So proved it DETERMINISTICALLY via a SYNTHETIC playwright hermetic (correctionFire 7/7, data: URL fixture): (1) intent-label-miss + correction-present → fires `kind:corrected` + actually clicks it; (2) NO corrections → miss fails, nothing clicked; (3) DANGEROUS correction → NOT auto-clicked (danger gate). The teach-the-app loop is now DETERMINISTIC end-to-end, CODE-ENFORCED — planner wording no longer matters. 250 assertions/14 suites green.
- **LIVE-FIRE demo attempts (3 runs): correction PROVEN correct but NOT organically triggered live.** Each time the corrected control (`Set Learning & Schedule`, `Doon School`) wasn't on the page WHEN a click failed — either the page was avatar-only (hydration flake) OR the step that would fail got PRUNED. ★ ROOT (advisor): on a GATED app, live-trigger construction is STRUCTURALLY BLOCKED — `pruneRedundantSteps` drops the very select/click step I engineered as the trigger (the reach-prefix `click "Demo School"` already satisfied school-selection). So the correction is a SAFETY NET that fires on an ORGANIC miss (a rendered page whose control the ticket mislabels) — which the improved engine now largely AVOIDS. Proven: extraction 5/5 + firing 7/7 SYNTHETIC (real browser: fires+clicks / no-corr-fails / dangerous-blocked) + wiring live (runs carry corrections, no breakage) + note now shows `[corrected] used your confirmed control` (distinguishable from `[recovered]`). Live organic fire = not observed (engine quality makes it rare — the RIGHT outcome for a safety net). CEILING accepted honestly.
- LATENT (logged, not chased): observed route-facts accumulate CROSS-TENANT — scope per route-template + cap (knowledge-hygiene).
- HONEST RESIDUAL: `click "My Calendar"` STILL fails with `button:"sc"` after 3 settle iterations — the flow RECOVERS (Create Event reachable without it, so outcome survives) but the STEP is still flaky. Not iterating a 4th time — the remaining causes (dashboard renders avatar-first / label truly differs) both point at needs-input, which is the built mechanism. Stated plainly, not folded into "good enough".

**★ SEQUENTIAL AUDIT COMPLETE (all 12 features). The RESOLUTION SURFACE (entrepreneur-lens "approve button") is wired END-TO-END:** break-it findings → bug-repro artifact → mission rollup → runs-history actionsPending → the resolve routes (`/findings/:i/resolve` yes-no, `/answer-control` which-control) that CLOSE each loop into projectKnowledge. 236 hermetic assertions / 12 suites green; web app tsc clean. "needs review" is no longer a dead end anywhere — every verdict carries what the user does next.
- **LIVE SMOKE-TEST PROVEN (run 25a5b0cb):** findings carry resolution `{none:10, unreachable:7, file-ticket:4}` (all 21 have a next-action), runs-list shows `actionsPending: 7`, outcome `4 broke · 7 review` (real, no FP flood). Resolve routes respond correctly (404 missing / 409 wrong-kind); re-verdict logic hermetic-proven (resolution 22/22). Loop is LIVE.

---

## AUDIT LOG

### [1] CRAWLER / FEATURE-MAPPING — ✅ core fix PROVEN, redesign in progress
- **Root found (probe-proven):** `slice(0,10)` over UNDEDUPED nested markup — 13 schools ×3 = 41 cands → only 3 crawled.
- **Fix (DONE, live-proven ×2):** dedup candidates by plain-lowercase label before cap. 3→**6 school slugs** (demo/demonstration/doon/facilitation/nzcurriculum/nzsky), 8→28 pages, Progressions cv 103–282.
- **Churn-fix EXPERIMENT: FAILED + reverted.** Hypothesis "reload-per-probe is churn" was WRONG — on a picker, reload-per-probe IS the enumeration mechanism (removing it → 6 tenants collapse to 1). Reverted; kept 2 free wins (no-op clicks don't reload). Revert re-verified 6 tenants.
- **OPEN — CALENDAR EMPTY, ROOT CORRECTED (2026-08-14, ★ my earlier "crawler reuses id across tenants" diagnosis was WRONG — code-verified):** the crawler does NOT rewrite query params — it takes `a[href]` verbatim (crawlMapService:545 `enqueue(abs.href)`) + click-paths navigate the app's own UI; NO code copies tenant A's `id=` onto tenant B's path. So `id=04eb731b` on demo+demonstration = the APP's "My Calendar" link serving that (shared/seeded QA calendar), NOT a crawler bug. The REAL issue is TWO separate capabilities, neither a URL bug: (a) **COVERAGE GAP** — NZ Curriculum's calendar is NOT in the map at all (crawler never descended into it) = the reach-the-state work; (b) **DATE NAVIGATION** — app defaults to date=2026-08-10 (empty week); the user's events are 10-Sep/Oct/Dec, so even a correctly-scoped calendar shows empty without navigating to the right week. contentVolume-blind-to-grid is a 3rd, lower concern (TRAP pinned stateSignature.hermetic #7). LESSON: don't write a root twice without code-proving it — "crawler reuses id" had the exact shape of the inert gate-seed/churn hypotheses. Verify NZ's real calendar id when robust login is available (standalone probe login too flaky; use the crawler's tryLogin).
- **OTHER OPEN:** self-calibration redesign (route-template normalization deletes detectGate cue-regex+NAV_HINT+anchor-cap). nzcurriculum dashboard renders blank (maybe real app defect). Login FLAKY (~50% land unauthenticated).
- Detail: memory project_xsion_crawler_root_fix.md; R&D scratchpad/CRAWLER_RND_SYNTHESIS.md.

### [4] BREAK-IT ENGINE — 🔧 IN PROGRESS
- **Roots (live-probed on Swiggy):** (a) submit hardcoded `click the Save button` — most apps have no Save → `no match for "Save"`; (b) fields filled 0/N — the field isn't on the page yet (Swiggy search is click-to-reveal: 0 inputs → click Search → /search → input appears); (c) api phase hardcoded early-return, no HTTP path (#207).
- **Field matcher is NOT the gap:** resolveFill already scores placeholder/aria/name (intentRunner ~380). Failure = 0 inputs present (wrong state), not unmatched.
- **FIX (a) submit affordance — BUILT + LIVE-PROVEN ✅:** new `submit` verb in intentRunner (`resolveSubmit`): derives submit-button(commit-verb label/type=submit/in-form) → click; else lone-text-input → Enter; else best-effort Enter. Deletes the "Save" constant. break-it emits `submit the form`.
  - **PROVEN by Swiggy /search unit test (the case old code COULDN'T do):** filled "pizza" on a form, Enter-submitted → URL moved /search → /search?query=pizza with real results. Old `click the Save button` had no Save to click there. Enter-path confirmed self-calibrating.
  - **Fixture run 671820c2 (2 broke · 6 review) is SUPPORTING not PROOF:** the fixture has a literal "Save Event" button, so the OLD code would also have driven it (Aug-13 pre-change run was 2 broke · 3 review, same shape). Real value: happy passed, crud 2 passed, adversarial 5 held + **2 real bugs** (End-before-start = console error/HTTP200 invalid persisted; Missing-end-date accepted). Confirms the engine drives + finds real bugs; the Swiggy test is what proves the NEW submit path specifically.
- **FIX (c) API prober (#207) — BUILT + PROVEN ✅:** new `apiProber.ts` — REPLAY observed endpoints only (never synthesize/assumed), same-origin only, NEVER auth endpoints, mutation-gate on HTTP verb (GET anywhere / writes need authorized), verdict from status+body vs oracle with fail-safe floor. Wired into runStep (`api` phase no longer early-returns; `map.api[]` threaded in).
  - **PROVEN:** apiProber.hermetic 18/18 (matching + discipline + verdict floor). LIVE HTTP proven end-to-end (httpbin): GET 404 + oracle-wants-rejection → HELD (real round-trip); GET → 503 → BROKE (hard 5xx). Fixture run f368238c (3 broke · 8 review): api attacks now say honest "no crawl-observed POST endpoint matches /api/events — not probed" (was the misleading "no API-request path yet" stub) because the static fixture has 0 observed endpoints + SoA assumed /api/events. NO regression: bugRepro 38/38, breakItService 7/7, stateSignature 24/24.
  - **The 'assumed' endpoint problem is a PLANNING defect** (SoA invents /api/events, /dapi/cart/add) — separate from the prober, worth a bridge-prompt fix later so plans only name observed endpoints.
- **⚠️ REGRESSION I INTRODUCED (found by verifying, must fix FIRST — blocks everything):** the submit fix flipped break-it from "all needs-review" to "all BROKE" (worse). schooltalk run 2d82f2dd = **9 broke, ALL FALSE POSITIVES.** Two mechanisms:
  1. `resolveSubmit`'s Enter fallback returns `matched:1` UNCONDITIONALLY (a keypress can't "fail") → `drovePass.clicked` always true → the `drove` gate (line 210) that used to stop non-driven attacks at needs-review is DEFEATED → non-driven attacks fall through to the broke logic. Evidence: happy/crud broke cite `fail:no input for "Event Title"` (form not even present) yet scored broke.
  2. `hasException = consoleErrors.length > 0` (line 201) counts AMBIENT noise: all 6 adversarial "broke" cite the SAME `Failed to load resource: the server responded...` (a 401/asset fetch on a partly-authed session) — identical evidence on 6 different attacks = ambient, not 6 bugs.
  - **FIXES:** (a) resolveSubmit Enter path must VERIFY it moved (url/DOM sig before/after; else matched:0+error); (b) a fill that failed "no input for X" forces `drove=false` (form absent ≠ attackable); (c) filter `/failed to load resource/i` + favicon/analytics from consoleErrors before hasException/oracle. Hard-signal = uncaught exception / rendered stack / 5xx, NOT a network fetch warning.
  - Re-verify: fixture 3-broke's 3rd finding is likely the same FP (Aug-13 baseline was 2). Real bugs have SPECIFIC PER-ATTACK evidence (fixture end-before-start, missing-end-date had differing signals) — that's the shape to keep.
- **api-probe path proven mechanically (httpbin: 404→held, 503→broke) but can't fire on real apps yet** — SoA plans against INVENTED paths (/api/demo/Teacher/calendar) not the observed qa-api.schooltalkapp.com ones. PLANNING defect (bridge prompt), separate from prober. registrable-domain widening DONE (43 same-app endpoints matchable, AWS/Google excluded; 24/24 hermetic).
- Detail: memory project_xsion_breakit_root.md.

### [4b] BREAK-IT PLAN VARIANCE — 🔧 the trustworthiness fix (deterministic coverage)
- **DEFECT (measured 3×, same fixture/code):** SoA re-plans from scratch every run → the fixture's planted end-before-start bug found only 1/3 runs (the "ordering" attack was sometimes simply not planned). A QA tool with non-deterministic coverage on an unchanged app is untrustworthy. `_ask_soa`→`run_core` passes NO temperature → backend default (~1.0) sampling noise. Correction: coverage must NOT depend on what the LLM thinks of.
- **FIX — DETERMINISTIC ATTACK-CLASS SCAFFOLD (`attackScaffold.ts`, pure, 16/16 hermetic):** the checklist lives in CODE not the prompt. From the crawl's observed `requirements[]`, enumerate invariant classes per field — empty(required)/long(text)/type-mismatch(typed)/**ordering(start↔end pairs)** — and for each (class×field) SoA's plan MISSED, synthesize the step with a mechanical oracle (reject=held, accept=broke). Same app → same classes EVERY run, any temperature. Runs even on empty SoA plan (the 0-findings case). Ordering detection is STRUCTURAL + false-positive-guarded: pair iff directional-match (start/end,from/to,min/max) AND remainders-equal AND (remainder empty OR range-ish) — so "Start"/"End"✓, "start date"/"end date"✓, but **"First name"/"Last name"✗** (remainder "name" not a range → NO manufactured "Last before First" attack). Wired into runBreakIt (appends scaffold to SoA's plan, logs LLM-vs-scaffold count).
- **DEPENDENCY FOUND: break-it silently degraded to NAME-ONLY planning** — the fixture map was `status:None, pages:0` (NEVER CRAWLED); breakItPlan works off the feature name alone. Now surfaced as a `test:think` "crawl this project first" (the "where's the button" principle — invisible failure → actionable). Re-crawled fixture → 3 reqs captured.
- **2 CRAWL EXTRACTION DEFECTS logged (under [1]/[2], not chased now):** (a) placeholder "start date" recorded as label "Start" (truncated — the empty-remainder branch makes the scaffold work anyway); (b) `required` under-reported as false on all fixture fields though the fixture DOES validate empty title → costs the empty-class attack. Both = DOM extraction not capturing what's there.
- **1st 3× (b9megigty) FAILED the bar** (ordering present 2/3, broke 1/3) → 2 more root fixes, both the same fault class:
  - **loose global-suppression key:** `coveredByPlan` set `ordering::*` / `type::*` from a broad TITLE regex (any title with "order"/"after"/"end...start") → wrongly suppressed the scaffold's own ordering step (RUN-2 had none). FIX: dedup keyed on the actual FIELD PAIR (`ordering::early|late`), only suppressing when a plan step FILLS BOTH pair fields; a titles-only match does NOT suppress (can't confirm coverage → add ours).
  - **attack ISOLATION** (the held-not-broke bug): the ordering attack left Title BLANK → the fixture's `if(!t)` "Title required" guard fired FIRST → held. FIX: every scaffold attack now HOLDS ALL OTHER FIELDS VALID (validValueFor per kind) so exactly ONE invariant is violated. (empty-class attack still leaves its own target blank.)
  - **field-misrouting hypothesis DISPROVEN** (both mine + advisor's): direct executeFlow test — "Start"→start-date input, "End"→end-date input, both pass, correct fields. The earlier `Event saved:"2026-08-15"` was the SAME preemption artifact (title empty→guard→wrong verdict), NOT a resolveFill bug. Don't re-litigate.
  - attackScaffold.hermetic now **19/19** (determinism + isolation + pair-dedup + First/Last-name false-positive guard).
  - **✅ BAR MET (job b4xnck4qz, 3× same fixture): ordering-attack-planned = True 3/3 AND ordering-broke = True 3/3.** The planted end-before-start bug is now found EVERY run (was 1/3). First genuine COVERAGE GUARANTEE in the engine — coverage no longer depends on what the LLM happens to think of.
- **[4] BREAK-IT STATUS: WORKING.** False-positive floor (executed-something gate + ambient-noise filter), login pre-step (reaches authenticated features), real API prober (#207, observed-only/same-app/verb-gated), resolution surface (the approve-button data — every finding → next action, 22/22), deterministic coverage scaffold (bar met 3/3). All hermetic-green + live-proven. REMAINING (lower priority, logged): SoA plans `(assumed)`/`{tenant}` api paths (bridge-prompt defect → prober correctly refuses); click-to-reveal reach-state (Swiggy /search); crawl extraction defects (label truncation, required under-report).

### [5] BUG-REPRO ENGINE — 🔧 IN PROGRESS (the user's "failed terribly" #1)
- **Symptom:** 22 runs, ALL `cant-perform` on the Lesson-2 schooltalk ticket. (Note: cant-perform is the CORRECT fail-safe verdict for a run that couldn't drive the app — the VERDICT is honest, the DRIVE is broken. Don't "fix" the honesty.)
- **Root (read the full stepsRun, run f2b6062b):** login SUCCEEDS (authResult:pass), "Click My Calendar" PASSES — so it's on a real authenticated page. Then everything fails on TWO layers:
  1. **Redundant/spurious steps** on an already-authenticated page: "Authenticate as a teacher" → parseIntent target "as a teacher" → no such control → `fail` (login pre-step already did this); "Accept terms of service" similar. These poison the flow early.
  2. **parseIntent target extraction too crude for ticket prose:** "Click the '5 Days Repeat' event" → hunts "5 Days Repeat" (real tile labelled differently); "Set the start date to October 10" → target "start date to October 10" (whole clause, not a field+value); "Refresh the browser" → looks for control "browser" (should be a page.reload). Also never selected the school (step "Select NZ Curriculum school" failed → stuck on default school, so the event/edit/planning flow isn't present).
- **SAME reach-the-state root as break-it + crawler:** can't drive the multi-step deep path (school→calendar→create recurring→edit→planning→date-picker) to where the bug lives.
- **REACH-THE-STATE — BUILT (`reachState.ts`, pure, 16/16 hermetic), the SHARED unblock (bug-repro + break-it + crawler-calendar):** CONSUME the crawl's recorded navigation instead of re-deriving it. `observedChoices(map)` = gates[].options[] ∪ single-click page labels (the picker options the crawl OBSERVED — no synthesis). `chosenOption(ticket, choices)` = longest-label match ("NZ Curriculum" beats "NZ"). `buildReachStatePrefix` prepends the EXACT recorded click `click "NZ Curriculum"` (reliable getByText, handles MUI <li>) so the run lands in the right tenant BEFORE the repro steps. `pruneRedundantSteps` drops (a) login/consent steps (the login pre-step already did them) + (b) the now-redundant SoA "select <school>" step (would fail on a page where the picker is gone — the mid-flow fail that poisoned earlier verdicts → cant-perform). Wired into bugReproService. General: any app whose feature sits behind a recorded chooser; fail-safe (no picker/no match → no prepend, non-gated apps unaffected).
- **1st live run (0e1e14e1): reach-state FIRED** (step0 = my prepend `click "NZ Curriculum"`, login-steps pruned, authResult=pass) but step0 FAILED: `Candidates on page: <empty>`, attempts:[]. ROOT: **post-login HYDRATION gap** — the login pre-step returns when the password field disappears, but the SPA re-renders /Teacher's portal picker ASYNC → the first step fired on an EMPTY DOM (crawler saw 41 candidates on this page; executor saw 0). FIX (intentRunner executeFlow, after auth pre-step): waitForFunction interactive-count>3 + settle, before step 0. Also fixed a PRUNE GAP: SoA emits field-level login steps ("fill Email field…") that LOGIN_STEP regex missed → added LOGIN_FIELD_STEP. reachState.hermetic 17/17. Added `reload` verb (parseIntent + dispatch) for the ticket's "refresh the page" step (was "no match for browser").
- **✅ REACH-STATE PROVEN — bug-repro TRANSFORMED (run 77d82d45).** Was: 22 runs, ALL cant-perform, step0 failed. NOW: **6 of 9 steps PASS, deep into the exact feature:** `click "NZ Curriculum"`✓ → `click "My Calendar"`✓ → `click recurring event`✓ → `click "Planning" tab`✓ → `refresh the page`✓ (new reload verb). The hydration-wait fix (executor was firing step0 on an empty post-login DOM) was the unlock.
  - 3 remaining fails, each DIFFERENT + honest: (1) duplicate `click "NZ Curriculum"` — SoA's other select form; FIXED (added `click` to SELECT_VERB, prunes it; 18/18). (2) `click "Edit"` — NOT a matcher bug: the event opened DIRECTLY into the edit/planning view (candidates: Set Learning & Schedule / Select Teachers / Planning / Add New Tag) — the app has no separate Edit button; SoA's step assumes a flow this app doesn't have. (3) `set "Lesson 2 start date"` — the date-nav gap + the ticket's precondition data (recurring event 10-Sep/Oct/Dec) likely not in this week (date=2026-08-10).
  - ★ FACT-CHECK CATCH: `finalText` LOOKED like it showed the bug ("Lesson 2 reverts to 10 September") but that was SoA's `actualBehavior` PREDICTION (finalText was empty) — did NOT observe the bug. Verdict correctly cant-perform. The `detail` is genuinely honest+actionable: "signed in fine but got stopped on a screen your ticket's steps don't mention (Set Learning&Schedule, Select Teachers…) — your steps assume [a different flow]."
- **[5] BUG-REPRO STATUS: WORKING (entrepreneur-lens loop COMPLETE).** On the REAL ticket (create precondition), a good run does 8/15 steps incl the WHOLE SETUP (NZ Curriculum→Create Event→fill title→set recurrence 10-Sep/Oct/Dec→Planning→refresh). All capabilities PROVEN: reach-state, create-precondition, MUTATION MARKER (`XSION-BUGREPRO-<runId>` lands on created data — verified `fill event title ... with "XSION-BUGREPRO-3fe5eb1b"`; user can find+delete), `needs-input` RESOLUTION (14/14 — when a control doesn't match but candidates exist, asks "which control is this step?" → user picks → projectKnowledge → run #2 uses it; NEVER guesses). HONEST CEILING: SoA plans controls this app lacks (no "Save" — auto-commits); building a Save-inference heuristic = the app-specific nudge the user rejected → declared ceiling per advisor. ⚠ RUN-TO-RUN VARIANCE = the login/hydration FLAKINESS (a weak run hydrates only the avatar button → fails at "My Calendar"; a good run gets through setup) — the mechanisms are solid, individual runs differ. Cosmetic: marker append doubles "with" when SoA's step already had "with a name" (works, ugly). Full suite 169 assertions/8 suites green.
- **NEXT (sequential audit): [8] mission → [9] map-diff/CLI → [10] project-knowledge → [11] runs-history → [12] security.** Each: what does the user DO with the output, is the verdict honest, deterministic coverage.
- **★★ STANDING PROCESS RULE (violated 5× now — ENFORCE):** NEVER edit a WATCHED src file OR restart the API while a live run is in progress — BOTH trigger a tsx-watch reload that ABORTS the run (orphans it as status:running forever). WORKFLOW: (1) batch ALL code edits, (2) let tsx reload settle, (3) kick the run, (4) HANDS OFF — no src edits, no restart — until it completes. Safe-during-run: reading records, editing .md/memory files (not watched), running hermetics in a separate tsx invocation. Capture runId from the POST, poll THAT id (list ordering has stale finishedAt).
- **STILL AFTER:** date-nav (app defaults date=2026-08-10, events are 10-Sep/Oct/Dec); resolution surface for bug-repro+mission (follows break-it pattern); parseIntent "refresh"→reload / "set X to Y"→fill.
- FULL HERMETIC SUITE GREEN (150 assertions/7 suites) — no regressions.

_(features 2,3,6–12 pending sequential audit)_

---

## FALSE-POSITIVE FIX (moat-critical) — CONVERGED on ONE general gate + login pre-step
**THE GENERAL PRINCIPLE (subsumes every FP class):** a verdict ABOUT THE APP requires the attack to have ACTUALLY EXECUTED against it. Implemented as the **executed-something gate**: if NO step reached status=pass → needs-review, before ANY broke/held logic. This replaced 3 per-symptom patches (form-absent, login-wall, skipped-destructive were all THIS one thing). Plus: has5xx/hasStack now scan EXECUTION EVIDENCE (observed+realErrors) not page copy (finalText) — a page containing "stack"/"500" isn't a crash.
**LOGIN PRE-STEP (reach-the-state):** break-it now passes the project's creds to executeFlow (was: no creds → only ever saw the login wall). PROVEN: schooltalk break-it now gets PAST login to the authenticated "Choose Portal" picker (observed shows it). Still can't SELECT a school → doesn't reach calendar (= the shared reach-the-state gap, next feature).
**Progression:** schooltalk 9 broke (all FP) → 2 broke → general gate. Fixture CLEAN RESULT after HARD restart (tsx-watch had been serving STALE code — always hard-restart to verify): GATE-v2 marker confirmed live. Fixture = **3 broke / 5 held / 9 needs-review / 2 passed**. The 3 broke are LEGITIMATE for this fixture: (1) end-before-start = the planted console.error bug ✓; (2) empty Start Date accepted — fixture only validates `if(!t)` title, NOT dates → genuine validation gap; (3) invalid date format accepted — same. So the FP floor WORKS: executed attacks verdict correctly, non-executed → needs-review. schooltalk 2-broke was STALE (pre-restart) — re-running clean. tsc clean, breakIt 7/7, apiProber 24/24, stateSig 24/24.
**LESSON: `tsx watch` silently serves stale code (it force-kills after 5s but the old module lingers). ALWAYS hard-restart (pkill -9 + confirm port drops) before trusting a live verification.** Cost me a wrong "2 broke" read.

### earlier 3 fixes (now unified under the gate above)
- resolveSubmit Enter path now VERIFIES movement (url/DOM sig) → matched:0 if nothing submitted (was matched:1 unconditional = defeated drove-gate).
- drove=false when a fill failed "no input for X" (form absent = wrong state, not attackable).
- consoleErrors filtered of AMBIENT noise (failed-to-load-resource / 401/403/404-asset / analytics / websocket / favicon) before hasException — hard signal = uncaught exception/rendered stack only.
- tsc clean, breakIt 7/7, apiProber 24/24.
- ⚠ NEW ISSUE FOUND (fixture re-run 78b18095): "empty title" attack scored broke "accepted invalid" BUT the fixture DOES reject empty title (`if(!t) Error: Title is required`). Root: the attack sent a DATE value as the title (`Event saved: "2026-08-15"`) not an empty string — so the field wasn't actually empty. A FILL-LOGIC bug (empty/omit mode not producing a truly blank field, OR the marker/date bleeding into the title). Separate from the ambient-noise FP. Fixture has REAL planted bug: end-before-start fires `console.error('...invalid date range accepted')` = the one true broke.
- PENDING: schooltalk re-run (byyzw7sla) to confirm 9-broke FP flood collapsed. finishedAt timestamps are STALE (server date issue) → don't trust run ordering by finishedAt; match by run id.

## RUN DATA (raw, append-only)
- Swiggy input probe: `/restaurants` = 0 inputs + "Search" button; click Search → /search → 2 inputs (text ph="Search for restaurants and food" + hidden submit). Root swiggy.com = bodyLen 0 (bot-walled).
- Crawler cap-7 live: 6 real school slugs, 28 pages, Progressions cv 103-282, all Calendars cv=0.

---

## SEQUENTIAL FEATURE SWEEP #2 — the BLANK-RECORD bug class (found + closed across every engine)

**The class:** an engine computes real results but writes them where NO reader looks → the user opens the run and sees `{}`. Every reader keys on `artifacts[0]`; the offenders wrote elsewhere. Battle-tested each menu feature on **exp-dent** (d8a5c9ac, code-mode, 6 flows/27 api/16 pages, repo=admin-ui).

- **API testing** (apiTestService) — FIXED earlier: results were in stepResults/replay not artifacts[0]. Proven live: schooltalk 45 endpoints → 17 pass · 26 fail · 2 skip (26 fails = honest 401 status-drift replaying protected endpoints unauth). ✅
- **Environment matrix** (envMatrixService) — TWO bugs: (1) no-flow path wrote blank `{}` + misleading `status:passed` when NOTHING ran. (2) with-flow path wrote `status:passed` even when conditions FAILED (dishonest green). FIXED: honest artifact w/ `resolution:unreachable` on no-flow; `honestStatus(passed,failed,ran)` → no-flow=failed, with-flow=failed-if-any-fail. Proven live: no-flow=`failed`+honest detail; with-flow on dent picked "Bulk Multi-Channel Notification Campaign", ran 2 conditions, honestly reported 4/5 steps failed (login wall) — real per-row artifact, not blank, not false-green. ✅
- **FE→API matching** (soaTestServices.startFeApi) — findings only in stepResults, `artifacts:[]` blank. FIXED: `artifacts:[{kind:'fe-api',results,...}]`, each row carries `resolution` (mismatch→file-ticket, unverifiable→answer-oracle). Proven live: dent 5 rows, code-cited ("useQuery(GET_USERS) at line 122"), honest match/mismatch/unverifiable. ✅
- **Generate test cases** (soaTestServices.startGenCases) — WORST: wrote `artifact:` (singular) key nothing reads → summary said "12 cases" but BOTH artifacts+stepResults empty. FIXED: `artifacts:[{kind:'test-cases',cases,...}]`, resolution `none` (cases ARE the deliverable, not a bug to file — avoids miscounting as pending). Proven live: dent 12 real cases (title/preconditions/priority). ✅
- **Security audit** (securityAuditService) — ALREADY CORRECT: `artifacts:[{kind,tier,findings}]`. dent tier-1 = 0 findings (honest empty, not blank). ✅
- **Complete regression / Test one flow** — route through the mission/startSoaRun path (already battle-tested: mission spawns real sub-runs, aggregates honest recorded outcomes; rollupActions reads `art.findings || art.results` so per-row resolutions surface). ✅

**SYSTEMIC CLOSE (not per-engine patching):** new `recordHonesty.ts` — `honestStatus(passed,failed,ran)` (green ONLY when nothing failed AND something ran; zero-ran ≠ pass) + `recordError(runId,kind,e)` (persist the failure INTO an artifact so an errored/timed-out run shows WHY, never blank `{}`). Wired into env-matrix + both soaTestServices catch handlers (a 180s bridge-timeout previously → blank `{}`).

**UI plumbing (advisor caught: non-blank JSON can still = blank SCREEN):** `useTestRun.loadRecorded` + `RunsScreen.RunResult` + `KIND_META` switch on `artifact.kind` and previously handled only break-it/bug-repro/env-matrix/flow → `api`, `fe-api`, `test-cases`, `security-audit` fell through to blank. ADDED hydration + compact renderers + kind-meta for all four, so every engine's saved record is viewable in Runs history. Runs-list pending-count now scans `results[]` too (fe-api answer-oracle rows count toward the pending badge). Labels via artifact `summary`. Proven: runs list shows `FE→API · Bulk Multi-Channel Notification Campaign · pending:1` (not "fe-api · pending:0").

tsc clean (api + web). No live run aborted (all src edits batched between runs, HANDS-OFF discipline held).

---

## SWEEP #3 (autonomous, sequential) — [1] CRAWLER: the post-login-seed bug (a WHOLE APP CLASS was silently broken)

**Battle-test target:** saucedemo.com (a real login-gated SPA I had NEVER tuned against — the honest generalization test, not schooltalk). Public demo creds (standard_user/secret_sauce, printed on its own login page).

**FOUND (root cause, code-proven via standalone Playwright probe):** after a SUCCESSFUL login, `crawlMapService` re-navigated to `baseUrl` root (`gotoRendered(page, baseUrl)`, line ~389) "so the BFS starts from the authenticated home." But for ANY app whose root URL IS the login route (saucedemo `/`, and any app rendering its sign-in form at `/`), re-visiting `/` logs you straight back OUT → the BFS then seeds from the login form → maps 1 page, 0 useful interactives, 0 flows. The `tryLogin` itself was PERFECT (probe: fills user-name/password, clicks login-button, reaches /inventory.html with 28 clickables) — the bug was throwing that landing away.

**FIX (self-calibrating, general):** after login, capture the landing URL; re-navigate to baseUrl ONLY if the landing page STILL `looksLikeLogin` (rare); otherwise SEED THE BFS FROM THE POST-LOGIN LANDING PAGE (`enqueue(landedUrl)`). Never map the login form as the app.

**PROVEN LIVE (before→after, same app+creds):**
- BEFORE: 1 page (`/`), 0 interactives, 0 flows — stuck on login.
- AFTER: 3 pages — `/inventory.html` (10 interactives) → `Sauce Labs Backpack` product detail (6) → `Add to cart` (5); **1 high-confidence FLOW synthesized: "Browse inventory and add product to cart" (3 steps).**

This is a GENERAL fix (the user's goal #1 — works for ALL apps): every app with a login-at-root was broken; now works. tsc clean, all 16 hermetic suites green (no regressions).

## SWEEP #3 — [2] BUG-REPRO: the "failed terribly" root = login couldn't sign into apps the CRAWLER can

**Battle-test:** saucedemo bug ticket (a bug that does NOT exist — the honest test is that the engine must NOT falsely confirm it).

**FOUND (3 chained general bugs, each code-proven):**
1. **FALSE-SSO misdiagnosis.** bug-repro's login (in `intentRunner`) matched the identifier field ONLY by email patterns (`type=email`, `name/id=email`, `autocomplete=username/email`, label~=email). saucedemo's field is `<input id="user-name" placeholder="Username">` → matched NONE → login no-op'd → the SSO detector fired on a stray 401 → WRONG "this app uses Google/Microsoft SSO, use a non-SSO account." The CRAWLER logged in fine (its `resolveIdentifierField` SCORES username|userid|login|account + sole-text-near-password fallback). **FIX (DRY, general): exported the crawler's proven `tryLogin` + `resolveIdentifierField` and made `intentRunner`'s login pre-step USE them** — so every engine signs in exactly like the crawler. `hadPasswordForm` still set → SSO detector stays honest.
2. **navigate-to-root logs us back OUT.** SoA plans a "navigate to <baseUrl>" step mid-repro; on login-at-root apps that returns to the login page (same class as the crawler seed bug). **FIX: `pruneRedundantSteps` now drops a BARE navigate-to-origin-root / `/login` step once authenticated** (keeps navigates to real inner routes + navigates that do other work). +5 hermetic assertions (reachState 21/21).
3. **mutation gated by authorization.** "click Add to cart" was skipped as a mutating step (project not `security.authorized`) → couldn't observe the badge → the repro couldn't complete.

**PROVEN LIVE (progression on the SAME ticket):**
- START: `cant-perform` + FALSE "app uses SSO" (never logged in).
- after unified-login: logs in (`click "Sauce Labs Backpack"` = PASS), honest `inconclusive` (not false SSO).
- after navigate-prune: navigate-to-root step GONE, still reaches product detail.
- after authorize: **BOTH mutating steps PASS end-to-end** (`click "Sauce Labs Backpack"` ✓ → `click "Add to cart"` ✓) — the FULL reproduction executes on the live app.
- Verdict stays honest `inconclusive` (the ticket's bug doesn't exist; the engine correctly does NOT falsely confirm it).

**STILL OPEN (recorded, next):** (a) resolution kind should be `authorize` (the approve-to-click button) when steps were skipped-for-authorization, NOT `unreachable`. (b) the oracle didn't get a concrete cart-badge reading → verdict `inconclusive` where `not-reproduced/fixed` would be ideal. Both are refinements on a now-WORKING engine — the "failed terribly" root (couldn't even log in) is FIXED. tsc clean, hermetics green.

**[2] BUG-REPRO closed the authorize gap:** when a mutating step is skipped-for-authorization, `deriveBugReproResolution` now returns `{kind:'authorize'}` (the approve-to-click button) instead of `unreachable` — the entrepreneur-lens "button, not a dead end." `authorize` added to `BugResolutionKind`. bugResolution hermetic 17/17. bug-repro is now WORKING end-to-end: unified login (any app the crawler can log into) → reach-state → navigate-to-root pruned → full mutation executes (with authorize) → honest verdict + concrete next-action button. All 16 hermetic suites green, tsc clean.

## SWEEP #3 — [3] BREAK-IT on saucedemo (fresh app): 0 false positives held; a reach-prefix was TRIED + REVERTED (recorded negative)

**Battle-test:** break-it "Add product to cart" on the freshly-crawled saucedemo (non-schooltalk/non-dent — real generalization). Unified login (the bug-repro fix) applies here too.

**RESULT:** 20 findings, **0 false positives (0 broke)** across every run — the FP floor holds on a brand-new app. The moat-critical invariant ("one false positive burns it permanently") is intact. Executed-vs-needs-review count VARIES run-to-run (5 held one run, 0 another) = the known SoA plan-variance (which invariant it probes drifts), NOT a regression.

**NEGATIVE RESULT (tried + reverted, per the "record learnings" mandate):** I added a crawl-derived reach-the-feature PREFIX (`buildFeatureReachPrefix` — prepend the matching flow's lead-in nav to each attack so it runs on the feature page, not the post-login home). LIVE-MEASURED A REGRESSION: 5 executed → 0 (all 18 needs-review). Root (advisor-confirmed): a failed reach step short-circuits the runner → `srAll.length < reachStepCount` → the slice-accounting zeroed `anyPass` → the executed-something gate fired → false needs-review. The finalText ("Swag Labs **1** …" = badge updated) was NOT proof the attack step drove. **REVERTED** all three wiring edits; kept `buildFeatureReachPrefix` + its 7/7 hermetic UNWIRED for a future short-circuit-proof attempt (the slice now guards `srAll.length > reachStepCount`). Did NOT loosen the oracle to read silent-DOM-delta as success — that's the exact false-positive door the user forbade; 18 honest needs-review IS the FP floor working.

**[3] BREAK-IT STATUS: WORKING at its honest ceiling** — logs in (unified), attacks execute where reachable, ZERO false positives, needs-review where the oracle genuinely can't classify. tsc clean, breakIt + featureReach hermetics green.

**PROCESS FIXES banked (advisor):** (1) creds+auth are wiped by every tsx reload — now ALWAYS `PUT /credentials` + `PATCH /security` in the same Bash call right before the kick. (2) The advisor is not "down" on a transient overload — call it at real decision points, don't self-authorize past the checkpoint.

## SWEEP #3 — [4] MISSION (the flagship prompt-agent): sub-run timeout was too short → "timed out" + empty rollup

**Battle-test:** plain-English mission "Test the add-to-cart feature — check it works and try to break it with bad inputs" on saucedemo.

**FOUND:** routing was CORRECT (parsed intent → chose break-it → spawned a sub-run), but `waitForSubRun`'s 240s timeout was shorter than a real break-it run (20 attacks × live nav = 5-8 min) → the mission reported its OWN sub-run as "timed out" and rolled up ZERO actions, even though the sub-run finished fine on its own. **FIX: bumped the sub-run wait to 600s** (still returns the instant the sub-run flips to passed/failed; only the ceiling changed).

**PROVEN LIVE (after fix):** mission → routes to break-it → sub-run completes "held (21 needs-review)" → **ACTIONS ROLLUP populated: "20× reachability blocked" + "1× answer a bug question"** — the entrepreneur-lens next-actions surface aggregated from the sub-run's per-finding resolutions (reads `art.findings || art.results`). [4] MISSION STATUS: WORKING end-to-end (route → run → honest rollup). tsc clean, 17 hermetic suites green.

## SWEEP #3 — [5] SoA-DRIVEN TEST-PLAN (approve-per-item): WORKING, no fix needed

**Battle-test:** `POST /test-plan` on dent (code-mode, repo). Returned **8 real, code-grounded, prioritized proposals (P0→P2)**, each carrying `{type, target, title, why, priority}`. The `type` (flow/fe-api/api/security) routes the FE's "approve & run" button to the right engine; the `why` cites specific code ("AuthContext stores JWT in localStorage — XSS vector", "Notifications page line 27-29 exposes BROADCAST_MULTI_CHANNEL", "Users page has 11 filter checkboxes"). Genuinely actionable, non-generic, correctly typed. [5] TEST-PLAN STATUS: WORKING end-to-end (SoA reads code+map → typed prioritized proposals → approve-per-item → routes to the matching engine). No fix required.

## SWEEP #3 — [6] RESOLUTION SURFACE (the entrepreneur-lens "approve button" + the correction loop): FIRES + PASSES

**Battle-test (LIVE):** `POST /runs/:id/findings/5/resolve {answer:"bug"}` on a break-it run whose finding #5 ("Empty quantity field") was `needs-review`/`answer-oracle`. RESULT: **re-verdicted to `broke`/`file-ticket`** and persisted — the "approve button" the user demanded ("where's the button where I approve and it gets to work") FIRES and PASSES live. The `fine`→held path + the yes/no re-verdict logic are covered by resolution.hermetic 22/22.

**The correction loop** (`/answer-control` → projectKnowledge human-confirmed → next run's planner enforces via the executor's `tryCorrection`): the route correctly GUARDS (rejects when a run has no `needs-input` to answer — proven by an honest rejection). The full fire-and-pass is proven by correctionFire.hermetic 7/7 (fact stored → surfaced-first → `tryCorrection` clicks the human-confirmed control, respecting the DANGEROUS gate — URL proof "the Delete button was NOT clicked") + correction.hermetic 5/5 + projectKnowledge 12/12. Enforcement lives in CODE (the executor), not a prompt, so a stored correction CAN'T be ignored — the advisor's "a fact applied by code can't be ignored" principle.

[6] RESOLUTION SURFACE STATUS: WORKING — every needs-review has a button; resolve re-verdicts live; the correction loop fires+passes (hermetic-proven, code-enforced). This is the "'needs review' is not a product → approve button" reframe, delivered.

---

## SWEEP #4 — THE REAL TARGET (admin.thedent.in, exp-dent, NO creds): the user was right, saucedemo hid everything

The prior "✅ WORKING" verdicts were measured on saucedemo (a substitute). On DENT (the user's actual app, no creds), every live engine ran against `/login` and produced authoritative-looking garbage. Root causes found + fixed:

### [A] API-test: 14 fake "your API is broken" failures = XSION'S OWN recording bug
`redact()` did `.slice(0,400)` on `samplePayload` — the payload that gets REPLAYED. Every GraphQL query >400 chars was stored as truncated (invalid) JSON → replay 400s "Unterminated string in JSON at position 400" (the slice boundary). PROVEN by perfect correlation on the stored dent map: every `len=400 validJSON=False` endpoint "failed", every `len<400 validJSON=True` passed. **FIX:** split `redactSecrets` (redact, NO truncate) for the replayable payload from `redact` (redact + slice) for display-only strings; + an api-test GUARD that skips (unverifiable) a payload that isn't valid JSON with "re-crawl to record the full payload" instead of blaming the app. PROVEN: dent api-test 14-fails → **8 pass · 1 real fail · 18 honest skips**. The 1 real fail (`GetEmailTemplateDefaults` "Cannot query field") is a genuine schema finding.

### [B] break-it ran 51 attacks against /login = no pre-flight auth gate + the __name MASTER BUG
break-it (unlike bug-repro) had no auth pre-flight → planned + ran 51 attacks against the sign-in page, each code-cited, all fake. **FIX:** `preflightAuth` probe before planning — login-gated + no working creds → ONE `{resolution:credentials}` record, ZERO attacks. **DEEPER ROOT found while building it:** `resolveIdentifierField`/`looksLikeLogin` returned null/false on dent's textbook email login → because a named helper inside `page.evaluate` throws `ReferenceError: __name is not defined` under tsx (the #209 bug) UNLESS `installEvalShim` ran on the context first. My probe (and any caller that forgets the shim) silently fails the login-detector. crawler + intentRunner DO install it; my gate didn't → added it. PROVEN: break-it on dent (no creds) now settles in **6s → 0 findings, resolution:credentials, honest "add credentials and re-run"** (was 51 fake findings).

**LESSON (re-scoping):** a "✅ working" on a substitute app is NOT working on the user's app. The __name/shim bug means ANY new code path that calls the in-page DOM helpers without `installEvalShim(context)` first will silently degrade — this is a standing footgun.

---

## HONEST RE-SCOPING (the user was right: "nothing works" on the real target)

Every "✅ WORKING" earlier this session was measured on **saucedemo (a substitute app)**. On **admin.thedent.in (the user's real app, no creds set)**, the truth per feature:

| Feature | Real-target status |
|---|---|
| Crawler | ✅ login-at-root fix is REAL (proven on saucedemo); dent crawl was code-mode so it mapped routes without live login |
| API testing | ✅ FIXED on dent — truncation false-failures gone (14 fake → 8 pass/1 real/18 honest-skip) |
| Break it | ✅ FIXED on dent — pre-flight gate (was 51 fake findings → 1 honest credentials record). Real attacks UNVERIFIED (needs dent creds) |
| Bug repro | ⚠ correctly refused on dent (no creds); the __name/shim + unified-login fixes are real but the FULL repro is UNVERIFIED on dent (needs creds) |
| Env matrix | ✅ pre-flight gate added; live matrix UNVERIFIED on dent (needs creds) |
| Generate | ✅ transparency added (shows chosen + available flows); FE picker still pending (#238) |
| FE→API, Security, Test-plan | code-mode (no live login needed) — records honest, proven on dent earlier |
| Mission | routing + rollup fixed; sub-runs inherit the gate |

**THE STANDING BLOCKER:** four live-browser features (break-it attacks, bug-repro full repro, env-matrix, complete-regression) CANNOT be verified working-against-dent without **dent credentials**, which I don't have and must not fabricate. The honest deliverable I CAN ship: every one of them now **refuses cleanly** (one credentials record, zero garbage) instead of producing authoritative-looking noise. When creds are added, they will actually run — the login machinery (unified tryLogin + __name shim) is proven correct on dent's real login form.

**THE MASTER BUG this pass:** `__name is not defined` — a named helper inside `page.evaluate` throws under tsx unless `installEvalShim(context)` ran first. It silently made the login-detector return false on dent's textbook email login. Any new code path touching the in-page DOM helpers MUST install the shim first. This is the footgun behind most of the "nothing works" symptoms.

---

## THE CRAWLER INTERACTION-GRAPH REDESIGN (research-grounded, fixture-verified) — the "map every element + relations" ask

User: "crawl each and every aspect — buttons, flows, how clicking connects to what — the tree of elements + pages + relations. Mode 2 (URL-only) is the USP. Build an in-house pipeline that learns per crawl + gets efficient over time."

**Research** (2 agents: SOTA + our-code audit; synthesis in scratchpad/xsion_exploration_framing.md): the object is a STATE-FLOW GRAPH; the one lever is state-abstraction (≈); cost = ne+nr·cr (reset≫click); coverage-per-cost core = {abstraction, count-novelty frontier, reset-minimizing, scroll-completeness}. "In-house ML" is the WRONG shape — winners are hash-maps + DOM string ops, no training. The genuine whitespace (no paper does it) = persist a per-app learned model across crawls.

**Harsh verification method:** built controlled fixtures (test-fixture/verify.html — 5 known states, 4 planted dangerous + safe look-alikes, 200-row 1-kind infinite list; hub.html for the A/B) served on localhost:5199 with EXACT ground truth, so "verified" = matched-to-ground-truth, not vibes.

**Stages (all fixture-verified, all hermetic-locked):**
- **CRAWL-a honest affordance count** — `present` = ground truth exactly (settings 11, not the fake MAX_ACTIONS=10).
- **CRAWL-b interaction GRAPH** — persisted `edges[]` (element X → state B, keyed on abstracted sig; new/loop labels; self-loops). Was computed-then-discarded. THIS is the tree the user asked for. graphEdge.hermetic 7/7.
- **CRAWL-c scroll-to-reveal + ADAPTIVE rework** — 2 termination tests; then the user's infinite-scroll insight: SATURATE on normalized-KIND set (not a fixed count). Fixture 200-row 1-kind list → stops at 4 scrolls (not 200). scrollReveal.hermetic 12/12.
- **CRAWL-d un-fake MAX_ACTIONS=10** — self-calibrated to affordancesPresent (ceiling 150). Rich page now captures 17/16/14 (was ≤10).
- **CRAWL-e safety gate** — consequence classifier (safetyGate.ts): same-origin link/GET-form = safe; Delete/Send/Pay/Logout/POST = mapped-but-NEVER-clicked. Fixture: all 4 planted dangerous correct categories, safe look-alikes cleared. 17/17. Makes crawling authed prod SAFE.
- **CRAWL-f curiosity frontier — MEASURED NEGATIVE, NOT shipped** — A/B (exploreAB.hermetic 4/4): curiosity TIES bfs (parent-novelty constant across siblings → degrades to FIFO). Reproduces #208 with the arm actually enabled. Recorded negative; arm stays bfs.
- **CRAWL-g persisted site-model — THE USP, PROVEN LIVE across 3 crawls** — siteModel.ts: stable (seen ≥2 crawls) vs volatile sigs + warm-start. Live: c1 "5 states 0 stable" → c2 "5 stable" → c3 "warm-start: re-confirmed 5/5 known, 0 new, 0 gone." Compounding + warm-start both live. siteModel.hermetic 18/18. No paper does this.

**2 hard bugs harsh-verify caught + fixed (live variance would have hidden them):** (1) click-path STATE EXPLOSION (11 pages/3 sigs on a 5-state app) — root was the load-bearing `contentVolume===0→enter` collapse rule; fixed at the enqueue seam + a routeKey-aware collapse tweak WITHOUT breaking schooltalk's real 6-tenant cv=0 coverage (verified against the stored schooltalk map). (2) HASH-ROUTER coverage gap — normUrl stripped the hash so `#settings`≡`#checkout`≡one route; fixed to preserve route-like hashes (normUrl.hermetic 11/11; dent/schooltalk zero-regression).

**Also fixed the CREDS bug + heavy [XSION] logging** the user asked for (Roles & coverage now promotes role creds → project default the engines use; PUT /credentials box added; 31 log statements).

**HONEST LIMITS:** (a) fixture-verified, NOT yet verified on dent (needs creds). (b) Mode-1 code-consequence enrichment DESIGNED not built — can't fixture-verify (no repo in fixture) + needs dent creds; safety not at risk (DOM classifier already correct). (c) crawl PERF: safeClickExplore restore()-reloads dominate (the nr·cr term) — 5-min fixture crawls; next lever = cache revealByScroll per routeKey (25 calls→5). 23 hermetic suites green, tsc clean api+web.

---

## ★ REAL-TARGET VERIFICATION — the crawler redesign on admin.thedent.in, BOTH MODES (creds provided)

Login verified live (looksLikeLogin=true, tryLogin=true → landed /). Two fresh projects, creds set, both crawled concurrently to `done`.

| | MODE 1 (code+url) | MODE 2 (url-only, the USP) |
|---|---|---|
| pages / distinct states | 23 / 23 | 23 / 23 |
| edges (interaction graph) | 53 | 52 |
| API endpoints | 27 | 27 |
| affordance `interactives` range | **18–72** | **18–72** |
| dangerous mapped-not-clicked | Send Notification | Send Notification |
| site-model | crawlCount 1, 23 states, 20 routeKeys | crawlCount 1, 23 states, 20 routeKeys |

**EVERY redesign stage VERIFIED on the real app:**
- **CRAWL-a (the honest count — the user's original observation):** interactives now range **18–72 per page** — the OLD dent map had all-10 (the MAX_ACTIONS fiction). Some dent pages have 72 real affordances. FIXED, proven on prod.
- **CRAWL-b (the interaction GRAPH the user asked for):** **52–53 edges, 23 distinct target states** — the "tree of elements + how clicking connects to what" is real on dent, in both modes.
- **CRAWL-e (safety on PROD):** `Send Notification` correctly mapped-but-NEVER-clicked — the crawl of the live admin panel did NOT fire a real notification to real users. The gate works where it matters most.
- **No explosion:** 23 pages / 23 sigs — perfect 1:1, the explosion fix holds on a complex real SPA.
- **CRAWL-g (the amortization USP):** site-model attached (23 states, 20 routeKeys ever seen); a 2nd dent crawl would promote the stable skeleton + warm-start.

**THE HEADLINE (Mode-2 = the USP, PROVEN):** with NO code at all, Mode 2 inferred the SAME complete graph as Mode 1 — 23/23 states, 52 vs 53 edges, identical API + affordance coverage. The moat holds: the interaction graph is buildable from observation alone on a real production admin panel.

**Note:** routeManifest=0 in Mode 1 this run (SoA router-read returned empty), so Mode 1 didn't out-cover Mode 2 via the code skeleton — both relied on click-discovery and converged to the same map. Worth a follow-up on why the manifest was empty, but it did NOT hurt coverage. Crawl perf: ~10 min for 2 concurrent heavy crawls (the safeClickExplore reload cost); the caching lever (next perf task) applies.

## ★ Mode-1 routeManifest BUG (surfaced by the dent verification) — FIXED + verified

The dent Mode-1 crawl showed routeManifest=0 → Mode-1 got NO code advantage over Mode-2 (both 23/23). ROOT: the manifest-read was gated `if (repo && queue.length===0 && pages.length===0)` — but the POST-LOGIN LANDING SEED (an earlier login fix that enqueues the authenticated home) fills the queue FIRST, so on ANY login-gated app `queue.length≠0` → the manifest was NEVER read. FIX: gate on `repo && pages.length===0 && !routeManifestOut` (fires whether or not the queue is seeded; manifest routes merge with the post-login seed; still skipped on resume).

PROVEN: `routeManifest(dent)` returns 13 real routes (incl param routes /users/:userId/meal-plan, /chats/:conversationId, with requiresAuth flags). Re-crawl with the fix: **routeManifest=13** (was 0), **31 API** (was 27), and the param routes correctly recorded as data-gated known-unknowns. THE MODE-1 ADVANTAGE IS NOW REAL: the code manifest declares detail routes (per-user meal-plan/workout-plan) that click-discovery alone can't know exist without the right data — Mode-1 now honestly surfaces "these routes exist, I need an ID to reach them," which Mode-2 (url-only) cannot. code+url is now genuinely richer than url-only, as intended. 23 hermetic suites green, tsc clean.

## [PERF] scroll-cache — TRIED + REVERTED (recorded negative; correctness over speed)

The dent instrumentation showed revealByScroll ran 25× on only 6 distinct routeKeys (/custom-plan 9×, /explore 8×) → tried caching the reveal per routeKey within a run (25→6 scroll calls). LIVE-MEASURED A REGRESSION on the fixture: #list (infinite-scroll) went 1 page → 5. ROOT: the scroll's REVEALED CONTENT feeds the collapse signal — first visit reveals 125 rows (high contentVolume), a CACHED re-visit shows only 25 (no scroll) → collapseDecision saw materially-different content → ENTERED it as a data-variant instead of collapsing. The revealed content is load-bearing for collapse, so it CANNOT be cached without corrupting the map. REVERTED; fixture back to clean 5/5/4. The real (un-cheap) perf lever remains safeClickExplore's restore()-reloads = the nr·cr term the research says dominates. Left un-cached — correctness over speed. 23 hermetic suites green, tsc clean.
