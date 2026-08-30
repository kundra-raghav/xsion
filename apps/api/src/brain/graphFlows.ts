/**
 * graphFlows.ts — A (structural understanding): derive real user FLOWS by WALKING the interaction graph, with NO LLM
 * in the path. The crawler already computed everything a flow is made of — states, edges (with verified control
 * identities), per-page requirements, and the API calls each page fired. A flow IS a navigable path through the graph
 * that ends at a state where a real MUTATION happened (or the terminal reachable state). This replaces the flaky
 * agentic LLM `map` call as the flow-FINDER; an optional bounded LLM pass only NAMES/judges what this finds.
 *
 * WHY (measured): the SoA `map` bridge call is variance-prone — sometimes returns flows, sometimes emits unparseable
 * output, sometimes hangs >150s (agentic file-reading loop). An understanding layer that flaky can't be the spine.
 * This derivation is deterministic: same graph → same flows, in milliseconds, never hangs.
 *
 * A "mutation" (the thing that makes a path a meaningful, testable flow) = an API endpoint that is a GraphQL mutation
 * OR a non-GET/HEAD HTTP method. Its operation name (gqlOperation, or METHOD url) is the CAPABILITY the flow exercises
 * — the seed of the entity/capability model.
 */
import type { GraphEdge, MappedPage, ApiEndpoint, MappedFlow } from './crawlTypes';

export interface DerivedFlowStep { intent: string; control?: string; selectorName?: string; toPath: string; }
export interface DerivedFlow {
  name: string;                 // structural, human-readable (e.g. "reach /explore › Create Meal Plan")
  scope?: string;               // tenant/school segment if the path is scoped
  steps: DerivedFlowStep[];     // the edge chain to reach the terminal state
  reachesMutation?: { capability: string; kind: string };  // the mutation the terminal page fired, if any
  requirements: Array<{ kind: string; label?: string; required?: boolean }>;  // inputs the terminal page needs
  terminalPath: string;
  confidence: 'high' | 'medium' | 'low';  // high = path ends in a real mutation; medium = data page; low = leaf nav
  source: 'structural';
}

const isMutation = (a: ApiEndpoint): boolean =>
  (a.graphql ? a.gqlKind === 'mutation' : !/^(get|head|options)$/i.test(a.method || 'get'));

const capabilityOf = (a: ApiEndpoint): string =>
  a.gqlOperation || `${(a.method || 'GET').toUpperCase()} ${a.url}`;

