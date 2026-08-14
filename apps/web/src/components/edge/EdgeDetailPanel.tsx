import { useState } from 'react';
import { TransitionEdge, StateNode } from '../../api/types';
import { Button } from '../ui/Button';
import { X, Copy, Check } from 'lucide-react';
import './EdgeDetailPanel.css';

interface EdgeDetailPanelProps {
  edge: TransitionEdge | null;
  fromNode: StateNode | null;
  toNode: StateNode | null;
  isOpen: boolean;
  onClose: () => void;
}

export function EdgeDetailPanel({ edge, fromNode, toNode, isOpen, onClose }: EdgeDetailPanelProps) {
  const [copiedJSON, setCopiedJSON] = useState(false);
  const [copiedReplayDebug, setCopiedReplayDebug] = useState(false);

  const handleCopySelectorBundle = async () => {
    if (edge?.selectorBundle) {
      await navigator.clipboard.writeText(JSON.stringify(edge.selectorBundle, null, 2));
      setCopiedJSON(true);
      setTimeout(() => setCopiedJSON(false), 2000);
    }
  };

  const handleCopyReplayDebug = async () => {
    if (edge) {
      const debugData = {
        edgeId: edge.id,
        selectorBundle: edge.selectorBundle,
        clickContext: edge.clickContext,
        tags: edge.tags,
      };
      await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
      setCopiedReplayDebug(true);
      setTimeout(() => setCopiedReplayDebug(false), 2000);
    }
  };

  if (!isOpen || !edge) {
    return null;
  }

  return (
    <>
      <div className="edge-detail-panel__backdrop" onClick={onClose} />
      <div className="edge-detail-panel">
        <div className="edge-detail-panel__header">
          <h2>Edge Details</h2>
          <button className="edge-detail-panel__close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="edge-detail-panel__content">
          {/* Tags Section */}
          {edge.tags && edge.tags.length > 0 && (
            <section className="edge-detail-panel__section">
              <div className="edge-detail-panel__tags">
                {edge.tags.map((tag) => (
                  <span
                    key={tag}
                    className={`edge-detail-panel__badge ${
                      tag === 'unstable' ? 'edge-detail-panel__badge--warning' : 'edge-detail-panel__badge--default'
                    }`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
              {edge.tags.includes('unstable') && (
                <p className="edge-detail-panel__warning">
                  ⚠️ This edge is marked as unstable. It may not reliably change state during replay.
                </p>
              )}
            </section>
          )}

          {/* Transition Section */}
          <section className="edge-detail-panel__section">
            <h3>Transition</h3>

            <div className="edge-detail-panel__transition">
              <div className="edge-detail-panel__node-label">
                {fromNode?.label || fromNode?.title || 'Unknown'}
              </div>
              <div className="edge-detail-panel__arrow">→</div>
              <div className="edge-detail-panel__node-label">
                {toNode?.label || toNode?.title || 'Unknown'}
              </div>
            </div>
          </section>

          {/* Action Section */}
          <section className="edge-detail-panel__section">
            <h3>Action</h3>

            <div className="edge-detail-panel__field">
              <label>Type</label>
              <div className="edge-detail-panel__readonly">
                <span className="edge-detail-panel__badge edge-detail-panel__badge--action">
                  {edge.action.type}
                </span>
              </div>
            </div>

            {edge.action.label && (
              <div className="edge-detail-panel__field">
                <label>Label</label>
                <div className="edge-detail-panel__readonly">{edge.action.label}</div>
              </div>
            )}

            <div className="edge-detail-panel__field">
              <label>Confidence</label>
              <div className="edge-detail-panel__readonly">
                <span
                  className={`edge-detail-panel__badge ${
                    edge.confidence >= 0.8
                      ? 'edge-detail-panel__badge--high'
                      : edge.confidence >= 0.6
                      ? 'edge-detail-panel__badge--medium'
                      : 'edge-detail-panel__badge--low'
                  }`}
                >
                  {(edge.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </section>

          {/* Click Context Section */}
          {edge.clickContext && (
            <section className="edge-detail-panel__section">
              <h3>Click Context</h3>

              <div className="edge-detail-panel__field">
                <label>Scope</label>
                <div className="edge-detail-panel__readonly">
                  <span className="edge-detail-panel__badge edge-detail-panel__badge--scope">
                    {edge.clickContext.scope}
                  </span>
                  {edge.clickContext.scopeSelector && (
                    <code className="edge-detail-panel__code">
                      {edge.clickContext.scopeSelector}
                    </code>
                  )}
                </div>
              </div>

              {edge.clickContext.elementText && (
                <div className="edge-detail-panel__field">
                  <label>Element Text</label>
                  <div className="edge-detail-panel__readonly">{edge.clickContext.elementText}</div>
                </div>
              )}

              {edge.clickContext.ariaLabel && (
                <div className="edge-detail-panel__field">
                  <label>Aria Label</label>
                  <div className="edge-detail-panel__readonly">{edge.clickContext.ariaLabel}</div>
                </div>
              )}

              {edge.clickContext.role && (
                <div className="edge-detail-panel__field">
                  <label>Role</label>
                  <div className="edge-detail-panel__readonly">{edge.clickContext.role}</div>
                </div>
              )}

              {edge.clickContext.testId && (
                <div className="edge-detail-panel__field">
                  <label>Test ID</label>
                  <div className="edge-detail-panel__readonly">
                    <code className="edge-detail-panel__code">{edge.clickContext.testId}</code>
                  </div>
                </div>
              )}

              {edge.clickContext.href && (
                <div className="edge-detail-panel__field">
                  <label>Href</label>
                  <div className="edge-detail-panel__readonly">
                    <code className="edge-detail-panel__code">{edge.clickContext.href}</code>
                  </div>
                </div>
              )}

              <div className="edge-detail-panel__info">
                ℹ️ Replay uses clickContext to scope selectors (nav/dialog/main).
              </div>
            </section>
          )}

          {/* Selector Bundle Section */}
          {edge.selectorBundle ? (
            <section className="edge-detail-panel__section">
              <h3>Selector Bundle</h3>

              <div className="edge-detail-panel__field">
                <label>Preferred Selector</label>
                <div className="edge-detail-panel__selector">
                  <span className="edge-detail-panel__selector-kind">
                    {edge.selectorBundle.preferred.kind}
                  </span>
                  <code className="edge-detail-panel__selector-value">
                    {edge.selectorBundle.preferred.role && edge.selectorBundle.preferred.name
                      ? `${edge.selectorBundle.preferred.role}[${edge.selectorBundle.preferred.name}]`
                      : edge.selectorBundle.preferred.value || 'N/A'}
                  </code>
                </div>
              </div>

              {edge.selectorBundle.fallbacks && edge.selectorBundle.fallbacks.length > 0 && (
                <div className="edge-detail-panel__field">
                  <label>Fallback Selectors</label>
                  <div className="edge-detail-panel__fallbacks">
                    {edge.selectorBundle.fallbacks.map((fallback: any, idx: number) => (
                      <div key={idx} className="edge-detail-panel__selector">
                        <span className="edge-detail-panel__selector-kind">{fallback.kind}</span>
                        <code className="edge-detail-panel__selector-value">
                          {fallback.role && fallback.name
                            ? `${fallback.role}[${fallback.name}]`
                            : fallback.value || 'N/A'}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="edge-detail-panel__field">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopySelectorBundle}
                  style={{ width: '100%', marginBottom: '8px' }}
                >
                  {copiedJSON ? (
                    <>
                      <Check size={16} />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy size={16} />
                      Copy Selector Bundle JSON
                    </>
                  )}
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyReplayDebug}
                  style={{ width: '100%' }}
                >
                  {copiedReplayDebug ? (
                    <>
                      <Check size={16} />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy size={16} />
                      Copy Replay Debug JSON
                    </>
                  )}
                </Button>
              </div>
            </section>
          ) : (
            <section className="edge-detail-panel__section">
              <h3>Selector Bundle</h3>
              <p className="edge-detail-panel__not-available">
                Selector bundle not available for this edge
              </p>
            </section>
          )}

          {/* Fingerprints Section */}
          {(edge.observedFromFingerprint || edge.observedToFingerprint) && (
            <section className="edge-detail-panel__section">
              <h3>State Fingerprints</h3>

              {edge.observedFromFingerprint && (
                <div className="edge-detail-panel__field">
                  <label>From State</label>
                  <div className="edge-detail-panel__readonly">
                    <code className="edge-detail-panel__fingerprint">
                      {edge.observedFromFingerprint}
                    </code>
                  </div>
                </div>
              )}

              {edge.observedToFingerprint && (
                <div className="edge-detail-panel__field">
                  <label>To State</label>
                  <div className="edge-detail-panel__readonly">
                    <code className="edge-detail-panel__fingerprint">
                      {edge.observedToFingerprint}
                    </code>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Metadata Section */}
          {edge.createdAt && (
            <section className="edge-detail-panel__section">
              <h3>Metadata</h3>

              <div className="edge-detail-panel__field">
                <label>Discovered At</label>
                <div className="edge-detail-panel__readonly">
                  {new Date(edge.createdAt).toLocaleString()}
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="edge-detail-panel__footer">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </>
  );
}
