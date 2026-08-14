# Xsion — the "QA beast" plan (iteration 3, 2026-08-12)

User's vision: a SOA-driven agentic QA beast that misses nothing — like an eagle on a hunt. Nothing hardcoded,
every role + flow captured, everything persisted in real time, and a testing matrix far beyond click-checks.
Below: honest answers to each point + a sequenced path. Written after the user's critique that iterations were
surface-level.

## THE HONEST CEILING (state this first — it's the real blocker)
The current crawl finds 1–7 flows with HIGH run-to-run variance (login-stick + bounded depth + timeout). That
variance — NOT the UI — is the ceiling on EVERYTHING the user wants. Per-role capture, "nothing is left",
complete flows all sit on top of a crawl that doesn't reliably finish. So: crawl-completeness + incremental-
persistence is the PREREQUISITE, not a nice-to-have. Fix that first or everything above it stays flaky.

## THE REAL BUG (fixing first): SAVE-ONCE-AT-THE-END
Today saveProjectMap is called ONLY at crawl:done. Mid-crawl, every page/flow/API/screenshot lives in memory
only. A refresh or a crashed/timed-out crawl loses EVERYTHING → "start from scratch every time." (db.json DOES
persist — but only the final map, which often never arrives.) FIX: persist INCREMENTALLY — each page/flow/API/
requirement written to the DB as it's discovered; a refresh RESUMES from the partial map; a killed crawl keeps
what it found. This is the visible pain + unblocks the rest.

## THE 3 ARCHITECTURAL ANSWERS (the user's actual questions)

### 1. NO HARDCODED FIELD TYPES (email/pw/image/pdf — "it can be anything")
Today `looksLikeLogin` hunts email+password = the hardcoding. GENERAL FORM: for ANY input/form the crawl reaches
→ read what the DOM already declares (type=file, accept="image/*,.pdf", required, min/max, pattern, label text,
aria) → emit a TYPED REQUIREMENT {selector, kind, accept, label, prompt, met:false}. SOA phrases the ask, the
user supplies the value (live prompt + record, per the user's earlier choice), it's stored in the map so the
flow is runnable later. CREDENTIALS become ONE instance of this generic requirement — not a special case. This
directly answers "it can be anything."

### 2. MULTI-ROLE = A FIRST-CLASS MAP DIMENSION (one URL, N roles, each its own flows)
Not a crawl variation — a data-model change. A CREDENTIAL SET PER ROLE; the crawl runs ONCE PER ROLE; every
page/flow/API is TAGGED with the role that saw it. Coverage becomes per-role → "nothing is left" is CHECKABLE
(show which roles are unmapped, which flows only one role sees). project.roles[] + role on every mapped entity.
This is probably the single highest-value item — it's how you guarantee no role's flow is missed.

### 3. THE "EVERYTHING" TESTING LIST — SPLIT BY WHAT'S REAL
✅ BUILDABLE (Playwright-native, real): device/viewport emulation, network throttle + latency injection, offline,
   cookies manipulation, SESSION-EXPIRY (clear/expire the session token mid-flow + assert redirect), slow-network,
   geolocation. These are a genuine "environment matrix" — run a flow under each condition.
⛔ STAYS QUARANTINED (do NOT re-admit on high energy): session HIJACKING, attacks, cyber/payload-injection.
   Reason unchanged: a confidently-wrong security finding is the worst output this product can produce; needs a
   real security substrate + human-in-loop. Keep it parked — being a beast at the honest half beats faking the
   dangerous half.

## SEQUENCED PATH (recommend this order — each unblocks the next)
1. **Incremental persistence + resume** (the bug; fixes visible pain, unblocks everything).
2. **Crawl completeness** (the ceiling): deeper/more-reliable crawl so flow-count stops varying — resumable,
   per-page requirement capture, better nav coverage.
3. **Generic requirements** (#1): typed field-requirements + live prompt + record; creds become one instance.
4. **Multi-role** (#2): role credential sets + per-role crawl + role-tagged coverage + "unmapped roles" view.
5. **Environment matrix** (#3 buildable half): run a flow under device/network/cookie/session-expiry conditions.
6. (Later, still SOA-driven) the reasoning/instruction surface where SOA says what it wants to test + user steers.

## WHAT STAYS OUT: cyber/attack/session-hijacking (quarantined, honestly labeled).
## PRINCIPLE HELD THROUGHOUT: SOA-driven (SOA reasons + asks, batched not per-click), fail-safe (inconclusive
never = pass), nothing hardcoded, everything persisted in real time, per-role completeness checkable.
