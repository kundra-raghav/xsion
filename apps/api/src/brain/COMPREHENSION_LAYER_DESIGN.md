The doc is durable. Returning it verbatim as my final output.

# Xsion Project-Comprehension Layer — Final Design

Status: design deliverable (spec + TypeScript shapes). No production edits.
Verified against: `crawlTypes.ts`, `projectKnowledge.ts`, `crawlMapService.ts`, `apiProber.ts`, `breakItService.ts`, `bugReproService.ts`, `soaClient.ts`, `store/store.ts` (this session).

Every adversarial finding is folded into the TYPES below — the types in §2 already are the post-adversarial types; the adversarial reasoning survives only as rule text. An engineer implementing §2 verbatim gets the hardened model, not the draft.

---

## 1. PURPOSE + THE FIREWALL RULE

### Purpose
Picture an app as a SYSTEM, not a list of pages: its **entities** and their **state machines**, its **capabilities per role**, and the **cross-role effect graph** (role A writes entity E; role B's action changes E). Derived from OBSERVED crawl facts (+ optionally CODE), every claim provenance- and confidence-gated, honest about what it cannot derive. It is the L2 comprehension tier above L1's `ProjectMap`.

### The firewall rule (load-bearing)
> **Interpretation MAY inform WHAT to test and in what ORDER. It may NEVER inform a VERDICT (whether something is broken).**

Same firewall as `projectKnowledge` (which holds NAVIGATION facts only), lifted one tier. A wrong comprehension guess must cost at most a wasted/mis-ordered test — never a false bug report and never a suppressed real one.

### Why
`confidence() = hits/(hits+misses)` and a *miss* requires an **observable contradiction event**. Where no such event can fire, confidence measures **how many times you crawled**, not how much evidence you have — it climbs toward a false 1.0 with re-crawls. A confidently-wrong model does not merely waste a test: if a downstream verdict path ever trusts it, a wrong "operator is forbidden" **inverts a real privilege-escalation bug into 'correct behaviour'**. So two things are non-negotiable: (a) every claim carries provenance + confidence with a real contradiction event, or a ceiling that says it can't be contradicted; (b) the model is structurally incapable of expressing a verdict, so a leak is inert (§4).

---

## 2. THE MODEL (post-adversarial TypeScript shapes)

### 2.0 Shared substrate (defined ONCE, stamped on every facet output)

```ts
import type { Provenance } from './projectKnowledge';  // 'observed' | 'human-confirmed'

/** Coverage of the crawl the model was derived from. Stamped on EVERY facet output.
 *  Below threshold, every facet returns its 'insufficient-coverage' shape WITH these numbers —
 *  never an empty-but-confident model. This is the one-screen bug's structural guard (§5, §7). */
export interface CoverageEnvelope {
  pagesCrawled: number;
  routesKnown: number;              // routeManifest.length — denominator
  endpointsObserved: number;
  rolesCrawled: string[];           // RoleDef.id where crawledAt is set
  rolesDeclared: string[];
  pagesPerRole: Record<string, number>;
  sufficient: boolean;              // pagesCrawled/routesKnown >= COVERAGE_MIN && endpointsObserved > 0
}

/** Every enumerated set in the model is OPEN-WORLD. No code path sets complete:true except human confirmation.
 *  This kills the uncapped-negative failure: the model can never assert "this set is closed" from absence. */
export interface OpenWorldSet {
  observed: string[];
  complete: false;                  // literal false — only a human-confirmed variant may carry true
}

/** Evidence identity for idempotent hit-counting. hits++ keys on this, so re-observing the SAME evidence
 *  (re-crawl, re-parse of one file) is idempotent. Without it, confidence measures crawl count, not evidence. */
export type EvidenceId = string;    // e.g. `${method} ${normUrl}#${contentHash}` | `${file}#${symbol}#${hash}`

/** FIREWALL TYPE SPLIT (Layer 4, §4). Every model field is one of these two halves.
 *  Only Addressing-typed data may be serialized into an LLM prompt; Evidence never may. */
export type Addressing<T> = T & { readonly __addressing: unique symbol };
export type Evidence<T>   = T & { readonly __evidence: unique symbol };
```

Reused verbatim from `projectKnowledge.ts`: `confidence(e)`, `isLive(e)`, `recordContradiction(...)`, and the `hits`/`misses`/demote-on-contradiction contract. A `Claim` below plugs straight into them.

```ts
/** The unit that can be counted AND contradicted. ceiling caps confidence for claim types with no possible
 *  miss event (else confidence is decorative). evidenceIds dedup hits by identity. */
export interface Claim {
  provenance: Provenance;           // 'observed' | 'human-confirmed' (+ code rungs, §2.4/§6)
  hits: number;
  misses: number;
  ceiling?: number;                 // < 1 when this claim type CANNOT be contradicted (see MISS rules)
  evidenceIds: EvidenceId[];        // hit dedup — re-observing the same evidence is idempotent
  evidence: Evidence<string>;       // human-readable provenance line — NEVER prompt-serialized
}
```

---

### 2.1 Facet 1 — Entity Model + State Machine

Backing: `entityModel.ts` (pure) + `entityModel.hermetic.ts`. Mirrors `siteModel.ts` (pure set-arithmetic, no LLM). Consumes `ProjectMap`.

**The one fact that shapes this facet:** entity STATE TRANSITIONS are not observable today. `crawlMapService.ts` writes `samplePayload`/`sampleResponse` only inside `if(!ep)` — one body sample per endpoint key, ever. There is never a second sighting to diff. So `from/to:'unknown'` is the NORMAL output, not the edge case.

```ts
export type EntityOrigin = 'api' | 'affordance';   // affordance origin is capped-confidence

export interface EntityField {
  name: string;                     // raw key ("title","orderStatus") — NEVER a value
  seenIn: Array<'request' | 'response'>;
  claim: Claim;                     // field claim: ceiling 0.8 today (miss underivable under if(!ep) freeze)
  roleVisibility: 'unknown'         // DEFAULT — fields frozen at first sighting → role diff UNDERIVABLE now (case d)
    | { seenByRoles: string[]; absentForRoles: string[] };   // only if fieldsByRole prerequisite lands
  looksLikeStateKey?: boolean;      // see stateKeyDetection below
}

export interface EntityTransition {  // the SPINE. A trigger that (probably) mutates this entity.
  trigger: Addressing<string>;      // "POST /event/:id/publish" | gql "publishEvent" | affordance "Approve"
  triggerKind: 'rest-write' | 'gql-mutation' | 'affordance';
  firedByLabels: Addressing<string[]>;
  roles: Addressing<string[]>;
  from: string | 'unknown';         // NEVER fabricated — 'unknown' unless a real value-diff or human confirmed it
  to: string | 'unknown';
  claim: Claim;
}

export interface EntityNode {
  canonical: string;                // chosen name, possibly path-qualified ("event", "users@/admin")
  aliases: string[];                // every raw segment/label mapping here — never merged on replace(/s$/,'') alone
  origin: EntityOrigin;
  fields: EntityField[];
  transitions: EntityTransition[];

  /** State detector is OPEN-WORLD and NOT exact-anchored (Attack1 #5). orderStatus/workflow_state/isPublished/
   *  approved_at must be catchable. There is no path to complete:true except human confirmation. */
  stateKeyDetection: OpenWorldSet & { complete: false };

  /** Honest FOUR-way. 'no-state-key-observed' REPLACES the old 'none' and carries its OWN ceiling (≤0.5):
   *  "not stateful" is a CLAIM, not the absence of one, and lives in the negative branch that must be capped
   *  exactly like the positives. A consumer may NEVER read it as "transitions impossible" — it is a test target. */
  stateMachine:
    | { kind: 'no-state-key-observed'; claim: Claim /* ceiling ≤0.5 */ }
    | { kind: 'stateful-values-unknown'; stateKey: string; sampleValue?: string; claim: Claim /* ceiling 0.6 */ }
    | { kind: 'observed'; stateKey: string; statesSeen: OpenWorldSet; edges: EntityTransition[]; claim: Claim };

  /** Attack1 #2: two distinct schemas fused under one path segment. Jaccard(respFields∪reqFields) below
   *  threshold ⇒ SPLIT into users@/admin vs users@/org/:id, path-prefix as discriminator. This flag is
   *  surfaced to Facet 2/3 joins so a phantom privilege-escalation target resting on a merge is suppressed. */
  mergeRisk: { sharedNameDistinctSchema: boolean };
  claim: Claim;                     // confidence this is a real entity at all (frequency-backed)
}

export interface EntityModel {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;       // WHAT it was derived from (not when derived) — stale-substrate honesty (§5)
  derivedAt: string;
  entities: EntityNode[];
  whyEmpty?: string;                // set with entities:[] when nothing derivable — NEVER a silent empty (case a)
  /** Attack1 #7: if one entity absorbs > DEGENERATE_PCT of all endpoints, path-derivation is opaque.
   *  Stop trusting path-derived entity; emit whyEmpty-style honesty, never a confident mega-entity. */
  entityDerivationDegenerate: boolean;
  prerequisites: string[];          // named capture changes that would unlock states/role-diffs (consent-gated)
}
```

**Provenance ceiling within Facet 1:** `human-confirmed` (1.0) > `api-observed` (direct) > `affordance-only` (UI copy, ceiling 0.5). Affordance evidence is always beatable by API evidence.

---

### 2.2 Facet 2 — Capability + Role Model

Extends §4.4's `Capability` by moving its scalar `role` into a **per-role observation table** and keying the record on `(verb, entity, scope)` — status is role-relative (`exercised` for admin + `denied` for operator is ONE capability, not two).

```ts
export type CapabilityVerb =
  | 'view' | 'list' | 'create' | 'edit' | 'update' | 'delete'
  | 'move' | 'approve' | 'allocate' | 'ship' | 'send' | 'activate' | 'export' | string;

/** Only 'denied' is a licensed "cannot", and only from an authz-shaped 403/401 (Attack1 #4). */
export type RoleCapStatus =
  | 'exercised'          // a write endpoint FIRED under this role → 2xx (proven-by-observation)
  | 'denied'            // authz-classed 403/401 OBSERVED ≥2× with a live page reach — the ONLY licensed "cannot"
  | 'denied-unconfirmed' // a single 403, or a non-authz denial class → a test target, NOT a claim
  | 'latent'            // affordance in THIS role's inventory but never fired
  | 'shadowed'          // page's roles include R, but affordance absent from R's view while another role saw it —
                        //   UI role-gating SIGNAL, NOT proof of "cannot" (could be flag/data-state/viewport)
  | 'not-reached';      // this role's crawl never hit the page → no evidence either way

export type DenialClass = 'authz' | 'rate-limit' | 'csrf' | 'unknown';  // derived from body/headers

export interface RoleCapObservation {
  role: string;                     // RoleDef.id — MUST be in coverage.rolesCrawled
  status: RoleCapStatus;
  hits: number; misses: number;     // RAW evidence counts, never thresholded into a claim
  evidenceIds: EvidenceId[];        // dedup
  statusCodes?: Evidence<number[]>; // the 403/401 codes kept verbatim — Evidence half, never prompt-serialized
  denialClass?: DenialClass;        // only 'authz' promotes denied-unconfirmed → denied
  firstSeen: string; lastSeen: string;
}

/** destructive is FAIL-CLOSED on the negative (Attack1 #1). Unknown verb ⇒ destructive:true.
 *  A false 'destructive:false' on a domain-verb destroyer (void/settle/disburse/retire) is the ONE
 *  irreversible-consequence failure — absence of a destructive signal is NOT evidence of safety. */
export type Destructive =
  | { value: true }
  | { value: false; vocabClosed: false };   // false ONLY when verb is in the explicit known-SAFE allowlist

export interface Capability {
  // IDENTITY (the key) — entity carries its access-path prefix so admin/tenant `users` never collapse (§2, cross-cut)
  verb: CapabilityVerb;
  entity: string;                   // path-derived OR gqlOperation-derived, prefix-qualified
  scope: string;                    // Scope.id; project-root when single-scope

  // DERIVATION EVIDENCE (provenance-tagged, never a role's verdict)
  source: Array<'http' | 'graphql' | 'affordance'>;
  endpointRef?: Addressing<{ method: string; url: string; gqlOperation?: string }>;
  affordanceRef?: Addressing<{ label: string; kind: 'nav' | 'action' | 'guarded'; onPath: string }>;
  accessPath?: Addressing<string>;  // reach-prefix from the GraphEdge chain
  requiredFields?: string[];        // reqFields ∪ revealedRequirements labels — KEYS only
  prerequisites?: Array<{ verb: CapabilityVerb; entity: string }>;

  // THE PER-ROLE TABLE (the whole point). One row per CRAWLED role; absent role = not-reached, still rendered.
  perRole: RoleCapObservation[];

  // HAZARD (fail-safe union — mislabeling destructive-as-safe is the expensive direction)
  destructive: Destructive;
  latentReason?: 'not-exercised' | 'safety-gated';  // splits case d: safety-gated when guarded OR destructive
  autoExercise: 'never' | 'probe-data-only';        // 'probe-data-only' gated on destructive.value===false AND
                                                    //   verb ∈ known-safe allowlist — NOT on "no destructive match"

  // DERIVATION CONFIDENCE (separate axis — projectKnowledge arithmetic verbatim)
  derivation: Claim;
  verbConflict?: Evidence<{ httpVerb?: string; labelVerb?: string; gqlVerb?: string }>;  // recorded, not resolved
}

export interface CapabilityModel {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;
  scope: string;
  roleCoverage: {
    rolesCrawled: string[];         // RoleDef.crawledAt SET — the ONLY roles the table may claim about
    rolesDeclared: string[];        // full roster incl. never-crawled — for honesty
    /** true requires ≥2 crawled roles AND a POSITIVE differentiator actually differed across them
     *  (a distinct endpoint/status/inventory entry). Identical-inventory-across-roles ⇒ false. */
    comparable: boolean;
    possibleClientSideGating: boolean;  // identical inventory across roles → gating may be client-side (Attack1 #7)
  };
  capabilities: Capability[];
  /** Differential TEST TARGETS — the product of the per-role table. NEVER a verdict. kind uses NEUTRAL
   *  targeting vocab, not bug-class names, so even the address names no verdict (Attack2 Layer 4). */
  testTargets: Array<{
    capability: { verb: CapabilityVerb; entity: string; scope: string };  // Addressing only
    kind: 'cross-role-write-differential'    // (was 'privilege-escalation')
        | 'role-visibility-differential'     // (was 'shadowed-affordance')
        | 'latent-destructive-probe'
        | 'unverified-mutation-probe';
    order: number;
    why?: Evidence<string>;         // display-only rationale — NEVER read by code, NEVER prompt-serialized
  }>;
}
```

---

### 2.3 Facet 3 — Cross-Role Effect Graph

Backing: `graphFlows.ts` — typed interfaces + one pure `deriveEffectGraph(...) → EffectGraph`, no LLM on the critical path.

**Substrate corrections (verified, not assumed):** (1) `mapDiff.pageSig()` strips entity identity (`norm()` collapses digits, bands counts) and never reads `contentVolume` — so mapDiff is reused for route/endpoint drift ONLY, and effect derivation gets its own entity fingerprint. (2) `store.mapHistory` rings whole `ProjectMap`s keyed on `crawledAt` with **no role stamp** — so the per-role timeline needed by Tier 2 does not exist today. (3) `GraphEdge` has no role field — action attribution comes ONLY from `ApiEndpoint.roles[]` + `firedBy[]`.

```ts
/** The missing primitive: a coarse, value-stripped, digit-collapsed, count-banded fingerprint of an entity's
 *  observed shape under one role. Same philosophy as stateSignature/mapDiff, so adding one order row does NOT
 *  register. entityDelta.isEmpty is what keeps ordinary data traffic from tripping the graph. */
export interface EntityFingerprint {
  entity: string; roleId: string; crawledAt: string;
  respFieldSet: string[]; reqFieldSet: string[];
  writeOps: string[]; readOps: string[]; worstStatus: number; contentBand: number;
}

/** Finer than projectKnowledge's observed|human-confirmed, because correlation must be nameable as non-causal. */
export type EffectProvenance = 'structural' | 'correlated' | 'repeated' | 'code-confirmed' | 'human-confirmed';

export interface EffectEdge {
  fromRole: Addressing<string>; action: Addressing<string>;
  entity: string; toRole: Addressing<string>; toEntity: string;   // entity carries access-path prefix (cross-cut)
  tier: 1 | 2;
  provenance: EffectProvenance;
  observedDelta?: Evidence<string>;   // WHAT changed — never WHETHER it was right; never prompt-serialized
  /** Attack1 #3: 'repeated' is UNREACHABLE without a quiescent baseline (a re-read with no role action).
   *  A systematic confound (cron, updated_at, shared counter) repeats by definition and would trivially
   *  satisfy "same delta ≥2 pairs". If baselineControlled is false, the ceiling stays at 'correlated'
   *  (test-ordering only). Any consumer MUST refuse to treat baselineControlled:false edges as causal. */
  baselineControlled: boolean;
  claim: Claim;                        // hits/misses; structural & correlated CAPPED below any causal threshold
}

export interface EffectGraph {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;
  /** edges:[] is NEVER read as "no cascades". insufficient-substrate is gated on a NON-EMPTY entity-fingerprint
   *  set, not on role count — a 2-role zero-API app must land here, not on 'applicable' with empty edges. */
  applicability: 'applicable' | 'not-applicable-single-role' | 'insufficient-sessions' | 'insufficient-substrate';
  edges: EffectEdge[];
  unattributed: Array<Evidence<{ entity: string; delta: string; note: string }>>;   // delta, no role write (case a/d)
  ambiguous: Array<Evidence<{ entity: string; delta: string; candidateRoles: string[] }>>;  // full SET, never a winner
  prerequisites: string[];             // e.g. the {ranAsRoleId, crawledAt} history-recording addition
}
```

---

### 2.4 Facet 4 — Code-derived comprehension (provenance ladder)

Reading CODE upgrades the model. The corrected ladder (Attack1 #6 — the draft was inverted):

```ts
/** Extends projectKnowledge's Provenance. CRITICAL ORDER: code is a PRIOR, not a rank above observation.
 *  code-unwitnessed sits BELOW a single observation (ceiling ≤0.4). It rises above observed ONLY once an
 *  observation AGREES (then code-and-observed, the real top rung below human). On DISAGREEMENT, observed WINS
 *  and the code claim is flagged code-vs-runtime-divergence — because dead code's path is never exercised, so
 *  recordContradiction can NEVER fire on it; ranking it above observation makes confidence structurally inverted. */
export type CodeProvenance =
  | 'inferred'          // ~0.2
  | 'code-unwitnessed'  // parsed from source, no live confirmation — ceiling ≤0.4
  | 'observed'
  | 'code-and-observed' // code AND live agree — top rung below human
  | 'human-confirmed';  // 1.0

/** Any code-derived enum/capability set is open-world: a source enum is never proof the runtime set is closed.
 *  Hits dedup by file+symbol+contentHash — re-parsing one file is ONE hit ever, not N. */
export interface CodeDerivedSet extends OpenWorldSet { evidenceIds: EvidenceId[]; }
```

Per app-shape: single-file inline-JS (parse `<script>`, regex fallback) → state enums, `role===` guards, handler→entity writes, validation predicates. Framework (dent) → router config, schema/migration enums (which literally ARE the state machines), GraphQL SDL/resolvers (148 ops → verb→entity→scope). Blackbox → all code fields optional; the same model SHAPE at `observed` confidence from crawl facts alone. **Code-vs-behavior divergence exits as a human-facing observation ("code says X / app did Y"), never as a verdict, and it DEMOTES the code claim.**

---

## 3. DERIVATION RULES (what observation licenses each claim)

**Facet 1.**
- entity exists ← a path segment or affordance RECURS across `map.api[]`/inventory (frequency-backed). A single sighting is an id, not an entity.
- naming: reuse `entityOf` but never blindly. A verb tail (`/event/:id/publish`) routes to the preceding recurring segment's `transitions`, not an entity. Discriminator is FREQUENCY. Never merge on `replace(/s$/,'')` (mangles `address`→`addres`); canonicalize only when aliases share endpoints/fields. Jaccard-below-threshold on shared-name schemas ⇒ SPLIT with path-prefix (`mergeRisk`).
- fields are REST-only: `jsonKeys` unwraps `.data` then top-level keys; for GraphQL that yields the operation name, so GraphQL entities carry fields only from `reqFields`/variables, else none.
- stateful ← a field name matching the OPEN detector `/(^|_|-)(status|state|stage|phase|step)($|_|-)/i` plus `is[A-Z]`/`*_at` heuristics; detection set is open-world.
- named from/to ← ONLY a real value-diff across two observations, or human. Never fabricated.

**Facet 2.**
1. role enumeration gates on `RoleDef.crawledAt`, never `map.roles`. A declared-but-never-crawled role gets NO `perRole` rows (its set is unknown, not empty).
2. `comparable = ≥2 crawled roles AND a positive differentiator actually differed`. Otherwise single-role rendering; no `cross-role-*` targets.
3. a capability exists ← `writes===true` OR an `action`/`guarded` affordance; `view`/`list` ← non-mutating endpoints / `nav` affordances.
4. verb ← `firedBy` label vocab first, else HTTP method; entity ← `ApiEndpoint.entity` (prefix-qualified).
5. GraphQL branch: ignore the URL, split `gqlOperation` camelCase into `[verbToken, ...entityTokens]` (`DeleteUser`→delete/user). **If the split yields an empty entity or an unknown leading token with no entity tail, DECLINE — emit `gqlOpaque`, no row.** Never a garbage `{verb:'execute',entity:''}`.
6. per-role status per §2.2 enum. `denied` requires `denialClass:'authz'` AND ≥2 denials across sessions with a live page reach; a single/non-authz 403 is `denied-unconfirmed` (a target).
7. `destructive` = fail-closed union: DELETE ∪ guarded-vocab ∪ gql `{Delete,Remove,Purge,Wipe}` ∪ **unknown verb**. `autoExercise:'probe-data-only'` only when `destructive.value===false` AND verb ∈ known-safe allowlist.
8. `latentReason:'safety-gated'` when guarded OR destructive; else `'not-exercised'` (the only auto-verify candidate).
9. verb conflicts recorded in `verbConflict`, resolved to the MOST-destructive reading; never silently collapsed.
10. `derivation` reuses `confidence()`/`isLive()`; `perRole` hits/misses stay raw evidence.

**Facet 3.** Step 0 applicability gate (single-role / no-timeline / no-substrate). Tier 1 (today, non-causal): E has a `writes:true` endpoint with role A and a read endpoint with role B≠A → `structural`. Tier 2 (needs timeline): order by `crawledAt`; A writes E then B's non-empty `entityDelta` with A the only writer in the interval → `correlated`. Upgrade to `repeated` ONLY with a quiescent baseline confirming the delta is NOT ambient; `entityDelta` EXCLUDES ambient fields (`updated_at`, `*_count`, sequence keys). code-read → `code-confirmed`; human → `human-confirmed`. Demote-on-contradiction: A wrote E, B unchanged → misses++, expires like `isLive`.

---

## 4. THE STRUCTURAL FIREWALL

Honest framing: "the verdict function doesn't take the model as a parameter" is ABSENCE, not prevention. Four layers; only 3 and 4 have teeth, and 4 is the one that survives the leak path verified live in this codebase.

**Layer 1 — Branded types (blocks accidents).** `Addressing<T>` / `Evidence<T>`. No `Evidence→Addressing` converter exists; crossing requires an `as any` that greps and reviews. Blocks accidental coupling, not a deliberate cast.

**Layer 2 — Module boundary (blocks new coupling).** Verdict code under `src/brain/oracle/`; comprehension under `src/brain/comprehension/`. Dependency-cruiser / `no-restricted-imports`: nothing under `oracle/` may import `comprehension/`. A BUILD failure.

**Layer 3 — No proposition in the payload (makes a leak inert to CODE readers).** The planner's output is pure ADDRESSING — `target`/`action`/`order`, optional display-only `why?`, and NO `expected*`/`shouldBe`/`assertion`/oracle field. If the code-read payload carries no verdict-shaped data, a leak past a cast is inert. True of `MissionStep`/`TestTarget`.

**Layer 4 — Addressing/Evidence split + single serializer (the ONLY barrier that survives the LLM launder).**
The verified leak path is a STRING IN A PROMPT, not a TypeScript import, so Layers 1–2 are inert against it:

| Step | Site | What happens |
|---|---|---|
| a | `breakItService.ts:173-179` | builds `surface`, passes it into `breakItPlan(...)` — an LLM planning call |
| b | `bugReproService.ts:114-115` | `surfaceHints(knowledgeNow)` joins that surface (its stated purpose: "feed SoA's surface next run") |
| c | `soaClient.ts:130-131` | SoA (the LLM) authors `expectHeld`/`expectBroke` prose into every `BreakStep` |
| d | `apiProber.ts:111` / `:118` | a regex over that prose mechanically decides `held`/`broke` |
| d′ | `breakItService.ts:611,623` | same `expectBroke`-gated flip on the UI path |

The comprehension layer's whole job is to feed the surface at (a/b). The instant any Evidence-typed field (a `rationale`, an `observedDelta`, a `statusCodes:[403]` paraphrase) lands in that prompt, the LLM paraphrases it into `expect*` and the regex converts interpretation into a verdict.

**The fix:** every model field is typed `Addressing<T>` or `Evidence<T>` (§2.0, applied throughout §2). Model→prompt routes through **exactly one serializer** that accepts ONLY `Addressing`. A hermetic test (`firewall.hermetic.ts`, same style as the existing `.hermetic.ts` suite) asserts NO `Evidence`-typed key appears in that serializer's output. `testTargets.kind` uses neutral targeting vocab (`cross-role-write-differential`), never a bug-class name. This removes the propositional string BEFORE the prompt is built — it does not trust the LLM not to repeat it.

**The pre-existing SoA channel — named, not closed (this design's explicit position).** `BreakStep.expectHeld/expectBroke` is ALREADY LLM-authored prose riding into a mechanical verdict at the four sites above. It is a **distinct, separately-gated interpretation channel** (SoA's "pre-declared oracle", re-verdicted by the `answer-oracle` loop at `breakItService.ts`). This design does NOT close it, because closing it means editing production verdict code, which this deliverable is explicitly not scoped to do. Honest position: **clean on the comprehension channel via Layer 4; acknowledged-and-gated on the SoA channel.** The `projectKnowledge` store itself is clean — `bugReproService.ts:19` imports only navigational `surfaceHints` — but store-cleanliness ≠ channel-cleanliness, which is exactly why Layer 4 is required.

---

## 5. NEGATIVE + EDGE CASE TABLE

Every case emits an HONEST representation, never a hallucination.

| Case | App shape | Honest representation | The line it must not cross |
|---|---|---|---|
| **single-role** | one crawled role | F2 `comparable:false` (one `perRole` row); F3 `not-applicable-single-role`; "single role crawled" | never "no role differences" — a comparison wasn't made |
| **zero-API** | in-memory app, no traffic | F1 affordance-origin (capped) or `entities:[]`+`whyEmpty`; **F3 `insufficient-substrate`** (gated on empty fingerprint set, NOT role count) | F3 must never be `applicable`+`edges:[]` reading as "no cascades exist" |
| **one-screen / insufficient coverage** | 2 roles both crawled the SAME single page | below `CoverageEnvelope.sufficient` → every facet returns `insufficient-coverage` WITH the numbers | never an empty-but-confident cross-role model from one screen (the headline bug) |
| **merged entities** | `/admin/users` vs `/org/:id/users`; `/resource/:type/:id` | Jaccard split → `users@/admin` vs `users@/org/:id`; `mergeRisk` surfaced; join uses path-prefix, not bare string; degenerate mega-entity → `entityDerivationDegenerate:true`+honesty | never one high-confidence union entity; never a phantom `cross-role-write-differential` on a merged key |
| **coincidental cascade** | shared counter / cron / `updated_at` on every write | F3 caps at `correlated`; ambient fields excluded; `baselineControlled:false` → `repeated` unreachable; ambient delta → `unattributed`/ambient-churn | never `repeated` from a systematic confound that repeats by definition |
| **stale code** | flag-off branch, `v1/` behind `v2/`, config-overridden enum | `code-unwitnessed` ≤0.4 (below one observation); on disagreement `observed` wins + `code-vs-runtime-divergence`; open-world set | never rank dead code above observation; dead code is immune to demotion, so never trust it more |
| **race** | two roles write the same entity in one interval | F3 `ambiguous` with the FULL `candidateRoles` set | never pick a winner |
| **background-job** | a delta with no role write | F3 `unattributed`; shape-identical to a race's ambient case, separable ONLY by a quiescent baseline — stated as a known limit | never guess an attributor; never silently fold into a role edge |
| **adversarial app** | uniform routing `/resource/:type`; opaque `execute(input)`; client-side-only role gating | F1 `entityDerivationDegenerate`; F2 Rule 5 DECLINES (`gqlOpaque`); `comparable:false`+`possibleClientSideGating:true` → probe-server-enforcement target | never a garbage capability row; never "roles are equal" from identical inventories |

---

## 6. CONFIDENCE + PROVENANCE MODEL (reuse projectKnowledge's)

`confidence(e) = hits/(hits+misses)` minus a 0.1 penalty on any miss, then clamped to the claim's `ceiling`. `isLive` expires when misses≥3 && misses>hits, or confidence<0.25. `recordContradiction` demotes, never hardens; `human-confirmed` is 1.0 and immune. Reused verbatim.

**Two cross-cutting invariants that make confidence mean evidence, not crawl count:**
1. **Hits deduplicated by `EvidenceId`.** Re-observing the same endpoint/file is idempotent. Without this, `confidence` measures how many times you looked.
2. **Every enumerated set is `OpenWorldSet` (`complete:false`).** No code path sets `complete:true` except human confirmation. This caps the NEGATIVE branch as rigorously as the positives — the model can never assert "this set is closed / this doesn't exist" from mere absence.

**Provenance ladders, per facet.** Facet 1/2: `affordance-only` (≤0.5) < `observed` < `human-confirmed`. Facet 3: `structural`/`correlated` (capped below any causal threshold) < `repeated`/`code-confirmed` < `human-confirmed`. Facet 4: `inferred` < `code-unwitnessed` (≤0.4) < `observed` < `code-and-observed` < `human-confirmed`. Ceilings live on the CLAIM, including every negative claim (`no-state-key-observed`, `destructive:{value:false}`, `denied-unconfirmed`).

**The single defect this model exists to prevent:** every ceiling in the naive draft was on a POSITIVE claim; the confident-wrong failures live in the NEGATIVES and closed-vocabulary booleans, where no observable contradiction event exists to decrement them. The fix is uniform — cap and open-world the negatives exactly as the positives, fail-closed on `destructive` and on unknown routing/vocab, and let live observation demote code.

---

## 7. ORDERING — build AFTER the coverage gap closes

A model derived from one screen is the confidently-wrong artifact. Facet 1 is only ACCIDENTALLY protected (its frequency-gate treats a single sighting as a non-entity); Facets 2 and 3 are NOT — two roles that crawled the same single page yield `comparable:true`, `perRole` rows, and structural edges from one screen. Therefore:

1. Close the coverage gap first (broad multi-role crawl).
2. The `CoverageEnvelope` gate is the enforcement: below `sufficient`, every facet returns `insufficient-coverage` with the numbers rather than a confident empty. This makes premature derivation self-announcing instead of silently wrong.
3. Facet 3 Tier 2 additionally waits on the named `{ranAsRoleId, crawledAt}` history-recording addition (verified absent in `store.ts`); until it lands, Tier 1 is real and Tier 2 degrades honestly to `insufficient-sessions`.

---

## 8. WHAT CONSUMES THE MODEL vs WHAT MUST NEVER

| CONSUMES (targeting/ordering — safe) | MUST NEVER read it (verdict paths) |
|---|---|
| test prioritization (which feature first) | `probeEndpoint` held/broke (`apiProber.ts`) |
| mission planning / decomposition | `runStep`/`verdictFromDom` broke/held (`breakItService.ts`) |
| coverage-gap reporting | `judgeDrop`/`judgeDropDifferential` (`dropOracle.ts`) |
| reach-prefix construction (how to get there) | `acceptIsDefect` / the answer-oracle question |
| warm-start / what's-new (`siteModel.ts`) | `deriveResolution` cause assignment |

The consuming side sees only `Addressing`-typed data through the single serializer. The verdict side reads live observation and its own store, which the comprehension model cannot reach.

---

## Honest limits
- Layers 1–2 are hygiene; an `as any` defeats them. Layer 3 makes code-path leaks inert; Layer 4 makes prompt-path leaks inert. Only these two have teeth.
- `code-*` is a stronger PRIOR, never truth; it demotes on live contradiction and never sources an oracle decision.
- A confidently-wrong model still poisons TARGETING (a wasted retry) even with the verdict firewall perfect — which is why every claim stays provenance/confidence-gated. The firewall bounds the blast radius to a wasted retry, exactly the projectKnowledge safety line, one tier up.
- The SoA `expect*` channel remains an acknowledged, separately-gated interpretation channel this deliverable does not close (scope: no production verdict edits).

### Prerequisites (consent-gated, NOT assumed)
1. Union fields + `fieldsByRole` on every observation (not just `if(!ep)`) — unlocks role field-diffs and field MISS detection.
2. Allowlisted state-key VALUES captured on every observation (bounded exception to shapes-only) — the only path to `stateMachine.kind:'observed'`.
3. `{ranAsRoleId, crawledAt}` stamped on every `mapHistory` entry — the only path to Facet 3 Tier 2.