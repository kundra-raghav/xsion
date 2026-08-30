/**
 * comprehension/entityModel.ts — FACET 1: entity model + (honest) state machine. Pure set-arithmetic over ProjectMap,
 * no LLM (mirrors siteModel.ts). Every claim carries provenance + confidence via the substrate.
 *
 * THE FACT THAT SHAPES THIS FACET (design §2.1): entity STATE TRANSITIONS are not observable today — the crawler
 * captures one body sample per endpoint key, so there is never a second sighting to diff. Therefore `from/to:'unknown'`
 * and `stateMachine.kind:'stateful-values-unknown'|'no-state-key-observed'` are the NORMAL outputs, never fabricated.
 *
 * ADVERSARIAL GUARDS baked in: (a) merged-entity Jaccard split (two schemas under one path segment → two nodes); (b)
 * degenerate mega-entity guard (one entity absorbs >X% of endpoints → opaque routing, honest whyEmpty); (c)
 * open-world, NON-anchored state-key detection (orderStatus/isPublished/*_at catchable); (d) the negative branch
 * ('no-state-key-observed') is a CLAIM with its own ceiling, never read as "transitions impossible".
 */
import { claim, reinforce, openWorldSet, computeCoverage, evidence, addressing } from './substrate';
import type { Claim, OpenWorldSet, CoverageEnvelope, Addressing } from './substrate';

// ── input shape (a subset of ProjectMap — kept structural so this stays testable without the whole crawl type) ──────
export interface EMEndpoint {
  method: string; url: string; statuses?: number[]; count?: number;
  firedBy?: string[]; writes?: boolean; entity?: string;
  reqFields?: string[]; respFields?: string[]; roles?: string[];
  graphql?: boolean; gqlKind?: 'query' | 'mutation' | 'subscription'; gqlOperation?: string;
}
export interface EMPage {
  url?: string; path?: string; roles?: string[];
  affordanceInventory?: Array<{ label: string; kind: 'nav' | 'action' | 'guarded'; revealedRequirements?: Array<{ label: string; kind: string }> }>;
}
export interface EMInput {
  pages: EMPage[];
  api: EMEndpoint[];
  routesKnown: number;
  rolesDeclared: string[];
  sourceMapCrawledAt: string;
  now: string;
}

// ── output types (design §2.1, verbatim) ─────────────────────────────────────────────────────────────────────────
export type EntityOrigin = 'api' | 'affordance';
export interface EntityField {
  name: string;
  seenIn: Array<'request' | 'response'>;
  claim: Claim;
  roleVisibility: 'unknown' | { seenByRoles: string[]; absentForRoles: string[] };
  looksLikeStateKey?: boolean;
}
export interface EntityTransition {
  trigger: Addressing<string>;
  triggerKind: 'rest-write' | 'gql-mutation' | 'affordance';
  firedByLabels: Addressing<string[]>;
  roles: Addressing<string[]>;
  from: string | 'unknown';
  to: string | 'unknown';
  claim: Claim;
}
export interface EntityNode {
  canonical: string;
  aliases: string[];
  origin: EntityOrigin;
  fields: EntityField[];
  transitions: EntityTransition[];
  stateKeyDetection: OpenWorldSet;
  stateMachine:
    | { kind: 'no-state-key-observed'; claim: Claim }
    | { kind: 'stateful-values-unknown'; stateKey: string; sampleValue?: string; claim: Claim }
    | { kind: 'observed'; stateKey: string; statesSeen: OpenWorldSet; edges: EntityTransition[]; claim: Claim };
  mergeRisk: { sharedNameDistinctSchema: boolean };
  claim: Claim;
}
export interface EntityModel {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;
  derivedAt: string;
  entities: EntityNode[];
  whyEmpty?: string;
  entityDerivationDegenerate: boolean;
  prerequisites: string[];
}

// ── tunables ─────────────────────────────────────────────────────────────────────────────────────────────────────
const AFFORDANCE_CEILING = 0.5;   // UI-copy-derived entities are always beatable by API evidence
const FIELD_CEILING = 0.8;        // fields can't be contradicted under the one-sample freeze (design §2.1)
const NO_STATE_CEILING = 0.5;     // the negative claim ("not stateful") is capped like any negative
const STATEFUL_UNKNOWN_CEILING = 0.6;
const DEGENERATE_PCT = 0.6;       // one entity absorbing >60% of endpoints ⇒ opaque routing
const JACCARD_SPLIT = 0.25;       // two same-named endpoint groups at/below this schema overlap ⇒ distinct entities
                                  //   (0.25 splits schemas sharing only `id`: |{id}| / |A∪B| for two 3-field groups = 1/5)

