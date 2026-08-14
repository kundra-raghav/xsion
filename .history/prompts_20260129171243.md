PROMPT 1 (Backend) — Extend edge model with click context + locator stats

Prompt:
Enhance Xsion backend models to store enough context for deterministic replay.

Update apps/api/src/types/models.ts:

Extend TransitionEdge to include:

clickContext?: { scope: 'page'|'nav'|'dialog'|'main'|'unknown'; scopeSelector?: string; elementText?: string; ariaLabel?: string; role?: string; testId?: string; href?: string }

preClickUrl?: string

postClickUrl?: string

fromFingerprint?: string

toFingerprint?: string

createdAt: string (ISO)

Extend TestRun to include:

stepResults?: Array<{ stepIndex:number; edgeId?:string; status:'pass'|'fail'; attempts: Array<{ kind:string; selector:string; matched:number; chosenIndex?:number; error?:string }>; note?:string; screenshotKey?:string }> (optional)

Update store persistence and any JSON serialization to include these new fields without breaking older data.

Update graph add emits to include these new edge fields when present.

Must compile.

Output code changes only.

PROMPT 2 (Backend) — During discovery: capture click context (nav/dialog/main) + stable attributes

Prompt:
Update the Playwright discovery runner to capture click context for each clicked element and store it into TransitionEdge.clickContext.

Implementation requirements:

When you pick a candidate element to click, evaluate in the browser context:

whether it is inside nav (closest('nav'))

inside a dialog/modal (closest('[role="dialog"]') or .overlay.show etc.)

inside main (closest('main'))

Determine scope:

if inside dialog -> 'dialog'

else if inside nav -> 'nav'

else if inside main -> 'main'

else 'page'

Capture best-effort attributes:

innerText trimmed (first 60 chars)

aria-label

role (from computed ARIA if possible; else tag)

data-testid if exists

href for anchors

Store in edge.clickContext:

scope

scopeSelector:

for 'nav' use 'nav'

for 'dialog' use '[role="dialog"]'

for 'main' use 'main'

for page/unknown keep undefined

Also store preClickUrl/postClickUrl and from/to fingerprints.

Ensure you do not introduce heavy DOM traversal.
Must compile. Keep changes localized.

Output code changes only.

PROMPT 3 (Backend) — Implement robust locator building from selectorBundle + scoping

Prompt:
Implement a robust locator resolver for replay that supports scoping and avoids strict-mode failures.

Create apps/api/src/runners/locator.ts with:
Types:

SelectorBundle (same as current)

ClickContext (same as stored on edges)

AttemptLog = { kind:string; selector:string; matched:number; chosenIndex?:number; error?:string }

Functions:

getScopeRoot(page, clickContext): Locator

If clickContext.scopeSelector exists:

return page.locator(clickContext.scopeSelector)

Else:

return page

buildLocator(root, selectorPart): Locator

selectorPart.kind:

'role': root.getByRole(role, { name })

'testid': root.getByTestId(value)

'text': root.getByText(value, { exact: true }) but fall back to non-exact if exact has 0 matches

'css': root.locator(value)

Return Locator

chooseBestMatch(locator): Promise<{ locator: Locator, matched:number, chosenIndex:number }>

Count matches via locator.count()

If 0 -> return matched 0

If 1 -> chosenIndex 0

If >1:

prefer visible matches: iterate first up to 5 and pick first visible

otherwise pick 0

Return locator.nth(chosenIndex)

resolveAndClick(page, selectorBundle, clickContext, opts): Promise<{ attempts: AttemptLog[] }>

Try preferred then fallbacks

For each attempt:

build scoped root

build locator

wait for at least attached+visible:

use locator.first().waitFor({ state:'visible', timeout }) but avoid throwing if multiple; handle count first

chooseBestMatch, then click

if click succeeds, return attempts

else record error and continue

If all fail, throw error "All selector attempts failed".

Add good logging to return attempts list.

No new deps. Must compile.

Output code changes only.

PROMPT 4 (Backend) — Upgrade smoke runner to use resolveAndClick + stepResults logging + artifacts on fail

Prompt:
Replace any current smoke replay click logic with the new robust resolver.

Update apps/api/src/runners/<your_smoke_runner>.ts (or wherever real smoke runner is implemented) to:

For each step (edge in test case path):

