/**
 * comprehension/index.ts — THE ASSEMBLER. Runs all four facets over a real ProjectMap and returns the world-model,
 * plus the ONE firewall-clean planner surface (testTargets → toPromptSurface). This is the single entry point a
 * consumer (break-it, the coverage gate, a report) calls; nothing downstream touches a facet directly.
 *
 * THE ADAPTER IS A STRAIGHT FIELD-COPY: the facet input shapes (EM, CM, EG inputs) are deliberately structural SUBSETS
 * of crawlTypes (ApiEndpoint, MappedPage, RoleDef), so this file adapts by copying named fields — no interpretation.
 * Fields the crawl doesn't populate (respFields on old maps, roleStatuses ever) simply arrive undefined and the facets
 * degrade honestly (a state machine becomes no-state-key-observed; a denial classifier stays silent) — never fabricate.
 *
 * FIREWALL (design §4): the facets emit `testTargets` whose `why` is Evidence. This assembler is the ONLY place those
 * targets become a prompt surface, and it does so EXCLUSIVELY through toPromptSurface (the allowlist serializer). A
 * consumer must use `promptSurface` (clean) for anything an LLM sees; `model` (rich, evidence-carrying) is for humans
 * and mechanical code only.
 */
import { deriveEntityModel } from './entityModel';
import { deriveCapabilityModel } from './capabilityModel';
import { deriveEffectGraph } from './effectGraph';
import { parseCode, reconcile } from './codeDerived';
import { toPromptSurface, type TestTarget } from './firewall';
import type { EntityModel } from './entityModel';
import type { CapabilityModel } from './capabilityModel';
import type { EffectGraph } from './effectGraph';
import type { CodeModel, ReconcileResult } from './codeDerived';

/** The minimal ProjectMap shape the assembler reads (structural — avoids importing the whole crawl type graph). */
export interface CompInputMap {
  baseUrl?: string;
  crawledAt?: string;
  routeManifest?: Array<{ path: string }>;
  roles?: Array<{ id: string; name?: string }>;
  pages?: Array<{
    url?: string; path?: string; roles?: string[];
    requirements?: Array<{ label?: string; kind?: string }>;
    affordanceInventory?: Array<{ label: string; kind: 'nav' | 'action' | 'guarded'; revealedRequirements?: Array<{ label: string; kind: string }> }>;
  }>;
  api?: Array<{
    method: string; url: string; statuses?: number[]; count?: number;
    firedBy?: string[]; writes?: boolean; entity?: string; reqFields?: string[]; respFields?: string[];
    roles?: string[]; graphql?: boolean; gqlKind?: 'query' | 'mutation' | 'subscription'; gqlOperation?: string;
  }>;
}

export interface ComprehensionModel {
  baseUrl?: string;
  sourceMapCrawledAt: string;
  derivedAt: string;
  entity: EntityModel;
  capability: CapabilityModel;
  effect: EffectGraph;
  code: CodeModel;
  codeReconciled?: ReconcileResult;   // present only when source was supplied
  /** the union of all facets' test targets, as pure ADDRESSING (firewall-clean — safe to put in an LLM prompt). */
  promptSurface: Array<Pick<TestTarget, 'target' | 'action' | 'order' | 'entity' | 'scope' | 'kind'>>;
}

/** map a facet-2 testTarget kind → the firewall's neutral TestTarget kind (identical vocab; a narrowing re-label). */
function capKindToTargetKind(k: string): TestTarget['kind'] {
  switch (k) {
    case 'cross-role-write-differential': return 'cross-role-write-differential';
    case 'role-visibility-differential': return 'role-visibility-differential';
    case 'latent-destructive-probe': return 'unverified-capability';
    case 'unverified-mutation-probe': return 'unverified-capability';
    default: return 'coverage-gap';
  }
}

