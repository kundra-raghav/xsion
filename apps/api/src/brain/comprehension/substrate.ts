/**
 * comprehension/substrate.ts — the shared, coverage-INDEPENDENT foundation of Xsion's L2 project-comprehension layer.
 *
 * This is §2.0 + §6 of COMPREHENSION_LAYER_DESIGN.md, implemented verbatim. It defines the units every facet
 * (entity model / capability+role / cross-role effect graph / code-derived) is built from, and it reuses
 * projectKnowledge's confidence machinery so a comprehension claim demotes-on-contradiction exactly like a
 * navigation fact.
 *
 * THE FIREWALL RULE (load-bearing): interpretation MAY inform WHAT to test and in what ORDER; it may NEVER inform a
 * VERDICT (whether something is broken). The Addressing<T>/Evidence<T> split below is the *type-level* enforcement of
 * that rule — see comprehension/firewall.ts for the runtime serializer that makes a leak inert.
 *
 * THE SINGLE DEFECT THIS MODULE EXISTS TO PREVENT (adversarial pass): confident-wrong NEGATIVES. `confidence()`
 * rises with re-crawls when no observable *contradiction event* can decrement a claim — so a negative claim
 * ("this set is closed", "not stateful", "destructive:false") climbs toward a false 1.0. The countermeasures baked
 * in here: (a) EvidenceId dedup so hits count evidence, not crawl passes; (b) OpenWorldSet so absence never becomes
 * "closed"; (c) per-claim `ceiling` so a claim type with no possible miss can't reach full confidence.
 */
import type { Provenance as NavProvenance } from '../projectKnowledge';
import { confidence as navConfidence } from '../projectKnowledge';

// ── PROVENANCE LADDER ────────────────────────────────────────────────────────────────────────────────────────────
// Extends projectKnowledge's 'observed' | 'human-confirmed' with the CODE rungs (§2.4/§6). Ordered weakest→strongest.
// The ranks encode the design's rule that code is a stronger PRIOR than a lucky single observation but is NEVER truth:
// a code fact unwitnessed by observation is capped BELOW a single observation; it only outranks `observed` once an
// observation AGREES with it ('code-and-observed'). Dead code (never exercised → never contradicted) must therefore
// never sit above the observation that could have caught it.
export type Provenance =
  | 'inferred'         // a weak structural guess (e.g. affordance-only) — lowest
  | 'code-unwitnessed' // read from source but no runtime observation agrees yet — capped ≤0.4 (dead-code guard)
  | 'observed'         // a live crawl actually saw it
  | 'code-and-observed'// code AND a live observation agree — the real top rung below human
  | 'human-confirmed'; // a human said so — 1.0, immune to demotion

/** Confidence ceiling per provenance rung (design §6). A claim's own `ceiling` (below) can lower it further, never
 *  raise it. These cap the rung; the claim caps the specific claim TYPE (esp. negatives). */
export const PROVENANCE_CEILING: Record<Provenance, number> = {
  'inferred': 0.4,
  'code-unwitnessed': 0.4,   // dead-code guard: an unwitnessed source fact never outranks one real observation
  'observed': 1.0,
  'code-and-observed': 1.0,
  'human-confirmed': 1.0,
};

/** Rank for "which provenance wins when two claims of the same fact disagree" — live observation must be able to
 *  DEMOTE code (a stale enum, a flagged-off branch). observed > code-unwitnessed by rank, so on disagreement the
 *  observation wins and the code claim is flagged divergent (see mergeClaim). */
export const PROVENANCE_RANK: Record<Provenance, number> = {
  'inferred': 0,
  'code-unwitnessed': 1,
  'observed': 2,
  'code-and-observed': 3,
  'human-confirmed': 4,
};

// ── EVIDENCE IDENTITY (idempotent hit-counting) ──────────────────────────────────────────────────────────────────
/** A stable identity for a piece of evidence. hits++ keys on this so re-observing the SAME evidence (a re-crawl, a
 *  re-parse of one file) is idempotent — without it, `confidence` measures how many times you LOOKED, not how much
 *  evidence exists (the root defect behind every confident-wrong case in the adversarial pass). Suggested shapes:
 *    `${method} ${normUrl}#${contentHash}`   (a runtime observation)
 *    `${file}#${symbol}#${hash}`             (a code fact) */