Emit WS event test:step (new) before click:
{ type:'test:step', runId, testRunId, stepIndex, edgeId, fromLabel?, toLabel?, ts }

Call resolveAndClick(page, edge.selectorBundle, edge.clickContext, { timeoutMs: 8000 })

After click, wait strategy:

domcontentloaded (10s timeout ignore)

short 250ms

Save screenshot after each step (optional), always on failure:

use artifacts helper to store screenshot with naming: screenshot-step-${stepIndex}.png

Record attempt logs into TestRun.stepResults with matched counts and chosenIndex.

On any failure:

Save screenshot + trace file if available (or at least a JSON trace log)

Update TestRun.status='fail', failedStepIndex

Error summary should include the last attempt error and include how many matches were found.

Emit WS event test:fail with error summary + screenshot artifact key.

On success:

status='pass'

emit test:done

Also:

Extend apps/api/src/types/events.ts to include:

test:step

test:fail

test:done
Keep backward compatibility.

Output code changes only.

PROMPT 5 (Backend) — Add “unstable edge” tagging + avoid in suite generation

Prompt:
Improve smoke suite selection by avoiding unstable edges.

Update TransitionEdge to include:

tags?: string[] (if not already)

Ensure store persists tags.

In discovery runner:

If an edge click results in:

same fingerprint as before (no navigation/state change) for 2+ times

OR opens a dialog and then returns to same state repeatedly

OR toFingerprint equals fromFingerprint
Then tag that edge as unstable.

Update smoke suite generator:

Prefer paths that contain 0 unstable edges.

If insufficient, allow at most 1 unstable edge.

Return code changes only.

PROMPT 6 (Backend) — Better waits + “element became visible” evidence

Prompt:
Improve replay timing robustness.

In resolveAndClick / smoke runner:

Before attempting click, if matched > 0 but not visible:

wait up to timeout for visibility

After click, additionally wait for either:

URL change from preClickUrl OR

fingerprint change (call fingerprint util) OR

a short stable delay (250ms)
Record which condition triggered in stepResults.note:

"url_changed"

"fingerprint_changed"

"timeout_stabilized"

This helps debug.

Output code changes only.

PROMPT 7 (Frontend) — Add Test Run timeline events (test:step/test:fail/test:done)

Prompt:
Update the frontend to support new test run WS events and display them.

Extend src/api/types.ts RunEvent union:

add test:step, test:fail, test:done

In store timeline appender, include these events.

Update RunDetailPage:

Show a “Replay Steps” list if the run has stepResults:

step index

status

attempt summary: kind + matched + chosenIndex

a link to screenshot if present

If stepResults not present, show fallback message.

Output code changes only.

PROMPT 8 (Frontend) — Edge detail shows clickContext + unstable tag + replay stats

Prompt:
Enhance Edge Detail UI (DiscoveryPage edge modal/panel):

Show clickContext:

scope

scopeSelector (if any)

ariaLabel / elementText / role / testId / href

Show tags including 'unstable' prominently with a warning style.

Add a “Copy replay debug JSON” button that copies:
{ edgeId, selectorBundle, clickContext, tags }

Also add a small explanation text:

"Replay uses clickContext to scope selectors (nav/dialog/main)."

Output code changes only.

PROMPT 9 (Frontend) — Smoke suite UI: exclude unstable edges toggle + show chosen paths

Prompt:
Improve the smoke suite generation UX:

On DiscoveryPage, when user clicks "Generate Smoke Suite":

Display the generated suite list:

each test case name

number of steps

how many unstable edges included

Add a toggle "Avoid unstable edges" (default ON) that sends a flag to backend generate endpoint (update backend to accept this).
If backend doesn't support it, implement frontend-only filter by refusing suites containing unstable edges and showing a warning.

Output code changes only.

PROMPT 10 (Backend+Frontend) — Contract alignment + hardening

Prompt:
Do a final pass to ensure FE/BE contracts align after Replay Robustness v1.

Backend:

Ensure REST endpoints return:

TransitionEdge.selectorBundle, clickContext, tags

TestRun.stepResults if present

Ensure WS emits test:* events with required fields.

Frontend:

Ensure API client typing matches backend payloads

Ensure no crashes if fields are missing (older persisted runs)

Add minimal toasts:

"Smoke run started"

"Smoke run failed at step X"

"Smoke run passed"

Output code changes only.