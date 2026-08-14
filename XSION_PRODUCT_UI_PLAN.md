# Xsion product UI — the "agentic AI at work" live run view (plan)

Goal: make the proven SoA-brain loop FEEL like a finished startup product — the AI reasoning live, clicks
happening in real-time, verdicts streaming with code citations. Advisor-shaped: wire → verify → design.

## THE ORDER (non-negotiable — don't build a beautiful shell then fake data into it)
1. **PLUMBING FIRST** — the loop is a detached CLI (runLoop.ts → stdout). The UI can't see it. Fix:
   a. Route `POST /projects/:id/soa-run` → `store.createTestRun` → returns runId (existing WS subscribe works).
   b. Replace console.log in the loop with `wsServer.broadcastToRun(runId, event)` at EVERY seam:
      plan-started · flow-discovered · step-attempt (with URL + candidate list) · verdict (with codeRef).
      THIS EVENT STREAM IS THE PRODUCT. Everything visual is a rendering of it.
2. **VERIFY** with one live run — events arrive over WS.
3. **DESIGN** the one hero screen against REAL events.

## SCOPE (late-session, large task → prove with ONE screen)
- BUILD: the **Live Run view** — flow list → steps streaming (pass/fail + URL) → verdicts with clickable code
  citations → the phase rail (PLAN → EXECUTE → VERIFY). This is the whole differentiator.
- KEEP existing: Projects, Settings, graph pages (reuse current components). NOT a full multi-page redesign.

## THE TWO THINGS THAT MAKE IT DIFFERENTIATED (already generated — don't lose them in the redesign)
- **Reasoning + codeRef per verdict** rendered as a CLICKABLE code citation ("Filters button exists at
  Users.tsx:343"). No other test tool shows this. THIS is the hero, not a hero image.
- **Verdict vocabulary as first-class visual state**: expected / flaky_selector / unverified / real_bug.
  `unverified` gets DIGNIFIED treatment — it's the fail-safe floor made visible = the honest differentiator.
  Never collapse it into a generic "warning" pill.

## VISUAL LANGUAGE (from artifact-design fundamentals, adapted for a Vite app not an Artifact)
- Concept: a "mission control for an AI QA agent" — calm, technical, trustworthy. The agent is WORKING, you're
  watching it think. Real-time, not a static report.
- Palette: a picked neutral (slight cool bias) ground; ONE accent for "the agent is live/acting"; semantic
  colors for the 4 verdicts (green=expected, amber=flaky, slate=unverified, red=real_bug) SEPARATE from accent.
- Type: a characterful display for headers + a clean body + a mono for code citations/URLs (the technical
  texture). Real content throughout (dent admin flows), never lorem.
- Motion: DELIBERATE — steps stream in, the current step pulses, a verdict resolves with a settle. The
  "AI at work" feeling comes from the live stream + the reasoning appearing, not gratuitous animation.
- Theme-aware (light + dark), layout via gap/grid, mono tabular for any metrics.

## NOTE: don't call it "the product" until the run view renders LIVE events from a real run. Wire → verify →
design. Mode 2 (code-less explore) comes LATER — this screen serves it too (same event stream).
