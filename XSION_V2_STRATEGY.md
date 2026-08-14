# Xsion v2 — from "boring feature-menu" to "a teammate that watches your back"

*Synthesis of three independent analyses (market/wedge agent, product-design agent, beloved-tools agent) + advisor.
All four converged on the SAME diagnosis and the SAME wedge — the strongest possible signal.*

## THE DIAGNOSIS (why it feels numb — unanimous)
Xsion built world-class HONESTY machinery (fail-safe verdicts, oracle-before-execution, `needs-review` not
fabricated bugs, code-citations, frame-by-frame replay = a real moat). But the PAYLOAD of all that rigor is a row
of chips: **"0 broke · 14 review."** That is epistemically correct and PRODUCT-HOSTILE. `needs-review` moves the
work BACK onto the human → the numb feeling. The moat produces homework, not outcomes.

Three mechanical causes (all in this session's own evidence, all fixable, all bigger than any new engine):
1. **Nothing durable is left behind** — every run is a screen you glance at once. No committed spec, no ticket, no
   growing suite. Beloved tools LEAVE SOMETHING BEHIND.
2. **First value gated behind 4 chores** — onboard→crawl→validate→project before the flagship is even clickable
   (we literally hit this: breakit-fixture couldn't reach the Test menu). Time-to-first-wow is the whole game.
3. **Everything is manual-trigger** — you must open Xsion, pick 1 of 8 tests, pick a feature. You don't open
   Sentry; Sentry opens you. Xsion has NO trigger surface.

## THE REFRAME (the one idea that unifies "for all three users")
**The unit of value is THE DIFF, not the app.** Xsion stops asking "what do you want to test?" (presumes you already
know) and starts answering "here's what your CHANGE put at risk." This is why the user wanting it "for all"
(solo builder + eng lead + QA eng) is right AND coherent — they're the same person at different scales, ONE spine:
- **Solo builder (WIN FIRST — it's who the founder IS + can dogfood on sloxt/dent):** `xsion check` before you push
  → "here's what you broke, with proof + the fix."
- **Eng lead:** same engine, fired on every PR (the GitHub App / CI gate = quarter 2).
- **QA eng:** every incident PINS a permanent check that the nightly watch + the gate both run (the flywheel).
Same spine, three audiences, sequenced not split. No rebuild.

## THE LAW OF BELOVED (the discriminating test for every feature)
"Did the user receive it WITHOUT opening anything and WITHOUT asking?" (Sentry → issue feed; Vercel → PR comment).
If a wow requires navigating to Xsion first, it's a DASHBOARD, not an agent. And: **every finding must hand over an
ACTION, not a verdict.** Do the work, don't display it.

## THE THREE THINGS THAT KILL THE NUMBNESS (none are new engines)
1. **Every finding → a NEXT ACTION:**
   - `broke` → a paste-ready bug ticket + a COMMITTABLE failing spec (`*.spec.ts`).
   - `held` → the TEST that proves it, added to your suite so it stays held.
   - `needs-review` → THE ONE question I need answered; your click resolves it AND TEACHES THE ORACLE.
     (`acceptIsDefect` is exactly this loop — already built, just not exposed. This converts our biggest
     liability — a wall of "needs-review" — into the thing that makes Xsion smarter with use.)
2. **Leave a DURABLE ARTIFACT** — a committed spec, a ticket, a pinned check. The suite grows with the app.
3. **A TRIGGER SURFACE** — `xsion check` reads the LOCAL git diff (zero new infra, days of work). GitHub App = later.

## THE 4 PROACTIVE FLOWS (engines repackaged as JOBS, not menu items)
| Flow | Trigger | What Xsion does | Payoff |
|---|---|---|---|
| **1. `xsion check` (pre-merge gate — SHIP FIRST)** | dev runs it / pre-push hook | diff → affected flows (via routeManifest) → break-it + env-matrix + api-test on ONLY the touched flows | catch the regression you JUST wrote, 90s before the PR |
| **2. Ticket-lands auto-repro** | paste a ticket (later: Linear/Jira) | bugRepro: prose→steps→run→code-cross-check | the "is it real / still real?" triage before you context-switch |
| **3. Nightly drift watch** | schedule (needs atomic store #206 ✓done) | re-crawl → diff map vs last night → only what CHANGED and BROKE | catches the break from someone else's merge / a dep bump; SILENT when clean |
| **4. Post-incident → permanent guard** | after an incident w/ a repro | promote the bugRepro into a SAVED check joining #1 + #3 | every incident makes Xsion permanently smarter (retention flywheel) |

Engine→job map: break-it = the muscle of #1 + the first-run wow · bugRepro = #2 + #4 · envMatrix = reliability rider
on #1 · apiTest = contract check on touched endpoints · crawlMap/routeManifest = now the DIFF→FLOW index (not a
wizard step) · securityAudit = surfaced ONLY when the diff touches a guard/validator/auth file · mission = the
onboarding runtime + the power-user escape hatch (menu becomes a prompt) · soaRun = the Mode-1 verify backbone.

## THE FIRST-5-MIN WOW (redesigned, concrete)
Kill the wizard. Onboarding = a MISSION. Ask 3 things (repo path, live URL, "got a bug that's bugging you?"
optional). Then TWO things run at once: the bounded crawl streams its map live AND — in parallel — Xsion
IMMEDIATELY proves something (pasted ticket → bugRepro; else break-it on the single highest-value flow). Payoff =
ONE finding with a HARD mechanical signal, code-cited, replayable, in ~90s. No menu ever shown. **GATE: first-run
finding is HARD-SIGNAL-ONLY (5xx / uncaught exception / rendered stack / accepts-clearly-invalid).** Our own
9-broke/8-false history says ONE false positive in minute three burns the moat permanently. If nothing hard is
found, say so honestly — that's trust-building, not failure.

## BUILD SEQUENCE (ranked, honest against what EXISTS in the codebase)
**Precondition DONE:** atomic store (#206) — required before any scheduled/unattended flow (they multiply concurrent
db.json writes).
1. **DIFF → affected-flow selection** — THE SPINE of all 4 flows. Reuse routeManifest (SoA reads routes). New work:
   parse `git diff` → map changed files → routes/handlers/components → the mapped flows that touch them. Without
   this every flow degrades to "run everything" (slow, un-teammate-like). BUILD FIRST.
2. **Onboarding-as-mission + auto-first-finding** (hard-signal gated) — the entire retention argument; makes minute 5 land.
3. **The CLI `xsion check`** — the trigger surface. Local git working-tree read, zero new infra vs a GitHub App
   (which is a quarter). It's WHERE THE DEV WITH THE DIFF ALREADY IS.
Then: every-finding→action + committable specs (kills numbness) → ticket-repro flow → nightly watch → incident-pin.

## MOAT DISCIPLINE (the filter for every future feature)
Does it EXPLOIT our fail-safe / code-cited / replay moat — or ask us to be a better Playwright? The second bucket is
RED OCEAN (QA Wolf, Mabl have more eng + capital). Trust is the whole product: ONE false positive spends more
credibility than ten true ones earn; NEVER be flaky (self-verify before reporting); the `needs-review` pile shown
PROUDLY is the strongest trust signal (a colleague says "I found 1 real break + 2 I honestly couldn't judge");
every finding REPLAYABLE so the dev verifies you in 5s instead of trusting on faith. That earned trust is what
unlocks the unattended flows — and it's the one thing a competitor can't copy by shipping more features.
