import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { StateNode, TransitionEdge } from '../api/types';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { FlowMap } from '../components/graph/FlowMap';
import { IframePreview } from '../components/preview/IframePreview';
import { ScreenshotStreamPreview } from '../components/preview/ScreenshotStreamPreview';
import { Timeline } from '../components/timeline/Timeline';
import { NodeDetailPanel } from '../components/node/NodeDetailPanel';
import { EdgeDetailPanel } from '../components/edge/EdgeDetailPanel';
import { ArrowLeft, Zap, Play, AlertCircle, Activity, StopCircle, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import './DiscoveryPage.css';

export function DiscoveryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('runId');
  const navigate = useNavigate();
  const {
    projects,
    runs,
    graphsByRunId,
    smokeSuitesByRunId,
    connectionStatusByRunId,
    loadProjects,
    loadRuns,
    subscribeRun,
    unsubscribeRun,
    updateNodeLabel,
    toggleNodeCritical,
    generateSmokeSuite,
    runSmokeSuite,
  } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [runningTests, setRunningTests] = useState(false);

  // Node detail panel state
  const [nodeDetailOpen, setNodeDetailOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<StateNode | null>(null);

  // Edge detail panel state
  const [edgeDetailOpen, setEdgeDetailOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<TransitionEdge | null>(null);

  // Timeline panel state
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) || null,
    [projects, projectId]
  );

  const run = useMemo(
    () => runs.discovery.find((r) => r.id === runId) || null,
    [runs.discovery, runId]
  );

  const graph = useMemo(
    () => (runId ? graphsByRunId[runId] : null) || { nodes: [], edges: [] },
    [graphsByRunId, runId]
  );

  useEffect(() => {
    if (!projectId || !runId) {
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      await Promise.all([loadProjects(), loadRuns()]);

      // Graph will be populated via subscription

      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, runId]);

  useEffect(() => {
    if (!runId) return;

    // Subscribe to run events
    subscribeRun(runId);

    return () => {
      unsubscribeRun(runId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const handleStop = () => {
    // Mock implementation
    console.log('Stop run requested');
  };

  const handleGenerateSmokeSuite = async () => {
    if (!projectId || !runId) return;

    try {
      setGenerating(true);
      await generateSmokeSuite(projectId, runId);
    } catch (error) {
      // Error handled in store
    } finally {
      setGenerating(false);
    }
  };

  const handleRunSmokeSuite = async () => {
    if (!projectId || !runId) return;

    try {
      setRunningTests(true);
      const testRun = await runSmokeSuite(projectId, runId);
      navigate(`/runs/${testRun.id}`);
    } catch (error) {
      // Error handled in store
    } finally {
      setRunningTests(false);
    }
  };

  const handleNodeClick = (nodeId: string) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || !runId) return;

    setSelectedNode(node);
    setNodeDetailOpen(true);
  };

  const handleEdgeClick = (edgeId: string) => {
    const edge = graph.edges.find((e) => e.id === edgeId);
    if (!edge || !runId) return;

    setSelectedEdge(edge);
    setEdgeDetailOpen(true);
  };

  const handleSaveNodeEdit = (label: string, critical: boolean) => {
    if (!selectedNode || !runId) return;

    updateNodeLabel(runId, selectedNode.id, label);

    const currentHasCritical = selectedNode.tags?.includes('critical');
    if (critical !== currentHasCritical) {
      toggleNodeCritical(runId, selectedNode.id);
    }

    setNodeDetailOpen(false);
    setSelectedNode(null);
  };

  const handleCancelNodeEdit = () => {
    setNodeDetailOpen(false);
    setSelectedNode(null);
  };

  const handleCancelEdgeDetail = () => {
    setEdgeDetailOpen(false);
    setSelectedEdge(null);
  };

  const handleReconnect = () => {
    if (!runId) return;

    // Unsubscribe and resubscribe to force reconnection
    unsubscribeRun(runId);
    setTimeout(() => {
      subscribeRun(runId);
    }, 100);
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

  // Empty state when no runId
  if (!runId) {
    return (
      <div className="discovery-page">
        <div className="discovery-page__header">
          <div className="discovery-page__breadcrumb">
            <Button variant="ghost" size="sm" onClick={() => navigate('/projects')}>
              <ArrowLeft size={16} />
              Projects
            </Button>
            {projectId && (
              <>
                <span className="discovery-page__breadcrumb-separator">/</span>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${projectId}`)}>
                  {project?.name || projectId}
                </Button>
              </>
            )}
            <span className="discovery-page__breadcrumb-separator">/</span>
            <span className="discovery-page__breadcrumb-current">Discovery</span>
          </div>
        </div>
        <div className="discovery-page__empty">
          <Activity size={64} strokeWidth={1.5} />
          <h3>No active discovery run</h3>
          <p className="discovery-page__empty-hint">
            Start a discovery run from the project detail page to begin exploring your web application
          </p>
          <Button onClick={() => navigate(projectId ? `/projects/${projectId}` : '/projects')}>
            Go to {projectId ? 'Project' : 'Projects'}
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="discovery-page__loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!project || !run) {
    return (
      <div className="discovery-page__error">
        <Activity size={64} strokeWidth={1.5} />
        <h3>Discovery run not found</h3>
        <p>This run may have been deleted or the ID is invalid</p>
        <Button onClick={() => navigate('/projects')}>Back to Projects</Button>
      </div>
    );
  }

  return (
    <div className="discovery-page">
      <div className="discovery-page__header">
        <div className="discovery-page__breadcrumb">
          <Button variant="ghost" size="sm" onClick={() => navigate('/projects')}>
            <ArrowLeft size={16} />
            Projects
          </Button>
          <span className="discovery-page__breadcrumb-separator">/</span>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${projectId}`)}>
            {project.name}
          </Button>
          <span className="discovery-page__breadcrumb-separator">/</span>
          <span className="discovery-page__breadcrumb-current">Discovery</span>
        </div>
      </div>

      <div className="discovery-page__controls">
        <div className="discovery-page__status">
          <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
          <div className="discovery-page__progress">
            <div className="discovery-page__progress-bar">
              <div
                className="discovery-page__progress-fill"
                style={{ width: `${run.progressPct}%` }}
              />
            </div>
            <span className="discovery-page__progress-text">{run.progressPct}%</span>
          </div>
          {connectionStatusByRunId[runId] && !connectionStatusByRunId[runId].connected && !connectionStatusByRunId[runId].retrying && (
            <Badge variant="error">Disconnected</Badge>
          )}
          {connectionStatusByRunId[runId]?.retrying && (
            <Badge variant="warning">Reconnecting...</Badge>
          )}
        </div>
        <div className="discovery-page__actions">
          {connectionStatusByRunId[runId] && !connectionStatusByRunId[runId].connected && !connectionStatusByRunId[runId].retrying && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReconnect}
            >
              <RefreshCw size={16} />
              Reconnect
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleStop}
            disabled={run.status !== 'running'}
          >
            <StopCircle size={16} />
            Stop
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGenerateSmokeSuite}
            isLoading={generating}
            disabled={run.status === 'running'}
          >
            <Zap size={16} />
            Generate Smoke Suite
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleRunSmokeSuite}
            isLoading={runningTests}
            disabled={run.status === 'running'}
          >
            <Play size={16} />
            Run Smoke Suite
          </Button>
        </div>

        {runId && smokeSuitesByRunId[runId] && smokeSuitesByRunId[runId].length > 0 && (
          <div className="discovery-page__smoke-suite">
            <h3>Generated Smoke Suite ({smokeSuitesByRunId[runId].length} tests)</h3>
            <div className="discovery-page__smoke-suite-list">
              {smokeSuitesByRunId[runId].map((testCase) => {
                const unstableCount = testCase.edgePath.filter((edgeId) => {
                  const edge = graph.edges.find((e) => e.id === edgeId);
                  return edge?.tags?.includes('unstable');
                }).length;
                return (
                  <div key={testCase.id} className="discovery-page__smoke-test">
                    <span className="discovery-page__smoke-test-name">{testCase.name}</span>
                    <div className="discovery-page__smoke-test-meta">
                      <span>{testCase.edgePath.length} steps</span>
                      {unstableCount > 0 && (
                        <Badge variant="warning">{unstableCount} unstable</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="discovery-page__main">
        <div className="discovery-page__content">
          <div className="discovery-page__preview">
            <div className="discovery-page__panel-header">
              <h3>Target Preview</h3>
            </div>
            {run.mode === 'iframe' && (
              <div className="discovery-page__warning">
                <AlertCircle size={16} />
                <span>Embedding depends on target site's security headers</span>
              </div>
            )}
            <div className="discovery-page__preview-content">
              {run.mode === 'iframe' ? (
                <IframePreview url={project.baseUrl} />
              ) : (
                <ScreenshotStreamPreview runId={runId} />
              )}
            </div>
          </div>

          <div className="discovery-page__graph">
            <div className="discovery-page__panel-header">
              <h3>Flow Map</h3>
              <span className="discovery-page__graph-stats">
                {graph.nodes.length} nodes, {graph.edges.length} edges
              </span>
            </div>
            <div className="discovery-page__graph-content">
              <FlowMap nodes={graph.nodes} edges={graph.edges} onNodeClick={handleNodeClick} onEdgeClick={handleEdgeClick} />
            </div>
          </div>
        </div>

        <div className={`discovery-page__timeline ${timelineCollapsed ? 'discovery-page__timeline--collapsed' : ''}`}>
          <div className="discovery-page__timeline-header" onClick={() => setTimelineCollapsed(!timelineCollapsed)}>
            <h3>Timeline</h3>
            <button className="discovery-page__timeline-toggle">
              {timelineCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
          {!timelineCollapsed && (
            <div className="discovery-page__timeline-content">
              <Timeline runId={runId} />
            </div>
          )}
        </div>
      </div>

      {/* Node Detail Panel */}
      <NodeDetailPanel
        node={selectedNode}
        isOpen={nodeDetailOpen}
        onClose={handleCancelNodeEdit}
        onSave={handleSaveNodeEdit}
      />

      {/* Edge Detail Panel */}
      <EdgeDetailPanel
        edge={selectedEdge}
        fromNode={selectedEdge ? graph.nodes.find((n) => n.id === selectedEdge.fromStateId) || null : null}
        toNode={selectedEdge ? graph.nodes.find((n) => n.id === selectedEdge.toStateId) || null : null}
        isOpen={edgeDetailOpen}
        onClose={handleCancelEdgeDetail}
      />
    </div>
  );
}
