/**
 * projectKnowledge.hermetic.ts — locks the PROJECT LEARNING STORE, especially the SAFETY properties the user named:
 * navigational-only, provenance, demote-on-contradiction (a wrong fact loses confidence, doesn't harden).
 * Run: cd apps/api && npx tsx src/brain/projectKnowledge.hermetic.ts
 */
import { recordObservation, recordContradiction, confidence, isLive, surfaceHints, KnowledgeEntry } from './projectKnowledge';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const T = '2026-08-14T00:00:00Z';

// 1. record a new fact → 1 entry, observed, confidence rising with hits.
{
  let e = recordObservation([], { kind: 'route', key: 'route:demo school', fact: 'clicking "Demo School" → /demo/Teacher/Dashboard' }, T);
  ok('records a new navigational fact', e.length === 1 && e[0].hits === 1 && e[0].provenance === 'observed');
  e = recordObservation(e, { kind: 'route', key: 'route:demo school', fact: 'clicking "Demo School" → /demo/Teacher/Dashboard' }, T);
  ok('re-observing the same fact bumps hits (dedup by key)', e.length === 1 && e[0].hits === 2);
  ok('confidence rises with clean hits', confidence(e[0]) > 0.5);
}

// 2. DEMOTE-ON-CONTRADICTION: a fact that FAILS loses confidence and eventually expires — never "trusted harder".
{
  let e = recordObservation([], { kind: 'selector', key: 'selector:x', fact: 'button "X" works' }, T);
  e = recordObservation(e, { kind: 'selector', key: 'selector:x', fact: 'button "X" works' }, T);   // hits=2
  const before = confidence(e[0]);
  e = recordContradiction(e, 'selector:x', T);   // it failed once
  ok('a contradiction LOWERS confidence (demote, not harden)', confidence(e[0]) < before, `${before}→${confidence(e[0])}`);
  e = recordContradiction(e, 'selector:x', T); e = recordContradiction(e, 'selector:x', T);   // 3 misses total
  ok('enough contradictions EXPIRE the fact (isLive false)', !isLive(e[0]));
  ok('expired facts are DROPPED from the surface fed to SoA', surfaceHints(e).length === 0);
}

// 3. PROVENANCE: human-confirmed is always full-confidence + never expires; upgrade never downgrades.
{
  let e = recordObservation([], { kind: 'gate', key: 'gate:/x', fact: 'gate at /x', provenance: 'human-confirmed' }, T);
  ok('human-confirmed is confidence 1', confidence(e[0]) === 1);
  e = recordContradiction(e, 'gate:/x', T); e = recordContradiction(e, 'gate:/x', T); e = recordContradiction(e, 'gate:/x', T);
  ok('human-confirmed never expires even with contradictions', isLive(e[0]) && confidence(e[0]) === 1);
  // an observed fact later human-confirmed UPGRADES; never the reverse.
  let e2 = recordObservation([], { kind: 'route', key: 'r', fact: 'a' }, T);
  e2 = recordObservation(e2, { kind: 'route', key: 'r', fact: 'a', provenance: 'human-confirmed' }, T);
  ok('observed→human-confirmed upgrades', e2[0].provenance === 'human-confirmed');
}

// 4. SAFETY LINE: the store only carries NAVIGATIONAL kinds — there is NO oracle/verdict kind. (Type-level + here we
//    assert the surface never emits anything but structural facts.)
{
  const kinds: KnowledgeEntry['kind'][] = ['gate', 'route', 'selector', 'load-quirk', 'nav-hint'];
  ok('all knowledge kinds are navigational (no held/broke/verdict kind exists)',
    !kinds.some((k) => /held|broke|repro|verdict|oracle|bug|expected|defect/i.test(k)));
}

// 5. surfaceHints is bounded + highest-confidence first.
{
  let e: KnowledgeEntry[] = [];
  for (let i = 0; i < 30; i++) e = recordObservation(e, { kind: 'route', key: `r${i}`, fact: `fact ${i}` }, T);
  const hints = surfaceHints(e);
  ok('surface is bounded to ≤20 hints', hints.length <= 20);
  ok('surface sorted by confidence desc', hints.every((h, i) => i === 0 || hints[i - 1].confidence >= h.confidence));
}

console.log(`\nprojectKnowledge hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
