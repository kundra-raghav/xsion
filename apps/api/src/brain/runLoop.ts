/**
 * runLoop.ts — the full closed loop, runnable standalone (proves the real integration end-to-end).
 *   PLAN (SoA reads repo → flows) → EXECUTE (Playwright drives one flow live) → VERIFY (SoA triages vs code).
 * Usage: node dist/brain/runLoop.js <repo> <baseUrl> [flowIndex]
 */
import { plan, verify, IntentFlow } from './soaClient';
import { executeFlow } from './intentRunner';
import * as fs from 'fs';

async function main() {
  const [repo, baseUrl, flowIdxArg] = process.argv.slice(2);
  if (!repo || !baseUrl) {
    console.error('usage: runLoop <repo> <baseUrl> [flowIndex]   (env FLOW_FILE=path to reuse a cached plan)');
    process.exit(2);
  }
  const flowIdx = flowIdxArg ? parseInt(flowIdxArg, 10) : 0;
  const flowFile = process.env.FLOW_FILE;

  // PLAN — or reuse a cached plan (FLOW_FILE) so before/after runs use IDENTICAL steps (fixes the
  // "each run re-plans a different flow" measurement problem — comparisons were never apples-to-apples).
  let flows: IntentFlow[];
  if (flowFile && fs.existsSync(flowFile)) {
    console.log(`\n=== PLAN (cached from ${flowFile}) ===`);
    flows = JSON.parse(fs.readFileSync(flowFile, 'utf8')).flows;
  } else {
    console.log(`\n=== PLAN (SoA reads ${repo}) ===`);
    const planned = await plan(repo, baseUrl);
    if (planned.error) console.log('  plan note:', planned.error);
    flows = planned.flows;
    if (flowFile) { fs.writeFileSync(flowFile, JSON.stringify({ flows }, null, 1)); console.log(`  cached plan → ${flowFile}`); }
  }
  console.log(`  ${flows.length} flow(s):`);
  flows.forEach((f, i) => console.log(`   [${i}] ${f.name} (${f.role}) — ${f.steps.length} steps`));
  if (!flows.length) { console.error('no flows — aborting'); process.exit(1); }

  const flow = flows[Math.min(flowIdx, flows.length - 1)];
  console.log(`\n=== EXECUTE (Playwright drives "${flow.name}" against ${baseUrl}) ===`);
  const result = await executeFlow(flow, baseUrl);
  console.log(`  status: ${result.status}`);
  result.stepResults.forEach((s) =>
    console.log(`   step ${s.stepIndex}: ${s.status.toUpperCase()}  ${s.note ? '— ' + s.note.slice(0, 80) : ''}`)
  );
  if (result.consoleErrors.length) console.log(`  console errors: ${result.consoleErrors.length}`);

  console.log(`\n=== VERIFY (SoA triages the result against ${repo}) ===`);
  const verification = await verify(repo, flow, result);
  if (verification.error) console.log('  verify note:', verification.error);
  console.log(`  flowCovered: ${verification.flowCovered}`);
  verification.findings.forEach((f) =>
    console.log(`   step ${f.stepIndex}: ${f.verdict.toUpperCase()} — ${f.reasoning.slice(0, 100)}${f.codeRef ? ' [' + f.codeRef + ']' : ''}`)
  );

  console.log('\n=== LOOP COMPLETE ===');
  console.log(JSON.stringify({ flow: flow.name, exec: result.status, verification }, null, 1).slice(0, 2000));
}

main().catch((e) => { console.error('LOOP ERROR:', e.message); process.exit(1); });
