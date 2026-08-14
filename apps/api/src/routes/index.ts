import { Router } from 'express';
import { projectsRouter } from './projects';
import { runsRouter } from './runs';
import { proxyRouter } from './proxy';

export const apiRouter = Router();

apiRouter.use('/projects', projectsRouter);
apiRouter.use('/runs', runsRouter);
apiRouter.use('/proxy', proxyRouter);
