/**
 * goalRunService.ts — exposes the GENERAL GOAL AGENT (runGoal) as a streamed, recorded run.
 *
 * A plain-English GOAL → runGoal drives it adaptively (LLM plans / deterministic executes / structure verifies),
 * streaming live frames (test:frame) + narration (test:think) to the UI exactly like break-it, and recording the
 * run (frames persisted → replayable). This is the general agent surfaced as a first-class run — NOT a per-task engine.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';
import { runGoalPlanned, runGoal, compileGoal } from './intentRunner';
import { observedChoices, chosenOption } from './reachState';   // extract the tenant scope from the goal text
import { makeFrameHook } from './liveFrame';
import { withDeadline } from './runtimeGuards';
import { recordObservation, surfaceHints } from './projectKnowledge';   // PROJECT LEARNING: goal runs now compound like bug-repro

function emit(runId: string, e: any) { wsServer.broadcastToRun(runId, e as any); }

export interface GoalOpts { goal: string; creds?: { email?: string; password?: string }; maxSteps?: number; }

export function startGoal(projectId: string, baseUrl: string, opts: GoalOpts): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `Goal · ${opts.goal.slice(0, 48)}` } as any);
  // 25min outer cap (the step-counter is the real bound; this is a backstop → terminal failed+reason, never a hang).
  const RUN_CAP_MS = Number(process.env.XSION_GOAL_RUN_CAP_MS) || 25 * 60_000;
  withDeadline(RUN_CAP_MS, `goal "${opts.goal.slice(0, 40)}"`, runGoalRun(runId, projectId, baseUrl, opts)).catch((e) => {
    const timedOut = /timed out|deadline/i.test(String(e?.message || e));
    const msg = timedOut ? `goal run exceeded ${Math.round(RUN_CAP_MS / 1000)}s and was stopped — a run-time limit, not a verdict.` : `goal run error: ${String(e?.message || e)}`;
    emit(runId, { type: 'test:think', message: msg });
    emit(runId, { type: 'test:phase', phase: 'done', label: timedOut ? 'Stopped (time limit)' : 'Run failed', kind: 'goal' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), artifacts: [{ kind: 'goal', goal: opts.goal, detail: msg } as any] } as any);
  });
  return runId;
}

async function runGoalRun(runId: string, projectId: string, baseUrl: string, opts: GoalOpts) {
  const project = store.getProject(projectId);
  const creds = opts.creds || (project as any)?._defaultCreds;
  emit(runId, { type: 'test:phase', phase: 'start', label: 'Understanding the goal', kind: 'goal' });
  emit(runId, { type: 'test:think', message: `Goal: ${opts.goal}` });
  emit(runId, { type: 'test:phase', phase: 'run', label: 'Working the goal step by step', kind: 'goal' });

  const frameHook = makeFrameHook(runId, emit as any);
  const marker = `XG${runId.slice(0, 6)}`;   // short + front-loaded so it survives label truncation + is uniquely findable
  const map = store.getProjectMap(projectId);
  const scope = chosenOption(opts.goal, observedChoices(map)) || undefined;   // deterministic tenant from the goal text
  if (scope) emit(runId, { type: 'test:think', message: `Target tenant from the goal: "${scope}" (deterministic).` });

  // PROJECT LEARNING (2026-08-27): goal runs now COMPOUND like bug-repro. Read what PRIOR goal/repro runs learned about
  // navigating THIS project (working login, tenant routes, gates, selectors) and (1) surface it to the user, (2) feed
  // it to the LLM gap-filler so a genuine gap re-uses a known route instead of re-guessing. NAVIGATIONAL only — never
  // an oracle verdict (projectKnowledge's firewall). Accumulate this run's learnings and persist at the end so the
  // NEXT run on this project starts smarter. This closes the gap called out in projectKnowledge.ts (goal runner was
  // the one path that emitted onLearn but never persisted → every mission re-discovered the app cold).
  let learned = store.getProjectKnowledge(projectId);
  const learnNow = () => new Date().toISOString();
  const priorHints = surfaceHints(learned);
  if (priorHints.length) emit(runId, { type: 'test:think', message: `Starting smart: ${priorHints.length} navigation fact(s) learned from prior runs on this project (e.g. ${priorHints[0].fact}). Reusing them instead of re-discovering — this is why repeat runs get faster. (Navigation only, never affects verdicts.)` });

  // ROUTING (2026-08-27): the PLANNED runner (runGoalPlanned) has deterministic producers ONLY for create-shaped
  // goals (reach/create/verify/locate). For ANY OTHER goal shape — "select an option", "change a setting and save",
  // "filter a table" — compileGoal yields just a single `llm` node, and the planned runner does ONE step then stops
  // honestly WITHOUT completing it (measured: custom-dropdown "select In Progress" clicked the trigger then stopped).
  // runGoal is the general ADAPTIVE LOOP built for exactly that: it LLM-plans each step, executes, and verifies via a
  // structural predicate (never the LLM's own "done" — audited honest: its only reached:true is a passed _final
  // predicate). Route non-create goals there so Xsion can COMPLETE arbitrary flows on any project. The proven-3/3
  // create path stays on runGoalPlanned untouched. Both share the same hooks (onLearn/onFrame/onThink) so learning +
  // live-frames + persistence apply to BOTH paths.
  const compiled = compileGoal(opts.goal, scope);
  const isCreateShaped = Object.values(compiled.nodes).some((n: any) => n.kind === 'create');
  const sharedHooks = {
    onThink: (m: string) => emit(runId, { type: 'test:think', message: m }),
    onFrame: frameHook,   // LIVE VIEW + PLAYBACK (same hook break-it uses)
    onLearn: (obs: any) => { learned = recordObservation(learned, obs, learnNow()); },   // ACCUMULATE navigational facts
  };
  const credArg = creds && creds.email && creds.password ? creds : undefined;
  emit(runId, { type: 'test:think', message: isCreateShaped ? 'Create-shaped goal → deterministic planned runner (near-zero LLM).' : 'General goal → adaptive runner (LLM plans each step, structure verifies — honest, no fake "done").' });
  const res = isCreateShaped
    ? await runGoalPlanned(opts.goal, baseUrl, sharedHooks, undefined, credArg, { maxSteps: opts.maxSteps ?? 20, marker, scope, map, priorHints: priorHints.map((h) => h.fact) })
    : await runGoal(opts.goal, baseUrl, sharedHooks, undefined, credArg, { maxSteps: opts.maxSteps ?? 16, marker });

  // PERSIST the learnings so the next run on this project starts smarter. Navigational only (the store enforces it).
  if (learned.length) {
    store.setProjectKnowledge(projectId, learned);
    const n = surfaceHints(learned).length;
    if (n) emit(runId, { type: 'test:think', message: `Learned/refreshed ${n} navigation fact(s) about this project — the next run starts smarter (known login, routes, selectors). Never affects bug verdicts, only navigation.` });
  }

  const ok = res.status === 'goal-reached';
  emit(runId, { type: 'test:think', message: ok ? `Goal reached (step ${res.reachedStep}): ${res.reason}` : `Stopped at step ${res.reachedStep}: ${res.reason} — honest stop, not a fake success.` });
  emit(runId, { type: 'test:phase', phase: 'done', label: ok ? 'Goal reached' : 'Stopped', kind: 'goal' });
  emit(runId, { type: 'test:done', passed: ok ? 1 : 0, failed: 0, skipped: ok ? 0 : 1, total: 1 });
  // persist the per-step results (selector + error per attempt) so a failure is DIAGNOSABLE from the record, not a
  // blind guess from frames (the gap that cost 3 guessing runs). Both on the artifact and the run's top-level field.
  const stepResults = (res.result?.stepResults || []).map((s: any) => ({ stepIndex: s.stepIndex, status: s.status, selector: s.attempts?.[0]?.selector, error: s.attempts?.[0]?.error, note: s.note }));
  store.updateTestRun(runId, {
    status: 'passed', finishedAt: new Date().toISOString(),
    stepResults,
    artifacts: [{ kind: 'goal', goal: opts.goal, outcome: res.status, reachedStep: res.reachedStep, reason: res.reason, memory: res.memory, stepResults, frames: frameHook.frames } as any],
  } as any);
}
