import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { wsServer } from '../ws';
import type { Project, StateNode, TransitionEdge } from '../types';
import { delay } from '../utils/delay';

/**
 * Mock discovery runner that simulates web crawling
 * In production, this would use Playwright/Puppeteer to actually crawl the site
 */
export async function startDiscoveryRunner(runId: string, project: Project): Promise<void> {
  console.log(`Starting discovery runner for run ${runId}, project: ${project.name}`);

  // Update run status to running
  store.updateDiscoveryRun(runId, {
    status: 'running',
    progressPct: 0,
  });

  wsServer.broadcastToRun(runId, {
    type: 'status',
    status: 'running',
  });

  try {
    // Simulate discovery process
    const totalSteps = 10;
    const nodesPerStep = 2;
    const edgesPerStep = 1;

    for (let step = 0; step < totalSteps; step++) {
      await delay(1000); // Simulate work

      // Generate mock nodes
      const newNodes: StateNode[] = [];
      for (let i = 0; i < nodesPerStep; i++) {
        const node: StateNode = {
          id: uuidv4(),
          projectId: project.id,
          runId,
          url: `${project.baseUrl}/page-${step}-${i}`,
          title: `Page ${step}-${i}`,
          fingerprint: `fp-${step}-${i}`,
          label: `Page ${step}-${i}`,
          tags: step === 0 && i === 0 ? ['critical'] : [],
          screenshotKey: `screenshots/${runId}/page-${step}-${i}.png`,
        };
        newNodes.push(node);
      }

      // Add nodes to graph
      store.addNodes(runId, newNodes);

      // Generate mock edges
      const newEdges: TransitionEdge[] = [];
      const graph = store.getGraph(runId);
      const allNodes = graph.nodes;
      if (allNodes.length >= 2) {
        for (let i = 0; i < edgesPerStep && allNodes.length >= 2; i++) {
          const fromNode = allNodes[Math.max(0, allNodes.length - 3)];
          const toNode = allNodes[allNodes.length - 1];

          const edge: TransitionEdge = {
            id: uuidv4(),
            projectId: project.id,
            runId,
            fromStateId: fromNode.id,
            toStateId: toNode.id,
            action: {
              type: 'click',
              selector: `a[href="${toNode.url}"]`,
              label: `Navigate to ${toNode.label}`,
            },
            confidence: 0.85 + Math.random() * 0.15,
            createdAt: new Date().toISOString(),
          };
          newEdges.push(edge);
        }
      }

      // Add edges to graph
      store.addEdges(runId, newEdges);

      // Broadcast graph updates
      wsServer.broadcastToRun(runId, {
        type: 'graph:add',
        nodes: newNodes,
        edges: newEdges,
      });

      // Update progress
      const progressPct = Math.round(((step + 1) / totalSteps) * 100);
      const currentGraph = store.getGraph(runId);
      store.updateDiscoveryRun(runId, {
        progressPct,
        nodesCount: currentGraph.nodes.length,
        edgesCount: currentGraph.edges.length,
      });

      wsServer.broadcastToRun(runId, {
        type: 'progress',
        progressPct,
      });
    }

    // Mark as finished
    store.updateDiscoveryRun(runId, {
      status: 'finished',
      finishedAt: new Date().toISOString(),
      progressPct: 100,
    });

    wsServer.broadcastToRun(runId, {
      type: 'status',
      status: 'finished',
    });

    wsServer.broadcastToRun(runId, {
      type: 'done',
    });

    console.log(`Discovery runner completed for run ${runId}`);
  } catch (error) {
    console.error(`Discovery runner failed for run ${runId}:`, error);
    store.updateDiscoveryRun(runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
    });

    wsServer.broadcastToRun(runId, {
      type: 'status',
      status: 'failed',
    });

    wsServer.broadcastToRun(runId, {
      type: 'done',
    });
  }
}
