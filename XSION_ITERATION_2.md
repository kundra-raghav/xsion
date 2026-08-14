# Xsion — iteration 2 (user critique → roadmap, 2026-08-12)

User's critique after using the 4-screen product. Grouped + sequenced (user chose: quick-fixes-first, then
SOA-driven crawl; per-field = prompt-live-and-record).

## PHASE A — QUICK FIXES (do first)
A1. **Project picker + add-new.** On open, land on a LIST of existing projects → select one, OR onboard a new
    URL (create project). No more auto-select-default. (Backend already has POST /projects + GET /projects.)
A2. **Oracle-toggle desync.** Topbar ORACLE (code+url / url only) must be the SAME source of truth as the
    onboard "Do you have the codebase locally?" radio. Right now they're independent → lift to one state,
    two-way bound.
A3. **"Save flow" + auto-continue (Validate screen).** After confirming/correcting a flow, the button should
    say "Save flow" (not "Save project"), and on save AUTO-ADVANCE to the next flow (or resume the crawl where
    it left off), so validation flows through instead of dead-ending. "Save project" is the final step after all
    flows handled.
A4. **GraphQL-aware API view.** A GraphQL endpoint is ONE url (/graphql) → the endpoint tells you nothing.
    → Capture the full PAYLOAD (already have samplePayload) + DERIVE the operation from it: for GraphQL, parse
    the `query`/`mutation` + operationName from the request body → show "mutation editAppointment" not just
    "POST /graphql". Show the payload (redacted) in the API row (expandable). Same for REST: show the body.

## PHASE B — SOA-DRIVEN CRAWL (the deeper re-architecture)
B1. **Invert the loop: SOA operates on permission/steps/instructions.** Today Xsion crawls mechanically then
    SOA comments. Vision: SOA is the BRAIN — it reasons about each page, decides what to explore next, and the
    UI shows that reasoning live + asks the user to approve/steer. Everything (map, test-case lists, "what do
    you want me to test") flows from SOA's reasoning with human-in-the-loop. Keep the model-research boundary:
    SOA reasons in BATCHES over accumulated observation (not per-click), Xsion still executes the clicks.
B2. **Per-field REQUIREMENTS (the Posture-Analysis image-upload miss).** When SOA hits a field/flow that needs
    real data to be testable (an image upload, a valid coupon, a specific user, a file), it must PROMPT LIVE
    (like the credential gate): "this upload needs an image — which one?" → user provides → RECORD the
    requirement in the map so the flow is actually runnable later. Not walk past it. Map gains a
    `requirements: [{field, kind:'image'|'file'|'data', prompt, value?, met:bool}]` per flow/page.
B3. **Crawl feels dull → real-time + interactive.** More live signal: SOA's reasoning streaming faster,
    the cursor/highlight tied to what SOA is actually examining, per-page "here's what I found + what I need",
    and the steer/chat input actually influencing the crawl.
B4. **A chatbot/instruction surface** where SOA says what it wants to test + the user directs it — the
    permission/steps/instructions model made concrete.

## Sequencing (user-chosen): A1→A4 (quick, visible, lower-risk) THEN B1→B4 (the ambitious re-architecture).
## Field-prompt style (user-chosen): PROMPT LIVE + RECORD (blocking like creds), not batch-fill-later.

## Known-good (don't regress): the 3 test runners work (API 8pass/2skip safe-methods+recorded; gencases 12 real
cases; feapi bridge built); the 5 screens; the crawl-map spine; fail-safe verdicts; creds env-only. Note a
data-quality caveat: crawl flow-count VARIES per run (login-stick + bounded depth) → sometimes a degenerate
1-flow map. B1/B2 (SOA-driven + richer capture) should improve this; A-phase doesn't fix it.
