import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import type { TestCase, StateNode, TransitionEdge } from '../types';

interface GraphNode {
  node: StateNode;
  edges: TransitionEdge[];
}

function buildGraph(nodes: StateNode[], edges: TransitionEdge[]): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();

  // Initialize nodes
  nodes.forEach((node) => {
    graph.set(node.id, { node, edges: [] });
  });

  // Add edges
  edges.forEach((edge) => {
    const graphNode = graph.get(edge.fromStateId);
    if (graphNode) {
      graphNode.edges.push(edge);
    }
  });

  return graph;
}

function findRootNode(nodes: StateNode[]): StateNode | undefined {
  // Find node tagged as entry-point or the first node
  return nodes.find((n) => n.tags.includes('entry-point')) || nodes[0];
}

function isEdgeUnstable(edge: TransitionEdge): boolean {
  return edge.tags?.includes('unstable') || false;
}

function countUnstableEdges(edgeIds: string[], edgeMap: Map<string, TransitionEdge>): number {
  return edgeIds.filter((edgeId) => {
    const edge = edgeMap.get(edgeId);
    return edge && isEdgeUnstable(edge);
  }).length;
}

function dfsLongestPaths(
  graph: Map<string, GraphNode>,
  startNodeId: string,
  edgeMap: Map<string, TransitionEdge>,
  maxPathLength: number = 6,
  topK: number = 3
): string[][] {
  const allPaths: string[][] = [];
  const visited = new Set<string>();

  function dfs(nodeId: string, currentPath: string[]) {
    if (currentPath.length >= maxPathLength) {
      allPaths.push([...currentPath]);
      return;
    }

    visited.add(nodeId);
    const graphNode = graph.get(nodeId);

    if (!graphNode || graphNode.edges.length === 0) {
      if (currentPath.length > 0) {
        allPaths.push([...currentPath]);
      }
      visited.delete(nodeId);
      return;
    }

    // Sort edges: prefer stable edges
    const sortedEdges = [...graphNode.edges].sort((a, b) => {
      const aUnstable = isEdgeUnstable(a) ? 1 : 0;
      const bUnstable = isEdgeUnstable(b) ? 1 : 0;
      return aUnstable - bUnstable;
    });

    // Explore all edges
    for (const edge of sortedEdges) {
      if (!visited.has(edge.toStateId)) {
        currentPath.push(edge.id);
        dfs(edge.toStateId, currentPath);
        currentPath.pop();
      }
    }

    visited.delete(nodeId);
  }

  dfs(startNodeId, []);

  // Sort by: 1) fewer unstable edges, 2) longer paths
  allPaths.sort((a, b) => {
    const aUnstableCount = countUnstableEdges(a, edgeMap);
    const bUnstableCount = countUnstableEdges(b, edgeMap);
    if (aUnstableCount !== bUnstableCount) {
      return aUnstableCount - bUnstableCount;
    }
    return b.length - a.length;
  });

  return allPaths.slice(0, topK);
}

export function generateSmokeSuite(projectId: string, runId: string): TestCase[] {
  const graph = store.getGraph(runId);

  if (graph.nodes.length === 0) {
    console.log(`No graph nodes found for run ${runId}`);
    return [];
  }

  if (graph.edges.length === 0) {
    console.log(`No edges found for run ${runId}, creating basic navigation test`);

    // Create a simple test case for just navigating to the root
    const rootNode = findRootNode(graph.nodes);
    if (rootNode) {
      const testCase: TestCase = {
        id: uuidv4(),
        projectId,
        name: `Smoke Test 1: Navigate to ${rootNode.label || 'Home'}`,
        edgePath: [],
        kind: 'smoke',
      };
      store.saveSmokeSuite(runId, [testCase]);
      console.log(`Generated 1 basic smoke test for run ${runId}`);
      return [testCase];
    }
    return [];
  }

  // Build adjacency list
  const graphMap = buildGraph(graph.nodes, graph.edges);

  // Build edge map
  const edgeMap = new Map<string, TransitionEdge>();
  graph.edges.forEach((edge) => {
    edgeMap.set(edge.id, edge);
  });

  // Find root node
  const rootNode = findRootNode(graph.nodes);
  if (!rootNode) {
    console.log(`No root node found for run ${runId}`);
    return [];
  }

  // Find 3 longest paths from root (preferring stable edges)
  const paths = dfsLongestPaths(graphMap, rootNode.id, edgeMap, 6, 3);

  // If no paths found (e.g., only self-loops), create tests from individual edges
  if (paths.length === 0 || paths.every((p) => p.length === 0)) {
    console.log(`No valid paths found, creating tests from individual edges`);

    const testCases: TestCase[] = graph.edges.slice(0, 5).map((edge, index) => {
      const testCase: TestCase = {
        id: uuidv4(),
        projectId,
        name: `Smoke Test ${index + 1}: ${edge.action.label || edge.action.type}`,
        edgePath: [edge.id],
        kind: 'smoke',
      };
      return testCase;
    });

    store.saveSmokeSuite(runId, testCases);
    console.log(`Generated ${testCases.length} smoke tests from edges for run ${runId}`);
    return testCases;
  }

  // Create test cases from paths
  const testCases: TestCase[] = paths.map((edgePath, index) => {
    // Build descriptive name from edges
    const edges = edgePath
      .map((edgeId) => graph.edges.find((e) => e.id === edgeId))
      .filter((e): e is TransitionEdge => e !== undefined);

    const pathDescription =
      edges.length > 0
        ? edges
            .slice(0, 3)
            .map((e) => e.action.label || e.action.type)
            .join(' → ')
        : 'Simple path';

    const testCase: TestCase = {
      id: uuidv4(),
      projectId,
      name: `Smoke Test ${index + 1}: ${pathDescription}${edges.length > 3 ? '...' : ''}`,
      edgePath,
      kind: 'smoke',
    };

    return testCase;
  });

  // Save suite to store
  store.saveSmokeSuite(runId, testCases);

  console.log(`Generated ${testCases.length} smoke tests for run ${runId}`);
  return testCases;
}
