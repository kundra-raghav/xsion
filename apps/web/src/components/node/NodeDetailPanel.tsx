import { useState } from 'react';
import { StateNode } from '../../api/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { X, Copy, Check } from 'lucide-react';
import './NodeDetailPanel.css';

interface NodeDetailPanelProps {
  node: StateNode | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (label: string, critical: boolean) => void;
}

export function NodeDetailPanel({ node, isOpen, onClose, onSave }: NodeDetailPanelProps) {
  const [editLabel, setEditLabel] = useState('');
  const [editCritical, setEditCritical] = useState(false);
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);

  // Initialize state when node changes
  if (node && isOpen && editLabel === '') {
    setEditLabel(node.label || node.title || '');
    setEditCritical(node.tags?.includes('critical') || false);
  }

  const handleSave = () => {
    onSave(editLabel, editCritical);
    setEditLabel('');
    setEditCritical(false);
  };

  const handleCancel = () => {
    onClose();
    setEditLabel('');
    setEditCritical(false);
  };

  const handleCopyFingerprint = async () => {
    if (node?.fingerprint) {
      await navigator.clipboard.writeText(node.fingerprint);
      setCopiedFingerprint(true);
      setTimeout(() => setCopiedFingerprint(false), 2000);
    }
  };

  if (!isOpen || !node) {
    return null;
  }

  return (
    <>
      <div className="node-detail-panel__backdrop" onClick={handleCancel} />
      <div className="node-detail-panel">
        <div className="node-detail-panel__header">
          <h2>Node Details</h2>
          <button className="node-detail-panel__close" onClick={handleCancel}>
            <X size={20} />
          </button>
        </div>

        <div className="node-detail-panel__content">
          {/* Basic Info Section */}
          <section className="node-detail-panel__section">
            <h3>Basic Information</h3>

            <div className="node-detail-panel__field">
              <label htmlFor="node-label">Label</label>
              <Input
                id="node-label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Enter node label"
              />
            </div>

            <div className="node-detail-panel__field">
              <div className="node-detail-panel__checkbox">
                <input
                  type="checkbox"
                  id="node-critical"
                  checked={editCritical}
                  onChange={(e) => setEditCritical(e.target.checked)}
                />
                <label htmlFor="node-critical">Mark as Critical</label>
              </div>
            </div>

            <div className="node-detail-panel__field">
              <label>URL</label>
              <div className="node-detail-panel__readonly">{node.url}</div>
            </div>

            {node.title && (
              <div className="node-detail-panel__field">
                <label>Page Title</label>
                <div className="node-detail-panel__readonly">{node.title}</div>
              </div>
            )}
          </section>

          {/* Fingerprint Section */}
          <section className="node-detail-panel__section">
            <h3>Fingerprint</h3>

            <div className="node-detail-panel__field">
              <label>Fingerprint Hash</label>
              <div className="node-detail-panel__fingerprint">
                <code>{node.fingerprint}</code>
                <button
                  className="node-detail-panel__copy-btn"
                  onClick={handleCopyFingerprint}
                  title="Copy fingerprint"
                >
                  {copiedFingerprint ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {node.normalizedUrl && (
              <div className="node-detail-panel__field">
                <label>Normalized URL</label>
                <div className="node-detail-panel__readonly">
                  <code>{node.normalizedUrl}</code>
                </div>
              </div>
            )}
          </section>

          {/* Signature Section */}
          {(node.h1 || node.navLabels || node.ctas) && (
            <section className="node-detail-panel__section">
              <h3>Page Signature</h3>
              <p className="node-detail-panel__section-desc">
                These elements contribute to the fingerprint hash
              </p>

              {node.h1 && (
                <div className="node-detail-panel__field">
                  <label>H1 Heading</label>
                  <div className="node-detail-panel__readonly">{node.h1}</div>
                </div>
              )}

              {node.navLabels && node.navLabels.length > 0 && (
                <div className="node-detail-panel__field">
                  <label>Navigation Labels</label>
                  <div className="node-detail-panel__tags">
                    {node.navLabels.map((label, idx) => (
                      <span key={idx} className="node-detail-panel__tag">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {node.ctas && node.ctas.length > 0 && (
                <div className="node-detail-panel__field">
                  <label>Call-to-Actions</label>
                  <div className="node-detail-panel__tags">
                    {node.ctas.map((cta, idx) => (
                      <span key={idx} className="node-detail-panel__tag node-detail-panel__tag--cta">
                        {cta}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {!node.h1 && !node.navLabels && !node.ctas && (
            <section className="node-detail-panel__section">
              <h3>Page Signature</h3>
              <p className="node-detail-panel__not-available">
                Signature data not available for this node
              </p>
            </section>
          )}

          {/* Tags Section */}
          <section className="node-detail-panel__section">
            <h3>Tags</h3>
            {node.tags && node.tags.length > 0 ? (
              <div className="node-detail-panel__tags">
                {node.tags.map((tag, idx) => (
                  <span
                    key={idx}
                    className={`node-detail-panel__tag ${
                      tag === 'critical' ? 'node-detail-panel__tag--critical' : ''
                    } ${tag === 'entry-point' ? 'node-detail-panel__tag--entry' : ''}`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <p className="node-detail-panel__not-available">No tags</p>
            )}
          </section>
        </div>

        <div className="node-detail-panel__footer">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Save Changes
          </Button>
        </div>
      </div>
    </>
  );
}
