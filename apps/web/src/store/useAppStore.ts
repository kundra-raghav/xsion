import { create } from 'zustand';
import { api } from '../api/client';
import type {
  Project,
  DiscoveryRun,
  TestRun,
  StateNode,
  TransitionEdge,
  TestCase,
  RunEvent,
} from '../api/types';

interface Toast {
  message: string;
  kind: 'success' | 'error' | 'info' | 'warning';
}

interface AppState {
  // State
  projects: Project[];
  runs: {
    discovery: DiscoveryRun[];
    test: TestRun[];
  };
  graphsByRunId: Record<string, { nodes: StateNode[]; edges: TransitionEdge[] }>;
  smokeSuitesByRunId: Record<string, TestCase[]>;
  timelineByRunId: Record<string, RunEvent[]>;
  connectionStatusByRunId: Record<string, { connected: boolean; retrying: boolean }>;
  ui: {
    toast?: Toast;
  };

  // Active subscriptions
  activeSubscriptions: Map<string, () => void>;

  // Selectors
  getLatestScreenshotForRun: (runId: string) => string | null;

  // Actions - Projects
  loadProjects: () => Promise<void>;
  createProject: (name: string, baseUrl: string) => Promise<Project>;

  // Actions - Runs
  loadRuns: () => Promise<void>;
  fetchAndReplaceGraph: (runId: string) => Promise<void>;

  // Actions - Discovery
  startDiscoveryRun: (
    projectId: string,
    mode: 'iframe' | 'screenshot_stream'
  ) => Promise<DiscoveryRun>;
  subscribeRun: (runId: string) => void;
  unsubscribeRun: (runId: string) => void;

  // Actions - Nodes
  updateNodeLabel: (runId: string, nodeId: string, label: string) => void;
  toggleNodeCritical: (runId: string, nodeId: string) => void;

  // Actions - Smoke Suite
  generateSmokeSuite: (projectId: string, runId: string) => Promise<TestCase[]>;
  runSmokeSuite: (projectId: string, runId: string) => Promise<TestRun>;

  // Actions - UI
  showToast: (message: string, kind: Toast['kind']) => void;
  clearToast: () => void;

  // Internal event handlers
  handleRunEvent: (runId: string, event: RunEvent) => void;
  addTimelineEvent: (runId: string, event: RunEvent) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  projects: [],
  runs: {
    discovery: [],
    test: [],
  },
  graphsByRunId: {},
  smokeSuitesByRunId: {},
  timelineByRunId: {},
  connectionStatusByRunId: {},
  ui: {},
  activeSubscriptions: new Map(),

  // Selectors
  getLatestScreenshotForRun: (runId: string) => {
    const graph = get().graphsByRunId[runId];
    if (!graph || !graph.nodes || graph.nodes.length === 0) return null;

    const latestNode = graph.nodes[graph.nodes.length - 1];
    return latestNode.screenshotKey ? `http://localhost:4000/${latestNode.screenshotKey}` : null;
  },

  // Load projects
  loadProjects: async () => {
    try {
      const projects = await api.listProjects();
      set({ projects });
    } catch (error) {
      console.error('Failed to load projects:', error);
      get().showToast('Failed to load projects', 'error');
    }
  },

  // Create project
  createProject: async (name: string, baseUrl: string) => {
    try {
      const project = await api.createProject({ name, baseUrl });
      set((state) => ({
        projects: [project, ...state.projects],
      }));
      get().showToast('Project created successfully', 'success');
      return project;
    } catch (error) {
      console.error('Failed to create project:', error);
      get().showToast('Failed to create project', 'error');
      throw error;
    }
  },

  // Load all runs
  loadRuns: async () => {
    try {
      const [discoveryRuns, testRuns] = await Promise.all([
        api.getDiscoveryRuns(),
        api.getTestRuns(),
      ]);
      set({
        runs: {
          discovery: discoveryRuns,
          test: testRuns,
        },
      });
    } catch (error) {
      console.error('Failed to load runs:', error);
      get().showToast('Failed to load runs', 'error');
    }
  },

