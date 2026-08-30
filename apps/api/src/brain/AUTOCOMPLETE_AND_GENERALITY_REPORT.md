# Xsion — Autocomplete Fix + Generality (Gap #3) Report
_(ultracode workflow, 10 agents, 2026-08-22)_

> **⚠ CORRECTION (measured after implementation, 2026-08-22):** the spec's ArrowDown re-probe is NOT sufficient for
> keystroke-DEBOUNCED widgets (MUI/AntD search). MEASURED on schooltalk: a one-shot `.fill()` never fires MUI's
> per-character input-event debounce → no dropdown → returns 'plain'. FIX (implemented in autocompleteFill.ts): if no
> option-delta after ArrowDown, and the field is SEARCH-LIKE (placeholder/aria/name matches /search|find|lookup|type
> to/ OR aria-autocomplete/combobox present), CLEAR + `pressSequentially(value, {delay:80})` + ~1200ms settle, then
> re-check the delta. Cleared-then-retype has no silent-short-fill risk (unlike the rejected End+Backspace nudge);
> assert inputValue()===value before returning 'plain', else 'failed'. Also: schooltalk options are
> `<li class="MuiListItem-container" role=null>` — added `li[class*="MuiListItem"/"MuiMenuItem"/"ListItem"/…]` to
> DETECT_SEL/PICK_SEL (a CLASSED li is a real option, not a bare SignalR push-row).

## A+B+C — Final Report

The advisor's guidance is decisive and I'll incorporate all of it: three buckets (not two), dedup the four-way-repeated findings, separate report section order from implementation order, group same-function edits into one pass, and name the fixture-coverage hole as the first thing to build. Writing the report now as my final text output.

# XSION MAINTAINER REPORT — Autocomplete fix, generality gaps, and next-steps ordering

**Honesty frame up front.** Of everything below, only three things have actually been *executed*: `fill`/`click` on the two real crawls (`rnd_dent_map.json`, `rnd_schooltalk_map.json`) and the drop-precision oracle (`dropOracle.hermetic.ts`, has a working fixture harness). The autocomplete spec is unimplemented. Every forms/auth/nav gap is code-reading, not a fixture run — the auth audit says so in its own words ("reasoned from the traces, not fixture-run"). I use three buckets throughout: **proven-works**, **unverified (reasoned from code)**, **likely-breaks (concrete stressor identified)**. Do not treat unverified findings as proven — that is the one way this report could get you burned.

All line numbers are qualified with their file. There are five different files in play and the source material used bare `:520`-style refs across all of them.

---

## A) AUTOCOMPLETE FIX — final implementation spec

**Architecture: plain `.fill()` first, escalate only on measured evidence.** This helper sits on *every* fill in break-it, missions, and SoA, so the 95% plain-field case must stay near-free. Designs that call `pressSequentially` unconditionally were rejected for taxing that path.

### New file: `apps/api/src/brain/autocompleteFill.ts`

Self-contained (own tokenizer/scorer, imports only Playwright types → no inbound edge from `intentRunner`, no cycle). Signature:

```ts
fillMaybeAutocomplete(page: Page, input: Locator, value: string): Promise<'plain' | 'committed' | 'failed'>
```

- `'plain'` — no dropdown ever appeared; the `.fill()` already done IS the whole job. Zero extra mutation.
- `'committed'` — typed + option selected + commit VERIFIED.
- `'failed'` — a dropdown appeared but nothing committed. HONEST failure → caller reports `matched:0`.

Full function body is in the handed-down spec and should be transcribed verbatim. The load-bearing correctness decisions that MUST survive transcription (these are *why* the design converged — do not re-introduce the rejected alternatives):

**DO NOT RE-INTRODUCE (each is a live bug in Node/Playwright-server or a silent false-pass):**
1. **`CSS.escape(listId)`** — `CSS` is a browser global, **undefined in Node/Playwright-server**; throws `ReferenceError` on the first widget with `aria-controls`, i.e. exactly the new path. Use the guarded `safeId()` test (`/^[A-Za-z][\w-]*$/`) instead.
2. **Bare `li` in the DETECTION selector** — schooltalk runs SignalR live-list push updates; a bare-`li` count fires the autocomplete path on a push, not on typing. `DETECT_SEL` excludes bare `li`; `PICK_SEL` (looser) is applied only *after* detection fired. Detection also requires the option-count delta to HOLD across two reads (SignalR flake guard).
3. **`if (best < 0) best = 0`** — clicking row 0 on no match writes silent bad data; strictly worse than the current bug. Never click a zero/negative-score row → `keyboardCommit` instead.
4. **`End`+`Backspace`+retype nudge** — a silent retype failure leaves the field one char short while returning `matched:1`, a *worse* vacuous pass than the bug being fixed. Replaced by the **non-mutating `ArrowDown` re-probe** (gated behind `isTextish`, which excludes date/number/checkbox where ArrowDown would mutate).
5. **`quotes[1]` as the value** — for `type "abc" into "Search"`, `quotes[1]` is the field *name*. Strip wrapping quotes off `withVal[1]` instead (companion fix below).
6. **Chip branch gated on `val === ''` alone** — false-fails react-select/AntD/MUI-multiple. Use the disjunctive `verifyCommit` (text OR chip+empty OR listbox-collapsed).

Detection is the **DOM option-count delta** as the sole detector that fires on the measured schooltalk case (bare `input[type="text"]`, no ARIA); ARIA markers are an *additional* trigger for generality, never the gate. (The incoming lean toward an ARIA gate was corrected — it would not fire on schooltalk.)

### Insertion points (three sites + one companion fix)

**Companion fix — REQUIRED, `intentRunner.ts:108`** (the value expression in the `parseIntent` return, NOT line 105). Break-it emits the value *quoted*, so `withVal[1]` is `"Jane Doe"` with quote characters; `pressSequentially` would type a `"` and match nothing. Strip wrapping quotes off `withVal[1]`; for the unquoted shape, strip trailing select-clauses; never over-strip to empty. **This fix is required for A to work at all — it cannot be deferred.**

