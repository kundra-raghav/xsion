/**
 * projectKnowledge.ts — the PROJECT LEARNING STORE (the "get smarter every run" feature), NAVIGATIONAL half only.
 *
 * Every bug-repro / break-it / flow run teaches Xsion how to GET AROUND this app: "there's a portal gate at /Teacher",
 * "'Demo School' is a clickable row → /demo/Teacher/Dashboard", "the login email field is input#email", "the Planning
 * tab lives inside the Create Event wizard". Future runs feed this into SoA's surface so they start where the last run
 * ended instead of re-discovering the app cold. This is what would have saved most of the schooltalk re-runs.
 *
 * ★ THE SAFETY LINE (the user's exact worry): this store holds STRUCTURE/NAVIGATION, never ORACLE truth. It must NEVER
 * learn "empty title is accepted → fine" or "date reverting → expected", because one wrong verdict fed back becomes
 * tomorrow's ground truth and inverts a REAL bug into "correct behaviour". So:
 *   • entries are FACTS ABOUT REACHING THINGS (gates, routes, working selectors, load quirks) — never held/broke/repro.
 *   • PROVENANCE on every entry: 'observed' (a run saw it) vs 'human-confirmed'. Verdict logic may read navigational
 *     facts freely, but ORACLE decisions are NEVER sourced from here (oracle knowledge, if ever added, is a SEPARATE
 *     store writable ONLY by a human answering acceptIsDefect — not built here, by design).
 *   • DEMOTE-ON-CONTRADICTION: a fact that fails (selector no longer resolves, route 404s) loses confidence rather
 *     than being trusted harder; enough failures expire it. Self-correcting, so stale structure can't mislead forever.
 */

// environment-state = a PERISHABLE OBSERVATION about what's present on a reached page (e.g. "this calendar day-window
// has no events"). It is STRUCTURE/CONTENT, not oracle truth — it says WHAT IS ON THE PAGE, never whether the app is
// CORRECT. Safety rule (advisor): it may INFORM + EXPLAIN + order what to check first, but must NEVER let a run skip
// the live observation. Every run still snapshots; a contradicting snapshot invalidates the fact via recordContradiction.
export type KnowledgeKind = 'gate' | 'route' | 'selector' | 'load-quirk' | 'nav-hint' | 'environment-state';
export type Provenance = 'observed' | 'human-confirmed';

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  key: string;            // stable identity for dedup/update, e.g. 'gate:/Teacher' or 'selector:login-email'
  fact: string;           // human-readable navigational fact ("clicking 'Demo School' → /demo/Teacher/Dashboard")
  provenance: Provenance;
  hits: number;           // times a run relied on / re-observed this and it held
  misses: number;         // times it FAILED (selector didn't resolve, route changed) → demotes confidence
  firstSeen: string;
  lastSeen: string;
}

/** confidence 0..1 from hits/misses — demote-on-contradiction: misses pull it down, they don't harden it. */
export function confidence(e: { hits: number; misses: number; provenance: Provenance }): number {
  if (e.provenance === 'human-confirmed') return 1;
  const total = e.hits + e.misses;
  if (total === 0) return 0.2;
  return Math.max(0, e.hits / total - (e.misses > 0 ? 0.1 : 0));   // any miss carries a small penalty
}

/** should this fact still be trusted / surfaced? Expire when misses dominate (structure genuinely changed). */
export function isLive(e: KnowledgeEntry): boolean {
  if (e.provenance === 'human-confirmed') return true;
  if (e.misses >= 3 && e.misses > e.hits) return false;   // 3+ contradictions and mostly-wrong → drop it
  return confidence(e) >= 0.25;
}

/** Merge a fresh observation into the entry list (dedup by key; bump hits or record a NEW fact). Pure — the store
 * boundary calls this and persists the result. `now` passed in (no Date.now() in pure logic / deterministic tests). */
export function recordObservation(
  entries: KnowledgeEntry[],
  obs: { kind: KnowledgeKind; key: string; fact: string; provenance?: Provenance },
  now: string,
): KnowledgeEntry[] {
  const out = entries.map((e) => ({ ...e }));
  const at = out.findIndex((e) => e.key === obs.key);
  if (at === -1) {
    out.push({ kind: obs.kind, key: obs.key, fact: obs.fact, provenance: obs.provenance || 'observed', hits: 1, misses: 0, firstSeen: now, lastSeen: now });
  } else {
    const e = out[at];
    e.hits += 1; e.lastSeen = now; e.fact = obs.fact;   // refresh the fact text (selectors/routes can drift)
    if (obs.provenance === 'human-confirmed') e.provenance = 'human-confirmed';   // upgrade never downgrades
  }
  return out;
}

/** Record that a fact FAILED (selector didn't resolve this run, route 404'd) → demote, don't delete. */
export function recordContradiction(entries: KnowledgeEntry[], key: string, now: string): KnowledgeEntry[] {
  return entries.map((e) => (e.key === key && e.provenance !== 'human-confirmed' ? { ...e, misses: e.misses + 1, lastSeen: now } : e));
}

/** The compact, LIVE navigational hints to feed SoA's surface next run (structure only, highest-confidence first). */
export function surfaceHints(entries: KnowledgeEntry[]): Array<{ kind: KnowledgeKind; fact: string; confidence: number }> {
  return entries
    .filter(isLive)
    .map((e) => ({ kind: e.kind, fact: e.fact, confidence: Number(confidence(e).toFixed(2)) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20);   // keep the surface small — cheap to feed, prompt-budget-safe
}
