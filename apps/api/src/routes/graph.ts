import { Router } from 'express';
import { store } from '../store';

export const graphRouter = Router();

// Get graph for a discovery run
graphRouter.get('/:runId', (req, res) => {
  const { runId } = req.params;

  const run = store.getDiscoveryRun(runId);
  if (!run) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const graph = store.getGraph(runId);
  return res.json(graph);
});
