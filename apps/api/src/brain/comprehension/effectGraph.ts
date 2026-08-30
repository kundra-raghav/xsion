/**
 * comprehension/effectGraph.ts — FACET 3: cross-role effect graph (design §2.3). Pure; no LLM on the critical path.
 *
 * THE FAILURE MODE THIS FACET EXISTS TO PREVENT: a CONFIDENT-WRONG CAUSAL EDGE — "operator's create caused the row
 * admin saw change", asserted from a coincidence (a cron job, an updated_at bump, a shared counter) rather than a
 * controlled observation. Guards, each load-bearing:
 *
 *  (1) SUBSTRATE REALITY (verified): store.mapHistory rings whole ProjectMaps with NO role stamp. So a per-role
 *      TIMELINE — what Tier 2 (temporal) needs — DOES NOT EXIST today. This facet therefore derives a TIER-1
 *      STRUCTURAL graph (an action under role A writes an entity role B reads) and reports Tier 2 as UNREACHABLE,
 *      listing the {ranAsRoleId, crawledAt} store change in `prerequisites`. It NEVER attributes a delta to whichever
 *      role crawled last. Tier 2 is gated behind an explicit `roleTimeline` input a future store change must populate.
 *  (2) 'repeated' (the only near-causal rung) is STRUCTURALLY UNREACHABLE without `baselineControlled` — a quiescent
 *      re-read with no role action. computeEffectProvenance() cannot RETURN 'repeated' when baselineControlled=false;
 *      it caps at 'correlated' (test-ordering only). A systematic confound repeats by definition and would trivially
 *      satisfy "same delta ≥2 pairs" — the baseline is what separates causation from a cron tick.
 *  (3) EvidenceId includes the CRAWL-PAIR identity, so two genuinely-distinct pairs bump `hits` (reinforce dedups by
 *      evId — an evId keyed on the delta alone would dedup pair 2 and make 'repeated' unreachable for the WRONG reason).
 *  (4) AMBIENT fields (updated_at, counters, version/etag) are excluded from delta detection — a FRESH list, opposite
 *      in role to Facet 1's state-key detector (there *_at is a state key; here it is noise).
 *  (5) edges:[] is NEVER "no cascades". Applicability gates on a NON-EMPTY entity-fingerprint set: a 2-role zero-API
 *      app lands on 'insufficient-substrate', never 'applicable' with empty edges.
 *  (6) When two roles could both have caused a delta, it goes to `ambiguous` with the FULL candidate set and NO edge
 *      is emitted (never pick a winner).
 *
 * FIREWALL: `observedDelta` is Evidence (WHAT changed, never WHETHER right); `unattributed`/`ambiguous` entries are
 * Evidence at the ENTRY level (the whole entry). None of it may reach a prompt — this facet emits addressing + a graph,
 * never a verdict about whether a cascade is a bug.
 */
import { claim, reinforce, computeCoverage, evidence, addressing } from './substrate';
import type { Claim, CoverageEnvelope, Addressing, Evidence } from './substrate';

// ── input (structural subset of the crawl map) ──────────────────────────────────────────────────────────────────────
export interface EGEndpoint {
  method: string; url: string; writes?: boolean; entity?: string;
  respFields?: string[]; reqFields?: string[]; roles?: string[]; firedBy?: string[];
  statuses?: number[]; count?: number; graphql?: boolean; gqlOperation?: string;
}
export interface EGPage { url?: string; path?: string; roles?: string[]; reachedByRoles?: string[]; }
/** The Tier-2 timeline primitive — populated ONLY by a future store change ({ranAsRoleId, crawledAt} per snapshot).
 *  Absent today ⇒ Tier 2 unreachable ⇒ a prerequisite, never a fabricated temporal edge. */
export interface EntityFingerprint {
  entity: string; roleId: string; crawledAt: string;
  respFieldSet: string[]; reqFieldSet: string[];
  writeOps: string[]; readOps: string[]; worstStatus: number; contentBand: number;
}
export interface EGInput {
  pages: EGPage[];
  api: EGEndpoint[];
  routesKnown: number;
  rolesDeclared: string[];
  sourceMapCrawledAt: string;
  now: string;
  /** OPTIONAL Tier-2 substrate. Undefined today (no role-stamped history). Two+ fingerprints for the SAME entity at
   *  DIFFERENT (roleId, crawledAt) enable a temporal read; a quiescent baseline entry (roleId='__baseline__') licenses
   *  the 'repeated' ceiling. */
  roleTimeline?: EntityFingerprint[];
}

