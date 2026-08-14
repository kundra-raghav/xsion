/**
 * Zod validators for API request/response validation
 */
import { z } from 'zod';
import type {
  Project,
  DiscoveryRun,
  TestRun,
  StateNode,
  TransitionEdge,
  TestCase,
  NetworkCall,
  ConsoleEvent,
  GraphResponse,
  RunEvent,
} from './models';

// ============================================================================
// Enums and Primitives
// ============================================================================

export const DiscoveryRunStatusSchema = z.enum(['queued', 'running', 'finished', 'failed']);
export const DiscoveryRunModeSchema = z.enum(['iframe', 'screenshot_stream']);
export const TestRunStatusSchema = z.enum(['running', 'passed', 'failed']);
export const TestCaseKindSchema = z.enum(['smoke', 'regression']);
export const TransitionActionTypeSchema = z.enum(['click', 'fill', 'navigate']);
export const RunArtifactKindSchema = z.enum(['screenshot', 'trace', 'har', 'log']);
export const ConsoleEventLevelSchema = z.enum(['log', 'warn', 'error', 'info', 'debug']);

// ============================================================================
// Core Model Schemas
// ============================================================================

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  createdAt: z.string(),
}) satisfies z.ZodType<Project>;

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
}) satisfies z.ZodType<DiscoveryRun>;

export const TransitionActionSchema = z.object({
  type: TransitionActionTypeSchema,
  selector: z.string(),
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
  createdAt: z.string(),
}) satisfies z.ZodType<TransitionEdge>;

export const StateNodeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
  fingerprint: z.string(),
  label: z.string().optional(),
  tags: z.array(z.string()),
  screenshotKey: z.string().optional(),
}) satisfies z.ZodType<StateNode>;

export const NetworkCallSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stateId: z.string(),
  method: z.string(),
  url: z.string().url(),
  statusCode: z.number().optional(),
  timestamp: z.string(),
}) satisfies z.ZodType<NetworkCall>;

export const ConsoleEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stateId: z.string(),
  level: ConsoleEventLevelSchema,
  message: z.string(),
  timestamp: z.string(),
}) satisfies z.ZodType<ConsoleEvent>;

export const TestCaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  edgePath: z.array(z.string()),
  kind: TestCaseKindSchema,
}) satisfies z.ZodType<TestCase>;

export const RunArtifactSchema = z.object({
  key: z.string(),
  kind: RunArtifactKindSchema,
  url: z.string().url(),
});

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
  progressPct: z.number().optional(),
  summary: z.string().optional(),
  errorSummary: z.string().optional(),
  artifacts: z.array(RunArtifactSchema),
  failedStepIndex: z.number().optional(),
  stepResults: z.array(StepResultSchema).optional(),
}) satisfies z.ZodType<TestRun>;

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  baseUrl: z.string().url('Base URL must be a valid URL'),
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const StartDiscoveryRequestSchema = z.object({
  mode: DiscoveryRunModeSchema,
});

export type StartDiscoveryRequest = z.infer<typeof StartDiscoveryRequestSchema>;

export const GenerateSmokeSuiteRequestSchema = z.object({
  maxDepth: z.number().int().positive().optional().default(3),
  includeCriticalOnly: z.boolean().optional().default(false),
});

export type GenerateSmokeSuiteRequest = z.infer<typeof GenerateSmokeSuiteRequestSchema>;

export const RunSmokeSuiteRequestSchema = z.object({
  suiteId: z.string().optional(),
  testCaseIds: z.array(z.string()).optional(),
});

export type RunSmokeSuiteRequest = z.infer<typeof RunSmokeSuiteRequestSchema>;

// ============================================================================
// Response Schemas
// ============================================================================

export const GraphResponseSchema = z.object({
  nodes: z.array(StateNodeSchema),
  edges: z.array(TransitionEdgeSchema),
}) satisfies z.ZodType<GraphResponse>;

// ============================================================================
// WebSocket Event Schemas
// ============================================================================

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
  status: DiscoveryRunStatusSchema,
});

export const RunEventSchema = z.discriminatedUnion('type', [
  ProgressEventSchema,
  GraphAddEventSchema,
  StatusEventSchema,
]) satisfies z.ZodType<RunEvent>;

// ============================================================================
// WebSocket Message Schemas
// ============================================================================

export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  runId: z.string(),
});

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  runId: z.string(),
});

export const WSMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
]);

export type WSMessage = z.infer<typeof WSMessageSchema>;