export type EvidenceId = string;

// ── FIREWALL TYPE SPLIT (§4 Layer 4) ─────────────────────────────────────────────────────────────────────────────
// Every model field is one of these two halves. Addressing = WHERE/WHAT (a target, an action, an entity NAME) — may
// be serialized into an LLM prompt. Evidence = WHY / the proof (statusCodes, a rationale, an observed delta) — must
// NEVER reach a prompt (the LLM would paraphrase it into an oracle expectation → interpretation authoring a verdict,
// the exact leak the design's live audit found on the SoA channel). The brands are phantom (erased at runtime); their
// only job is to make the serializer in firewall.ts reject Evidence-typed fields at the type level.
declare const __addressing: unique symbol;
declare const __evidence: unique symbol;
export type Addressing<T> = T & { readonly [__addressing]: true };
export type Evidence<T> = T & { readonly [__evidence]: true };

/** Brand a value as Addressing (safe to serialize into a prompt/target). Runtime no-op. */
export const addressing = <T>(v: T): Addressing<T> => v as Addressing<T>;
/** Brand a value as Evidence (NEVER serialize into a prompt). Runtime no-op. */
export const evidence = <T>(v: T): Evidence<T> => v as Evidence<T>;

// ── OPEN-WORLD SET ───────────────────────────────────────────────────────────────────────────────────────────────
/** Every enumerated set in the model is OPEN-WORLD: it lists what was observed and DECLARES it is not known-complete.
 *  No derivation path may set `complete: true` — only a human-confirmed variant may. This kills the uncapped-negative
 *  failure: the model can never assert "this set is closed / X does not exist" from the mere ABSENCE of an
 *  observation. `observed` fields; `complete` is the literal `false` for the derived case. */
export interface OpenWorldSet {
  readonly observed: string[];
  readonly complete: false;
}
/** Human-confirmed closure — the ONLY way a set becomes known-complete. Kept a distinct type so `complete:true`
 *  cannot be produced by any automatic derivation (it requires constructing this, which only the human-confirm path
 *  does). */
export interface ClosedSet {
  readonly observed: string[];
  readonly complete: true;
  readonly closedBy: 'human-confirmed';
}
export const openWorldSet = (observed: string[]): OpenWorldSet => ({ observed: [...new Set(observed)], complete: false });

// ── THE CLAIM (the unit that can be counted AND contradicted) ────────────────────────────────────────────────────
/** Every fact in the comprehension model is a Claim. It plugs into projectKnowledge's confidence/demote machinery.
 *  `ceiling` caps confidence for claim TYPES that have no possible miss event (a negative/closed-vocab claim) — else
 *  confidence would be decorative and climb to a false 1.0. `evidenceIds` dedup hits by identity. `evidence` is the
 *  human-readable provenance line and is Evidence-typed so it can never be prompt-serialized. */
export interface Claim {
  provenance: Provenance;
  hits: number;
  misses: number;
  /** < 1 when this claim type CANNOT be contradicted by any observable event (see the MISS-rules per facet). The
   *  effective confidence is clamped to min(ceiling, provenance-ceiling). REQUIRED for every negative/closed-vocab
   *  claim; optional (defaults to the provenance ceiling) for a positive claim with a real miss event. */
  ceiling?: number;
  evidenceIds: EvidenceId[];
  evidence: Evidence<string>;
}

/** Create a fresh claim from one piece of evidence. */
export function claim(provenance: Provenance, evId: EvidenceId, evLine: string, ceiling?: number): Claim {
  return { provenance, hits: 1, misses: 0, ceiling, evidenceIds: [evId], evidence: evidence(evLine) };
}

/** confidence(claim) — reuses projectKnowledge's hits/misses formula, then clamps to BOTH the provenance ceiling and
 *  the claim's own ceiling. human-confirmed is 1.0 and immune (delegated to navConfidence). This is the one place
 *  every consumer reads a comprehension confidence, so the negative-branch cap is enforced uniformly. */
