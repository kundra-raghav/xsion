import { z } from 'zod';

// Project schemas
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  createdAt: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;

// Discovery Run schemas
export const DiscoveryRunStatusSchema = z.enum(['queued', 'running', 'finished', 'failed']);
export const DiscoveryRunModeSchema = z.enum(['iframe', 'screenshot_stream']);

export const DiscoveryRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: DiscoveryRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  progressPct: z.number().min(0).max(100),
  mode: DiscoveryRunModeSchema,
  nodesCount: z.number().optional(),
  edgesCount: z.number().optional(),
});

export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;
export type DiscoveryRunStatus = z.infer<typeof DiscoveryRunStatusSchema>;
export type DiscoveryRunMode = z.infer<typeof DiscoveryRunModeSchema>;

// State Node schemas
export const StateNodeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  fingerprint: z.string(),
  label: z.string().optional(),
  tags: z.array(z.string()),
  screenshotKey: z.string().optional(),
  // Debug info
  normalizedUrl: z.string().optional(),
  h1: z.string().optional(),
  navLabels: z.array(z.string()).optional(),
  ctas: z.array(z.string()).optional(),
});

export type StateNode = z.infer<typeof StateNodeSchema>;

// Transition Edge schemas
export const TransitionActionSchema = z.object({
  type: z.enum(['click', 'fill', 'navigate']),
  selector: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
});

export const ClickContextSchema = z.object({
  scope: z.enum(['page', 'nav', 'dialog', 'main', 'unknown']),
  scopeSelector: z.string().optional(),
  elementText: z.string().optional(),
  ariaLabel: z.string().optional(),
  role: z.string().optional(),
  testId: z.string().optional(),
  href: z.string().optional(),
});

export const TransitionEdgeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  fromStateId: z.string(),
  toStateId: z.string(),
  action: TransitionActionSchema,
  confidence: z.number().min(0).max(1),
  selectorBundle: z.any().optional(),
  clickContext: ClickContextSchema.optional(),
  preClickUrl: z.string().optional(),
  postClickUrl: z.string().optional(),
  fromFingerprint: z.string().optional(),
  toFingerprint: z.string().optional(),
  observedFromFingerprint: z.string().optional(),
  observedToFingerprint: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

export type ClickContext = z.infer<typeof ClickContextSchema>;
export type TransitionAction = z.infer<typeof TransitionActionSchema>;
export type TransitionEdge = z.infer<typeof TransitionEdgeSchema>;

// Run Artifact schemas
export const RunArtifactKindSchema = z.enum(['screenshot', 'trace', 'har', 'log']);

export const RunArtifactSchema = z.object({
  key: z.string(),
  kind: RunArtifactKindSchema,
  url: z.string(),
});

export type RunArtifact = z.infer<typeof RunArtifactSchema>;
export type RunArtifactKind = z.infer<typeof RunArtifactKindSchema>;

// Test Case schemas
export const TestCaseKindSchema = z.enum(['smoke', 'regression']);

export const TestCaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  edgePath: z.array(z.string()),
  kind: TestCaseKindSchema,
});

export type TestCase = z.infer<typeof TestCaseSchema>;
export type TestCaseKind = z.infer<typeof TestCaseKindSchema>;

// Test Run schemas
export const TestRunStatusSchema = z.enum(['running', 'passed', 'failed']);

export const StepAttemptSchema = z.object({
  kind: z.string(),
  selector: z.string(),
  matched: z.number(),
  chosenIndex: z.number().optional(),
  error: z.string().optional(),
});

export const StepResultSchema = z.object({
  stepIndex: z.number(),
  edgeId: z.string().optional(),
  status: z.enum(['pass', 'fail']),
  attempts: z.array(StepAttemptSchema),
  note: z.string().optional(),
  screenshotKey: z.string().optional(),
});

export const TestRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  suiteId: z.string().optional(),
  status: TestRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  progressPct: z.number().min(0).max(100).optional(),
  summary: z.string().optional(),
  errorSummary: z.string().optional(),
  artifacts: z.array(RunArtifactSchema),
  failedStepIndex: z.number().optional(),
  stepResults: z.array(StepResultSchema).optional(),
});

