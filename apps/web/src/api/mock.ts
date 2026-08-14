import type {
  Project,
  DiscoveryRun,
  StateNode,
  TransitionEdge,
  TestCase,
  TestRun,
  RunEvent,
  GraphResponse,
  CreateProjectRequest,
  StartDiscoveryRunRequest,
} from './types';
import type { ApiClient } from './client';

// In-memory storage
const projects: Project[] = [
  {
    id: 'proj-1',
    name: 'E-commerce Site',
    baseUrl: 'https://example-shop.com',
    createdAt: '2025-01-15T10:00:00Z',
  },
  {
    id: 'proj-2',
    name: 'Marketing Landing Page',
    baseUrl: 'https://marketing.example.com',
    createdAt: '2025-01-20T14:00:00Z',
  },
  {
    id: 'proj-3',
    name: 'Customer Portal',
    baseUrl: 'https://portal.example.com',
    createdAt: '2025-01-10T09:00:00Z',
  },
];

const discoveryRuns: DiscoveryRun[] = [
  {
    id: 'run-1',
    projectId: 'proj-1',
    status: 'finished',
    startedAt: '2025-01-29T08:30:00Z',
    finishedAt: '2025-01-29T08:45:00Z',
    progressPct: 100,
    mode: 'iframe',
  },
  {
    id: 'run-2',
    projectId: 'proj-1',
    status: 'running',
    startedAt: '2025-01-29T13:00:00Z',
    progressPct: 45,
    mode: 'screenshot_stream',
  },
  {
    id: 'run-3',
    projectId: 'proj-2',
    status: 'finished',
    startedAt: '2025-01-28T16:45:00Z',
    finishedAt: '2025-01-28T16:52:00Z',
    progressPct: 100,
    mode: 'iframe',
  },
];

const stateNodes: StateNode[] = [
  {
    id: 'state-1',
    projectId: 'proj-1',
    runId: 'run-1',
    url: 'https://example-shop.com',
    title: 'Home',
    fingerprint: 'fp-home-1',
    label: 'Home Page',
    tags: ['entry'],
    screenshotKey: 'screenshots/run-1/state-1.png',
  },
  {
    id: 'state-2',
    projectId: 'proj-1',
    runId: 'run-1',
    url: 'https://example-shop.com/products',
    title: 'Products',
    fingerprint: 'fp-products-1',
    label: 'Product Listing',
    tags: ['products'],
    screenshotKey: 'screenshots/run-1/state-2.png',
  },
  {
    id: 'state-3',
    projectId: 'proj-1',
    runId: 'run-1',
    url: 'https://example-shop.com/cart',
    title: 'Shopping Cart',
    fingerprint: 'fp-cart-1',
    label: 'Cart',
    tags: ['cart', 'checkout'],
    screenshotKey: 'screenshots/run-1/state-3.png',
  },
  {
    id: 'state-4',
    projectId: 'proj-1',
    runId: 'run-1',
    url: 'https://example-shop.com/checkout',
    title: 'Checkout',
    fingerprint: 'fp-checkout-1',
    label: 'Checkout Page',
    tags: ['checkout'],
    screenshotKey: 'screenshots/run-1/state-4.png',
  },
  {
    id: 'state-5',
    projectId: 'proj-1',
    runId: 'run-1',
    url: 'https://example-shop.com/products/laptop',
    title: 'Product Detail - Laptop',
    fingerprint: 'fp-product-laptop-1',
    label: 'Laptop Product',
    tags: ['products', 'detail'],
    screenshotKey: 'screenshots/run-1/state-5.png',
  },
];

const transitionEdges: TransitionEdge[] = [
  {
    id: 'edge-1',
    projectId: 'proj-1',
    runId: 'run-1',
    fromStateId: 'state-1',
    toStateId: 'state-2',
    action: {
      type: 'click',
      selector: 'nav a[href="/products"]',
      label: 'Products Link',
    },
    confidence: 0.95,
  },
  {
    id: 'edge-2',
    projectId: 'proj-1',
    runId: 'run-1',
    fromStateId: 'state-2',
    toStateId: 'state-5',
    action: {
      type: 'click',
      selector: '.product-card[data-id="laptop"]',
      label: 'Laptop Product Card',
    },
    confidence: 0.92,
  },
  {
    id: 'edge-3',
    projectId: 'proj-1',
    runId: 'run-1',
    fromStateId: 'state-5',
    toStateId: 'state-3',
    action: {
      type: 'click',
      selector: 'button.add-to-cart',
      label: 'Add to Cart',
    },
    confidence: 0.98,
  },
  {
    id: 'edge-4',
    projectId: 'proj-1',
    runId: 'run-1',
    fromStateId: 'state-3',
    toStateId: 'state-4',
    action: {
      type: 'click',
      selector: 'button.checkout',
      label: 'Proceed to Checkout',
    },
    confidence: 0.96,
  },
  {
    id: 'edge-5',
    projectId: 'proj-1',
    runId: 'run-1',
    fromStateId: 'state-1',
    toStateId: 'state-3',
    action: {
      type: 'click',
      selector: 'nav .cart-icon',
      label: 'Cart Icon',
    },
    confidence: 0.94,
  },
];