export function confidence(c: Claim): number {
  if (c.provenance === 'human-confirmed') return 1;
  // map our extended provenance onto projectKnowledge's 2-value formula: only 'human-confirmed' is special there,
  // every other rung uses the hits/misses ratio, which is exactly what we want — the rung ceiling caps it below.
  const base = navConfidence({ hits: c.hits, misses: c.misses, provenance: 'observed' as NavProvenance });
  const cap = Math.min(PROVENANCE_CEILING[c.provenance] ?? 1, c.ceiling ?? 1);
  return Math.max(0, Math.min(base, cap));
}

/** isLive(claim) — should this claim still be trusted/surfaced? Expires when contradictions dominate (structure
 *  genuinely changed) or confidence collapses. human-confirmed never expires. (design §6: misses≥3 && misses>hits,
 *  or confidence<0.25.) */
export function isLive(c: Claim): boolean {
  if (c.provenance === 'human-confirmed') return true;
  if (c.misses >= 3 && c.misses > c.hits) return false;
  return confidence(c) >= 0.25;
}

/** Fold a fresh observation of the SAME fact into an existing claim (idempotent by EvidenceId). Bumps hits only for
 *  NEW evidence; upgrades provenance only UP the rank ladder; on a code-vs-observed AGREEMENT promotes to
 *  'code-and-observed'. Never lowers a ceiling’s effect silently — a stricter ceiling wins (min). Pure. */
export function reinforce(c: Claim, obs: { provenance: Provenance; evId: EvidenceId; evLine?: string; ceiling?: number }): Claim {
  if (c.provenance === 'human-confirmed') return c;   // human-confirmed is 1.0 + immune — never touched by reinforcement (advisor Bug 1)
  const out: Claim = { ...c, evidenceIds: [...c.evidenceIds] };
  const isNewEvidence = !out.evidenceIds.includes(obs.evId);
  if (isNewEvidence) { out.hits += 1; out.evidenceIds.push(obs.evId); }
  // provenance upgrade: code + a live observation AGREEING → 'code-and-observed' (the real top rung below human).
  const bothCodeAndObs = (c.provenance === 'code-unwitnessed' && obs.provenance === 'observed')
    || (c.provenance === 'observed' && obs.provenance === 'code-unwitnessed')
    || (c.provenance === 'observed' && obs.provenance === 'code-and-observed');
  if (bothCodeAndObs) out.provenance = 'code-and-observed';
  else if (PROVENANCE_RANK[obs.provenance] > PROVENANCE_RANK[out.provenance]) out.provenance = obs.provenance;
  if (obs.ceiling != null) out.ceiling = Math.min(out.ceiling ?? 1, obs.ceiling);
  return out;
}

/** Record that this claim was CONTRADICTED by a live observation (the structure changed, the code was stale/dead).
 *  Demotes, never hardens. If a code-provenance claim is contradicted by observation, it is ALSO demoted below
 *  observed (dead-code guard: live observation wins). human-confirmed is immune. Pure. */
export function contradict(c: Claim, evLine?: string): Claim {
  if (c.provenance === 'human-confirmed') return c;
  const out: Claim = { ...c, misses: c.misses + 1 };
  // 'code-and-observed' contradicted → the CODE half is impeached but a live observation once AGREED, so the observed
  // half survives: demote to 'observed', NOT below it (advisor Bug 2 — else one contradiction throws away real
  // observed evidence). A pure code claim ('code-unwitnessed') stays where it is (misses do the demoting via ceiling).
  if (out.provenance === 'code-and-observed') out.provenance = 'observed';
  if (evLine) out.evidence = evidence(String(c.evidence) + ` | CONTRADICTED: ${evLine}`);
  return out;
}

// ── COVERAGE ENVELOPE (the one-screen structural guard, §5/§7) ───────────────────────────────────────────────────
/** Coverage of the crawl the model is derived from. Stamped on EVERY facet output. Below threshold, every facet
 *  returns its 'insufficient-coverage' shape WITH these numbers — never an empty-but-confident model. This is the
 *  structural guard against building a system model from one screen (the exact artifact the whole design exists to
 *  prevent). `sufficient` is the single gate every facet reads. */
