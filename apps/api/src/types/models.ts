/**
 * Core data models mirroring frontend contracts
 */

// Project
export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  // SECURITY-AUDIT CONSENT (the authorization gate). The exploit tiers fire real attacks, so they only unlock
  // when the user explicitly attests they OWN / are authorized to test this target. Per-project, user-set.
  security?: {
    authorized: boolean;       // "I own or am authorized to test this target" — user attestation
    authorizedAt?: string;
    allowDestructive?: boolean; // NOTE: destructive tier ALSO needs a per-RUN ack; this is the standing opt-in
  };
  // MULTI-ROLE (item 4): a credential set per role. Credentials (_email/_password) are IN-MEMORY ONLY and
  // stripped before persist — only id/name/hasCredentials survive to db.json.
  roles?: Array<{ id: string; name: string; hasCredentials?: boolean; _email?: string; _password?: string }>;
}

// Discovery Run
export type DiscoveryRunStatus = 'queued' | 'running' | 'finished' | 'failed';
export type DiscoveryRunMode = 'iframe' | 'screenshot_stream';

export interface DiscoveryRun {
  id: string;
  projectId: string;
  status: DiscoveryRunStatus;
  startedAt: string;
  finishedAt?: string;
  progressPct: number;
  mode: DiscoveryRunMode;
  nodesCount?: number;
  edgesCount?: number;
}

// State Node
export interface StateNode {
  id: string;
  projectId: string;
  runId: string;
  url: string;
  title?: string;
  fingerprint: string;
  label?: string;
  tags: string[];
  screenshotKey?: string;
  // Debug info
  normalizedUrl?: string;
  h1?: string;
  navLabels?: string[];
  ctas?: string[];
}

// Transition Action
export type TransitionActionType = 'click' | 'fill' | 'navigate';

export interface TransitionAction {
  type: TransitionActionType;
  selector?: string;
  label?: string;
  value?: string;
}

// Click Context
export interface ClickContext {
  scope: 'page' | 'nav' | 'dialog' | 'main' | 'unknown';
  scopeSelector?: string;
  elementText?: string;
  ariaLabel?: string;
  role?: string;
  testId?: string;
  href?: string;
}

// Transition Edge
export interface TransitionEdge {
  id: string;
  projectId: string;
  runId: string;
  fromStateId: string;
  toStateId: string;
  action: TransitionAction;
  confidence: number;
  selectorBundle?: any;
  clickContext?: ClickContext;
  preClickUrl?: string;
  postClickUrl?: string;
  fromFingerprint?: string;
  toFingerprint?: string;
  observedFromFingerprint?: string;
  observedToFingerprint?: string;
  tags?: string[];
  createdAt: string;
}

// Network Call
export interface NetworkCall {
  id: string;
  runId: string;
  stateId: string;
  method: string;
  url: string;
  statusCode?: number;
  timestamp: string;
}

// Console Event
export type ConsoleEventLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export interface ConsoleEvent {
  id: string;
  runId: string;
  stateId: string;
  level: ConsoleEventLevel;
  message: string;
  timestamp: string;
}

// Test Case
export type TestCaseKind = 'smoke' | 'regression';

export interface TestCase {
  id: string;
  projectId: string;
  name: string;
  edgePath: string[];
  kind: TestCaseKind;
}

// Test Run
export type TestRunStatus = 'running' | 'passed' | 'failed';

export interface StepAttempt {
  kind: string;
  selector: string;
  matched: number;
  chosenIndex?: number;
  error?: string;
}

export interface StepResult {
  stepIndex: number;
  edgeId?: string;
  status: 'pass' | 'fail';
  attempts: StepAttempt[];
  note?: string;
  screenshotKey?: string;
}

export interface TestRun {
  id: string;
  projectId: string;
  suiteId?: string;
  status: TestRunStatus;
  startedAt: string;
  finishedAt?: string;
  progressPct?: number;
  summary?: string;
  errorSummary?: string;
  artifacts: RunArtifact[];
  failedStepIndex?: number;
  stepResults?: StepResult[];
}

// Run Artifact
export type RunArtifactKind = 'screenshot' | 'trace' | 'har' | 'log';

export interface RunArtifact {
  key: string;
  kind: RunArtifactKind;
  url: string;
}

// Graph Response
export interface GraphResponse {
  nodes: StateNode[];
  edges: TransitionEdge[];
}

// WebSocket Events
export interface ProgressEvent {
  type: 'progress';
  progressPct: number;
}

export interface GraphAddEvent {
  type: 'graph:add';
  nodes?: StateNode[];
  edges?: TransitionEdge[];
}

export interface StatusEvent {
  type: 'status';
  status: DiscoveryRunStatus;
}

export type RunEvent = ProgressEvent | GraphAddEvent | StatusEvent;
