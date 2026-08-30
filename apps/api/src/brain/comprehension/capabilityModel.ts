/**
 * comprehension/capabilityModel.ts — FACET 2: capability + per-role model (design §2.2). Pure set-arithmetic over the
 * crawl map's endpoints + role-tagged affordance inventories; no LLM. Every row carries provenance/confidence.
 *
 * THE SHAPE THAT DRIVES THIS FACET: a capability is keyed on (verb, entity, scope) and its STATUS is ROLE-RELATIVE —
 * `exercised` for admin and `denied` for operator is ONE capability with a per-role table, not two capabilities.
 *
 * THE TWO IRREVERSIBLE-CONSEQUENCE GUARDS (design §2.2, load-bearing):
 *  (1) DESTRUCTIVE is FAIL-CLOSED: an unknown verb ⇒ destructive:true. `destructive:false` is licensed ONLY when the
 *      verb is in an explicit known-SAFE allowlist. Absence of a destructive signal is NOT evidence of safety — a
 *      domain destroyer (void/settle/disburse/retire) must never be auto-exercised because we failed to recognise it.
 *  (2) 'denied' is the ONLY licensed "cannot", and ONLY from an authz-shaped 403/401 observed ≥2× with a live reach.
 *      A single 403, or a non-authz denial (rate-limit/csrf/unknown), is 'denied-unconfirmed' — a TEST TARGET, never a
 *      claim that the role cannot do it. This is the confident-wrong-negative firewall for role permissions.
 *
 * The differential testTargets are pure ADDRESSING (Facet firewall): kind uses neutral targeting vocab, `why` is an
 * Evidence field that toPromptSurface strips. This facet emits targets; it never emits a permission verdict.
 */
import { claim, reinforce, contradict, computeCoverage, evidence, addressing } from './substrate';
import type { Claim, CoverageEnvelope, Addressing, Evidence } from './substrate';

// ── input (structural subset of the crawl map) ──────────────────────────────────────────────────────────────────────
export interface CMEndpoint {
  method: string; url: string; statuses?: number[]; count?: number;
  firedBy?: string[]; writes?: boolean; entity?: string; reqFields?: string[];
  roles?: string[];                                   // roles under which this endpoint was OBSERVED to fire
  graphql?: boolean; gqlKind?: 'query' | 'mutation' | 'subscription'; gqlOperation?: string;
  /** per-role status observations, when the crawl saw a denial (kept verbatim; the Evidence half). */
  roleStatuses?: Array<{ role: string; status: number; body?: string; headers?: Record<string, string> }>;
}
export interface CMAffordance {
  label: string; kind: 'nav' | 'action' | 'guarded';
  revealedRequirements?: Array<{ label: string; kind: string }>;
}
export interface CMPage {
  url?: string; path?: string; roles?: string[];
  affordanceInventory?: CMAffordance[];
  /** which roles' crawls actually reached this page (subset of roles). */
  reachedByRoles?: string[];
}
export interface CMInput {
  pages: CMPage[];
  api: CMEndpoint[];
  routesKnown: number;
  rolesDeclared: string[];
  scope?: string;
  sourceMapCrawledAt: string;
  now: string;
}

// ── output types (design §2.2, verbatim) ─────────────────────────────────────────────────────────────────────────
export type CapabilityVerb =
  | 'view' | 'list' | 'create' | 'edit' | 'update' | 'delete'
  | 'move' | 'approve' | 'allocate' | 'ship' | 'send' | 'activate' | 'export' | string;

export type RoleCapStatus =
  | 'exercised' | 'denied' | 'denied-unconfirmed' | 'latent' | 'shadowed' | 'not-reached';

export type DenialClass = 'authz' | 'rate-limit' | 'csrf' | 'unknown';

export interface RoleCapObservation {
  role: string;
  status: RoleCapStatus;
  hits: number; misses: number;
  evidenceIds: string[];
  statusCodes?: Evidence<number[]>;
  denialClass?: DenialClass;
  firstSeen: string; lastSeen: string;
}

export type Destructive = { value: true } | { value: false; vocabClosed: false };