export interface CoverageEnvelope {
  pagesCrawled: number;
  routesKnown: number;                 // routeManifest.length — the denominator (0 → ratio unknown, see computeCoverage)
  endpointsObserved: number;
  rolesCrawled: string[];              // role ids that actually crawled (a page tagged with them exists)
  rolesDeclared: string[];             // roles defined on the project
  pagesPerRole: Record<string, number>;
  sufficient: boolean;
  /** why not sufficient (for the honest 'insufficient-coverage' surface) — Evidence-typed (display, never a prompt). */
  reason: Evidence<string>;
}

/** Fraction of known routes actually crawled that gates 'sufficient'. Deliberately modest — the design's point is to
 *  reject ONE-SCREEN maps, not to demand exhaustive coverage. */
export const COVERAGE_MIN_RATIO = 0.5;
/** Absolute floor: even with routesKnown unknown (blackbox, no manifest), require more than a single screen so a
 *  1-page map can never read as "sufficient". */
export const COVERAGE_MIN_PAGES = 3;

/** Compute the CoverageEnvelope from a crawl map. `routesKnown === 0` (blackbox, no route manifest) → fall back to
 *  the absolute page floor rather than a divide-by-zero ratio. `sufficient` requires BOTH enough pages AND — when a
 *  manifest exists — a real fraction of it, so neither a rich-but-narrow nor a manifest-only map slips through. */
export function computeCoverage(input: {
  pagesCrawled: number;
  routesKnown: number;
  endpointsObserved: number;
  rolesCrawled: string[];
  rolesDeclared: string[];
  pagesPerRole: Record<string, number>;
}): CoverageEnvelope {
  const { pagesCrawled, routesKnown, endpointsObserved, rolesCrawled, rolesDeclared, pagesPerRole } = input;
  const ratioOk = routesKnown > 0 ? (pagesCrawled / routesKnown) >= COVERAGE_MIN_RATIO : true;
  const pagesOk = pagesCrawled >= COVERAGE_MIN_PAGES;
  // ⚠ DELIBERATE AMENDMENT TO DESIGN §2.0: the spec's `sufficient` formula reads `... && endpointsObserved > 0`. We
  // DROP that clause on purpose (do NOT "fix" it back). Reason: a real, functional app can be zero-API (in-memory,
  // like the torture fixture) — requiring observed endpoints would wrongly gate EVERY such app to insufficient even
  // with all views crawled. Coverage means breadth of VIEWS, not presence of network traffic; Facet 1 falls back to
  // DOM-derived entities when endpointsObserved===0. endpointsObserved is still carried in the envelope for facets to
  // read (a zero-API app's entity model is DOM-origin + capped-confidence, per Facet 1).
  const sufficient = pagesOk && ratioOk;   // NOTE: endpointsObserved is NOT required — a real, functional app can be
  //                                            zero-API (in-memory, like the torture fixture); entity derivation
  //                                            falls back to DOM affordances there (Facet 1). Requiring it would
  //                                            wrongly gate every zero-API app to insufficient. Coverage = breadth of
  //                                            VIEWS crawled, not presence of network traffic.
  const reason = sufficient
    ? `sufficient: ${pagesCrawled} pages` + (routesKnown ? ` / ${routesKnown} routes (${Math.round(100 * pagesCrawled / routesKnown)}%)` : ' (blackbox)')
    : !pagesOk ? `insufficient: only ${pagesCrawled} page(s) crawled (need ≥${COVERAGE_MIN_PAGES}) — a model from this few screens would be confidently wrong`
      : `insufficient: ${pagesCrawled}/${routesKnown} routes crawled (${Math.round(100 * pagesCrawled / routesKnown)}% < ${Math.round(100 * COVERAGE_MIN_RATIO)}%)`;
  return { pagesCrawled, routesKnown, endpointsObserved, rolesCrawled, rolesDeclared, pagesPerRole, sufficient, reason: evidence(reason) };
}
