# Xsion — the product vision, refined to prod-ready (2026-08-12)

User's rough sketch → a viable, honest product. An **agentic browser workspace**: you onboard a web app,
watch Xsion crawl + reason live, steer it when it's stuck or wrong, and then point it at whatever you need
tested. Below is the refined shape + an HONEST scope map (what's built / small extension / new work / out).

## THE PRODUCT IN ONE LINE
Onboard a URL (with or without its codebase) → Xsion crawls & maps the whole app while you watch it think →
you validate/correct the map → it's saved as a **project** → then you run tests against it (regression,
one flow, generate cases, API testing) with code-cited, fail-safe verdicts.

## THE FLOW (refined from the sketch)
1. **Onboard** — user gives: web URL + "do you have the codebase locally?" (yes → path). This picks the MODE:
   - MODE 1 (code + URL): oracle = code. Strong, fact-checkable verdicts. (Built + proven.)
   - MODE 2 (URL only): oracle = observed behavior + convention. Weaker, fail-safe verdicts. (Designed, not built.)
2. **Crawl & map (watch it work)** — Xsion explores the app: pages, flows, buttons, fields, filters, and —
   critically — the **API surface** (every request method/url/status/payload it fires, captured live). The UI
   shows Xsion's THINKING stream + a screenshot-stream of the page with a **synthetic cursor** showing where it
   clicks in real time. (See "How we show it" — this is NOT a live iframe of their site.)
   - **BOUNDED, not exhaustive** (advisor: "map EVERYTHING" is unbounded + is what caused read-thrash): highest-
     value flows first, breadth-limited, RESUMABLE. "Complete map" = the reachable high-value surface, honestly.
   - **Credential gate (the one blocking prompt)**: when the crawl hits a login it can't pass, the overlay
     window PROMPTS the user for email+password inline, Xsion stores a reference (see Credentials below), logs
     in, continues. This is the sketch's "overlay asks a question" moment — and it's the ONLY blocking one.
3. **Validate the map (NOT per-flow-modal — redesigned)** — the sketch's "confirm each flow as detected" blocks
   the crawl on a human and dies at 20 flows. INSTEAD: crawl runs to completion UNBLOCKED → present the map with
   a **per-flow CONFIDENCE score** → user corrects ONLY the low-confidence or wrong ones ("this flow is actually
   X", "you missed the Y step"). Same benefit (map correct from the start), no modal spam. Xsion re-maps the
   corrected flows.
4. **Onboarded as a PROJECT** — the URL becomes a persistent project storing: the semantic map, flow inventory
   (with confidence + user corrections), the **API inventory** (endpoints + sample payloads/outputs), the
   credential reference, and the code link (Mode 1). (Extends the existing Project model — already `{id,name,
   baseUrl}` + graph/store; we ADD map/apiInventory/flows/credRef.)
5. **Test menu** — point Xsion at what to test (scope tiers below).

## THE TEST MENU (split by what the substrate can HONESTLY support)
✅ SUPPORTED (built on flows / StepResults / NetworkCall / code-reading):
  - **Complete regression** — run all mapped flows, verdict each.
  - **Test flow X** — one flow, deep.
  - **Generate test cases** — from a flow / feature / whole app (Mode-1 code-aware, or Mode-2 behavior).
  - **API testing** — replay recorded endpoints, assert payload/output/status; flag 4xx/5xx, contract drift.
    (NetworkCall model already captures method/url/status; we extend to payload/response bodies.)
  - **FE→API matching** — does a UI action fire the API the code says it should? (Mode 1.)
⛔ OUT OF SCOPE (explicitly, for now — a confident-wrong finding here is worst; needs real security tooling):
  - **Cyber / attack / payload-injection testing.** NOT a v1 feature. Parking it honestly, same discipline as
    Mode-2's weakened verdicts. Revisit only with a real security substrate + human-in-loop.

## HOW WE SHOW IT (the "agentic browser" UI — corrected for reality)
- Playwright is HEADLESS → the user watches XSION'S RENDER of the page (a live screenshot-stream), NOT a real
  iframe of their site. `DiscoveryRunMode` is ALREADY `'iframe' | 'screenshot_stream'` — the codebase already
  chose: **screenshot-stream is the reliable default; iframe is opportunistic** (via the existing
  routes/proxy.ts — it exists precisely because direct iframing often fails on XFO/CSP). Be honest in copy: "this
  is Xsion's view of your app."
- Layout: the page-view fills most of the window; a **synthetic cursor** animates to each click (real-time "it's
  working"); an **overlay panel** (the current MissionControl, evolved) shows the thinking-stream + phase + and
  pops modal ONLY for creds / low-confidence corrections. A short **chat/steer input** lets the user redirect
  ("skip billing", "focus on the users flow", "that flow is wrong").

## CREDENTIALS (named as a real obligation — most likely to be built carelessly)
Storing a user's app credentials is a product obligation, not a test hack (we used env vars for our own tests).
REQUIREMENTS: never written to the repo, never in logs (redact), encrypted at rest (or OS keychain), per-project
scoped, user-revocable. The crawl uses a stored REFERENCE, never plaintext in the event stream.

## HONEST SCOPE MAP (the answer to "is this a startup product?")
- ✅ BUILT + PROVEN: Mode-1 loop (plan/execute/verify), code-cited fail-safe verdicts, intent→selector, auth,
  the live WS event stream, the mission-control UI, project model, NetworkCall substrate.
- 🟡 SMALL EXTENSION: URL-as-project onboarding flow, API inventory (payloads/outputs), test-menu routing,
  credential storage, screenshot-stream + synthetic cursor, the steer/chat input.
- 🔵 NEW WORK: the bounded crawl→map→confidence pipeline, the map-validation/correction UX, Mode-2 explore verb.
- ⛔ OUT: cyber/attack testing; exhaustive "map everything"; live-iframe-of-their-site (screenshot-stream instead).

VERDICT: yes — this is a coherent startup product (an AI QA agent you onboard, watch, steer, and trust because
it fails safe + cites code). The refinement = bound the crawl, batch the validation, quarantine cyber, respect
credentials, be honest that "watch it work" = our render. Build order next: onboarding+crawl-map (the new spine)
→ map-validation UX → API inventory → test menu. Iterate from there.
