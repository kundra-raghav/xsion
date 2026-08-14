import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { api } from '../api/client';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { ArrowLeft, Activity } from 'lucide-react';
import { formatDate } from '../utils/format';
import './RunDetailPage.css';

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { projects, showToast, subscribeRun, unsubscribeRun, runs } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Get run from store (updated by WebSocket) OR fetch initially
  const discoveryRun = runs.discovery.find((r) => r.id === runId) || null;
  const testRun = runs.test.find((r) => r.id === runId) || null;

  useEffect(() => {
    loadRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Subscribe to run if it's still running
  useEffect(() => {
    if (!runId) return;

    const isRunning =
      (discoveryRun && (discoveryRun.status === 'running' || discoveryRun.status === 'queued')) ||
      (testRun && testRun.status === 'running');

    if (isRunning) {
      subscribeRun(runId);
      return () => {
        unsubscribeRun(runId);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, runs.discovery, runs.test]);

  const loadRun = async () => {
    if (!runId) return;

    // If run already exists in store, skip loading
    if (discoveryRun || testRun) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(false);

      // Load the run (could be either type)
      const runData: any = await api.getRun(runId);

      // Add run to store so it gets updated by WebSocket events
      useAppStore.setState((state) => {
        // Check the runType discriminator
        if (runData.runType === 'test') {
          return {
            runs: {
              ...state.runs,
              test: [runData, ...state.runs.test.filter((r) => r.id !== runId)],
            },
          };
        } else {
          // Default to discovery run
          return {
            runs: {
              ...state.runs,
              discovery: [runData, ...state.runs.discovery.filter((r) => r.id !== runId)],
            },
          };
        }
      });
    } catch (err) {
      setError(true);
      showToast('Failed to load run', 'error');
      console.error('Failed to load run:', err);
    } finally {
      setLoading(false);
    }
  };

  const getProject = (projectId: string) => {
    return projects.find((p) => p.id === projectId) || null;
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
      <div className="run-detail__loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || (!discoveryRun && !testRun)) {
    return (
      <div className="run-detail__error">
        <Activity size={64} strokeWidth={1.5} />
        <h3>Run not found</h3>
        <p>This run may have been deleted or the ID is invalid</p>
        <Button onClick={() => navigate('/runs')}>Back to Runs</Button>
      </div>
    );
  }

  const project = discoveryRun
    ? getProject(discoveryRun.projectId)
    : testRun
    ? getProject(testRun.projectId)
    : null;

  // Render Discovery Run
  if (discoveryRun) {
    return (
      <div className="run-detail">
        <div className="run-detail__header">
          <div className="run-detail__breadcrumb">
            <Button variant="ghost" size="sm" onClick={() => navigate('/runs')}>
              <ArrowLeft size={16} />
              Runs
            </Button>
            <span className="run-detail__breadcrumb-separator">/</span>
            <span className="run-detail__breadcrumb-current">Discovery Run</span>
          </div>
        </div>

        <div className="run-detail__title">
          <div>
            <h1>Discovery Run</h1>
            <p className="run-detail__subtitle">{project?.name || discoveryRun.projectId}</p>
          </div>
          <Badge variant={getStatusVariant(discoveryRun.status)}>
            {discoveryRun.status}
          </Badge>
        </div>

        <div className="run-detail__content">
          <section className="run-detail__section">
            <h2 className="run-detail__section-title">Progress Summary</h2>
            <div className="run-detail__grid">
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Run ID</span>
                <span className="run-detail__stat-value">{discoveryRun.id}</span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Mode</span>
                <span className="run-detail__stat-value">{discoveryRun.mode}</span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Progress</span>
                <span className="run-detail__stat-value">{discoveryRun.progressPct}%</span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Started At</span>
                <span className="run-detail__stat-value">{formatDate(discoveryRun.startedAt)}</span>
              </div>
              {discoveryRun.finishedAt && (
                <div className="run-detail__stat">
                  <span className="run-detail__stat-label">Finished At</span>
                  <span className="run-detail__stat-value">{formatDate(discoveryRun.finishedAt)}</span>
                </div>
              )}
            </div>
          </section>

          <section className="run-detail__section">
            <h2 className="run-detail__section-title">Final Stats</h2>
            <div className="run-detail__grid">
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Nodes Discovered</span>
                <span className="run-detail__stat-value run-detail__stat-value--large">
                  {discoveryRun.nodesCount || 0}
                </span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Edges Found</span>
                <span className="run-detail__stat-value run-detail__stat-value--large">
                  {discoveryRun.edgesCount || 0}
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  // Render Test Run
  if (testRun) {
    return (
      <div className="run-detail">
        <div className="run-detail__header">
          <div className="run-detail__breadcrumb">
            <Button variant="ghost" size="sm" onClick={() => navigate('/runs')}>
              <ArrowLeft size={16} />
              Runs
            </Button>
            <span className="run-detail__breadcrumb-separator">/</span>
            <span className="run-detail__breadcrumb-current">Test Run</span>
          </div>
        </div>

        <div className="run-detail__title">
          <div>
            <h1>Test Run</h1>
            <p className="run-detail__subtitle">{project?.name || testRun.projectId}</p>
          </div>
          <Badge variant={getStatusVariant(testRun.status)}>
            {testRun.status}
          </Badge>
        </div>

        <div className="run-detail__content">
          <section className="run-detail__section">
            <h2 className="run-detail__section-title">Status Summary</h2>
            <div className="run-detail__grid">
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Run ID</span>
                <span className="run-detail__stat-value">{testRun.id}</span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Suite ID</span>
                <span className="run-detail__stat-value">{testRun.suiteId}</span>
              </div>
              <div className="run-detail__stat">
                <span className="run-detail__stat-label">Started At</span>
                <span className="run-detail__stat-value">{formatDate(testRun.startedAt)}</span>
              </div>
              {testRun.finishedAt && (
                <div className="run-detail__stat">
                  <span className="run-detail__stat-label">Finished At</span>
                  <span className="run-detail__stat-value">{formatDate(testRun.finishedAt)}</span>
                </div>
              )}
            </div>
          </section>

          {testRun.status === 'failed' && (
            <section className="run-detail__section">
              <h2 className="run-detail__section-title">Failure Details</h2>
              <div className="run-detail__failure">
                <div className="run-detail__stat">
                  <span className="run-detail__stat-label">Failed Step Index</span>
                  <span className="run-detail__stat-value run-detail__stat-value--error">
                    {testRun.failedStepIndex}
                  </span>
                </div>
                {testRun.errorSummary && (
                  <div className="run-detail__error-summary">
                    <span className="run-detail__stat-label">Error Summary</span>
                    <pre className="run-detail__error-text">{testRun.errorSummary}</pre>
                  </div>
                )}
              </div>
            </section>
          )}

          {testRun.stepResults && testRun.stepResults.length > 0 && (
            <section className="run-detail__section">
              <h2 className="run-detail__section-title">Replay Steps</h2>
              <div className="run-detail__steps">
                {testRun.stepResults.map((stepResult) => (
                  <div key={stepResult.stepIndex} className="run-detail__step">
                    <div className="run-detail__step-header">
                      <span className="run-detail__step-index">Step {stepResult.stepIndex + 1}</span>
                      <Badge variant={stepResult.status === 'pass' ? 'success' : 'error'}>
                        {stepResult.status}
                      </Badge>
                    </div>
                    <div className="run-detail__step-attempts">
                      {stepResult.attempts.map((attempt, idx) => (
                        <div key={idx} className="run-detail__attempt">
                          <span className="run-detail__attempt-kind">{attempt.kind}</span>
                          <span className="run-detail__attempt-matched">
                            {attempt.matched} match{attempt.matched !== 1 ? 'es' : ''}
                          </span>
                          {attempt.chosenIndex !== undefined && (
                            <span className="run-detail__attempt-chosen">chose #{attempt.chosenIndex}</span>
                          )}
                          {attempt.error && (
                            <span className="run-detail__attempt-error">{attempt.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {stepResult.note && (
                      <div className="run-detail__step-note">
                        Note: {stepResult.note}
                      </div>
                    )}
                    {stepResult.screenshotKey && (
                      <a
                        href={`http://localhost:4000/${stepResult.screenshotKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="run-detail__step-screenshot"
                      >
                        View Screenshot
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {!testRun.stepResults && (
            <section className="run-detail__section">
              <p className="run-detail__no-data">No step results available for this run.</p>
            </section>
          )}

          <section className="run-detail__section">
            <h2 className="run-detail__section-title">Artifacts</h2>
            {testRun.artifacts && testRun.artifacts.length > 0 ? (
              <div className="run-detail__artifacts">
                {testRun.artifacts.map((artifact) => {
                  // Ensure absolute URL to backend
                  const artifactUrl = artifact.url.startsWith('http')
                    ? artifact.url
                    : `http://localhost:4000${artifact.url}`;

                  return (
                    <a
                      key={artifact.key}
                      href={artifactUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="run-detail__artifact"
                      onClick={(e) => {
                        e.preventDefault();
                        window.open(artifactUrl, '_blank');
                      }}
                    >
                      <div className="run-detail__artifact-info">
                        <span className="run-detail__artifact-type">{artifact.kind}</span>
                        <span className="run-detail__artifact-key">{artifact.key}</span>
                      </div>
                      <span className="run-detail__artifact-link">View →</span>
                    </a>
                  );
                })}
              </div>
            ) : (
              <p className="run-detail__empty">No artifacts available</p>
            )}
          </section>

          {testRun.artifacts && testRun.artifacts.some((a) => a.kind === 'screenshot') && (
            <section className="run-detail__section">
              <h2 className="run-detail__section-title">Screenshot Gallery</h2>
              <div className="run-detail__gallery">
                {testRun.artifacts
                  .filter((a) => a.kind === 'screenshot')
                  .map((artifact) => {
                    // Ensure absolute URL to backend
                    const artifactUrl = artifact.url.startsWith('http')
                      ? artifact.url
                      : `http://localhost:4000${artifact.url}`;

                    return (
                      <a
                        key={artifact.key}
                        href={artifactUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="run-detail__gallery-item"
                        onClick={(e) => {
                          e.preventDefault();
                          window.open(artifactUrl, '_blank');
                        }}
                      >
                        <img
                          src={artifactUrl}
                          alt={artifact.key}
                          className="run-detail__gallery-image"
                          onLoad={() => {
                            console.log('[RunDetail] Screenshot loaded:', artifactUrl);
                          }}
                          onError={(e) => {
                            console.error('[RunDetail] Screenshot failed to load:', artifactUrl);
                            e.currentTarget.style.opacity = '0.3';
                            e.currentTarget.style.border = '2px solid red';
                          }}
                        />
                        <span className="run-detail__gallery-label">{artifact.key}</span>
                      </a>
                    );
                  })}
              </div>
            </section>
          )}
        </div>
      </div>
    );
  }

  return null;
}