**Site 2 — `intentRunner.ts:539`, raw-input placeholder scan — THE LOAD-BEARING HOOK.** The measured schooltalk field resolves *here* (no accessible role-name → not the role path). Inside `scanAndFill`, read `boundingBox` FIRST (an open list shifts layout), then call `fillMaybeAutocomplete`; on `'failed'` return `done` with `matched:0` and an error string. Returning `done` (not retry) on `'failed'` is correct: inputs exist, so the reveal-retry must not fire — the existing `r.seen.length === 0` guard (~`intentRunner.ts:553`) already prevents it.

**Site 1 — `intentRunner.ts:510`, role textbox/combobox path.** For ARIA-exposed autocompletes (MUI/AntD generality). `box` read at `intentRunner.ts:508` stays first; then the helper; `'failed'` → `matched:0`.

**Site 3 — `crawlMapService.ts:1440`, `fillByLabel` (replay honesty).** Between the Locator resolve (`crawlMapService.ts:1439`) and the `data-xsfill` strip (`:1441`) — the attribute-scoped Locator must stay live. Replace the `.fill()`; `return r !== 'failed'`.

**Break-it needs no call site.** `breakItService.ts:328` emits `fill the "X" field with "value"` strings that flow through `parseIntent`→`resolveFill`; fixing site 2 + the value fix fixes break-it's 2/4 automatically. No change to `breakItService.ts` or `attackScaffold.ts`.

### Fallback ladder (summary)
1. `.fill()` throws (readonly) → click + `ControlOrMeta+A` + `pressSequentially`.
2. No option delta + no ARIA markers → non-mutating `ArrowDown` re-probe → still nothing → `'plain'` (zero mutation).
3. List markers present but list never paints (1200ms) → `keyboardCommit` (ArrowDown+Enter+verify).
4. List shows only "No results"/"Loading" (after one 500ms retry) → `'failed'`.
5. Options exist but none score > 0 → `keyboardCommit`, never a wrong-row click.
6. Best-option click throws → `keyboardCommit`.
7. Click/keyboard succeeded but `verifyCommit` fails all three shapes → `'failed'` (→ `matched:0`).

Worst-case wall time ≈ under 9s, well within `XSION_STEP_CAP_MS` = 60000ms (`intentRunner.ts:799`).

### Flagged, adjacent to A (a second path to the same 2/4 symptom this helper CANNOT reach)
`intentRunner.ts:92` — the bare `/\bpress\b/` alternative fires *before* the fill branch at `intentRunner.ts:97`, so `"type the teacher name and press Enter to select"` routes to `verb='press'` and never reaches `resolveFill`. Narrow the `press` branch so it doesn't swallow phrasings that also contain `type/fill/enter the … name`. This is a `parseIntent` change — group it with the line-108 value fix in one commit.

### Verification caveat (critical — see §C)
**No fixture exercises autocomplete.** A cannot be verified against a fixture today. Verification is either the schooltalk teacher-search field manually, or a new fixture must be written.

---

## B) GENERALITY (Gap #3)

### Harness facts (how the crawler is pointed at anything)
- **Entry:** `npx tsx src/cli.ts check` from the app dir, reads `.xsion.json` (`{ name, baseUrl, repo, authorized: true }`). `baseUrl` is the crawl entry; `startCrawlMap` (`crawlMapService.ts:194`) navigates there.
- **Mode axis:** `crawlMapService.ts:343` → `mode: repo ? 'code' : 'blackbox'`. Omit `repo` → blackbox. Fixtures can only meaningfully exercise **blackbox**.
- **`file://` is OUT.** `crawlMapService.ts:364/:738/:758` drop any candidate whose `new URL(...).origin` ≠ baseUrl's origin; `file://` origin is `"null"`. Serve over localhost. `baseUrl` must be an http origin for scope checks to behave.
- **No fixture server exists.** Convention: `dropOracle.hermetic.ts:111` expects `test-fixture/` on `:5199` via `XSION_FIXTURE_URL`. No-install serve:
  `cd /Users/raghavkundra/Desktop/Dev/xsion/apps/api/test-fixture && python3 -m http.server 5199`
- **Baseline maps (the "2 apps"):** `rnd_dent_map.json`, `rnd_schooltalk_map.json`. Inspect: `pages`, `flows`, `api`, `edges`, `routeManifest`, `knownUnknowns`, `siteModel`.

### Unambiguous run recipe (per target)
1. `cd /Users/raghavkundra/Desktop/Dev/xsion/apps/api/test-fixture && python3 -m http.server 5199`
2. In a scratch dir, write `.xsion.json`: `{ "name": "<target>", "baseUrl": "http://localhost:5199/<file>.html", "authorized": true }` (omit `repo` → blackbox).
3. From that dir, run a real crawl (do NOT pass `--no-crawl` on first run — first run needs the crawl):
   `npx tsx /Users/raghavkundra/Desktop/Dev/xsion/apps/api/src/cli.ts check`
4. Inspect the stored map's `pages`/`routeManifest`/`flows` against each fixture's in-file documented ground truth.

### Ranked runnable targets (fixtures first)

**1. hub.html — HIGHEST crawler-generality value.** 20 hash routes, 13 distinct states, 8 identical-structure duplicates listed FIRST (a FIFO/BFS trap). In-file ground truth (lines 9-16): novelty-ranked curiosity should reach more distinct states than BFS under a budget < 20. Stresses `stateSignature` collapse + frontier ordering/budget (`crawlMapService.ts:40, :274, :357`). Check: `routeManifest` lists ~13 distinct; dups must NOT each become a distinct page. Cleanest quantitative metric (distinct-states-reached vs budget). **Bucket: likely-breaks** (in-file ground truth exists, never run).

**2. verify.html — HIGH.** 4 hash routes, known affordance counts (lines 17-20). Dangerous POST-form controls (Delete account / Send Broadcast / Pay $49) must be flagged; safe look-alikes (Clear filters GET-form, Cancel, "Delete draft" `<a href>`) must be demoted. Plus infinite-scroll `#list` appending 200 rows of ONE kind → normalized-kind saturation. Stresses the safety/danger classifier (`authGate.ts` / `safetyGate`) and affordance-set + scroll saturation (`crawlMapService.ts:1106-1155`). **Bucket: likely-breaks** (documented counts, never run).

