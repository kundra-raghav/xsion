/**
 * comprehension/codeDerived.ts — FACET 4: code-derived comprehension + the provenance-ladder RECONCILER (design §2.4).
 *
 * THE ORDER THAT MUST NOT INVERT (Attack1 #6 — the design's draft was inverted, this is the correction): CODE IS A
 * PRIOR, NOT A RANK ABOVE OBSERVATION. A claim parsed from source but never seen live is `code-unwitnessed`, ceiling
 * ≤0.4 — BELOW a single live observation. It rises above observed ONLY when an observation AGREES (→ code-and-observed,
 * the real top rung below human). WHY: dead code's path is never exercised, so a contradiction can NEVER fire on it —
 * ranking unwitnessed code above observation would make confidence structurally inverted (a wrong claim that can only
 * ever rise). On DISAGREEMENT, OBSERVED WINS, the code claim is DEMOTED, and the divergence exits as a human-facing
 * observation ("code says X / app did Y") — NEVER as a verdict. That is the firewall: code informs; runtime decides.
 *
 * OPEN-WORLD: a source enum is NEVER proof the runtime set is closed (a value can be added at runtime, or the enum
 * can be dead). Every CodeDerivedSet is open-world; hits dedup by file+symbol+contentHash (re-parsing one file is ONE
 * hit ever). The parser is best-effort (regex fallback for single-file inline JS); ALL code fields are optional so the
 * same model SHAPE stands at `observed` confidence from crawl facts alone in blackbox mode.
 */
import { claim, reinforce, contradict, openWorldSet } from './substrate';
import type { Claim, OpenWorldSet, Provenance } from './substrate';

// ── code-derived artifacts (best-effort parse) ───────────────────────────────────────────────────────────────────
export interface CodeDerivedSet extends OpenWorldSet { evidenceIds: string[]; }
/** a state enum found in source: entity (best-effort) → the value set. open-world. */
export interface CodeStateEnum { entity: string; symbol: string; values: CodeDerivedSet; claim: Claim; }
/** a role guard found in source (role===, hasRole, requireRole). names a role + a guarded thing. */
export interface CodeRoleGuard { role: string; guardedSymbol: string; claim: Claim; }
/** a handler→entity write inferred from a mutation function touching an entity store. */
export interface CodeWrite { handler: string; entity: string; claim: Claim; }
export interface CodeModel {
  parsed: boolean;
  parseMode: 'inline-js' | 'framework' | 'none';
  stateEnums: CodeStateEnum[];
  roleGuards: CodeRoleGuard[];
  writes: CodeWrite[];
  whyEmpty?: string;
}

// ── divergence surfacing (human-facing observation, NEVER a verdict) ──────────────────────────────────────────────
export interface CodeVsRuntimeDivergence {
  entity: string; symbol: string;
  codeValues: string[];        // WHAT code said
  runtimeValue: string;        // WHAT the app did (the value not in the code enum)
  note: 'code-vs-runtime-divergence — code says X / app did Y; observation wins, code claim demoted';
}

// ── the reconciler output: code claims merged with an observed model ──────────────────────────────────────────────
export interface ReconciledStateEnum {
  entity: string; symbol: string;
  values: OpenWorldSet;        // open-world union (runtime may exceed code)
  claim: Claim;                // provenance reflects the merge (code-and-observed on agreement; observed on divergence)
}
export interface ReconcileResult {
  enums: ReconciledStateEnum[];
  divergences: CodeVsRuntimeDivergence[];   // exits as observations, never verdicts
}

