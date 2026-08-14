import type { StateNode, TransitionEdge } from './models';

export type RunEvent =
  | { type: 'progress'; runId: string; progressPct: number }
  | { type: 'status'; runId: string; status: string }
  | { type: 'graph:add'; runId: string; nodes?: StateNode[]; edges?: TransitionEdge[] }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string; ts: string }
  | {
      type: 'step:start';
      runId: string;
      stepIndex: number;
      state: { url: string; fingerprint: string; title?: string };
      candidatesCount: number;
      ts: string;
    }
  | {
      type: 'step:action';
      runId: string;
      stepIndex: number;
      action: {
        type: string;
        label?: string;
        selector?: string;
        selectorBundle?: any;
        value?: string;
      };
      ts: string;
    }
  | {
      type: 'step:result';
      runId: string;
      stepIndex: number;
      fromFingerprint: string;
      toFingerprint: string;
      url: string;
      createdNewState: boolean;
      ts: string;
    }
  | {
      type: 'step:error';
      runId: string;
      stepIndex: number;
      message: string;
      screenshotArtifactKey?: string;
      ts: string;
    }
  | {
      type: 'test:step';
      runId: string;
      testRunId: string;
      stepIndex: number;
      edgeId?: string;
      fromLabel?: string;
      toLabel?: string;
      ts: string;
    }
  | {
      type: 'test:fail';
      runId: string;
      testRunId: string;
      stepIndex: number;
      error: string;
      screenshotKey?: string;
      ts: string;
    }
  | {
      type: 'test:done';
      runId: string;
      testRunId: string;
      status: 'pass' | 'fail';
      ts: string;
    }
  | { type: 'done'; runId: string; ts: string };