**3. hard-target.html — HIGH, adversarial.** Shadow-DOM buttons (`attachShadow` at `hard-target.html:326`), nested-modal loop trap (re-opens itself, `:385`), URL-token churn (`?t=`+token+`&x=`+uuidish, `:294`), duplicate/decoy labels. **Concrete finding: shadow-DOM affordances are invisible** (see cross-cutting §B-finding-1). Secondary: does `normUrl` strip `?t=`/`&x=` churn so the route dedups, or does churn explode the frontier? Does the modal loop-trap bound out? **Bucket: likely-breaks** (concrete stressor identified).

**4. calendar-dnd.html — LAST, NOT a crawl target.** Drop-precision oracle only; driven directly by `dropOracle.hermetic.ts` via `page.goto`, bypassing `startCrawlMap`. `?mode=correct|buggy|snap|persist=1` give known answers. Run: `XSION_FIXTURE_URL=http://localhost:5199 npx tsx src/brain/dropOracle.hermetic.ts` (skips gracefully if server down). **Bucket: proven-works** (working harness) for the oracle path; the crawl pipeline is not exercised here.

### Cross-cutting generality gaps (deduped — four audits described several of these as separate findings)

**FINDING 1 — Shadow DOM is invisible everywhere. ONE fix closes FOUR holes → top ROI.** Every page-side `evaluate` uses light-DOM `document.querySelectorAll` with no `shadowRoot` traversal. Evidence sites across the pipeline:
- Affordance harvest / signature: `crawlMapService.ts:64, :102, :937, :1290-1292`; `stateSignature.ts:151, :174`
- Auth classification: `authSignals.ts:52, :59, :67, :72` (note: Playwright `input[...]` locators at `crawlMapService.ts:1635/:1641` *do* pierce open shadow roots, but the *classification* in authSignals does not → login form in a shadow root reads as "not a gate")
- Form capture: `captureFormFields` scope `crawlMapService.ts:1231`; `extractFieldRequirements` `crawlMapService.ts:1704`
- **Fix direction:** one recursive open-`shadowRoot` walker in the shared field/affordance/signature evaluate queries. Stressor: `hard-target.html:326`. **Bucket: likely-breaks** (concrete stressor).

**FINDING 2 — Strict origin equality drops multi-origin/subdomain apps.** `crawlMapService.ts:364/:738/:758` require exact `new URL(...).origin === baseUrl.origin`, so `app.` ↔ `accounts.` ↔ `dashboard.` flows are silently dropped (and `file://` is out, see harness facts). Fix direction: scope by registrable domain (eTLD+1) with an opt-out, not exact origin. **Bucket: unverified (code-reading).**

**FINDING 3 — Uncovered axis: multi-file cross-document link-following.** All fixtures are single-document hash-routed SPAs → they exercise the in-place SPA frontier + action-path replay (`crawlMapService.ts:40, :274`) and `stateSignature` collapse, but NOT anchor-crawl across pages (`crawlMapService.ts:737-758`), which only the two baseline maps touch. Not a code gap — a **fixture coverage hole**. Named again in §C.

### Top generality gaps by shape — proven-works vs unverified vs likely-breaks

**Proven-works (executed):**
- `fill` / `click` on the two baseline app shapes (dent = classic form; schooltalk = SSO-first + slow-hydrate click-SPA).
- Drop-precision differential oracle (`dropOracle.hermetic.ts`).

**Likely-breaks (concrete stressor identified — highest confidence among the un-run):**
- Shadow-DOM blindness (FINDING 1; `hard-target.html:326`).
- hub.html duplicate-state collapse under BFS/budget (in-file ground truth, lines 9-16).

**Unverified (reasoned from code only — do NOT report as proven; all forms/auth/nav findings below):**