// ── parser (best-effort; regex fallback for single-file inline JS) ───────────────────────────────────────────────
const STATE_ENUM_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/g;   // FOO = ['a','b']
const STRING_LIT_RE = /['"`]([^'"`]+)['"`]/g;
const ROLE_GUARD_RE = /(?:role\s*===?\s*|hasRole\(\s*|requireRole\(\s*|user\.role\s*===?\s*)['"`]([a-z_]+)['"`]/gi;
const looksStateEnumName = (n: string) => /(status|state|stage|phase|step|kind|type)(es|s)?$/i.test(n) || /^[A-Z_]+_(STATUS|STATES|STATUSES)$/.test(n);

/** Hash a string cheaply + deterministically (no Date/Math.random — those throw in this environment anyway). */
const cheapHash = (s: string): string => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/** Parse a single source blob (or the inline <script> of an HTML file). Best-effort; returns whatever it can. */
export function parseCode(source: string | undefined, opts: { file?: string } = {}): CodeModel {
  if (!source || !source.trim()) return { parsed: false, parseMode: 'none', stateEnums: [], roleGuards: [], writes: [], whyEmpty: 'no source provided — blackbox mode (model shape stands at observed confidence from crawl facts).' };
  const file = opts.file || 'source';
  const stateEnums: CodeStateEnum[] = [];
  const roleGuards: CodeRoleGuard[] = [];
  const writes: CodeWrite[] = [];

  // state enums: `const ORDER_STATUS = ['draft','approved',...]`
  for (const m of source.matchAll(STATE_ENUM_RE)) {
    const symbol = m[1];
    if (!looksStateEnumName(symbol)) continue;
    const values = [...m[2].matchAll(STRING_LIT_RE)].map((x) => x[1]).filter(Boolean);
    if (values.length < 2) continue;   // a 1-element "enum" is not a state machine signal
    const entity = symbol.toLowerCase().replace(/_?(status|statuses|states|state|kinds?|types?)$/i, '').replace(/_/g, '') || 'unknown';
    const contentHash = cheapHash(values.join(','));
    const evId = `${file}#${symbol}#${contentHash}`;
    stateEnums.push({
      entity, symbol,
      values: { ...openWorldSet(values), evidenceIds: [evId] },
      // code-unwitnessed: parsed, not yet seen live → ceiling ≤0.4 (a PRIOR, below one observation).
      claim: claim('code-unwitnessed', evId, `enum ${symbol}=[${values.join(',')}] in ${file} (open-world; runtime may exceed)`, undefined),
    });
  }
  // role guards: `role === 'admin'`, `hasRole('editor')`
  const seenGuards = new Set<string>();
  for (const m of source.matchAll(ROLE_GUARD_RE)) {
    const role = m[1].toLowerCase();
    const key = role;
    if (seenGuards.has(key)) continue; seenGuards.add(key);
    const evId = `${file}#roleguard#${role}#${cheapHash(m[0])}`;
    roleGuards.push({ role, guardedSymbol: m[0], claim: claim('code-unwitnessed', evId, `role guard for "${role}" in ${file}`, undefined) });
  }
  const parsed = stateEnums.length + roleGuards.length + writes.length > 0;
  return { parsed, parseMode: 'inline-js', stateEnums, roleGuards, writes, whyEmpty: parsed ? undefined : 'source parsed but no state enums / role guards found (regex fallback; may be a framework app — supply parsed schema/router config).' };
}

/** THE RECONCILER. Merge code-derived enums with the OBSERVED state values per entity. This is where the ladder is
 *  enforced — via the substrate's reinforce/contradict, so the arithmetic is the SAME one proven in substrate tests.
 *
 *  @param codeEnums   code-parsed enums (code-unwitnessed priors)
 *  @param observed    map of `${entity}#${symbol}` → the state values OBSERVED live (may be empty in one-sample crawls)
 */
export function reconcile(codeEnums: CodeStateEnum[], observed: Record<string, string[]>): ReconcileResult {
  const out: ReconciledStateEnum[] = [];
  const divergences: CodeVsRuntimeDivergence[] = [];
  for (const ce of codeEnums) {
    const obsKey = `${ce.entity}#${ce.symbol}`;
    const obsValues = observed[obsKey] || observed[ce.entity] || [];
    let c = ce.claim;   // starts code-unwitnessed (≤0.4)
    const codeSet = new Set(ce.values.observed);
    if (obsValues.length) {
      // an observation exists. Does it AGREE (subset of code enum) or DIVERGE (a value not in code)?
      const novel = obsValues.filter((v) => !codeSet.has(v));
      if (novel.length === 0) {
        // AGREEMENT → upgrade toward code-and-observed (substrate handles code-unwitnessed + observed → code-and-observed).
        c = reinforce(c, { provenance: 'observed', evId: `obs#${obsKey}#${cheapHash(obsValues.join(','))}` });
      } else {
        // DIVERGENCE → OBSERVED WINS. Demote the code claim; surface a human-facing observation (never a verdict).
        c = contradict(c, `app produced state(s) [${novel.join(',')}] not in code enum ${ce.symbol}`);
        for (const v of novel) divergences.push({ entity: ce.entity, symbol: ce.symbol, codeValues: [...codeSet], runtimeValue: v, note: 'code-vs-runtime-divergence — code says X / app did Y; observation wins, code claim demoted' });
      }
    }
    // open-world UNION: runtime values may exceed the code enum; the set is never "closed" by code.
    const union = openWorldSet([...codeSet, ...obsValues]);
    out.push({ entity: ce.entity, symbol: ce.symbol, values: union, claim: c });
  }
  return { enums: out, divergences };
}