  // Fetch and replace graph (used for reconnection)
  fetchAndReplaceGraph: async (runId: string) => {
    try {
      const graph = await api.getGraph(runId);
      set((state) => ({
        graphsByRunId: {
          ...state.graphsByRunId,
          [runId]: graph,
        },
      }));
    } catch (error) {
      console.error('Failed to fetch graph:', error);
    }
  },

  // Start discovery run
  startDiscoveryRun: async (projectId: string, mode: 'iframe' | 'screenshot_stream') => {
    try {
      const run = await api.startDiscoveryRun(projectId, { mode });
      set((state) => ({
        runs: {
          ...state.runs,
          discovery: [run, ...state.runs.discovery],
        },
        graphsByRunId: {
          ...state.graphsByRunId,
          [run.id]: { nodes: [], edges: [] },
        },
      }));
      get().showToast('Discovery run started', 'success');
      return run;
    } catch (error) {
      console.error('Failed to start discovery run:', error);
      get().showToast('Failed to start discovery run', 'error');
      throw error;
    }
  },

  // Subscribe to run events
  subscribeRun: (runId: string) => {
    const state = get();

    // Don't subscribe if already subscribed
    if (state.activeSubscriptions.has(runId)) {
      return;
    }

    // Subscribe to events with connection state handler
    const unsubscribe = api.streamRunEvents(
      runId,
      (event) => {
        get().handleRunEvent(runId, event);
      },
      async (connected, retrying) => {
        // Update connection status
        set((state) => ({
          connectionStatusByRunId: {
            ...state.connectionStatusByRunId,
            [runId]: { connected, retrying },
          },
        }));

        // Show toast based on connection state
        if (!connected && retrying) {
          get().showToast('Connection lost, retrying...', 'warning');
        } else if (!connected && !retrying) {
          get().showToast('Connection failed. Click Reconnect to try again.', 'error');
        } else if (connected) {
          get().showToast('Connected', 'success');
          // Fetch latest graph from REST on reconnect to ensure consistency
          await get().fetchAndReplaceGraph(runId);
        }
      }
    );

    // Store unsubscribe function
    const newSubscriptions = new Map(state.activeSubscriptions);
    newSubscriptions.set(runId, unsubscribe);
    set({
      activeSubscriptions: newSubscriptions,
      connectionStatusByRunId: {
        ...state.connectionStatusByRunId,
        [runId]: { connected: true, retrying: false },
      },
    });
  },

  // Unsubscribe from run events
  unsubscribeRun: (runId: string) => {
    const state = get();
    const unsubscribe = state.activeSubscriptions.get(runId);

    if (unsubscribe) {
      unsubscribe();
      const newSubscriptions = new Map(state.activeSubscriptions);
      newSubscriptions.delete(runId);
      set({ activeSubscriptions: newSubscriptions });
    }
  },

  // Handle run events
  handleRunEvent: (runId: string, event: RunEvent) => {
    // Add to timeline
    get().addTimelineEvent(runId, event);

    if (event.type === 'progress') {
      console.log(`[Store] Progress update for ${runId}: ${event.progressPct}%`);
      // Update run progress for both discovery and test runs
      set((state) => ({
        runs: {
          ...state.runs,
          discovery: state.runs.discovery.map((run) =>
            run.id === runId ? { ...run, progressPct: event.progressPct } : run
          ),
          test: state.runs.test.map((run) =>
            run.id === runId ? { ...run, progressPct: event.progressPct } : run
          ),
        },
      }));
    } else if (event.type === 'status') {
      console.log(`[Store] Status update for ${runId}: ${event.status}`);
      // Update run status
      set((state) => {
        const discoveryRuns = state.runs.discovery.map((run) =>
          run.id === runId ? { ...run, status: event.status as any } : run
        );
        const testRuns = state.runs.test.map((run) =>
          run.id === runId ? { ...run, status: event.status as any } : run
        );
        return {
          runs: {
            ...state.runs,
            discovery: discoveryRuns,
            test: testRuns,
          },
        };
      });
    } else if (event.type === 'graph:add') {
      // Add new nodes and edges (with deduplication)
      set((state) => {
        const currentGraph = state.graphsByRunId[runId] || { nodes: [], edges: [] };
        const existingNodeIds = new Set(currentGraph.nodes.map((n) => n.id));
        const existingEdgeIds = new Set(currentGraph.edges.map((e) => e.id));

        // Filter out duplicates
        const newNodes = event.nodes
          ? event.nodes.filter((n) => !existingNodeIds.has(n.id))
          : [];
        const newEdges = event.edges
          ? event.edges.filter((e) => !existingEdgeIds.has(e.id))
          : [];

        return {
          graphsByRunId: {
            ...state.graphsByRunId,
            [runId]: {
              nodes: [...currentGraph.nodes, ...newNodes],
              edges: [...currentGraph.edges, ...newEdges],
            },
          },
        };
      });
    } else if (event.type === 'test:step') {
      // Test step started - could show progress toast if needed
      console.log(`[Store] Test step ${event.stepIndex} started for ${runId}`);
    } else if (event.type === 'test:fail') {
      // Test failed
      get().showToast(`Test failed at step ${event.stepIndex + 1}`, 'error');
    } else if (event.type === 'test:done') {
      // Test completed
      if (event.status === 'pass') {
        get().showToast('All smoke tests passed!', 'success');
      } else {
        get().showToast('Smoke test suite failed', 'error');
      }
    }
  },

