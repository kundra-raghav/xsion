import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { List } from 'lucide-react';
import { formatDate } from '../utils/format';
import './RunsPage.css';

export function RunsPage() {
  const navigate = useNavigate();
  const { projects, runs, loadProjects, loadRuns, subscribeRun, unsubscribeRun } = useAppStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadProjects(), loadRuns()]);
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to running runs for live updates
  useEffect(() => {
    const runningDiscoveryIds: string[] = [];
    const runningTestIds: string[] = [];

    // Find all running/queued discovery runs
    runs.discovery.forEach((run) => {
      if (run.status === 'running' || run.status === 'queued') {
        runningDiscoveryIds.push(run.id);
        subscribeRun(run.id);
      }
    });

    // Find all running test runs
    runs.test.forEach((run) => {
      if (run.status === 'running') {
        runningTestIds.push(run.id);
        subscribeRun(run.id);
      }
    });

    // Cleanup: unsubscribe when component unmounts
    return () => {
      runningDiscoveryIds.forEach((id) => unsubscribeRun(id));
      runningTestIds.forEach((id) => unsubscribeRun(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.discovery, runs.test]);

  const getProjectName = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    return project?.name || projectId;
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'finished':
      case 'passed':
        return 'success';
      case 'running':
        return 'info';
      case 'failed':
        return 'error';
      case 'queued':
        return 'warning';
      default:
        return 'default';
    }
  };


  if (loading) {
    return (
      <div className="runs-page__loading">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="runs-page">
      <div className="runs-page__header">
        <h1>All Runs</h1>
      </div>

      {loading ? (
        <div className="runs-page__loading">
          <Spinner size="lg" />
        </div>
      ) : runs.discovery.length === 0 && runs.test.length === 0 ? (
        <div className="runs-page__empty-all">
          <List size={64} strokeWidth={1.5} />
          <h3>No runs yet</h3>
          <p>Start a discovery run from a project to see it appear here</p>
        </div>
      ) : (
        <div className="runs-page__content">
          {/* Discovery Runs Section */}
          <section className="runs-page__section">
            <h2 className="runs-page__section-title">Discovery Runs</h2>
            {runs.discovery.length === 0 ? (
              <div className="runs-page__empty">
                <p>No discovery runs yet</p>
              </div>
            ) : (
            <div className="runs-page__list">
              {runs.discovery.map((run) => (
                <div
                  key={run.id}
                  className="runs-page__item"
                  onClick={() => navigate(`/runs/${run.id}`)}
                >
                  <div className="runs-page__item-main">
                    <div className="runs-page__item-header">
                      <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
                      <span className="runs-page__item-type">Discovery</span>
                    </div>
                    <div className="runs-page__item-project">{getProjectName(run.projectId)}</div>
                    <div className="runs-page__item-meta">
                      Started {formatDate(run.startedAt)}
                      {run.mode && <span className="runs-page__item-mode"> • {run.mode}</span>}
                    </div>
                  </div>
                  <div className="runs-page__item-stats">
                    <span>{run.progressPct}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Test Runs Section */}
        <section className="runs-page__section">
          <h2 className="runs-page__section-title">Test Runs</h2>
          {runs.test.length === 0 ? (
            <div className="runs-page__empty">
              <p>No test runs yet</p>
            </div>
          ) : (
            <div className="runs-page__list">
              {runs.test.map((run) => (
                <div
                  key={run.id}
                  className="runs-page__item"
                  onClick={() => navigate(`/runs/${run.id}`)}
                >
                  <div className="runs-page__item-main">
                    <div className="runs-page__item-header">
                      <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
                      <span className="runs-page__item-type">Test</span>
                    </div>
                    <div className="runs-page__item-project">{getProjectName(run.projectId)}</div>
                    <div className="runs-page__item-meta">
                      Started {formatDate(run.startedAt)}
                      {run.finishedAt && (
                        <span> • Finished {formatDate(run.finishedAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="runs-page__item-stats">
                    {run.status === 'failed' && run.failedStepIndex !== undefined ? (
                      <span className="runs-page__item-error">
                        Failed at step {run.failedStepIndex}
                      </span>
                    ) : null}
                  </div>
                </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
