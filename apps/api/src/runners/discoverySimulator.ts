import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { wsServer } from '../ws';
import type { DiscoveryRun, StateNode, TransitionEdge } from '../types';
import { delay } from '../utils/delay';
import { createPlaceholderScreenshot } from '../utils/screenshots';

const PAGE_NAMES = [
  'Home',
  'Dashboard',
  'Settings',
  'Profile',
  'Billing',
  'Reports',
  'Analytics',
  'Users',
  'Teams',
  'Projects',
  'Notifications',
  'Security',
  'API Keys',
  'Integrations',
  'Help',
  'Documentation',
  'Account',
  'Preferences',
  'Activity Log',
  'Audit Trail',
];

const ACTION_LABELS = [
  'Login',
  'Go to Settings',
  'Save',
  'Navigate to Dashboard',
  'View Profile',
  'Edit Profile',
  'Open Billing',
  'View Reports',
  'Check Analytics',
  'Manage Users',
  'Create Team',
  'Add Project',
  'View Notifications',
  'Update Security',
  'Generate API Key',
  'Connect Integration',
  'Get Help',
  'Read Docs',
  'Update Account',
  'Change Preferences',
  'View Activity',
  'Check Audit',
];

function generatePageUrl(baseUrl: string, pageName: string): string {
  const slug = pageName.toLowerCase().replace(/\s+/g, '-');
  return `${baseUrl}/${slug}`;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomConfidence(): number {
  return 0.5 + Math.random() * 0.45; // 0.5 to 0.95
}

export async function startSimulatedDiscovery(run: DiscoveryRun): Promise<void> {
  console.log(`Starting simulated discovery for run ${run.id}, project: ${run.projectId}`);

  const project = store.getProject(run.projectId);
  if (!project) {
    console.error(`Project ${run.projectId} not found`);
    return;
  }

  // Update run status to running
  store.updateDiscoveryRun(run.id, {
    status: 'running',
    progressPct: 0,
  });

  wsServer.broadcastToRun(run.id, {
    type: 'status',
    status: 'running',
  });

  wsServer.broadcastToRun(run.id, {
    type: 'log',
    message: `Starting discovery for ${project.baseUrl}`,
    level: 'info',
  });

  try {
    // Create root node (Home page)
    const rootScreenshot = await createPlaceholderScreenshot(run.id, 0, 'Home', project.baseUrl);
    const rootNode: StateNode = {
      id: uuidv4(),
      projectId: run.projectId,
      runId: run.id,
      url: project.baseUrl,
      title: 'Home',
      fingerprint: `fp-home-${Date.now()}`,
      label: 'Home',
      tags: ['critical', 'entry-point'],
      screenshotKey: rootScreenshot.key,
    };

    store.addNodes(run.id, [rootNode]);

    wsServer.broadcastToRun(run.id, {
      type: 'graph:add',
      nodes: [rootNode],
    });

    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: 'Discovered root page',
      level: 'info',
    });

    // Simulate discovery process
    const totalDuration = randomInt(20000, 40000); // 20-40 seconds
    const stepCount = randomInt(8, 15);
    const stepDuration = totalDuration / stepCount;

    const availablePages = [...PAGE_NAMES];
    const discoveredNodes: StateNode[] = [rootNode];

    for (let step = 0; step < stepCount; step++) {
      await delay(stepDuration);

      // Generate 1-3 new nodes
      const nodeCount = randomInt(1, 3);
      const newNodes: StateNode[] = [];

      for (let i = 0; i < nodeCount && availablePages.length > 0; i++) {
        const pageIndex = randomInt(0, availablePages.length - 1);
        const pageName = availablePages.splice(pageIndex, 1)[0];

        const screenshot = await createPlaceholderScreenshot(
          run.id,
          discoveredNodes.length + i,
          pageName,
          generatePageUrl(project.baseUrl, pageName)
        );
        const node: StateNode = {
          id: uuidv4(),
          projectId: run.projectId,
          runId: run.id,
          url: generatePageUrl(project.baseUrl, pageName),
          title: pageName,
          fingerprint: `fp-${pageName.toLowerCase()}-${Date.now()}`,
          label: pageName,
          tags: pageName === 'Settings' || pageName === 'Dashboard' ? ['critical'] : [],
          screenshotKey: screenshot.key,
        };

        newNodes.push(node);
        discoveredNodes.push(node);
      }

      if (newNodes.length > 0) {
        store.addNodes(run.id, newNodes);
      }

      // Generate 1-4 edges connecting to new nodes
      const edgeCount = randomInt(1, Math.min(4, newNodes.length + 1));
      const newEdges: TransitionEdge[] = [];

      for (let i = 0; i < edgeCount && discoveredNodes.length >= 2; i++) {
        // Pick a random source node (prefer recent nodes)
        const fromIndex = Math.max(0, discoveredNodes.length - randomInt(2, 5));
        const fromNode = discoveredNodes[fromIndex];

        // Pick a target from new nodes or recent nodes
        let toNode: StateNode;
        if (newNodes.length > 0 && Math.random() > 0.3) {
          toNode = newNodes[randomInt(0, newNodes.length - 1)];
        } else {
          const toIndex = Math.max(0, discoveredNodes.length - randomInt(1, 3));
          toNode = discoveredNodes[toIndex];
        }

        // Don't create self-loops
        if (fromNode.id === toNode.id) continue;

        const actionLabel = ACTION_LABELS[randomInt(0, ACTION_LABELS.length - 1)];

        const edge: TransitionEdge = {
          id: uuidv4(),
          projectId: run.projectId,
          runId: run.id,
          fromStateId: fromNode.id,
          toStateId: toNode.id,
          action: {
            type: Math.random() > 0.7 ? 'click' : 'navigate',
            selector: `a[href="${toNode.url}"]`,
            label: actionLabel,
          },
          confidence: randomConfidence(),
          createdAt: new Date().toISOString(),
        };

        newEdges.push(edge);
      }

      if (newEdges.length > 0) {
        store.addEdges(run.id, newEdges);
      }

      // Broadcast graph updates
      if (newNodes.length > 0 || newEdges.length > 0) {
        wsServer.broadcastToRun(run.id, {
          type: 'graph:add',
          nodes: newNodes.length > 0 ? newNodes : undefined,
          edges: newEdges.length > 0 ? newEdges : undefined,
        });

        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: `Discovered ${newNodes.length} pages and ${newEdges.length} transitions`,
          level: 'info',
        });
      }

      // Update progress
      const progressPct = Math.min(99, Math.round(((step + 1) / stepCount) * 100));
      const currentGraph = store.getGraph(run.id);
      store.updateDiscoveryRun(run.id, {
        progressPct,
        nodesCount: currentGraph.nodes.length,
        edgesCount: currentGraph.edges.length,
      });

      wsServer.broadcastToRun(run.id, {
        type: 'progress',
        progressPct,
      });
    }

    // Mark as finished
    const finalGraph = store.getGraph(run.id);
    store.updateDiscoveryRun(run.id, {
      status: 'finished',
      finishedAt: new Date().toISOString(),
      progressPct: 100,
      nodesCount: finalGraph.nodes.length,
      edgesCount: finalGraph.edges.length,
    });

    wsServer.broadcastToRun(run.id, {
      type: 'progress',
      progressPct: 100,
    });

    wsServer.broadcastToRun(run.id, {
      type: 'status',
      status: 'finished',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: `Discovery completed: ${finalGraph.nodes.length} pages, ${finalGraph.edges.length} transitions`,
      level: 'info',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'done',
    });

    console.log(`Discovery completed for run ${run.id}: ${finalGraph.nodes.length} nodes, ${finalGraph.edges.length} edges`);
  } catch (error) {
    console.error(`Discovery failed for run ${run.id}:`, error);
    store.updateDiscoveryRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
    });

    wsServer.broadcastToRun(run.id, {
      type: 'status',
      status: 'failed',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: `Discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      level: 'error',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'done',
    });
  }
}