/**
 * Run the whole comprehension layer over a crawl map.
 * @param map     a ProjectMap (or the structural subset above)
 * @param opts.source  optional app source (single-file inline JS) → enables Facet 4 + code/runtime reconciliation
 * @param opts.now     ISO timestamp to stamp derivation (pass one — the environment forbids Date.now in pure code)
 */
export function deriveComprehension(map: CompInputMap, opts: { source?: string; sourceFile?: string; now: string }): ComprehensionModel {
  const now = opts.now;
  const pages = (map.pages || []).map((p) => ({
    url: p.url, path: p.path, roles: p.roles || [], reachedByRoles: p.roles || [],
    affordanceInventory: (p.affordanceInventory || []).map((a) => ({ label: a.label, kind: a.kind, revealedRequirements: a.revealedRequirements })),
  }));
  const api = (map.api || []).map((e) => ({
    method: e.method, url: e.url, statuses: e.statuses, count: e.count, firedBy: e.firedBy,
    writes: e.writes, entity: e.entity, reqFields: e.reqFields, respFields: e.respFields,
    roles: e.roles || [], graphql: e.graphql, gqlKind: e.gqlKind, gqlOperation: e.gqlOperation,
  }));
  const routesKnown = (map.routeManifest || []).length || pages.length;
  const rolesDeclared = (map.roles || []).map((r) => r.id);
  const sourceMapCrawledAt = map.crawledAt || now;
  const common = { pages, api, routesKnown, rolesDeclared, sourceMapCrawledAt, now };

  const entity = deriveEntityModel(common);
  const capability = deriveCapabilityModel(common);
  const effect = deriveEffectGraph(common);
  const code = parseCode(opts.source, { file: opts.sourceFile || 'source' });

  // Facet 4 reconciliation: merge code enums with the OBSERVED state values Facet 1 detected per entity.
  let codeReconciled: ReconcileResult | undefined;
  if (code.parsed && code.stateEnums.length) {
    const observed: Record<string, string[]> = {};
    for (const ent of entity.entities) {
      const sm = ent.stateMachine;
      if (sm.kind === 'observed') observed[ent.canonical.split('@')[0]] = (sm as any).statesSeen?.observed || [];
    }
    codeReconciled = reconcile(code.stateEnums, observed);
  }

  // FIREWALL SEAM: build the ONE prompt surface from the capability facet's test targets (the richest source of
  // differential targets today) via the allowlist serializer. `why` (Evidence) is structurally stripped here.
  //
  // But raw targets are NOISY (affordance-label fragments become pseudo-entities: "+", "−", "@admin", "sign"; and the
  // same capability yields several targets). Shipping 20 arbitrary-order noisy hints into an LLM prompt is worse than
  // shipping none. So before serializing we (a) DROP low-quality entities, (b) DEDUP, (c) RANK by usefulness — a
  // latent DESTRUCTIVE probe (delete-all / reset-db / purge) is the most valuable thing to flag; a cross-role write
  // differential next; visibility-differential last. `order` is rewritten to the rank so the slice is priority, not
  // insertion order.
  const entityName = (e: string) => e.split('@')[0].trim();
  const isJunkEntity = (e: string) => { const n = entityName(e); return n.length <= 2 || n === '?' || /^[+\-•·…]+$/.test(n) || /^@/.test(e.trim()); };
  const KIND_RANK: Record<TestTarget['kind'], number> = {
    'cross-role-write-differential': 0, 'unverified-capability': 1, 'state-transition': 1, 'role-visibility-differential': 2, 'coverage-gap': 3,
  };
  // a latent-DESTRUCTIVE probe is the single most useful hint — surface it above everything (its cap is destructive).
  const isLatentDestructive = (t: (typeof capability.testTargets)[number]) => t.kind === 'latent-destructive-probe';
  const seen = new Set<string>();
  const ranked = capability.testTargets
    .filter((t) => !isJunkEntity(t.capability.entity))
    .map((t) => ({ t, kind: capKindToTargetKind(t.kind), rank: (isLatentDestructive(t) ? -1 : KIND_RANK[capKindToTargetKind(t.kind)]) }))
    .sort((a, b) => a.rank - b.rank)
    .filter(({ t, kind }) => { const k = `${t.capability.verb}::${entityName(t.capability.entity)}::${kind}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const rawTargets: TestTarget[] = ranked.map(({ t, kind }, i) => ({
    target: `${t.capability.verb}:${entityName(t.capability.entity)}`,
    action: 'observe' as const,
    order: i,                              // RANK, not the derivation counter
    entity: entityName(t.capability.entity),
    scope: t.capability.scope,
    kind,
    why: (t.why as unknown as string),     // Evidence — deliberately dropped by toPromptSurface
  }));
  const promptSurface = toPromptSurface(rawTargets);

  return { baseUrl: map.baseUrl, sourceMapCrawledAt, derivedAt: now, entity, capability, effect, code, codeReconciled, promptSurface };
}

/**
 * prioritizeAttacks — reorder deterministic attack steps by comprehension RANK, WITHIN phase groups (firewall §1:
 * "interpretation MAY inform WHAT to test and in what ORDER"). This is the ONLY thing the world-model does to break-it:
 * it reads ADDRESSING (the ranked target list) and reshuffles order; it NEVER touches a step's oracle/verdict fields
 * (acceptIsDefect/expectBroke), so a wrong comprehension guess costs at most a mis-ordered test, never a false bug.
 *
 * WHY only order (honest ceiling): nothing caps break-it's executed step count, so every attack runs regardless — this
 * matters ONLY when a run hits its RUN_CAP_MS deadline mid-sweep, where the high-value attacks having run first is the
 * difference between a useful partial and a useless one. Phase grouping (happy→crud→adversarial→api) is PRESERVED — an
 * adversarial step never jumps ahead of the happy baseline; reordering happens strictly inside each phase.
 *
 * @param steps      attack steps, each exposing a `phase` and one or more field labels (via getLabels)
 * @param surface    the ranked promptSurface (lower `order` = higher priority)
 * @param getLabels  extract the field labels a step touches (matched against target/entity names)
 * @param getPhase   extract the step's phase (grouping key preserved across the sort)
 */
export function prioritizeAttacks<S>(
  steps: S[],
  surface: Array<{ order: number; target: string; entity?: string }>,
  getLabels: (s: S) => string[],
  getPhase: (s: S) => string,
): S[] {
  if (!steps.length || !surface.length) return steps;
  // build a rank lookup: a normalized token (from target/entity) → its best (lowest) rank.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const rankOf = new Map<string, number>();
  for (const t of surface) {
    for (const tok of [t.entity || '', t.target.split(':').pop() || '', t.target].map(norm).filter(Boolean)) {
      const r = rankOf.get(tok); if (r === undefined || t.order < r) rankOf.set(tok, t.order);
    }
  }
  // a step's rank = the best rank of any target token that appears in any of its field labels (Infinity = unranked).
  const stepRank = (s: S): number => {
    let best = Infinity;
    for (const lbl of getLabels(s)) { const nl = norm(lbl); for (const [tok, r] of rankOf) { if (r < best && (nl.includes(tok) || tok.includes(nl))) best = r; } }
    return best;
  };
  // PHASE ORDER preserved: bucket by first-seen phase order, stable-sort within each bucket by comprehension rank.
  const phaseOrder: string[] = []; const buckets = new Map<string, Array<{ s: S; i: number; r: number }>>();
  steps.forEach((s, i) => { const p = getPhase(s); if (!buckets.has(p)) { buckets.set(p, []); phaseOrder.push(p); } buckets.get(p)!.push({ s, i, r: stepRank(s) }); });
  const out: S[] = [];
  for (const p of phaseOrder) {
    const b = buckets.get(p)!;
    b.sort((a, z) => a.r - z.r || a.i - z.i);   // rank asc; ties keep original order (stable)
    for (const { s } of b) out.push(s);
  }
  return out;
}

export type { EntityModel, CapabilityModel, EffectGraph, CodeModel };