  addTimelineEvent: (runId: string, event: RunEvent) => {
    set((state) => {
      const currentTimeline = state.timelineByRunId[runId] || [];
      const updatedTimeline = [...currentTimeline, event];

      // Cap at 500 events
      const cappedTimeline = updatedTimeline.slice(-500);

      return {
        timelineByRunId: {
          ...state.timelineByRunId,
          [runId]: cappedTimeline,
        },
      };
    });
  },

  // Update node label
  updateNodeLabel: (runId: string, nodeId: string, label: string) => {
    set((state) => {
      const graph = state.graphsByRunId[runId];
      if (!graph) return state;

      return {
        graphsByRunId: {
          ...state.graphsByRunId,
          [runId]: {
            ...graph,
            nodes: graph.nodes.map((node) =>
              node.id === nodeId ? { ...node, label } : node
            ),
          },
        },
      };
    });
  },

  // Toggle node critical tag
  toggleNodeCritical: (runId: string, nodeId: string) => {
    set((state) => {
      const graph = state.graphsByRunId[runId];
      if (!graph) return state;

      return {
        graphsByRunId: {
          ...state.graphsByRunId,
          [runId]: {
            ...graph,
            nodes: graph.nodes.map((node) => {
              if (node.id !== nodeId) return node;

              const hasCritical = node.tags?.includes('critical');
              const newTags = hasCritical
                ? (node.tags || []).filter((t) => t !== 'critical')
                : [...(node.tags || []), 'critical'];

              return { ...node, tags: newTags };
            }),
          },
        },
      };
    });
  },

  // Generate smoke suite
  generateSmokeSuite: async (projectId: string, runId: string) => {
    try {
      const testCases = await api.generateSmokeSuite(projectId, runId);
      set((state) => ({
        smokeSuitesByRunId: {
          ...state.smokeSuitesByRunId,
          [runId]: testCases,
        },
      }));
      get().showToast(
        `Generated ${testCases.length} smoke test${testCases.length !== 1 ? 's' : ''}`,
        'success'
      );
      return testCases;
    } catch (error) {
      console.error('Failed to generate smoke suite:', error);
      get().showToast('Failed to generate smoke suite', 'error');
      throw error;
    }
  },

  // Run smoke suite
  runSmokeSuite: async (projectId: string, runId: string) => {
    try {
      const testRun = await api.runSmokeSuite(projectId, runId);
      set((state) => ({
        runs: {
          ...state.runs,
          test: [testRun, ...state.runs.test],
        },
      }));

      // Subscribe to test run events for real-time updates
      get().subscribeRun(testRun.id);

      get().showToast('Smoke suite started', 'success');
      return testRun;
    } catch (error) {
      console.error('Failed to run smoke suite:', error);
      get().showToast('Failed to run smoke suite', 'error');
      throw error;
    }
  },

  // Show toast
  showToast: (message: string, kind: Toast['kind']) => {
    set({ ui: { toast: { message, kind } } });
    // Auto clear after 5 seconds
    setTimeout(() => {
      get().clearToast();
    }, 5000);
  },

  // Clear toast
  clearToast: () => {
    set({ ui: {} });
  },
}));