// ── output types (design §2.3, verbatim) ─────────────────────────────────────────────────────────────────────────
export type EffectProvenance = 'structural' | 'correlated' | 'repeated' | 'code-confirmed' | 'human-confirmed';
export interface EffectEdge {
  fromRole: Addressing<string>; action: Addressing<string>;
  entity: string; toRole: Addressing<string>; toEntity: string;
  tier: 1 | 2;
  provenance: EffectProvenance;
  observedDelta?: Evidence<string>;
  baselineControlled: boolean;
  claim: Claim;
}
export interface EffectGraph {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;
  derivedAt: string;
  applicability: 'applicable' | 'not-applicable-single-role' | 'insufficient-sessions' | 'insufficient-substrate';
  edges: EffectEdge[];
  unattributed: Array<Evidence<{ entity: string; delta: string; note: string }>>;
  ambiguous: Array<Evidence<{ entity: string; delta: string; candidateRoles: string[] }>>;
  prerequisites: string[];
  whyEmpty?: string;
}

// ── tunables + vocab ─────────────────────────────────────────────────────────────────────────────────────────────
// ceilings for the NON-substrate provenance union (substrate's PROVENANCE_CEILING does NOT apply here). structural &
// correlated are capped BELOW any causal reading; only baseline-controlled 'repeated' + code/human may go higher.
const EFFECT_CEILING: Record<EffectProvenance, number> = {
  structural: 0.35, correlated: 0.5, repeated: 0.75, 'code-confirmed': 0.9, 'human-confirmed': 1.0,
};
// AMBIENT fields — noise for effect detection (a systematic confound). FRESH list, opposite role to Facet 1's
// state-key detector. A delta consisting ONLY of ambient fields is NOT an effect.
const AMBIENT = /^(updated_?at|modified_?at|created_?at|last_?(modified|seen|login)|version|etag|revision|_?rev|seq|sequence|counter|count|total|timestamp|ts|nonce|checksum|hash|updatedby|modifiedby)$/i;
const isAmbient = (f: string) => AMBIENT.test(f.replace(/[^a-z0-9_]/gi, ''));

