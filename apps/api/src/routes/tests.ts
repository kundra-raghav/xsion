import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { startTestRunner } from '../runners/test';

export const testsRouter = Router();

// Generate smoke suite for a discovery run
testsRouter.post('/generate/:projectId/:runId', (req, res) => {
  const { projectId, runId } = req.params;

  const project = store.getProject(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const run = store.getDiscoveryRun(runId);
  if (!run) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const graph = store.getGraph(runId);
  if (graph.edges.length === 0) {
    return res.json([]);
  }

  // Generate simple test cases from edges
  const testCases = graph.edges.slice(0, 5).map((edge, idx) => {
    const testCase = {
      id: uuidv4(),
      projectId,
      name: `Test: ${edge.action.label || edge.action.type}`,
      edgePath: [edge.id],
      kind: 'smoke' as const,
    };
    return testCase;
  });

  // Save smoke suite
  store.saveSmokeSuite(runId, testCases);

  return res.json(testCases);
});

// Run smoke suite for a discovery run
testsRouter.post('/run/:projectId/:runId', (req, res) => {
  const { projectId, runId } = req.params;

  const project = store.getProject(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const run = store.getDiscoveryRun(runId);
  if (!run) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const testRun = store.createTestRun({
    id: uuidv4(),
    projectId,
    suiteId: `suite-${runId}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    artifacts: [],
  });

  // Start test runner asynchronously
  startTestRunner(testRun.id, project).catch((error) => {
    console.error(`Test runner failed for run ${testRun.id}:`, error);
    store.updateTestRun(testRun.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Test runner encountered an error',
    });
  });

  return res.status(201).json(testRun);
});