// state-key detector: OPEN-WORLD + NOT exact-anchored (Attack1 #5). Catches status/state/stage/phase/step as a
// word-part, plus is<Cap> booleans and *_at timestamps-as-state. NEVER asserts a field is NOT a state key.
// snake/kebab boundary OR camelCase hump (orderStatus, workflowStage). Two patterns so `/i` can't loosen the seam.
const STATE_SNAKE = /(^|_|-)(status|state|stage|phase|step)($|_|-)/i;                 // status, order_status, order-status
const STATE_CAMEL = /(Status|State|Stage|Phase|Step|status|state|stage|phase|step)([A-Z]|$)/;   // orderStatus, statusCode
const isStateKeyName = (n: string) => STATE_SNAKE.test(n) || STATE_CAMEL.test(n) || /^is[A-Z]/.test(n) || /(_at|At)$/.test(n) || /workflow|lifecycle/i.test(n);

const entityOfUrl = (url: string): string | undefined => {
  try {
    const path = new URL(url, 'http://x').pathname;
    // last non-:id, non-numeric, non-version segment = the resource
    const segs = path.split('/').filter(Boolean).filter((s) => !/^:?id$/i.test(s) && !/^\d+$/.test(s) && !/^v\d+$/i.test(s) && s !== 'api' && s !== 'graphql');
    const last = segs[segs.length - 1];
    return last ? last.toLowerCase().replace(/s$/, '') : undefined;   // singularize ONLY for the canonical guess; aliases keep raw
  } catch { return undefined; }
};
const accessPrefix = (url: string): string => { try { return new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch { return ''; } };
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; const inter = [...a].filter((x) => b.has(x)).length; return inter / (a.size + b.size - inter || 1); };

/** Derive the entity model from a crawl map. Pure. */
export function deriveEntityModel(input: EMInput): EntityModel {
  const { pages, api, routesKnown, rolesDeclared, sourceMapCrawledAt, now } = input;
  const rolesCrawled = [...new Set(pages.flatMap((p) => p.roles || []))];
  const pagesPerRole: Record<string, number> = {};
  for (const r of rolesCrawled) pagesPerRole[r] = pages.filter((p) => (p.roles || []).includes(r)).length;
  const coverage = computeCoverage({ pagesCrawled: pages.length, routesKnown, endpointsObserved: api.length, rolesCrawled, rolesDeclared, pagesPerRole });

  const base = { coverage, sourceMapCrawledAt, derivedAt: now, entities: [] as EntityNode[], entityDerivationDegenerate: false, prerequisites: [] as string[] };

  // INSUFFICIENT COVERAGE → honest empty (the one-screen guard). Never emit a confident model from too few screens.
  if (!coverage.sufficient) {
    return { ...base, whyEmpty: `insufficient coverage — ${String(coverage.reason)}. Entity model withheld to avoid a confidently-wrong artifact.` };
  }

  // ── group API endpoints by (entity-guess + access-prefix) so admin-scope `users` and tenant-scope `users` don't fuse.
  const groups = new Map<string, EMEndpoint[]>();
  for (const ep of api) {
    const ent = ep.entity || entityOfUrl(ep.url);
    if (!ent) continue;
    const key = ent + '@' + accessPrefix(ep.url);
    (groups.get(key) || groups.set(key, []).get(key)!).push(ep);
  }

  // DEGENERATE guard (Attack1 #7): if one entity-name owns >DEGENERATE_PCT of ALL endpoints, path-derivation is opaque.
  if (api.length >= 5) {
    const byName = new Map<string, number>();
    for (const ep of api) { const e = (ep.entity || entityOfUrl(ep.url) || '?'); byName.set(e, (byName.get(e) || 0) + 1); }
    const top = Math.max(0, ...byName.values());
    if (top / api.length > DEGENERATE_PCT && byName.size <= 2) {
      return { ...base, entityDerivationDegenerate: true, whyEmpty: `entity derivation degenerate — one path segment absorbs ${Math.round(100 * top / api.length)}% of endpoints (opaque/uniform routing); refusing a confident mega-entity.` };
    }
  }

  const entities: EntityNode[] = [];

  // ── build API-origin entities, with the Jaccard split for same-name-distinct-schema (Attack1 #2) ──
  // first, collapse groups that are the SAME entity name at DIFFERENT prefixes but share a schema; split those that don't.
  const byName = new Map<string, string[]>();   // entityName -> group keys
  for (const key of groups.keys()) { const name = key.split('@')[0]; (byName.get(name) || byName.set(name, []).get(name)!).push(key); }

  for (const [name, keys] of byName) {
    // schema fingerprint per group
    const schemaOf = (k: string) => new Set(groups.get(k)!.flatMap((ep) => [...(ep.reqFields || []), ...(ep.respFields || [])]));
    // decide split: if any two groups of the same name have Jaccard < threshold, keep them separate (path-qualified).
    let split = false;
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (jaccard(schemaOf(keys[i]), schemaOf(keys[j])) < JACCARD_SPLIT) split = true;
    const emit = (groupKeys: string[], canonical: string) => {
      const eps = groupKeys.flatMap((k) => groups.get(k)!);
      entities.push(buildApiEntity(canonical, groupKeys, eps, split));
    };
    if (split && keys.length > 1) { for (const k of keys) emit([k], name + '@' + k.split('@')[1]); }
    else emit(keys, name);
  }

  // ── affordance-origin entities: capability labels the crawl saw but no API confirmed (capped confidence) ──
  const apiEntityNames = new Set(entities.map((e) => e.canonical.split('@')[0]));
  const affLabels = new Set<string>();
  for (const pg of pages) for (const a of (pg.affordanceInventory || [])) if (a.kind === 'action') {
    // "Create Event" → entity "event"; a rough noun-extraction, capped low
    const m = a.label.toLowerCase().match(/\b(?:create|add|new|edit|delete|approve|view)\s+(?:an?\s+)?([a-z]+)/);
    const ent = m?.[1]?.replace(/s$/, '');
    if (ent && !apiEntityNames.has(ent)) affLabels.add(ent);
  }
  for (const ent of affLabels) {
    entities.push({
      canonical: ent, aliases: [ent], origin: 'affordance', fields: [], transitions: [],
      stateKeyDetection: openWorldSet([]),
      stateMachine: { kind: 'no-state-key-observed', claim: claim('inferred', 'aff#' + ent, `entity "${ent}" from an affordance label only (no API)`, NO_STATE_CEILING) },
      mergeRisk: { sharedNameDistinctSchema: false },
      claim: claim('inferred', 'aff#' + ent, `entity "${ent}" inferred from a UI action label, no API observed`, AFFORDANCE_CEILING),
    });
  }

  return { ...base, entities };
}