/** first path segment as a scope (tenant/school), if the app is partitioned that way. */
export function scopeOfPath(path: string): string | undefined {
  const m = (path || '').match(/^\/([^/]+)\//);
  const s = m?.[1];
  if (!s || /^(api|assets?|static|_next|login|auth)$/i.test(s)) return undefined;
  return s;
}

/**
 * Build the flows. Deterministic BFS/DFS over edges from the root state to each reachable state, keeping the SHORTEST
 * path to each destination (the canonical way to reach it). A destination is a FLOW if its page fired a mutation
 * (high value) or holds data/requirements (medium) — bare leaf navigations are low. Grouped/scoped by path prefix.
 */
export function deriveFlows(input: { baseUrl: string; edges: GraphEdge[]; pages: MappedPage[]; api: ApiEndpoint[] }): DerivedFlow[] {
  const { edges, pages, api } = input;
  const pageByPath = new Map<string, MappedPage>();
  for (const p of pages) pageByPath.set(p.path, p);

  // mutations grouped by the page they first fired on → "reaching this page exercises capability X"
  const mutationByPath = new Map<string, { capability: string; kind: string }>();
  for (const a of api) {
    if (!isMutation(a)) continue;
    const path = a.firstSeenOnPath;
    if (path && !mutationByPath.has(path)) mutationByPath.set(path, { capability: capabilityOf(a), kind: a.graphql ? `gql:${a.gqlKind}` : a.method });
  }

  // adjacency by fromSig → edges. The root = edges whose fromSig is empty/'' (crawl start) or the smallest in-degree.
  const bySig = new Map<string, GraphEdge[]>();
  for (const e of edges) { const k = e.fromSig || 'ROOT'; (bySig.get(k) || bySig.set(k, []).get(k)!).push(e); }

  // shortest path (by edge count) to each toSig, via BFS from ROOT. Each queue item carries its step chain.
  const roots = edges.filter((e) => !e.fromSig).map((e) => e.fromSig || 'ROOT');
  const start = roots.length ? (edges.find((e) => !e.fromSig)!.fromSig || 'ROOT') : 'ROOT';
  const seen = new Set<string>();
  const pathToSig = new Map<string, DerivedFlowStep[]>();   // toSig → steps
  const q: Array<{ sig: string; steps: DerivedFlowStep[] }> = [{ sig: start, steps: [] }];
  seen.add(start);
  while (q.length) {
    const { sig, steps } = q.shift()!;
    for (const e of (bySig.get(sig) || [])) {
      if (seen.has(e.toSig)) continue;
      const control = e.action?.label;
      const selectorName = (e.action as any)?.elementId?.name || undefined;
      const step: DerivedFlowStep = {
        intent: e.action?.kind === 'navigate' ? `go to ${e.toPath}` : `${e.action?.kind || 'click'} "${control}"`,
        control, selectorName, toPath: e.toPath,
      };
      const chain = [...steps, step];
      pathToSig.set(e.toSig, chain);
      seen.add(e.toSig);
      q.push({ sig: e.toSig, steps: chain });
    }
  }

  const flows: DerivedFlow[] = [];
  for (const [toSig, steps] of pathToSig) {
    if (!steps.length) continue;
    const terminalPath = steps[steps.length - 1].toPath;
    const page = pageByPath.get(terminalPath);
    const mut = mutationByPath.get(terminalPath);
    const reqs = (page?.requirements || []).map((r: any) => ({ kind: r.kind, label: r.label, required: r.required }));
    const scope = scopeOfPath(terminalPath);
    const confidence: DerivedFlow['confidence'] = mut ? 'high' : (reqs.length || (page?.contentVolume || 0) > 0) ? 'medium' : 'low';
    const lastControl = steps[steps.length - 1].control;
    const name = mut
      ? `${mut.capability} — via ${terminalPath}`
      : lastControl && steps[steps.length - 1].intent.startsWith('click')
        ? `reach "${lastControl}" (${terminalPath})`
        : `reach ${terminalPath}`;
    flows.push({ name, scope, steps, reachesMutation: mut, requirements: reqs, terminalPath, confidence, source: 'structural' });
  }

  // rank: mutation-flows first, then by fewest steps (canonical/shortest), cap generously.
  flows.sort((a, b) => {
    const rank = (f: DerivedFlow) => (f.confidence === 'high' ? 0 : f.confidence === 'medium' ? 1 : 2);
    return rank(a) - rank(b) || a.steps.length - b.steps.length;
  });
  return flows.slice(0, 40);
}

/** adapt DerivedFlow → the existing MappedFlow shape so engines consume it with zero changes. */
export function toMappedFlows(derived: DerivedFlow[]): MappedFlow[] {
  return derived.map((d) => ({
    id: (globalThis as any).crypto?.randomUUID?.() || `flow-${d.terminalPath}-${d.steps.length}`,
    name: d.name,
    role: 'user',
    steps: d.steps.map((s) => ({ intent: s.intent, expectedOutcome: undefined })),
    confidence: d.confidence,
    reasoning: d.reachesMutation ? `path fires ${d.reachesMutation.kind} ${d.reachesMutation.capability}` : `reaches ${d.terminalPath}`,
    description: undefined,
    breaksIf: undefined,
    businessValue: (d.confidence === 'high' ? 'important' : undefined) as any,
    source: 'structural',
    scope: d.scope,
    requirements: d.requirements,
  } as any));
}
