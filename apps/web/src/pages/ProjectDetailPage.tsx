import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { DiscoveryRunMode } from '../api/types';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { Modal } from '../components/ui/Modal';
import { ArrowLeft, Play, ExternalLink, Monitor, Camera, FolderX } from 'lucide-react';
import { formatDate } from '../utils/format';
import './ProjectDetailPage.css';

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { projects, runs, loadProjects, loadRuns, startDiscoveryRun } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [showModeModal, setShowModeModal] = useState(false);
  const [selectedMode, setSelectedMode] = useState<DiscoveryRunMode>('screenshot_stream');
  const [starting, setStarting] = useState(false);

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) || null,
    [projects, projectId]
  );

  const projectRuns = useMemo(
    () => runs.discovery.filter((r) => r.projectId === projectId),
    [runs.discovery, projectId]
  );

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadProjects(), loadRuns()]);
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleStartDiscovery = async () => {
    if (!projectId) return;

    try {
      setStarting(true);
      const newRun = await startDiscoveryRun(projectId, selectedMode);
      navigate(`/projects/${projectId}/discovery?runId=${newRun.id}`);
    } catch (error) {
      // Error handled in store
    } finally {
      setStarting(false);
    }
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'finished':
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
      <div className="project-detail__loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="project-detail__error">
        <FolderX size={64} strokeWidth={1.5} />
        <h3>Project not found</h3>
        <p>This project may have been deleted or the ID is invalid</p>
        <Button onClick={() => navigate('/projects')}>Back to Projects</Button>
      </div>
    );
  }

  return (
    <div className="project-detail">
      <div className="project-detail__header">
        <div className="project-detail__breadcrumb">
          <Button variant="ghost" size="sm" onClick={() => navigate('/projects')}>
            <ArrowLeft size={16} />
            Projects
          </Button>
          <span className="project-detail__breadcrumb-separator">/</span>
          <span className="project-detail__breadcrumb-current">{project.name}</span>
        </div>
      </div>

      <div className="project-detail__main">
        <Card>
          <CardHeader>
            <h2>{project.name}</h2>
          </CardHeader>
          <CardBody>
            <div className="project-detail__info">
              <div className="project-detail__info-item">
                <span className="project-detail__info-label">Base URL</span>
                <a
                  href={project.baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="project-detail__info-link"
                >
                  {project.baseUrl}
                  <ExternalLink size={14} />
                </a>
              </div>
              <div className="project-detail__info-item">
                <span className="project-detail__info-label">Created</span>
                <span className="project-detail__info-value">
                  {formatDate(project.createdAt)}
                </span>
              </div>
            </div>
            <div className="project-detail__actions">
              <Button onClick={() => setShowModeModal(true)} size="lg">
                <Play size={18} />
                Start Discovery
              </Button>
            </div>
          </CardBody>
        </Card>

        {projectRuns.length > 0 && (
          <Card>
            <CardHeader>
              <h3>Past Discovery Runs ({projectRuns.length})</h3>
            </CardHeader>
            <CardBody>
              <div className="project-detail__runs">
                {projectRuns.map((run) => (
                  <div
                    key={run.id}
                    className="project-detail__run-item"
                    onClick={() => navigate(`/runs/${run.id}`)}
                  >
                    <div className="project-detail__run-header">
                      <div className="project-detail__run-info">
                        <Badge variant={getStatusVariant(run.status)}>
                          {run.status}
                        </Badge>
                        <span className="project-detail__run-mode">
                          {run.mode === 'iframe' ? (
                            <>
                              <Monitor size={14} /> Iframe Mode
                            </>
                          ) : (
                            <>
                              <Camera size={14} /> Screenshot Stream
                            </>
                          )}
                        </span>
                      </div>
                      <span className="project-detail__run-date">
                        {formatDate(run.startedAt)}
                      </span>
                    </div>
                    <div className="project-detail__run-progress">
                      <div className="project-detail__run-progress-bar">
                        <div
                          className="project-detail__run-progress-fill"
                          style={{ width: `${run.progressPct}%` }}
                        />
                      </div>
                      <span className="project-detail__run-progress-text">
                        {run.progressPct}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </div>

      <Modal
        isOpen={showModeModal}
        onClose={() => setShowModeModal(false)}
        title="Select Discovery Mode"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModeModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleStartDiscovery} isLoading={starting}>
              <Play size={16} />
              Start
            </Button>
          </>
        }
      >
        <div className="project-detail__mode-selection">
          <p className="project-detail__mode-description">
            Choose how you want to preview the discovery process:
          </p>
          <div className="project-detail__mode-options">
            <label
              className={`project-detail__mode-option ${
                selectedMode === 'iframe' ? 'project-detail__mode-option--selected' : ''
              }`}
            >
              <input
                type="radio"
                name="mode"
                value="iframe"
                checked={selectedMode === 'iframe'}
                onChange={(e) => setSelectedMode(e.target.value as DiscoveryRunMode)}
              />
              <div className="project-detail__mode-content">
                <div className="project-detail__mode-icon">
                  <Monitor size={24} />
                </div>
                <div className="project-detail__mode-details">
                  <h4>Iframe Mode</h4>
                  <p>Watch live navigation in an embedded browser</p>
                  <span className="project-detail__mode-note">Best effort</span>
                </div>
              </div>
            </label>

            <label
              className={`project-detail__mode-option ${
                selectedMode === 'screenshot_stream' ? 'project-detail__mode-option--selected' : ''
              }`}
            >
              <input
                type="radio"
                name="mode"
                value="screenshot_stream"
                checked={selectedMode === 'screenshot_stream'}
                onChange={(e) => setSelectedMode(e.target.value as DiscoveryRunMode)}
              />
              <div className="project-detail__mode-content">
                <div className="project-detail__mode-icon">
                  <Camera size={24} />
                </div>
                <div className="project-detail__mode-details">
                  <h4>Screenshot Stream Mode</h4>
                  <p>View real-time screenshots as pages are discovered</p>
                  <span className="project-detail__mode-note project-detail__mode-note--recommended">
                    Recommended
                  </span>
                </div>
              </div>
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
