/**
 * missionSummary.hermetic.ts — mission's result summarizer + action rollup, tested as pure functions. Mission is an
 * ORCHESTRATOR; when its summarizer drops a sub-engine's real verdicts, the mission reports EMPTY even though break-it
 * / audit / env-matrix produced real findings (the baseline sweep: mission items=0 while its sub-engines had real=2/1/3).
 * These assertions lock the fix: held/passed count as real verdicts, every sub-engine kind is summarized (incl. flow),
 * and the action rollup surfaces the resolutions.
 */
import { summarizeArtifact, rollupActions } from './missionService';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// ── summarizeArtifact must not drop held/passed (the exact mission=empty bug) ──
{
  const art = { kind: 'break-it', findings: [{ verdict: 'held' }, { verdict: 'held' }, { verdict: 'needs-review' }, { verdict: 'needs-review' }, { verdict: 'needs-review' }, { verdict: 'needs-review' }, { verdict: 'passed' }] };
  const s = summarizeArtifact({}, art);
  ok('break-it summary MENTIONS held (not dropped)', /held/i.test(s));
  ok('break-it summary reflects the 2 held + 1 passed as real verdicts', /2|3/.test(s));
  ok('break-it summary is non-empty for a held+needs-review run', s.trim().length > 0);
}
{
  const art = { kind: 'break-it', findings: [{ verdict: 'broke' }, { verdict: 'held' }, { verdict: 'needs-review' }] };
  ok('break-it summary reports a broke', /broke/i.test(summarizeArtifact({}, art)));
}
// ── every sub-engine kind is summarized, including flow (the missing branch) ──
ok('audit kind summarized', summarizeArtifact({}, { kind: 'security-audit', findings: [{ verdict: 'vulnerable' }] }).length > 0);
ok('env-matrix kind summarized', summarizeArtifact({}, { kind: 'env-matrix', results: [{ status: 'fail' }, { status: 'pass' }] }).includes('1'));
ok('bug-repro kind summarized', summarizeArtifact({}, { kind: 'bug-repro', verdict: 'reproduced' }) === 'reproduced');
ok('FLOW kind summarized (no longer falls through to run.summary)', (() => { const s = summarizeArtifact({ summary: 'fallback' }, { kind: 'flow', stepResults: [{ status: 'pass' }, { status: 'pass' }, { status: 'fail' }] }); return s !== 'fallback' && s.trim().length > 0; })());

// ── rollupActions surfaces the resolutions from break-it findings ──
{
  const steps = [{ findings: [{ resolution: { kind: 'file-ticket' } }, { resolution: { kind: 'answer-oracle' } }, { resolution: { kind: 'none' } }, { resolution: { kind: 'file-ticket' } }] }];
  const acts = rollupActions(steps);
  ok('rollup counts file-ticket ×2', acts.some((a) => a.kind === 'file-ticket' && a.count === 2));
  ok('rollup counts answer-oracle ×1', acts.some((a) => a.kind === 'answer-oracle' && a.count === 1));
  ok('rollup drops "none" (held/passed produce no action)', !acts.some((a) => a.kind === 'none'));
}
ok('rollup handles bug-repro artifact (object, not array)', rollupActions([{ findings: { resolution: { kind: 'credentials' } } }]).some((a) => a.kind === 'credentials'));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
