import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Shell } from './layout/Shell';
import { ProjectsPage } from '../pages/ProjectsPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { DiscoveryPage } from '../pages/DiscoveryPage';
import { RunsPage } from '../pages/RunsPage';
import { RunDetailPage } from '../pages/RunDetailPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      {
        index: true,
        element: <Navigate to="/projects" replace />,
      },
      {
        path: 'projects',
        element: <ProjectsPage />,
      },
      {
        path: 'projects/:projectId',
        element: <ProjectDetailPage />,
      },
      {
        path: 'projects/:projectId/discovery',
        element: <DiscoveryPage />,
      },
      {
        path: 'runs',
        element: <RunsPage />,
      },
      {
        path: 'runs/:runId',
        element: <RunDetailPage />,
      },
    ],
  },
]);
