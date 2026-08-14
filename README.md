# Xsion — AI QA Agent for Web Apps

Xsion is an **agentic browser workspace** that onboard a web app, crawls it, maps its flows and API surface, and runs tests with **code-cited, fail-safe verdicts**. It is built around a closed-loop brain: **SoA plans → Xsion executes with Playwright → SoA verifies against the code**.

> The unit of value is the **diff**, not the app. Xsion answers "here's what your change put at risk" instead of asking "what do you want to test?"

## What it does

1. **Onboard** — give Xsion a live URL and, optionally, a local repo path.
2. **Crawl & map** — Xsion explores the app in real time, captures pages, flows, buttons, forms, and every network call it fires.
3. **Validate** — review the discovered map, correct low-confidence flows, and save it as a persistent **project**.
4. **Test** — run regression suites, single flows, generated cases, or API contract checks against the mapped app.

## Two modes

| Mode | Input | Oracle | Verdict strength |
|------|-------|--------|------------------|
| **Mode 1 — Code-aware** | URL + local repo | The actual code | Strong: `real_bug`, `flaky_selector`, `expected`, `unverified` |
| **Mode 2 — Code-less** | URL only | Observed behavior + UX convention | Weak/honest: mechanical facts (5xx, console errors, broken links) flagged as `anomaly` or `unverifiable` |

## Core principles

- **Fail-safe over fabricated.** If Xsion can't prove something, it says `unverified` or `unverifiable` — never a confident-wrong bug.
- **Code-cited verdicts.** Every `real_bug` or `expected` finding references the relevant source line.
- **Replayable.** Every step is recorded with screenshots, selector attempts, and fingerprints so a developer can verify in seconds.
- **No hardcoded flows.** Flows are discovered from the app and its code, not a brittle script list.
- **Per-role completeness.** The same URL is crawled per role so no user journey is missed.

## Proactive flows (v2)

- **`xsion check`** — run against the local git diff before pushing; only tests flows touched by the change.
- **Ticket-to-repro** — paste a bug ticket and Xsion turns it into a runnable, code-cross-checked repro.
- **Nightly drift watch** — re-crawl and diff the map, surfacing only what changed and broke.
- **Post-incident guard** — promote a repro into a permanent check that joins the pre-merge gate and nightly watch.

## Tech stack

- **Runtime / executor:** Node.js + TypeScript + Playwright
- **Brain / planner-verifier:** Python SoA bridge (`soa_gemini/xsion_bridge.py`)
- **Frontend:** Vite + React
- **Backend:** Fastify/Express-style API with WebSocket event stream
- **Persistence:** JSON store (atomic, resumable)

## Status

- ✅ Mode 1 closed-loop (plan / execute / verify) proven end-to-end
- ✅ Live WebSocket event stream + mission-control UI
- ✅ Project model, network call capture, and screenshot replay
- 🟡 Onboarding-as-mission, API inventory, and map-validation UX in progress
- 🔵 Mode 2 black-box exploration, nightly watch, and `xsion check` CLI upcoming
- ⛔ Security attack / payload-injection testing explicitly out of scope for v1

## Repository layout

```
xsion/
├── apps/               # Monorepo apps (API, frontend, discovery runner)
├── soa_gemini/         # Python SoA bridge and planner/verifier
├── prompts.md          # Engineering prompts used to evolve the system
├── SOA_BRAIN_PLAN.md   # Closed-loop brain architecture
├── XSION_*_PLAN.md     # Product, UI, v2 strategy, and iteration plans
└── README.md           # This file
```

## License

Proprietary — Xsion is a private product repository.