export interface Capability {
  verb: CapabilityVerb;
  entity: string;
  scope: string;
  source: Array<'http' | 'graphql' | 'affordance'>;
  endpointRef?: Addressing<{ method: string; url: string; gqlOperation?: string }>;
  affordanceRef?: Addressing<{ label: string; kind: 'nav' | 'action' | 'guarded'; onPath: string }>;
  requiredFields?: string[];
  prerequisites?: Array<{ verb: CapabilityVerb; entity: string }>;
  perRole: RoleCapObservation[];
  destructive: Destructive;
  latentReason?: 'not-exercised' | 'safety-gated';
  autoExercise: 'never' | 'probe-data-only';
  derivation: Claim;
  verbConflict?: Evidence<{ httpVerb?: string; labelVerb?: string; gqlVerb?: string }>;
}

export interface CapabilityModel {
  coverage: CoverageEnvelope;
  sourceMapCrawledAt: string;
  derivedAt: string;
  scope: string;
  roleCoverage: {
    rolesCrawled: string[];
    rolesDeclared: string[];
    comparable: boolean;
    possibleClientSideGating: boolean;
  };
  capabilities: Capability[];
  testTargets: Array<{
    capability: { verb: CapabilityVerb; entity: string; scope: string };
    kind: 'cross-role-write-differential' | 'role-visibility-differential' | 'latent-destructive-probe' | 'unverified-mutation-probe';
    order: number;
    why?: Evidence<string>;
  }>;
  whyEmpty?: string;
}

// ── vocab (the fail-closed hazard classifier) ────────────────────────────────────────────────────────────────────
// KNOWN-SAFE: the ONLY verbs that may be `destructive:false` and auto-exercised. Deliberately conservative — a verb not
// here is destructive by default. Reads/list/exports don't mutate; view is idempotent.
const KNOWN_SAFE_VERBS = new Set<string>(['view', 'list', 'get', 'read', 'search', 'export', 'download', 'preview']);
// verbs that are unambiguously destructive even if a caller mislabels them (belt-and-braces; not exhaustive by design).
const KNOWN_DESTRUCTIVE_VERBS = new Set<string>(['delete', 'remove', 'purge', 'reset', 'drop', 'void', 'settle', 'disburse', 'retire', 'revoke', 'wipe', 'destroy']);

// verb inference from HTTP method (weakest) + label (strongest, human intent) + gql kind.
const VERB_FROM_METHOD: Record<string, CapabilityVerb> = { GET: 'view', POST: 'create', PUT: 'update', PATCH: 'edit', DELETE: 'delete' };
const LABEL_VERB = /\b(view|list|create|add|new|edit|update|delete|remove|move|approve|allocate|ship|send|activate|deactivate|export|download|reset|purge|void|settle|disburse|retire|revoke)\b/i;
const verbFromLabel = (label: string): CapabilityVerb | undefined => {
  const m = label.toLowerCase().match(LABEL_VERB);
  if (!m) return undefined;
  const v = m[1];
  return ({ add: 'create', new: 'create', remove: 'delete', deactivate: 'activate', download: 'export' } as Record<string, CapabilityVerb>)[v] || v;
};

