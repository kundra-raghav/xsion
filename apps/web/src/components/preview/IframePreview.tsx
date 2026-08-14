import { useState } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { Button } from '../ui/Button';
import './IframePreview.css';

interface IframePreviewProps {
  url: string;
  onSwitchToScreenshot?: () => void;
}

export function IframePreview({ url, onSwitchToScreenshot }: IframePreviewProps) {
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showWarning] = useState(true);

  // Use proxy URL to bypass X-Frame-Options headers
  const proxyUrl = `http://localhost:4000/api/proxy?url=${encodeURIComponent(url)}`;

  // Check if URL is known to have issues in iframe
  const isComplexSite = (url: string) => {
    const complexDomains = ['youtube.com', 'google.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    return complexDomains.some(domain => url.includes(domain));
  };

  const handleLoad = () => {
    setLoading(false);
    setError(false);
  };

  const handleError = () => {
    setLoading(false);
    setError(true);
  };

  return (
    <div className="iframe-preview">
      {isComplexSite(url) && showWarning && (
        <div style={{
          backgroundColor: '#fff3cd',
          border: '1px solid #ffc107',
          borderRadius: '4px',
          padding: '12px 16px',
          margin: '12px',
          display: 'flex',
          alignItems: 'start',
          gap: '12px',
          fontSize: '14px',
          color: '#856404'
        }}>
          <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>Iframe Mode Limitations:</strong> Complex sites like YouTube may only show a skeleton UI in iframe mode.
            Resources (CSS, JS, images) are not proxied. Use <strong>Screenshot Stream Mode</strong> for full functionality.
            {onSwitchToScreenshot && (
              <Button
                size="sm"
                onClick={onSwitchToScreenshot}
                style={{ marginTop: '8px', fontSize: '13px' }}
              >
                Switch to Screenshot Mode
              </Button>
            )}
          </div>
        </div>
      )}
      {loading && (
        <div className="iframe-preview__loading">
          Loading preview...
        </div>
      )}
      {error ? (
        <div className="iframe-preview__error">
          <AlertCircle size={48} />
          <p>Unable to load preview</p>
          <p className="iframe-preview__error-detail">
            This site may have disabled iframe embedding (X-Frame-Options header)
          </p>
          {onSwitchToScreenshot && (
            <Button onClick={onSwitchToScreenshot} style={{ marginTop: 'var(--spacing-md)' }}>
              Try Screenshot Stream Mode
            </Button>
          )}
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <iframe
            src={proxyUrl}
            title="Preview"
            className="iframe-preview__frame"
            onLoad={handleLoad}
            onError={handleError}
            sandbox="allow-scripts allow-same-origin"
          />
          {!loading && (
            <div className="iframe-preview__overlay">
              <Info size={16} style={{ flexShrink: 0 }} />
              <span>Automation runs in backend. This iframe is a visual preview only.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
