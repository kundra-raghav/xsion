import { useEffect, useState, useMemo } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { Badge } from '../ui/Badge';
import './ScreenshotStreamPreview.css';

interface ScreenshotStreamPreviewProps {
  runId: string;
}

export function ScreenshotStreamPreview({ runId }: ScreenshotStreamPreviewProps) {
  const graph = useAppStore((state) => state.graphsByRunId[runId]);
  const run = useAppStore((state) =>
    state.runs.discovery.find((r) => r.id === runId)
  );
  const timeline = useAppStore((state) => state.timelineByRunId[runId] || []);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Extract latest URL and action from timeline
  const latestInfo = useMemo(() => {
    let currentUrl = '';
    let lastAction = '';

    // Iterate through timeline events in reverse to find latest info
    for (let i = timeline.length - 1; i >= 0; i--) {
      const event = timeline[i];

      if (!currentUrl && event.type === 'step:result') {
        currentUrl = event.url;
      }

      if (!lastAction && event.type === 'step:action') {
        lastAction = event.action.label || event.action.type || 'Unknown action';
      }

      if (currentUrl && lastAction) break;
    }

    return { currentUrl, lastAction };
  }, [timeline]);

  // Auto-select the most recent node when new nodes are added
  useEffect(() => {
    if (graph?.nodes && graph.nodes.length > 0) {
      const latestNode = graph.nodes[graph.nodes.length - 1];
      if (selectedNodeId !== latestNode.id) {
        setSelectedNodeId(latestNode.id);
        setImageLoading(true);
        setImageError(false);
      }
    }
  }, [graph?.nodes, selectedNodeId]);

  // Get the currently selected node
  const selectedNode = graph?.nodes.find((n) => n.id === selectedNodeId);

  // Get screenshot URL from the selected node
  const screenshotUrl = selectedNode?.screenshotKey
    ? `http://localhost:4000/${selectedNode.screenshotKey}`
    : null;

  // Filter nodes that have screenshots
  const nodesWithScreenshots = graph?.nodes.filter((n) => n.screenshotKey) || [];

  const isRunning = run?.status === 'running' || run?.status === 'queued';

  // Debug logging
  useEffect(() => {
    console.log('[ScreenshotStream] Graph nodes:', graph?.nodes.length || 0);
    console.log('[ScreenshotStream] Nodes with screenshots:', nodesWithScreenshots.length);
    console.log('[ScreenshotStream] Selected node:', selectedNode?.id, selectedNode?.screenshotKey);
    console.log('[ScreenshotStream] Screenshot URL:', screenshotUrl);
  }, [graph?.nodes, nodesWithScreenshots.length, selectedNode, screenshotUrl]);

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

  if (!graph || nodesWithScreenshots.length === 0) {
    return (
      <div className="screenshot-stream">
        <div className="screenshot-stream__main">
          <div className="screenshot-stream__overlay">
            {isRunning ? (
              <>
                <Loader2 size={48} strokeWidth={1.5} className="spinner" />
                <span className="screenshot-stream__text" style={{ fontSize: '16px', fontWeight: 500 }}>
                  Waiting for screenshots...
                </span>
                <span className="screenshot-stream__text" style={{ fontSize: '13px', opacity: 0.7 }}>
                  Discovery is exploring the application and will capture screenshots soon
                </span>
              </>
            ) : (
              <>
                <Camera size={48} strokeWidth={1.5} />
                <span className="screenshot-stream__text" style={{ fontSize: '16px', fontWeight: 500 }}>
                  No screenshots captured
                </span>
                <span className="screenshot-stream__text" style={{ fontSize: '13px', opacity: 0.7 }}>
                  Discovery completed without capturing screenshots
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screenshot-stream">
      <div className="screenshot-stream__main">
        {screenshotUrl && !imageError ? (
          <>
            {imageLoading && (
              <div
                className="screenshot-stream__overlay"
                style={{
                  background: 'rgba(0, 0, 0, 0.5)',
                  zIndex: 10,
                }}
              >
                <Loader2 size={32} strokeWidth={2} className="spinner" />
                <span className="screenshot-stream__text" style={{ marginTop: '8px' }}>
                  Loading screenshot...
                </span>
              </div>
            )}
            <img
              key={screenshotUrl}
              src={screenshotUrl}
              alt={selectedNode?.label || 'Screenshot'}
              className="screenshot-stream__image"
              style={{ opacity: imageLoading ? 0 : 1, transition: 'opacity 0.3s' }}
              onLoad={() => {
                console.log('[ScreenshotStream] Screenshot loaded:', screenshotUrl);
                setImageLoading(false);
              }}
              onError={(e) => {
                console.error('[ScreenshotStream] Failed to load screenshot:', screenshotUrl);
                console.error('[ScreenshotStream] Error details:', e);
                setImageError(true);
                setImageLoading(false);
              }}
            />
            {!imageLoading && (
              <>
                {/* Top-left overlay with live info */}
                <div className="screenshot-stream__info-overlay">
                  <div className="screenshot-stream__info-row">
                    <span className="screenshot-stream__info-label">Status:</span>
                    <Badge variant={getStatusVariant(run?.status || '')}>
                      {run?.status || 'unknown'}
                    </Badge>
                  </div>
                  {latestInfo.currentUrl && (
                    <div className="screenshot-stream__info-row">
                      <span className="screenshot-stream__info-label">URL:</span>
                      <span className="screenshot-stream__info-value">{latestInfo.currentUrl}</span>
                    </div>
                  )}
                  {latestInfo.lastAction && (
                    <div className="screenshot-stream__info-row">
                      <span className="screenshot-stream__info-label">Last Action:</span>
                      <span className="screenshot-stream__info-value">{latestInfo.lastAction}</span>
                    </div>
                  )}
                </div>

                {/* Bottom overlay with node label */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: '16px',
                    left: '16px',
                    right: '16px',
                    background: 'rgba(0, 0, 0, 0.85)',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    fontSize: '14px',
                    color: 'white',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                    {selectedNode?.label || 'Unknown Page'}
                  </div>
                  <div style={{ opacity: 0.8, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedNode?.url}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="screenshot-stream__overlay">
            <Camera size={48} strokeWidth={1.5} />
            <span className="screenshot-stream__text">Failed to load screenshot</span>
            <span className="screenshot-stream__text" style={{ fontSize: '12px', opacity: 0.7 }}>
              {screenshotUrl || 'No screenshot URL available'}
            </span>
          </div>
        )}
      </div>

      {nodesWithScreenshots.length > 0 && (
        <div className="screenshot-stream__timeline-container">
          <div className="screenshot-stream__timeline-header">
            <span>Screenshots ({nodesWithScreenshots.length})</span>
          </div>
          <div className="screenshot-stream__timeline">
            {nodesWithScreenshots.map((node, index) => (
            <button
              key={node.id}
              className={`screenshot-stream__thumb ${
                selectedNodeId === node.id ? 'screenshot-stream__thumb--active' : ''
              }`}
              onClick={() => {
                setSelectedNodeId(node.id);
                setImageLoading(true);
                setImageError(false);
              }}
              title={`${index + 1}. ${node.label || node.url}`}
            >
              <img
                src={`http://localhost:4000/${node.screenshotKey}`}
                alt={node.label || 'Screenshot'}
                className="screenshot-stream__thumb-image"
                onLoad={() => {
                  console.log('[ScreenshotStream] Thumbnail loaded:', node.screenshotKey);
                }}
                onError={(e) => {
                  console.error('[ScreenshotStream] Thumbnail failed to load:', node.screenshotKey);
                  console.error('[ScreenshotStream] Full URL:', `http://localhost:4000/${node.screenshotKey}`);
                  // Don't hide the thumbnail on error - show placeholder
                  e.currentTarget.style.border = '2px solid red';
                }}
              />
              <div className="screenshot-stream__thumb-label">{index + 1}</div>
            </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