const testCases: TestCase[] = [
  {
    id: 'test-1',
    projectId: 'proj-1',
    name: 'Home to Products Navigation',
    edgePath: ['edge-1'],
    kind: 'smoke',
  },
  {
    id: 'test-2',
    projectId: 'proj-1',
    name: 'Add Product to Cart Flow',
    edgePath: ['edge-1', 'edge-2', 'edge-3'],
    kind: 'smoke',
  },
  {
    id: 'test-3',
    projectId: 'proj-1',
    name: 'Complete Checkout Flow',
    edgePath: ['edge-1', 'edge-2', 'edge-3', 'edge-4'],
    kind: 'smoke',
  },
];

const testRuns: TestRun[] = [];

// Helper function to simulate delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Active streaming subscriptions
const activeStreams = new Map<string, { intervalId: NodeJS.Timeout; listeners: Set<(event: RunEvent) => void> }>();

// Mock API implementation
export const mockApi: ApiClient = {
  // Project operations
  async listProjects(): Promise<Project[]> {
    await delay(300);
    return [...projects];
  },

  async createProject(request: CreateProjectRequest): Promise<Project> {
    await delay(500);
    const newProject: Project = {
      id: `proj-${Date.now()}`,
      name: request.name,
      baseUrl: request.baseUrl,
      createdAt: new Date().toISOString(),
    };
    projects.push(newProject);
    return newProject;
  },

  async getProject(projectId: string): Promise<Project> {
    await delay(200);
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }
    return project;
  },

  // Discovery run operations
  async listRuns(): Promise<DiscoveryRun[]> {
    await delay(300);
    return [...discoveryRuns];
  },

  async getRun(runId: string): Promise<DiscoveryRun> {
    await delay(200);
    const run = discoveryRuns.find(r => r.id === runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return run;
  },

  async startDiscoveryRun(projectId: string, request: StartDiscoveryRunRequest): Promise<DiscoveryRun> {
    await delay(500);
    const newRun: DiscoveryRun = {
      id: `run-${Date.now()}`,
      projectId,
      status: 'queued',
      startedAt: new Date().toISOString(),
      progressPct: 0,
      mode: request.mode,
    };
    discoveryRuns.unshift(newRun);

    // Simulate run starting after a short delay
    setTimeout(() => {
      const run = discoveryRuns.find(r => r.id === newRun.id);
      if (run) {
        run.status = 'running';
      }
    }, 1000);

    return newRun;
  },

  // Real-time updates
  streamRunEvents(runId: string, onEvent: (event: RunEvent) => void): () => void {
    // Check if stream already exists
    if (!activeStreams.has(runId)) {
      const listeners = new Set<(event: RunEvent) => void>();

      let progress = 0;
      let nodeCount = 0;
      let edgeCount = 0;

      const intervalId = setInterval(() => {
        const run = discoveryRuns.find(r => r.id === runId);
        if (!run) {
          clearInterval(intervalId);
          activeStreams.delete(runId);
          return;
        }

        // Simulate progress updates
        if (run.status === 'running' && progress < 100) {
          progress += Math.floor(Math.random() * 15) + 5;
          if (progress > 100) progress = 100;

          run.progressPct = progress;

          // Send progress event
          const progressEvent: RunEvent = {
            type: 'progress',
            progressPct: progress,
          };
          listeners.forEach(listener => listener(progressEvent));

          // Simulate graph growth
          if (Math.random() > 0.5) {
            const newNodes: StateNode[] = [];
            const newEdges: TransitionEdge[] = [];

            // Add new node
            if (nodeCount < 10 && Math.random() > 0.3) {
              nodeCount++;
              const newNode: StateNode = {
                id: `state-sim-${nodeCount}`,
                projectId: run.projectId,
                runId: run.id,
                url: `${projects.find(p => p.id === run.projectId)?.baseUrl}/page-${nodeCount}`,
                title: `Page ${nodeCount}`,
                fingerprint: `fp-sim-${nodeCount}`,
                label: `Simulated Page ${nodeCount}`,
                tags: ['simulated'],
                screenshotKey: `screenshots/${run.id}/state-sim-${nodeCount}.png`,
              };
              newNodes.push(newNode);
              stateNodes.push(newNode);
            }

            // Add new edge
            if (edgeCount < 15 && nodeCount > 1 && Math.random() > 0.4) {
              edgeCount++;
              const fromIdx = Math.floor(Math.random() * nodeCount);
              const toIdx = Math.floor(Math.random() * nodeCount);
              if (fromIdx !== toIdx) {
                const newEdge: TransitionEdge = {
                  id: `edge-sim-${edgeCount}`,
                  projectId: run.projectId,
                  runId: run.id,
                  fromStateId: `state-sim-${fromIdx + 1}`,
                  toStateId: `state-sim-${toIdx + 1}`,
                  action: {
                    type: 'click',
                    selector: `.link-${edgeCount}`,
                    label: `Link ${edgeCount}`,
                  },
                  confidence: 0.7 + Math.random() * 0.3,
                };
                newEdges.push(newEdge);
                transitionEdges.push(newEdge);
              }
            }

            // Send graph add event if we have new nodes or edges
            if (newNodes.length > 0 || newEdges.length > 0) {
              const graphEvent: RunEvent = {
                type: 'graph:add',
                nodes: newNodes.length > 0 ? newNodes : undefined,
                edges: newEdges.length > 0 ? newEdges : undefined,
              };
              listeners.forEach(listener => listener(graphEvent));
            }
          }

          // Finish run when progress reaches 100
          if (progress >= 100) {
            run.status = 'finished';
            run.finishedAt = new Date().toISOString();

            const statusEvent: RunEvent = {
              type: 'status',
              status: 'finished',
            };
            listeners.forEach(listener => listener(statusEvent));

            clearInterval(intervalId);
            activeStreams.delete(runId);
          }
        }
      }, 2000); // Update every 2 seconds

      activeStreams.set(runId, { intervalId, listeners });
    }

    // Add listener to set
    const stream = activeStreams.get(runId)!;
    stream.listeners.add(onEvent);

    // Return unsubscribe function
    return () => {
      const stream = activeStreams.get(runId);
      if (stream) {
        stream.listeners.delete(onEvent);

        // If no more listeners, clean up
        if (stream.listeners.size === 0) {
          clearInterval(stream.intervalId);
          activeStreams.delete(runId);
        }
      }
    };
  },

  // Graph operations
  async getGraph(runId: string): Promise<GraphResponse> {
    await delay(400);

    const nodes = stateNodes.filter(n => n.runId === runId);
    const edges = transitionEdges.filter(e => e.runId === runId);

    return { nodes, edges };
  },

  // Test generation and execution
  async generateSmokeSuite(projectId: string, runId: string): Promise<TestCase[]> {
    await delay(800);

    // Get graph for this run
    const edges = transitionEdges.filter(e => e.runId === runId && e.projectId === projectId);

    if (edges.length === 0) {
      return [];
    }

    // Generate simple test cases from edges
    const generatedTests: TestCase[] = [];

    // Single edge tests
    edges.slice(0, 3).forEach((edge, idx) => {
      generatedTests.push({
        id: `test-gen-${Date.now()}-${idx}`,
        projectId,
        name: `Test: ${edge.action.label || edge.action.type}`,
        edgePath: [edge.id],
        kind: 'smoke',
      });
    });

    // Multi-edge path (if enough edges)
    if (edges.length >= 2) {
      generatedTests.push({
        id: `test-gen-${Date.now()}-path`,
        projectId,
        name: `Test: Multi-step flow`,
        edgePath: edges.slice(0, 3).map(e => e.id),
        kind: 'smoke',
      });
    }

    testCases.push(...generatedTests);
    return generatedTests;
  },

  async runSmokeSuite(projectId: string): Promise<TestRun> {
    await delay(1000);

    const newTestRun: TestRun = {
      id: `testrun-${Date.now()}`,
      projectId,
      status: 'running',
      startedAt: new Date().toISOString(),
      artifacts: [],
    };

    testRuns.push(newTestRun);

    // Simulate test completion
    setTimeout(() => {
      const testRun = testRuns.find(t => t.id === newTestRun.id);
      if (testRun) {
        const success = Math.random() > 0.3;
        testRun.status = success ? 'passed' : 'failed';
        testRun.finishedAt = new Date().toISOString();
        testRun.summary = success
          ? 'All tests passed successfully'
          : 'Some tests failed - see artifacts for details';

        if (!success) {
          testRun.failedStepIndex = Math.floor(Math.random() * 3);
          testRun.errorSummary = 'Element not found: button[data-action="submit"]';
        }

        testRun.artifacts = [
          {
            key: `artifacts/${testRun.id}/trace.json`,
            kind: 'trace',
            url: `/api/artifacts/${testRun.id}/trace.json`,
          },
          {
            key: `artifacts/${testRun.id}/log.txt`,
            kind: 'log',
            url: `/api/artifacts/${testRun.id}/log.txt`,
          },
        ];
      }
    }, 5000);

    return newTestRun;
  },

  // Additional methods for new store structure
  async getDiscoveryRuns(): Promise<DiscoveryRun[]> {
    await delay(300);
    return [...discoveryRuns];
  },

  async getTestRuns(): Promise<TestRun[]> {
    await delay(300);
    return [...testRuns];
  },

  async getTestRun(runId: string): Promise<TestRun> {
    await delay(300);
    const testRun = testRuns.find((r) => r.id === runId);
    if (!testRun) {
      throw new Error('Test run not found');
    }
    return testRun;
  },
};