const LABEL_VERB = /\b(view|list|create|add|new|edit|update|delete|remove|move|approve|allocate|ship|send|activate|export|reset|purge|void|settle|disburse|retire|revoke)\b/i;
const entityOfUrl = (url: string): string | undefined => {
  try {
    const segs = new URL(url, 'http://x').pathname.split('/').filter(Boolean)
      .filter((s) => !/^:?id$/i.test(s) && !/^\d+$/.test(s) && !/^v\d+$/i.test(s) && s !== 'api' && s !== 'graphql');
    let idx = segs.length - 1;
    if (idx >= 1 && LABEL_VERB.test(segs[idx])) idx--;
    const last = segs[idx];
    return last ? last.toLowerCase().replace(/s$/, '') : undefined;
  } catch { return undefined; }
};
const accessPrefix = (url: string): string => { try { return new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch { return ''; } };
const qualEntity = (url: string, entity?: string): string => (entity || entityOfUrl(url) || '?') + '@' + accessPrefix(url);
const actionLabel = (ep: EGEndpoint): string => ep.graphql ? (ep.gqlOperation || 'mutation') : `${ep.method} ${ep.url}`;

/** THE PROVENANCE GATE. Given the observed situation, return the HIGHEST licensed provenance. Cannot return 'repeated'
 *  unless baselineControlled — a systematic confound satisfies "same delta ≥2 pairs" trivially, so without a quiescent
 *  baseline the ceiling is 'correlated' (test-ordering signal only, never causal). This is one function so the rung is
 *  structurally unreachable, not an if at a call site that a refactor could drop. */
export function computeEffectProvenance(opts: { tier: 1 | 2; repeatedPairs: number; baselineControlled: boolean; codeConfirmed?: boolean; humanConfirmed?: boolean }): EffectProvenance {
  if (opts.humanConfirmed) return 'human-confirmed';
  if (opts.codeConfirmed) return 'code-confirmed';
  if (opts.tier === 1) return 'structural';                 // an action-exists edge — never more than structural
  // tier 2 (temporal):
  if (opts.repeatedPairs >= 2 && opts.baselineControlled) return 'repeated';
  return 'correlated';                                      // includes: repeated-but-uncontrolled (the confound cap)
}

/** Derive the cross-role effect graph. Pure. */
export function deriveEffectGraph(input: EGInput): EffectGraph {
  const { pages, api, routesKnown, rolesDeclared, sourceMapCrawledAt, now, roleTimeline } = input;
  const rolesCrawled = [...new Set([...pages.flatMap((p) => p.reachedByRoles || p.roles || []), ...api.flatMap((e) => e.roles || [])])];
  const pagesPerRole: Record<string, number> = {};
  for (const r of rolesCrawled) pagesPerRole[r] = pages.filter((p) => (p.reachedByRoles || p.roles || []).includes(r)).length;
  const coverage = computeCoverage({ pagesCrawled: pages.length, routesKnown, endpointsObserved: api.length, rolesCrawled, rolesDeclared, pagesPerRole });

  // Tier 2 is unreachable without a role-stamped timeline (verified: store.mapHistory has none). Always surface the
  // prerequisite so the honesty is a deliverable, not a comment.
  const tier2Available = !!roleTimeline && roleTimeline.length >= 2;
  const prerequisites = tier2Available ? [] : ['store.mapHistory must record {ranAsRoleId, crawledAt} per snapshot to enable Tier-2 temporal effect derivation (a quiescent baseline re-read is additionally required for causal "repeated" edges)'];

  const base = { coverage, sourceMapCrawledAt, derivedAt: now, edges: [] as EffectEdge[], unattributed: [] as EffectGraph['unattributed'], ambiguous: [] as EffectGraph['ambiguous'], prerequisites };

  // APPLICABILITY ORDER (design §2.3): coverage first; then the entity-fingerprint set must be NON-EMPTY (a 2-role
  // zero-API app lands on insufficient-substrate, NOT applicable-with-empty-edges); then single-role; then timeline.
  if (!coverage.sufficient) return { ...base, applicability: 'insufficient-substrate', whyEmpty: `insufficient coverage — ${String(coverage.reason)}.` };

  // the entity-fingerprint set = entities we can actually reason about (an entity touched by ≥1 endpoint with fields).
  const writeEndpoints = api.filter((e) => e.writes);
  const readableEntities = new Set(api.filter((e) => (e.respFields || []).some((f) => !isAmbient(f))).map((e) => qualEntity(e.url, e.entity)));
  const fingerprintSetEmpty = readableEntities.size === 0 && writeEndpoints.length === 0;
  if (fingerprintSetEmpty) return { ...base, applicability: 'insufficient-substrate', whyEmpty: 'no entity fingerprints (zero API surface) — cross-role effects not derivable from UI-only crawl.' };

  if (rolesCrawled.length < 2) return { ...base, applicability: 'not-applicable-single-role', whyEmpty: `only ${rolesCrawled.length} role crawled — a cross-role graph needs ≥2.` };

  // ── TIER 1: STRUCTURAL edges. role A has a WRITE action on entity E; role B (≠A) has a READ on the SAME entity E
  //    (respFields overlap, non-ambient). This is an EXISTENCE-of-a-path edge — never causal (provenance:'structural').
  const edges: EffectEdge[] = [];
  const unattributed: EffectGraph['unattributed'] = [];
  const ambiguous: EffectGraph['ambiguous'] = [];
  // index reads by entity → set of (role, non-ambient respFields). A READ is a NON-WRITE endpoint (GET / gql query):
  // a write endpoint that happens to RETURN a body (e.g. POST …/approve → {orderStatus,error}) is NOT a read of its
  // own entity — counting it makes every write a self-reader and emits phantom "path exists" edges from a write to a
  // read that doesn't exist. The design's edge is write-by-A → a SEPARATE read-by-B; the read index must exclude writes.
  const readsByEntity = new Map<string, Array<{ role: string; fields: string[] }>>();
  for (const ep of api) {
    if (ep.writes) continue;                                   // ← a write is never a read of its own entity
    const nonAmbient = (ep.respFields || []).filter((f) => !isAmbient(f));
    if (!nonAmbient.length) continue;
    const ent = qualEntity(ep.url, ep.entity);
    for (const role of ep.roles || []) (readsByEntity.get(ent) || readsByEntity.set(ent, []).get(ent)!).push({ role, fields: nonAmbient });
  }
  for (const ep of writeEndpoints) {
    const ent = qualEntity(ep.url, ep.entity);
    const writerRoles = [...new Set(ep.roles || [])];
    const readers = readsByEntity.get(ent) || [];
    for (const wRole of writerRoles) {
      const otherReaders = [...new Set(readers.filter((r) => r.role !== wRole).map((r) => r.role))];
      for (const rRole of otherReaders) {
        const evId = `struct#${ent}#${actionLabel(ep)}#${wRole}->${rRole}`;
        edges.push({
          fromRole: addressing(wRole), action: addressing(actionLabel(ep)),
          entity: ent, toRole: addressing(rRole), toEntity: ent,
          tier: 1, provenance: 'structural', baselineControlled: false,
          claim: claim('inferred', evId, `structural: ${wRole} can write ${ent}, ${rRole} reads it (path exists; not causal)`, EFFECT_CEILING.structural),
        });
      }
    }
  }

  // ── TIER 2: TEMPORAL edges — ONLY if a role-stamped timeline exists (never today). Per-entity, compare consecutive
  //    fingerprints across roles; a non-ambient field-set change after role A's action = a candidate effect.
  if (tier2Available) {
    const byEntity = new Map<string, EntityFingerprint[]>();
    for (const fp of roleTimeline!) (byEntity.get(fp.entity) || byEntity.set(fp.entity, []).get(fp.entity)!).push(fp);
    for (const [ent, fpsRaw] of byEntity) {
      const fps = [...fpsRaw].sort((a, b) => a.crawledAt.localeCompare(b.crawledAt));
      // count repeated identical non-ambient deltas across DISTINCT pairs (each pair contributes at most one hit).
      const deltaPairs = new Map<string, Set<string>>();   // deltaKey -> set of pair-ids
      const baselineByDelta = new Map<string, boolean>();
      const attributionByDelta = new Map<string, { delta: string; writers: Set<string> }>();
      for (let i = 1; i < fps.length; i++) {
        const prev = fps[i - 1], cur = fps[i];
        const changed = [...new Set([...cur.respFieldSet, ...prev.respFieldSet])].filter((f) => !isAmbient(f) && (cur.respFieldSet.includes(f) !== prev.respFieldSet.includes(f) || cur.worstStatus !== prev.worstStatus));
        if (!changed.length && cur.contentBand === prev.contentBand && cur.worstStatus === prev.worstStatus) continue;   // quiescent
        const deltaKey = changed.sort().join(',') + '|band' + (cur.contentBand - prev.contentBand);
        const pairId = `${prev.crawledAt}->${cur.crawledAt}`;
        (deltaPairs.get(deltaKey) || deltaPairs.set(deltaKey, new Set()).get(deltaKey)!).add(pairId);
        // a baseline pair = a re-read with NO role action between (roleId '__baseline__'): licenses causal 'repeated'.
        const wasBaseline = prev.roleId === '__baseline__' || cur.roleId === '__baseline__';
        baselineByDelta.set(deltaKey, (baselineByDelta.get(deltaKey) || false) || wasBaseline);
        // ATTRIBUTION — the guard: credit ONLY a role whose fingerprint for THIS entity actually WROTE (non-empty
        // writeOps). A read-only role whose snapshot merely came next is NOT the cause (that would be "attribute to
        // whoever crawled last" — the exact confident-wrong causal edge this facet exists to prevent). If neither
        // pair-adjacent role wrote, the delta has no attributable action → it stays unattributed (recorded below).
        const wrote = (fp: EntityFingerprint) => fp.roleId !== '__baseline__' && (fp.writeOps || []).length > 0;
        const rec = attributionByDelta.get(deltaKey) || { delta: deltaKey, writers: new Set<string>() };
        if (wrote(cur)) rec.writers.add(cur.roleId);
        else if (wrote(prev)) rec.writers.add(prev.roleId);
        attributionByDelta.set(deltaKey, rec);
      }
      for (const [deltaKey, pairIds] of deltaPairs) {
        const rec = attributionByDelta.get(deltaKey)!;
        const writers = [...rec.writers];
        const baselineControlled = baselineByDelta.get(deltaKey) || false;
        // AMBIGUOUS: ≥2 candidate writer roles → NO edge, record the full set.
        if (writers.length >= 2) { ambiguous.push(evidence({ entity: ent, delta: deltaKey, candidateRoles: writers })); continue; }
        // UNATTRIBUTED: a delta with no role action behind it → record, no edge (case a/d).
        if (writers.length === 0) { unattributed.push(evidence({ entity: ent, delta: deltaKey, note: 'delta observed with no attributable role action (possible confound/cron)' })); continue; }
        const wRole = writers[0];
        // readers of this entity under a different role (structural target of the temporal effect).
        const readerRoles = [...new Set((readsByEntity.get(ent) || []).filter((r) => r.role !== wRole).map((r) => r.role))];
        const prov = computeEffectProvenance({ tier: 2, repeatedPairs: pairIds.size, baselineControlled });
        for (const rRole of readerRoles.length ? readerRoles : ['(unknown-reader)']) {
          let c = claim('observed', `temporal#${ent}#${deltaKey}#${wRole}`, `temporal: ${wRole} action preceded ${deltaKey} change on ${ent}`, EFFECT_CEILING[prov]);
          // bump hits by distinct pair (evId includes pair identity so pair 2 is NOT deduped).
          for (const pairId of pairIds) c = reinforce(c, { provenance: 'observed', evId: `temporal#${ent}#${deltaKey}#${pairId}` });
          edges.push({
            fromRole: addressing(wRole), action: addressing('(temporal)'),
            entity: ent, toRole: addressing(rRole), toEntity: ent,
            tier: 2, provenance: prov, baselineControlled,
            observedDelta: evidence(deltaKey),
            claim: c,
          });
        }
      }
    }
  }

  const applicability: EffectGraph['applicability'] = tier2Available ? 'applicable' : 'insufficient-sessions';
  return { ...base, applicability, edges, unattributed, ambiguous };
}
