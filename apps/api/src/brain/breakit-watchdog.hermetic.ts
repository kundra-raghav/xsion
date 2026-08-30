/**
 * breakit-watchdog.hermetic.ts — locks the TERMINAL-STATUS WATCHDOG invariant: once a break-it run's promise settles,
 * the run is NEVER left status='running' (the honesty hole the torture suite surfaced). Pure — replicates the exact
 * `.finally()` guard logic from breakItService against a mock store, so the invariant is enforced-by-construction and
 * regression-locked without a 40-min live run. Run: cd apps/api && npx tsx src/brain/breakit-watchdog.hermetic.ts
 */
export {};   // make this a module (own scope) so pass/fail/ok don't collide with sibling hermetics under whole-program tsc
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

// a mock of the store surface the watchdog touches.
function mockStore(initial: any) {
  let run = { ...initial };
  return {
    getTestRun: (_id: string) => run,
    updateTestRun: (_id: string, u: any) => { run = { ...run, ...u }; return run; },
    peek: () => run,
  };
}

// THE WATCHDOG GUARD — copied verbatim in shape from breakItService's .finally() net, parameterised on the store.
function watchdog(store: ReturnType<typeof mockStore>, runId: string, feature: string) {
  const r = store.getTestRun(runId) as any;
  if (r && r.status === 'running') {
    store.updateTestRun(runId, {
      status: 'failed', finishedAt: '2026-08-29T00:00:00Z',
      artifacts: [...(r.artifacts || []), { kind: 'break-it', feature, findings: [], detail: 'break-it settled without writing a terminal status — forced terminal by the run watchdog (partial results preserved).', resolution: { kind: 'error' } }],
    });
  }
}

// 1. THE CORE INVARIANT: a run stuck 'running' after settle → forced terminal 'failed'.
{
  const s = mockStore({ id: 'r1', status: 'running', artifacts: [{ kind: 'break-it', findings: [{ title: 'partial1' }, { title: 'partial2' }] }] });
  watchdog(s, 'r1', 'Impersonate');
  ok('stuck-running run is forced to a terminal status', s.peek().status === 'failed');
  ok('… and never sits at running', s.peek().status !== 'running');
}

// 2. PARTIAL RESULTS PRESERVED: the watchdog APPENDS, never replaces — findings already accumulated survive.
{
  const s = mockStore({ id: 'r2', status: 'running', artifacts: [{ kind: 'break-it', findings: [{ title: 'p1' }, { title: 'p2' }] }] });
  watchdog(s, 'r2', 'Approve');
  const allFindings = s.peek().artifacts.flatMap((a: any) => a.findings || []);
  ok('the 2 partial findings survive (append, not replace)', allFindings.some((f: any) => f.title === 'p1') && allFindings.some((f: any) => f.title === 'p2'));
  ok('the watchdog note is appended as its own artifact', s.peek().artifacts.some((a: any) => /forced terminal/.test(a.detail || '')));
}

// 3. NO-OP when the run ALREADY reached terminal (the normal path wrote 'passed') — never overwrite a real verdict.
{
  const s = mockStore({ id: 'r3', status: 'passed', artifacts: [{ kind: 'break-it', findings: [{ title: 'real', verdict: 'needs-review' }] }] });
  const before = JSON.stringify(s.peek());
  watchdog(s, 'r3', 'Allocate');
  ok('a run that already reached terminal is left UNTOUCHED', JSON.stringify(s.peek()) === before);
  ok('… its real verdict is not clobbered', s.peek().status === 'passed');
}

// 4. NO-OP on 'failed' too (idempotent — a second settle can't double-write).
{
  const s = mockStore({ id: 'r4', status: 'failed', artifacts: [] });
  const before = JSON.stringify(s.peek());
  watchdog(s, 'r4', 'x');
  ok('a failed run is left untouched (idempotent)', JSON.stringify(s.peek()) === before);
}

// 5. the forced-terminal artifact carries an HONEST reason (a safeguard, NOT a verdict about the app).
{
  const s = mockStore({ id: 'r5', status: 'running', artifacts: [] });
  watchdog(s, 'r5', 'Reset database');
  const note = s.peek().artifacts.find((a: any) => /watchdog/.test(a.detail || ''));
  ok('the note says safeguard, never a bug-verdict about the app', !!note && !/broke|bug|defect|vulnerab/i.test(note.detail));
  ok('… and resolution.kind is error (a harness stop, not a finding)', note.resolution?.kind === 'error');
}

console.log(`\nbreak-it watchdog hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