FORMS (`crawlMapService.ts` capture + `intentRunner.ts` executor) — top tier are *silent false passes* (return `matched:1` while doing nothing; worse than a hard failure):
1. **Checkbox/radio steps false-pass.** `intentRunner.ts:100` classifies any step containing `check` as `verb='observe'` → no-op branch (`:866-868`) returns `matched:1`. No `.check()`/`setChecked` anywhere. Fix: add `check`/`toggle` verb ahead of observe, gated on checkbox/radio role, dispatching `setChecked`.
2. **Custom dropdowns false-pass.** `resolveSelect` only queries native `page.locator('select')` (`intentRunner.ts:273`). React-Select/MUI/Radix return null → fall to `resolveClick` (`:873`) → opens menu, reports `matched:1`, never picks. Fix: on null, click trigger, require a `[role=option]`/listbox match, fail honestly if none.
3. **Typed inputs (number/email/tel/date) unfillable + trip a blind reveal.** `inputSel` (`intentRunner.ts:520, :603`) excludes `email/number/tel/url/date/password`; `type=number` is role `spinbutton`, missed by `bestMatch(..., ['textbox','combobox'])` at `:506`. Miss → `seen.length===0` → trips REVEAL-TO-FILL guard at `:550` → blind command-palette click on a working form. Fix: widen `inputSel`, add `spinbutton` to `bestMatch` roles. **(Adjacent to A's site 2 — sequence together, see §C.)**
4. **`fillByLabel` can't set selects/files; its reject deletes crawl branches.** `crawlMapService.ts:1424` puts `select` in the candidate set then `.fill()`s it (`:1440`); catch → false → `replayOk=false` at `:590` → whole frontier branch dropped as "app changed." Same for file inputs, readonly date-pickers. Fix: branch on tag/type (`selectOption`/`setInputFiles`/keyboard), never treat fill-reject as "app changed."
5. **Multi-step wizards can't be encoded → collapse to one page.** `NavStep` is only a click-label or `{fill,value}` (`crawlMapService.ts:40, :586-589`) — no select/check step kind. `extractFieldRequirements` (`:698`) is pure metadata, `met` hardcoded `false` (`:1729`), nothing consumes it → clicks "Next" without satisfying validation → signature collapses wizard to one page. Fix: extend `NavStep` with select/check/upload; satisfy required fields before Next.
6. **Cascading/dependent selects false-pass.** `resolveSelect` picks first select scoring ≥1 (`intentRunner.ts:284`), no target-label scoping, no wait for repopulation. Country→State fires against stale options, throws, falls to item-2 false-pass click. Fix: scope by target label, wait for repopulation.
7. **Capture collapses radio groups, drops unlabeled fields.** `captureFormFields` skips no-label fields (`crawlMapService.ts:1248`), dedupes by lowercased label (`:1249-1250`); radio group collapses N→1; same-label distinct fields merge; selectors `#id`→`[name]`→`input[type]` (`:1700-1702`) non-unique for radios; cap 25 (`:1255`). Fix: group by `name` for radio/checkbox, make selectors positionally unique, add fieldset/legend grouping.
8. **Rich-text editors invisible + unfillable.** Neither `FIELD_SEL` (`crawlMapService.ts:1226`), the requirement scan (`:1704`), nor `inputSel` (`intentRunner.ts:520`) match `[contenteditable]`/`[role=textbox]`. Fix: include them in capture and fill via focus + keyboard type.
- Minor: `STOPWORDS` (`intentRunner.ts:117-119`) and target-strip regex (`:103`) omit `checkbox`/`radio`/`toggle`; verb precedence (`:97` fill before `:99` select) means a mixed step only fills.

AUTH (`authSignals.ts`, `authGate.ts`, `crawlMapService.ts`) — false-passes/destructive first:
1. **OAuth-redirect & 2FA/OTP → false `signed-in`.** `knownAppRoute` (`crawlMapService.ts:1664, :474`) checks `pathname` only, never origin. `judgeTick` (`authSignals.ts:155-157`) returns `in-app` on url-change + no password field. OAuth bounce or `/verify-code` satisfies both → false `signed-in` on a consent/OTP screen. Fix: `knownAppRoute` must require same origin AND path not matching auth vocab (`/oauth /verify /mfa /consent /sso /callback`).
2. **DESTRUCTIVE — captcha / "field required" re-arms the CRED-WIPING branch.** Error regex (`authSignals.ts:76`) matches `try again`; CTX guard (`:77`) matches the form. Two consecutive ticks → `rejected` → `crawlMapService.ts:492-495` clears stored creds (`_defaultCreds: undefined`). Captcha "please try again" is indistinguishable from genuine rejection. **This is the ONLY destructive finding in the entire set.** Fix: only `rejected` on unambiguous phrases (`invalid email or password`, `bad credentials`); never clear creds on first crawl of an unfamiliar shape — downgrade ambiguous → `indeterminate` (keep creds, block).
3. **`__nav:N` asymmetry → false `signed-in`.** `authSignals.ts:68` pushes `__nav:${n}` into `authedAffordances`; `classifyLoginGate` filters it out (`:108`) but `judgeTick` uses bare `.length` (`:154`). A login page with a marketing nav → `in-app`. Fix: apply the same `__nav` filter in `judgeTick`.
4. **Login page with "Dashboard/Settings" header scored NOT a gate (reopens schooltalk failure).** `AUTHED_VOCAB` (`authSignals.ts:63`) matches those words; `classifyLoginGate:109` subtracts 3; `ssoWall` +2 (`:112`) requires `!insideApp` so never fires → not a gate → maps login screen, reports `done`. Fix: don't count header/marketing app-word links as `authedAffordances`; require a `logout`/`sign out` control to zero out a gate.
5. **`resolveIdentifierField` types email into search/promo box.** `crawlMapService.ts:1598` scores search/coupon at −6 but `bestScore` starts at `0` (`:1601`) → negative can't win → `best` stays −1 → fallback `best = 0` (`:1605`) picks first non-password input (the excluded one). Fix: init `bestScore = -Infinity`; prefer the text input immediately preceding the password field.
6. **HONEST-BLOCK — magic-link/passwordless/multi-tenant step-1 blocked, but message blames creds.** No password field → `input[type="password"].fill()` (`crawlMapService.ts:1641`) times out → `indeterminate`; `authGate.ts:46` wrongly says creds "didn't sign in"; `:33` burns 8s. Fix: detect passwordless/SSO-only walls, emit shape-specific message, skip the 8s wait when SSO-wall.
7. **authGate FAILS OPEN on probe error / 45s cap (the exact bug the file claims to prevent).** `authGate.ts:50-52, :61` return `blocked:false` on throw/timeout → break-it runs against the login screen. Fix: on cap/error for a page that DID look like a gate, fail CLOSED; fail-open only when the probe positively saw a non-gated app.

NAV / render (`crawlMapService.ts`, `stateSignature.ts`):
1. **No iframe support anywhere — silent state loss.** Zero `frames()/frameLocator/contentFrame` in `src/brain/`; every `evaluate` is top-frame only (`crawlMapService.ts:64/102/937/1290`); `domSignature.len` (`:1483`, `body.innerText`) excludes child frames → in-iframe nav changes neither URL nor bodyLen → `viewChanged` (`:1386-1387`) false → state dropped, map reads as complete. Fix: iterate same-origin `page.frames()` in harvest + signature.
2. **Click-nav discovery collapses on non-English / icon-only UIs.** `NAV_HINT` (`crawlMapService.ts:1210`) is a ~30-word English regex gating which controls get clicked (`:1355`); `aggressive` only fires when `sameOriginAnchors === 0` (`:759`). Localized/icon apps get everything classed `action` (`:1348`), never clicked. Fix: fall back to aggressive when `NAV_HINT` matches 0 non-destructive candidates, not only when anchors===0.
3. **`waitForHydration` has no staleness baseline — hash-routing race.** Both phases (`crawlMapService.ts:100-106, :111-119`) are absolute predicates; hash routes via `gotoRendered` (`:583→:128`) where networkidle returns instantly → Phase 1 passes on previous route's controls, Phase 2 sees already-stable count → capture races the swap (click path masks with `waitForTimeout(800)` at `:1378`; hash-goto has none). Fix: pass a pre-nav node-count/title baseline, require change before stability poll.
4. Shadow DOM — see FINDING 1.
5. **`viewChanged` text-length threshold misses fine changes.** `|Δlen| > 250` (`crawlMapService.ts:1387`) — tab switches, filter-applies, small modals lost. Fix: OR in a structural-signature delta.
6. **`revealByScroll` only moves `scrollTop`.** (`crawlMapService.ts:1143`) — no-op for ag-Grid/transform virtual lists. Fix: also drive `page.mouse.wheel`/PageDown.
7. Strict origin equality — see FINDING 2.
8. **Kind-saturation short-circuit strands heterogeneous tail.** `if (sawLabels) { if (kindStall...) break }` (`crawlMapService.ts:1186`) never consults height/key stalls. Fix: require kind AND height/key stall before breaking.
9. **Hydration never settles on live-updating pages.** Phase-2 `|n - prev| <= 2` (`crawlMapService.ts:115`) never converges with a ticker/toast/carousel → burns full `HYDRATE_TIMEOUT = 20000` (20s, `:34`) per page. Fix: cap the poll independently or tolerate a bounded oscillation band.

---

## C) NEXT-STEPS ordering — from "works on 2 apps" toward "works on many"

**IMPORTANT: this implementation order differs from the report's section order (A/B/C).** Section A is first because you asked for that section layout, not because the autocomplete feature is the top priority. By damage, the destructive auth bug precedes it.

### Step 0 (BEFORE anything else) — build the missing fixtures. This is the precondition for "works on many."
The fixture inventory has a hole exactly where the two highest-severity areas live: **no fixture exercises autocomplete, and no fixture exercises auth** (hub/verify/hard-target contain no login flow). That means A cannot be verified against a fixture, and every one of the 7 auth findings is unverifiable today. Also missing: **multi-file cross-document link-following** (FINDING 3). Build, in this order:
1. A login fixture served on `:5199` covering: classic form, SSO-first wall, OAuth bounce off-origin, `/verify-code` OTP, captcha "please try again", magic-link (email-only), and a `<login-form>` shadow-DOM variant. This single fixture makes auth findings 1–7 + the shadow-DOM auth site testable.
2. An autocomplete fixture: bare `input[type=text]` type-then-select (schooltalk shape), an ARIA combobox (MUI/AntD), a react-select chip widget, a "no results" case, and a SignalR-style live-`li` push to prove the DETECT_SEL exclusion holds.
3. A two-file cross-document site (real anchors, two origins-worth of paths) for the uncovered link-following axis.

Until (1) and (2) exist, verify A and the auth fixes manually against the schooltalk teacher-search field and mark them UNVERIFIED in any status you publish.

### Step 1 — Auth #2, the destructive cred-wipe. FIRST by damage.
Narrowed regex + downgrade ambiguous errors to `indeterminate`, never clear creds on first crawl (`authSignals.ts:76`, `crawlMapService.ts:492-495`). Roughly one commit. It destroys correct user credentials on any app with a captcha or a required-field validator — that precedes shipping any new feature. Test against login fixture (0) once built; until then, reason-check only.

### Step 2 — The `parseIntent` commit (required for A).
Group together, one commit: line-108 value-quote fix + the `/\bpress\b/` narrowing at `intentRunner.ts:92` (both are `parseIntent` changes; the value fix is load-bearing for A). Test: break-it `fill … with "value"` strings tokenize without the leading `"`.

### Step 3 — The single `scanAndFill`/`resolveFill` pass (A + forms #3 together — same function, adjacent lines).
Do NOT edit this scan twice. In one pass: (a) widen `inputSel` to typed text-like inputs + add `spinbutton` to the `bestMatch` role list (forms #3, `intentRunner.ts:520/:506/:550`), THEN (b) insert `fillMaybeAutocomplete` at site 2 (`:539`), site 1 (`:510`), and site 3 (`crawlMapService.ts:1440`). Ordering matters: widen the selector first so the reveal-to-fill guard stops mis-firing, then graft the helper on top. Test: schooltalk teacher-search manually now; autocomplete fixture once built.

### Step 4 — Shadow-DOM walker. Highest ROI structural fix: ONE change, FOUR holes.
Add one recursive open-`shadowRoot` walker to the shared field/affordance/signature evaluate queries (FINDING 1 sites). Closes generality-target #3's concrete finding, forms #9, auth #8, nav #4 simultaneously. Test: `hard-target.html` (shadow buttons must enter the affordance set) + the shadow-DOM login-fixture variant.

### Step 5 — Run the three generality fixtures and record results (converts "likely-breaks" → measured).
In order: **hub.html** first (quantitative distinct-states-vs-budget metric; the cleanest generality number), then **hard-target.html** (confirms Step 4 closed shadow-DOM; checks normUrl churn + modal loop-trap), then **verify.html** (danger classifier + scroll saturation — a different pipeline stage). This is the first point where any of B's likely-breaks becomes proven either way.

### Step 6 — Remaining forms false-passes (checkbox/radio #1, custom dropdown #2, cascading #6).
These are the next silent-false-pass class after A. Each needs its own fixture affordance (add to the forms fixture). Order by frequency in real apps: custom dropdown (#2) > checkbox (#1) > cascading (#6).

### Step 7 — Remaining auth honest-blocks + fail-open (#1, #3, #4, #5, #6, #7).
Correctness/UX, not data-loss. Do after the login fixture (0) exists so each is verifiable. #7 (fail-open) and #1 (origin check on `knownAppRoute`) are the two that let break-it run against a login screen — prioritize those within this group.

### Step 8 — Nav robustness (#1 iframe, #2 non-English, #3 hydration race, #9 live-page timeout) and origin-scope widening (FINDING 2 + multi-document fixture).
Broadest generality lift for genuinely unfamiliar apps, but each is larger and lower-confidence than the false-pass fixes above. Iframe (#1) and non-English nav (#2) unlock whole app classes; do them before the polish items (#5, #6, #8).

### Honest status of "works on many" after this sequence
Steps 1–5 move you from "works on 2 apps" to "no longer silently lies or destroys creds on the shapes we can name, and shadow-DOM/hub/hard-target are measured." Steps 6–8 extend coverage but each remains **unverified until its fixture exists**. The gating reality: **without Step 0 fixtures, most of this stays code-reasoned, not proven.** The fixture build is not optional overhead — it is the mechanism that turns this whole backlog from "reasoned" to "known."

---

## Full autocomplete implementation spec (fillMaybeAutocomplete)

Everything is settled. I have the measured markup, the timeout budget, the SignalR flakiness vector, and confirmation of which hook is load-bearing. Writing the final spec now.

---

# FINAL SPEC — `fillMaybeAutocomplete`: type-then-select autocomplete fill handler

## Verdict

**Base architecture: Design #1** (plain `.fill()` first, escalate only on evidence). It is the only one that respects the stated constraint — this helper sits on **every** fill in break-it, missions, and SoA, so plain fields must stay near-free. #2 and #3 both call `pressSequentially` unconditionally, taxing the 95% plain-field case on the engine's path. Rejected.

**But #1's escalation mechanism is replaced, and grafts are pulled from #2/#3.** Grounded in the measured data:

- `apps/api/rnd_schooltalk_map.json` shows the teacher-search field is **bare `input[type="text"]`** — `label: "Search for teacher's calendars using names"`, no `role`, no `aria-controls`, no `aria-autocomplete`, no combobox/listbox markers anywhere in the map. **Therefore the DOM option-count delta is the sole detector that fires on the measured case; ARIA is an *additional* trigger for generality, never the gate.** (This corrects the incoming lean toward an ARIA gate — it would not fire on schooltalk.)
- The field has no accessible role-name, so it resolves through the **RAW-INPUT PLACEHOLDER SCAN (site 2)**, not the role path. **Site 2 is the load-bearing hook.**
- The map shows SignalR live dashboard updates and 12–13 list-bearing interactives per page. A detection count that includes bare `<li>` can fire on a push update, not on typing → false autocomplete path. **The detection selector must exclude bare `li`.**
- Step cap is `XSION_STEP_CAP_MS` = **60000ms** (intentRunner.ts:799). Ceilings are an aggregate-cost concern, not a per-step crash risk — but use #3's tight event-gated ceilings anyway (don't burn 4s × N steps of a shared budget).

## Grafts and hard rejections

| Source | Grafted | |
|---|---|---|
| #1 | plain-`.fill()`-first architecture; never click a zero-score option; box-read stays first | ✅ core |
| #2 | disjunctive `verifyCommit` (text **or** chip+empty **or** listbox-collapsed); no-results/loading guard; readonly-clear fallback | ✅ |
| #3 | tight event-gated ceilings (1200ms open, 600ms commit poll); aria-controls-scoped pick when a valid id exists | ✅ |
| — | **NEW:** non-mutating `ArrowDown` re-probe replaces #1's corrupting `End`+`Backspace`+retype nudge | ✅ decisive |

**Rejected outright:**
- #1's no-delta nudge (`End`→`Backspace`→`pressSequentially`): fires on every plain field, and a silent retype failure leaves the field one char short while returning `matched:1` — a worse vacuous pass than the bug being fixed.
- #3's `if (best < 0) best = 0`: clicking row 0 on no match writes silent bad data. Strictly worse than the current bug.
- #1's chip branch gated on `val === ''` alone (false-fails react-select/AntD/MUI-multiple): superseded by #2's disjunctive verify.
- `CSS.escape(listId)` in **#1 and #3**: `CSS` is a browser global, **undefined in Node/Playwright-server** — throws `ReferenceError` on the first widget with `aria-controls`, i.e. exactly the new path. Replaced with a guarded id test.
- Reaching for `quotes[1]` as the value (#1/#2): for `type "abc" into "Search"`, `quotes[1]` is the field name. Strip wrapping quotes off `withVal[1]` instead.

## The function to add — `src/brain/autocompleteFill.ts` (new, self-contained)

Own tokenizer/scorer, no import back into `intentRunner` (severs any cycle risk). Imports only Playwright types.

```ts
import type { Page, Locator } from 'playwright';

// ── DETECTION selector: option nodes ONLY. NO bare `li` — schooltalk runs SignalR live list updates,
//    and a bare-li count would fire the autocomplete path on a push update, not on our typing. ──
const DETECT_SEL = '[role="option"], .ant-select-item-option, [class*="MuiAutocomplete-option" i]';
// ── PICK selector: looser, applied only AFTER detection fired, scoped to the widget's own list when possible. ──
const PICK_SEL =
  '[role="option"], [role="listbox"] li, ul[class*="option" i] li, ul[class*="menu" i] li, [class*="MuiAutocomplete-option" i]';
const NO_RESULT_RE = /^\s*(no (options|results|matches|data)|loading|searching|\.\.\.)\s*$/i;

const STOP = new Set(['the','a','an','of','for','and','or','with','to','in','on']);
function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 1 && !STOP.has(w));
}
function scoreText(optText: string, value: string): number {
  const a = optText.trim().toLowerCase(), v = value.trim().toLowerCase();
  if (!a || NO_RESULT_RE.test(a)) return -1;
  if (a === v) return 100;                          // exact wins
  if (a.startsWith(v) || v.startsWith(a)) return 60; // prefix beats scattered overlap → "Jane Doe" not "Janet"
  const have = new Set(words(a));
  return words(v).reduce((acc, w) => acc + (have.has(w) ? 2 : a.includes(w) ? 1 : 0), 0);
}
// Node-safe id guard — CSS.escape does NOT exist server-side. Only build a #id selector for a simple id.
function safeId(id: string | null): string | null {
  return id && /^[A-Za-z][\w-]*$/.test(id) ? id : null;
}
async function detectCount(page: Page): Promise<number> {
  try { return await page.locator(DETECT_SEL).count(); } catch { return 0; }
}
/** keystrokes meaningful? textarea + textual <input>. Gates out <select>, date/number/checkbox (where ArrowDown mutates). */
async function isTextish(input: Locator): Promise<boolean> {
  try {
    const tag = (await input.evaluate((el: any) => el.tagName)).toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = ((await input.getAttribute('type')) || 'text').toLowerCase();
    return ['text','search','email','tel','url',''].includes(t);
  } catch { return false; }
}

/**
 * Signature:
 *   fillMaybeAutocomplete(page: Page, input: Locator, value: string): Promise<'plain' | 'committed' | 'failed'>
 *
 *   'plain'     — no dropdown ever appeared; the .fill() already done IS the whole job. Zero extra mutation.
 *   'committed' — typed + an option selected + commit VERIFIED.
 *   'failed'    — a dropdown appeared but nothing committed (HONEST failure → caller reports matched:0).
 *
 * Worst-case wall time (all event-gated, ceilings not costs): fill 6000 + settle 150 + ArrowDown reprobe 250
 *   + open 1200 + N textContent reads (~12×~30ms) + keyboard commit 250 + verify poll 600 ≈ under 9s,
 *   well within the 60s XSION_STEP_CAP_MS step budget.
 */
export async function fillMaybeAutocomplete(
  page: Page, input: Locator, value: string,
): Promise<'plain' | 'committed' | 'failed'> {
  const one = input.first();
  await one.scrollIntoViewIfNeeded().catch(() => {});

  // ── FAST PATH: the ordinary fill every non-autocomplete field needs. Baseline BEFORE typing (delta, not presence). ──
  const before = await detectCount(page);
  try { await one.fill(value, { timeout: 6000 }); }
  catch {                                             // readonly widgets (some AntD): clear via select-all
    await one.click({ timeout: 3000 }).catch(() => {});
    await one.press('ControlOrMeta+A').catch(() => {});
    await one.pressSequentially(value, { delay: 40 }).catch(() => {});
  }

  if (!(await isTextish(one))) return 'plain';        // <select>/date/etc — .fill already did the right thing

  // Did .fill()'s input event open a list? (require the delta to HOLD across two reads — SignalR flake guard)
  await page.waitForTimeout(150);
  let after = await detectCount(page);
  if (after <= before) after = await detectCount(page);

  // ── NON-MUTATING RE-PROBE: some widgets open only on a key event, not on .fill()'s input event.
  //    ArrowDown changes no value (isTextish already excluded date/number where it would). NOT End/Backspace/retype. ──
  const ariaAutocomplete = await one.getAttribute('aria-autocomplete').catch(() => null);
  const ariaControls = safeId((await one.getAttribute('aria-controls').catch(() => null))
                          || (await one.getAttribute('aria-owns').catch(() => null)));
  const ariaTrigger = ariaAutocomplete != null || ariaControls != null
                   || (await one.getAttribute('role').catch(() => null)) === 'combobox';

  if (after <= before && !ariaTrigger) {
    await one.click().catch(() => {});
    await one.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(250);
    after = await detectCount(page);
    if (after <= before) return 'plain';             // genuinely plain — value is typed, done, zero mutation
  }

  // ── AUTOCOMPLETE PATH. Scope the list to the widget's own id when it exposes a safe one; else page-level. ──
  const list = ariaControls
    ? page.locator(`#${ariaControls} [role="option"], #${ariaControls} li`)
    : page.locator(PICK_SEL);
  try { await list.first().waitFor({ state: 'visible', timeout: 1200 }); }
  catch { return keyboardCommit(page, one, value); } // markers said combobox but no list painted → keys

  // ── NO-RESULTS / LOADING GUARD: "a list rendered" ≠ "an option exists". ──
  {
    const first = ((await list.first().textContent().catch(() => '')) || '').trim();
    if (NO_RESULT_RE.test(first)) {
      await page.waitForTimeout(500);                 // one more debounce settle
      const retry = ((await list.first().textContent().catch(() => '')) || '').trim();
      if (!retry || NO_RESULT_RE.test(retry)) return 'failed';
    }
  }

  // ── PICK: best option by score. NEVER click a zero/negative-score row. ──
  const n = Math.min(await list.count().catch(() => 0), 12);
  let bestI = -1, bestS = 0, bestTxt = '';
  for (let i = 0; i < n; i++) {
    const txt = ((await list.nth(i).textContent().catch(() => '')) || '').trim();
    const s = scoreText(txt, value);
    if (s > bestS) { bestS = s; bestI = i; bestTxt = txt; }
  }
  if (bestI < 0 || bestS <= 0) return keyboardCommit(page, one, value); // no meaningful match → keys, not a wrong row

  try { await list.nth(bestI).click({ timeout: 3000 }); }
  catch { return keyboardCommit(page, one, value); }

  return (await verifyCommit(page, one, bestTxt)) ? 'committed' : keyboardCommit(page, one, value);
}

// ArrowDown/Enter — widget-agnostic commit when an option node can't be found/clicked.
async function keyboardCommit(page: Page, input: Locator, value: string): Promise<'committed' | 'failed'> {
  try {
    await input.press('ArrowDown'); await page.waitForTimeout(120); await input.press('Enter');
    return (await verifyCommit(page, input, value)) ? 'committed' : 'failed';
  } catch { return 'failed'; }
}

// DISJUNCTIVE commit check (mirrors resolveSubmit's "verify it actually moved", intentRunner.ts:600-614).
// Accepts ALL THREE successful shapes because libraries express commit differently. Tight 600ms poll.
async function verifyCommit(page: Page, input: Locator, chosen: string): Promise<boolean> {
  const deadline = Date.now() + 600;
  const want = chosen.trim().toLowerCase();
  const firstWord = chosen.trim().split(/\s+/)[0] || chosen;
  while (Date.now() < deadline) {
    const val = ((await input.inputValue().catch(() => '')) || '').trim().toLowerCase();
    // (a) input holds the committed text (MUI single, plain custom combobox)
    if (val && want && (val === want || want.includes(val) || val.includes(want))) return true;
    // (b) input EMPTIED and a chip/tag carrying the text appeared (react-select, AntD, MUI multiple)
    if (!val) {
      const chip = await page.locator('[class*="chip" i], [class*="tag" i], [class*="MuiChip" i], [data-selected="true"]')
        .filter({ hasText: firstWord }).count().catch(() => 0);
      if (chip > 0) return true;
    }
    // (c) listbox collapsed after a non-empty selection (weakest — gated on non-empty val to avoid empty-input false pass)
    if (val && (await input.getAttribute('aria-expanded').catch(() => null)) === 'false') return true;
    await page.waitForTimeout(80);
  }
  return false;
}
```

## Where it hooks in

`parseIntent` (intentRunner.ts:91-108) routes fill-shaped intents to `verb='fill'` at line 97; dispatch reaches `resolveFill` (line 505). **The helper is invoked inside `resolveFill` and `fillByLabel`, not in `parseIntent`.** parseIntent's only change is the value-capture fix below. Verb precedence is unchanged (fill-first is correct).

### Site 2 — `intentRunner.ts:539`, raw-input placeholder scan — **THE LOAD-BEARING HOOK**
The measured schooltalk field (`input[type="text"]`, no role-name) resolves here, not via the role path. Inside `scanAndFill`, replace the `.fill()`:
```ts
const box = await inputs.nth(best).boundingBox().catch(() => null);   // stays FIRST — an open list shifts layout
const r = await fillMaybeAutocomplete(page, inputs.nth(best), value);
if (r === 'failed')
  return { done: { kind: 'input:placeholder', selector: seen[best], matched: 0,
                   error: `typed into ${seen[best]} but no autocomplete option committed`, chosenIndex: best, box }, seen };
return { done: { kind: 'input:placeholder', selector: `${seen[best]}=${value}`, matched: 1, chosenIndex: best, box }, seen };
```
Returning `done` with `matched:0` on `'failed'` is correct: inputs exist, so the reveal-retry must NOT fire — the existing `r.seen.length === 0` guard (line ~553) already prevents it. Do not "fix" it the other way.

### Site 1 — `intentRunner.ts:510`, role textbox/combobox path
For ARIA-exposed autocompletes (MUI/AntD generality). `box` read at line 508 stays first:
```ts
const box = await m.loc.first().boundingBox().catch(() => null);   // line 508 unchanged — FIRST
const r = await fillMaybeAutocomplete(page, m.loc.first(), value);
if (r === 'failed')
  return { kind: `role:${m.cand.role}`, selector: m.cand.name, matched: 0,
           error: `typed into "${m.cand.name}" but no autocomplete option committed`, box };
return { kind: `role:${m.cand.role}`, selector: `${m.cand.name}=${value}`, matched: 1, chosenIndex: 0, box };
```

### Site 3 — `crawlMapService.ts:1440`, `fillByLabel` (replay honesty)
Between the Locator resolve (line 1439) and the `data-xsfill` strip (line 1441) — the attribute-scoped Locator must stay live:
```ts
const el = page.locator('[data-xsfill="1"]').first();               // line 1439, unchanged
const r = await fillMaybeAutocomplete(page, el, value);             // replaces line 1440 .fill()
await page.evaluate(() => { const e = (globalThis as any).document.querySelector('[data-xsfill="1"]'); if (e) e.removeAttribute('data-xsfill'); });  // line 1441 unchanged
return r !== 'failed';                                               // honest replay
```

**Break-it needs no call site.** breakItService.ts:328 emits `fill the "X" field with "value"` strings that flow through `parseIntent`→`resolveFill`; fixing site 2 (+ value fix) fixes break-it's 2/4 automatically. No change to breakItService.ts or attackScaffold.ts.

## Companion fix (REQUIRED) — value over-capture at `intentRunner.ts:108`

Verified: break-it emits the value **quoted**, so `withVal[1]` (line 105) is `"Jane Doe"` **with quote characters** — `pressSequentially` would type a `"` and match no option. Fix at the return (**line 108**, not 105 as the source designs stated):
```ts
// line 105 unchanged:  const withVal = intent.match(/\bwith\s+(.+)$/i);
// replace the value expression in the return at LINE 108:
let value: string | undefined;
if (withVal) {
  const raw = withVal[1].trim();
  const quoted = raw.match(/^["']([\s\S]*)["']$/);           // strip WRAPPING quotes off withVal[1]...
  value = quoted
    ? quoted[1]                                              // ...quoted (break-it shape): take inner, DON'T trim clauses
    : raw.replace(/\s+(and\s+)?(pick|choose|select)\b[\s\S]*$/i, '')  // ...unquoted: strip trailing select-clause
         .replace(/\s+from the (dropdown|list|suggestions|options)\b[\s\S]*$/i, '').trim();
  if (!value) value = raw;                                   // never over-strip to empty
} else if (keyMatch) {
  value = keyMatch[1];
}
return { verb, target: target || intent, value, target2: target2 || undefined };
```
Do **not** reach for `quotes[1]` — for `type "abc" into "Search"`, `quotes[1]` is the field name `Search`, which would be typed as the value.

## Fallback behavior (summary)

1. `.fill()` throws (readonly) → click + `ControlOrMeta+A` + `pressSequentially`.
2. No option delta and no ARIA markers → non-mutating `ArrowDown` re-probe → still nothing → `'plain'` (zero mutation).
3. List markers present but list never paints (1200ms) → `keyboardCommit` (ArrowDown+Enter+verify).
4. List shows only "No results"/"Loading" (after one 500ms retry) → `'failed'`.
5. Options exist but none score > 0 → `keyboardCommit`, never a wrong-row click.
6. Best option click throws → `keyboardCommit`.
7. Click/keyboard succeeded but `verifyCommit` fails all three shapes → `'failed'` (honest, → `matched:0`).

## Files
- **New:** `apps/api/src/brain/autocompleteFill.ts` — `fillMaybeAutocomplete(page, input, value): Promise<'plain'|'committed'|'failed'>`, self-contained (own tokenizer/scorer, no inbound edge from intentRunner → no cycle).
- **Edit:** `apps/api/src/brain/intentRunner.ts` — line 108 (value capture), site 1 (~510), site 2 (~539).
- **Edit:** `apps/api/src/brain/crawlMapService.ts` — line 1440.
- **No change:** `breakItService.ts`, `attackScaffold.ts`, verb precedence, `scoreCandidate`.

## Flagged, out of scope
`intentRunner.ts:92` — the bare `/\bpress\b/` alternative fires before the fill branch at line 97, so `"type the teacher name and press Enter to select"` routes to `verb='press'` and never reaches `resolveFill`. A real second path to the same 2/4 symptom that this helper cannot reach. Follow-up: narrow the `press` branch so it doesn't swallow phrasings that also contain `type/fill/enter the … name`.