function buildApiEntity(canonical: string, groupKeys: string[], eps: EMEndpoint[], mergeRisk: boolean): EntityNode {
  const aliases = [...new Set([canonical.split('@')[0], ...eps.map((e) => e.entity).filter(Boolean) as string[]])];
  // fields (shapes only, never values) — one claim per field name, ceiling FIELD_CEILING (no miss under the freeze).
  const fieldMap = new Map<string, EntityField>();
  const roleOf = (ep: EMEndpoint) => ep.roles || [];
  for (const ep of eps) {
    for (const [seenIn, list] of [['request', ep.reqFields || []], ['response', ep.respFields || []]] as const) {
      for (const f of list) {
        const evId = `${ep.method} ${ep.url}#${seenIn}:${f}`;
        const ex = fieldMap.get(f);
        if (ex) { ex.claim = reinforce(ex.claim, { provenance: 'observed', evId }); if (!ex.seenIn.includes(seenIn)) ex.seenIn.push(seenIn); }
        else fieldMap.set(f, { name: f, seenIn: [seenIn], claim: claim('observed', evId, `field "${f}" seen in ${seenIn} of ${ep.method} ${ep.url}`, FIELD_CEILING), roleVisibility: 'unknown', looksLikeStateKey: isStateKeyName(f) });
      }
    }
  }
  const fields = [...fieldMap.values()];

  // transitions: every WRITE endpoint on this entity is a (probable) mutation trigger. from/to UNKNOWN (not observable).
  const transitions: EntityTransition[] = eps.filter((e) => e.writes).map((ep) => ({
    trigger: addressing(ep.graphql ? (ep.gqlOperation || 'mutation') : `${ep.method} ${ep.url}`),
    triggerKind: ep.graphql ? 'gql-mutation' : 'rest-write',
    firedByLabels: addressing([...new Set(ep.firedBy || [])]),
    roles: addressing([...new Set(roleOf(ep))]),
    from: 'unknown', to: 'unknown',
    claim: claim('observed', `write#${ep.method} ${ep.url}`, `write ${ep.method} ${ep.url} mutates ${canonical} (from/to unobservable)`, FIELD_CEILING),
  }));

  // state machine — honest four-way. A field that looks like a state key ⇒ 'stateful-values-unknown' (we can't see the
  // values under the freeze). None ⇒ 'no-state-key-observed' (a CLAIM, capped, NOT "transitions impossible").
  const stateFields = fields.filter((f) => f.looksLikeStateKey).map((f) => f.name);
  const stateKeyDetection = openWorldSet(stateFields);
  const stateMachine: EntityNode['stateMachine'] = stateFields.length
    ? { kind: 'stateful-values-unknown', stateKey: stateFields[0], claim: claim('observed', `statekey#${canonical}#${stateFields[0]}`, `"${stateFields[0]}" looks like a state key on ${canonical}; values not observable (one-sample freeze)`, STATEFUL_UNKNOWN_CEILING) }
    : { kind: 'no-state-key-observed', claim: claim('observed', `nostate#${canonical}`, `no state-key field observed on ${canonical} — a claim, not a proof of statelessness`, NO_STATE_CEILING) };

  const totalCount = eps.reduce((s, e) => s + (e.count || 1), 0);
  return {
    canonical, aliases, origin: 'api', fields, transitions, stateKeyDetection, stateMachine,
    mergeRisk: { sharedNameDistinctSchema: mergeRisk },
    claim: claim('observed', `entity#${canonical}`, `entity "${canonical}" from ${eps.length} endpoint(s), ${totalCount} call(s)`, undefined),
  };
}
