import { Router } from 'express';
import { store } from '../store';

export const runsRouter = Router();

// List all runs (both discovery and test runs)
runsRouter.get('/', (_req, res) => {
  const discoveryRuns = store.listDiscoveryRuns();
  const testRuns = store.listTestRuns();

  return res.json({
    discoveryRuns,
    testRuns,
  });
});

// Get run by ID (checks both discovery and test runs)
runsRouter.get('/:runId', (req, res) => {
  const { runId } = req.params;

  // Check discovery runs first
  const discoveryRun = store.getDiscoveryRun(runId);
  if (discoveryRun) {
    return res.json({ ...discoveryRun, runType: 'discovery' });
  }

  // Check test runs
  const testRun = store.getTestRun(runId);
  if (testRun) {
    return res.json({ ...testRun, runType: 'test' });
  }

  return res.status(404).json({ error: 'Run not found' });
});

// Get graph for a run
runsRouter.get('/:runId/graph', (req, res) => {
  const { runId } = req.params;

  // Verify the run exists
  const discoveryRun = store.getDiscoveryRun(runId);
  if (!discoveryRun) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const graph = store.getGraph(runId);
  return res.json(graph);
});