export type StepAttempt = z.infer<typeof StepAttemptSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type TestRun = z.infer<typeof TestRunSchema>;
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

// Event schemas for streaming
export const ProgressEventSchema = z.object({
  type: z.literal('progress'),
  progressPct: z.number().min(0).max(100),
});

export const GraphAddEventSchema = z.object({
  type: z.literal('graph:add'),
  nodes: z.array(StateNodeSchema).optional(),
  edges: z.array(TransitionEdgeSchema).optional(),
});

export const StatusEventSchema = z.object({
  type: z.literal('status'),
  status: z.union([DiscoveryRunStatusSchema, TestRunStatusSchema]),
});

export const LogEventSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  ts: z.string(),
});

export const StepStartEventSchema = z.object({
  type: z.literal('step:start'),
  stepIndex: z.number(),
  state: z.object({
    url: z.string(),
    fingerprint: z.string(),
    title: z.string().optional(),
  }),
  candidatesCount: z.number(),
  ts: z.string(),
});

export const StepActionEventSchema = z.object({
  type: z.literal('step:action'),
  stepIndex: z.number(),
  action: z.object({
    type: z.string(),
    label: z.string().optional(),
    selector: z.string().optional(),
    selectorBundle: z.any().optional(),
    value: z.string().optional(),
  }),
  ts: z.string(),
});

export const StepResultEventSchema = z.object({
  type: z.literal('step:result'),
  stepIndex: z.number(),
  fromFingerprint: z.string(),
  toFingerprint: z.string(),
  url: z.string(),
  createdNewState: z.boolean(),
  ts: z.string(),
});

export const StepErrorEventSchema = z.object({
  type: z.literal('step:error'),
  stepIndex: z.number(),
  message: z.string(),
  screenshotArtifactKey: z.string().optional(),
  ts: z.string(),
});

export const DoneEventSchema = z.object({
  type: z.literal('done'),
  ts: z.string(),
});

export const TestStepEventSchema = z.object({
  type: z.literal('test:step'),
  testRunId: z.string(),
  stepIndex: z.number(),
  edgeId: z.string().optional(),
  fromLabel: z.string().optional(),
  toLabel: z.string().optional(),
  ts: z.string(),
});

export const TestFailEventSchema = z.object({
  type: z.literal('test:fail'),
  testRunId: z.string(),
  stepIndex: z.number(),
  error: z.string(),
  screenshotKey: z.string().optional(),
  ts: z.string(),
});

export const TestDoneEventSchema = z.object({
  type: z.literal('test:done'),
  testRunId: z.string(),
  status: z.enum(['pass', 'fail']),
  ts: z.string(),
});

export const RunEventSchema = z.union([
  ProgressEventSchema,
  GraphAddEventSchema,
  StatusEventSchema,
  LogEventSchema,
  StepStartEventSchema,
  StepActionEventSchema,
  StepResultEventSchema,
  StepErrorEventSchema,
  TestStepEventSchema,
  TestFailEventSchema,
  TestDoneEventSchema,
  DoneEventSchema,
]);

export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
export type GraphAddEvent = z.infer<typeof GraphAddEventSchema>;
export type StatusEvent = z.infer<typeof StatusEventSchema>;
export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartEvent = z.infer<typeof StepStartEventSchema>;
export type StepActionEvent = z.infer<typeof StepActionEventSchema>;
export type StepResultEvent = z.infer<typeof StepResultEventSchema>;
export type StepErrorEvent = z.infer<typeof StepErrorEventSchema>;
export type TestStepEvent = z.infer<typeof TestStepEventSchema>;
export type TestFailEvent = z.infer<typeof TestFailEventSchema>;
export type TestDoneEvent = z.infer<typeof TestDoneEventSchema>;
export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;

// API response types
export interface GraphResponse {
  nodes: StateNode[];
  edges: TransitionEdge[];
}

export interface CreateProjectRequest {
  name: string;
  baseUrl: string;
}

export interface StartDiscoveryRunRequest {
  mode: DiscoveryRunMode;
}