const entityOfUrl = (url: string): string | undefined => {
  try {
    const segs = new URL(url, 'http://x').pathname.split('/').filter(Boolean)
      .filter((s) => !/^:?id$/i.test(s) && !/^\d+$/.test(s) && !/^v\d+$/i.test(s) && s !== 'api' && s !== 'graphql');
    // skip a trailing action verb segment (…/order/:id/approve → entity "order")
    let idx = segs.length - 1;
    if (idx >= 1 && verbFromLabel(segs[idx])) idx--;
    const last = segs[idx];
    return last ? last.toLowerCase().replace(/s$/, '') : undefined;
  } catch { return undefined; }
};
const accessPrefix = (url: string): string => { try { return new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch { return ''; } };
// a trailing RESTful action segment (…/order/:id/approve) names the verb — human intent, like an affordance label.
const verbFromUrl = (url: string): CapabilityVerb | undefined => {
  try {
    const segs = new URL(url, 'http://x').pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    return last && !/^:?id$/i.test(last) && !/^\d+$/.test(last) ? verbFromLabel(last) : undefined;
  } catch { return undefined; }
};
const qualEntity = (url: string, entity?: string): string => (entity || entityOfUrl(url) || '?') + '@' + accessPrefix(url);

const classifyDenial = (status: number, body?: string, headers?: Record<string, string>): DenialClass => {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (status === 429 || h['retry-after']) return 'rate-limit';
  if (/csrf|xsrf/i.test(body || '') || /csrf|xsrf/i.test(JSON.stringify(h))) return 'csrf';
  if (status === 401 || status === 403) {
    // an authz denial names permission/role/forbidden; a generic 403 with no such body is 'unknown' (fail-open target).
    if (/forbid|unauthor|permission|not allowed|access denied|insufficient|role/i.test(body || '')) return 'authz';
    if (status === 401) return 'authz';   // 401 is definitionally an auth challenge
    return 'unknown';
  }
  return 'unknown';
};

function classifyDestructive(verb: CapabilityVerb, affordanceGuarded: boolean): { destructive: Destructive; autoExercise: Capability['autoExercise']; latentReason?: Capability['latentReason'] } {
  const v = String(verb).toLowerCase();
  if (KNOWN_DESTRUCTIVE_VERBS.has(v)) return { destructive: { value: true }, autoExercise: 'never', latentReason: 'safety-gated' };
  if (KNOWN_SAFE_VERBS.has(v)) return { destructive: { value: false, vocabClosed: false }, autoExercise: 'probe-data-only' };
  // FAIL-CLOSED: unknown verb ⇒ destructive:true, never auto-exercise. Absence of a signal ≠ safety.
  return { destructive: { value: true }, autoExercise: 'never', latentReason: affordanceGuarded ? 'safety-gated' : 'not-exercised' };
}

/** Derive the capability + role model from a crawl map. Pure. */
export function deriveCapabilityModel(input: CMInput): CapabilityModel {
  const { pages, api, routesKnown, rolesDeclared, sourceMapCrawledAt, now } = input;
  const scope = input.scope || 'project-root';
  const rolesCrawled = [...new Set([...pages.flatMap((p) => p.roles || []), ...pages.flatMap((p) => p.reachedByRoles || []), ...api.flatMap((e) => e.roles || [])])];
  const pagesPerRole: Record<string, number> = {};
  for (const r of rolesCrawled) pagesPerRole[r] = pages.filter((p) => (p.reachedByRoles || p.roles || []).includes(r)).length;
  const coverage = computeCoverage({ pagesCrawled: pages.length, routesKnown, endpointsObserved: api.length, rolesCrawled, rolesDeclared, pagesPerRole });

  const base = {
    coverage, sourceMapCrawledAt, derivedAt: now, scope,
    roleCoverage: { rolesCrawled, rolesDeclared, comparable: false, possibleClientSideGating: false },
    capabilities: [] as Capability[], testTargets: [] as CapabilityModel['testTargets'],
  };
  if (!coverage.sufficient) return { ...base, whyEmpty: `insufficient coverage — ${String(coverage.reason)}. Capability model withheld.` };

  // ── build capabilities keyed on (verb, entity@prefix, scope) ─────────────────────────────────────────────────────
  const caps = new Map<string, Capability>();
  const keyOf = (verb: string, entity: string) => `${verb}::${entity}::${scope}`;
  const upsert = (verb: CapabilityVerb, entity: string, seed: () => Capability): Capability => {
    const k = keyOf(verb, entity); const ex = caps.get(k); if (ex) return ex; const c = seed(); caps.set(k, c); return c;
  };
  const ensureRole = (cap: Capability, role: string): RoleCapObservation => {
    let r = cap.perRole.find((x) => x.role === role);
    if (!r) { r = { role, status: 'not-reached', hits: 0, misses: 0, evidenceIds: [], firstSeen: now, lastSeen: now }; cap.perRole.push(r); }
    return r;
  };

  // (A) HTTP/GraphQL endpoints → capabilities. A fired write under a role = 'exercised' for that role.
  for (const ep of api) {
    const httpVerb = VERB_FROM_METHOD[ep.method?.toUpperCase()] as CapabilityVerb | undefined;
    const labelVerb = (ep.firedBy || []).map(verbFromLabel).find(Boolean);
    const urlVerb = verbFromUrl(ep.url);   // RESTful action segment = intent, ranks with the label
    const gqlVerb = ep.graphql ? (ep.gqlKind === 'mutation' ? 'update' : ep.gqlKind === 'query' ? 'view' : undefined) : undefined;
    const verb = labelVerb || urlVerb || gqlVerb || httpVerb || 'view';
    const entity = qualEntity(ep.url, ep.entity);
    const cap = upsert(verb, entity, () => {
      const haz = classifyDestructive(verb, false);
      return {
        verb, entity, scope, source: [ep.graphql ? 'graphql' : 'http'],
        endpointRef: addressing({ method: ep.method, url: ep.url, ...(ep.gqlOperation ? { gqlOperation: ep.gqlOperation } : {}) }),
        requiredFields: ep.reqFields ? [...new Set(ep.reqFields)] : undefined,
        perRole: [], ...haz,
        derivation: claim('observed', `cap#${ep.method} ${ep.url}`, `capability ${verb} ${entity} from ${ep.method} ${ep.url}`, undefined),
      };
    });
    if (!cap.source.includes(ep.graphql ? 'graphql' : 'http')) cap.source.push(ep.graphql ? 'graphql' : 'http');
    // record a verb conflict (recorded, never resolved) — evidence-typed.
    if (labelVerb && httpVerb && labelVerb !== httpVerb) cap.verbConflict = evidence({ httpVerb: ep.method, labelVerb, gqlVerb });

    // per-role: fired (2xx observed) → exercised; a denial → classified.
    for (const role of ep.roles || []) {
      const r = ensureRole(cap, role);
      const evId = `${ep.method} ${ep.url}@${role}`;
      if (!r.evidenceIds.includes(evId)) { r.evidenceIds.push(evId); r.hits++; }
      if (r.status === 'not-reached' || r.status === 'latent') r.status = 'exercised';
      r.lastSeen = now;
    }
    for (const rs of ep.roleStatuses || []) {
      const r = ensureRole(cap, rs.role);
      const evId = `${ep.method} ${ep.url}@${rs.role}#${rs.status}`;
      if (rs.status >= 400) {
        if (!r.evidenceIds.includes(evId)) { r.evidenceIds.push(evId); r.misses++; }
        r.statusCodes = evidence([...((r.statusCodes as unknown as number[]) || []), rs.status]);
        const dc = classifyDenial(rs.status, rs.body, rs.headers);
        r.denialClass = dc;
        // 'denied' ONLY from authz-class AND ≥2 observed denials. Otherwise denied-unconfirmed (a target).
        r.status = (dc === 'authz' && r.misses >= 2) ? 'denied' : 'denied-unconfirmed';
        r.lastSeen = now;
      } else {
        if (!r.evidenceIds.includes(evId)) { r.evidenceIds.push(evId); r.hits++; }
        if (r.status !== 'denied') r.status = 'exercised';
      }
    }
  }

  // (B) affordances → capabilities (latent if never fired). role visibility from which roles' inventory carried it.
  const affByLabelRoles = new Map<string, { aff: CMAffordance; onPath: string; roles: Set<string>; pageRoles: Set<string> }>();
  for (const pg of pages) {
    const pageRoles = new Set(pg.reachedByRoles || pg.roles || []);
    for (const a of pg.affordanceInventory || []) {
      if (a.kind === 'nav') continue;
      const k = a.label.toLowerCase();
      const rec = affByLabelRoles.get(k) || { aff: a, onPath: pg.path || pg.url || '', roles: new Set<string>(), pageRoles: new Set<string>() };
      for (const r of pageRoles) rec.roles.add(r);
      for (const r of pageRoles) rec.pageRoles.add(r);
      affByLabelRoles.set(k, rec);
    }
  }
  const allInventoryRoles = new Set<string>([...affByLabelRoles.values()].flatMap((r) => [...r.roles]));
  for (const [label, rec] of affByLabelRoles) {
    const verb = verbFromLabel(rec.aff.label) || 'view';
    // entity from the label noun (best-effort); qualify by the page path prefix so it aligns with API entities loosely.
    const noun = rec.aff.label.toLowerCase().replace(LABEL_VERB, '').replace(/^\s*(an?|the)\s+/, '').trim().split(/\s+/)[0]?.replace(/s$/, '') || '?';
    const entity = noun + '@' + rec.onPath.split('/').filter(Boolean).slice(0, 2).join('/');
    const cap = upsert(verb, entity, () => {
      const haz = classifyDestructive(verb, rec.aff.kind === 'guarded');
      return {
        verb, entity, scope, source: ['affordance'],
        affordanceRef: addressing({ label: rec.aff.label, kind: rec.aff.kind, onPath: rec.onPath }),
        requiredFields: rec.aff.revealedRequirements?.map((r) => r.label),
        perRole: [], ...haz,
        derivation: claim('observed', `cap-aff#${label}`, `capability ${verb} ${entity} from affordance "${rec.aff.label}"`, 0.6),
      };
    });
    if (!cap.source.includes('affordance')) cap.source.push('affordance');
    // per-role visibility: role saw the affordance in its inventory but it never fired → latent; a role that reached
    // pages carrying this label's page but did NOT see it → shadowed (UI gating SIGNAL, not "cannot").
    for (const role of rec.roles) {
      const r = ensureRole(cap, role);
      if (r.status === 'not-reached') r.status = 'latent';
    }
    for (const role of allInventoryRoles) {
      if (!rec.roles.has(role)) {
        // role exists in some inventory but not this affordance's → shadowed signal.
        const r = ensureRole(cap, role);
        if (r.status === 'not-reached') r.status = 'shadowed';
      }
    }
  }

  const capabilities = [...caps.values()];

  // ── role coverage: comparable requires ≥2 roles AND a POSITIVE differentiator that actually differed ──────────────
  let comparable = false, anyDifferentiator = false, anyIdentical = false;
  if (rolesCrawled.length >= 2) {
    for (const cap of capabilities) {
      const statuses = rolesCrawled.map((role) => cap.perRole.find((r) => r.role === role)?.status || 'not-reached');
      const distinct = new Set(statuses);
      if (distinct.size > 1) anyDifferentiator = true; else anyIdentical = true;
    }
    comparable = anyDifferentiator;
  }
  const possibleClientSideGating = rolesCrawled.length >= 2 && !anyDifferentiator && anyIdentical;

  // ── differential TEST TARGETS (pure addressing; why is Evidence, stripped by toPromptSurface) ────────────────────
  const testTargets: CapabilityModel['testTargets'] = [];
  let order = 0;
  for (const cap of capabilities) {
    const addr = { verb: cap.verb, entity: cap.entity, scope: cap.scope };
    const exercisedRoles = cap.perRole.filter((r) => r.status === 'exercised').map((r) => r.role);
    const deniedish = cap.perRole.filter((r) => r.status === 'denied' || r.status === 'denied-unconfirmed');
    const shadowed = cap.perRole.filter((r) => r.status === 'shadowed');
    // cross-role write differential: one role exercised a write, another was denied/unconfirmed → probe enforcement.
    if (exercisedRoles.length && deniedish.length) {
      testTargets.push({ capability: addr, kind: 'cross-role-write-differential', order: order++, why: evidence(`${exercisedRoles.join(',')} exercised; ${deniedish.map((r) => r.role).join(',')} not — probe server-side enforcement`) });
    }
    // role-visibility differential (shadowed): some role saw it, another didn't → probe if hidden = enforced.
    if (exercisedRoles.length || cap.perRole.some((r) => r.status === 'latent')) {
      for (const s of shadowed) testTargets.push({ capability: addr, kind: 'role-visibility-differential', order: order++, why: evidence(`${s.role} did not see affordance others did — probe whether hiding is server-enforced`) });
    }
    // latent destructive probe: a destructive capability seen but never exercised (SAFELY probed only, never auto-fired).
    if (cap.destructive.value === true && cap.perRole.some((r) => r.status === 'latent')) {
      testTargets.push({ capability: addr, kind: 'latent-destructive-probe', order: order++, why: evidence(`destructive ${cap.verb} ${cap.entity} latent — probe safely, never auto-exercise`) });
    }
    // unverified mutation: a write endpoint with no exercised role at all → probe once.
    if (cap.source.some((s) => s !== 'affordance') && cap.destructive.value === false && !exercisedRoles.length && cap.perRole.every((r) => r.status !== 'exercised')) {
      testTargets.push({ capability: addr, kind: 'unverified-mutation-probe', order: order++, why: evidence(`${cap.verb} ${cap.entity} never observed firing — verify it works`) });
    }
  }

  return { ...base, roleCoverage: { rolesCrawled, rolesDeclared, comparable, possibleClientSideGating }, capabilities, testTargets };
}
