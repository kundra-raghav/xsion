import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { IframePreview } from './IframePreview';
import { Button } from '../ui/Button';
import './TargetPreview.css';

interface TargetPreviewProps {
  url: string;
}

export function TargetPreview({ url }: TargetPreviewProps) {
  const [previewMode, setPreviewMode] = useState<'iframe' | 'link'>('iframe');

  return (
    <div className="target-preview">
      <div className="target-preview__header">
        <div className="target-preview__url">
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
            <ExternalLink size={14} />
          </a>
        </div>
        <div className="target-preview__controls">
          <Button
            size="sm"
            variant={previewMode === 'iframe' ? 'primary' : 'secondary'}
            onClick={() => setPreviewMode('iframe')}
          >
            Iframe
          </Button>
          <Button
            size="sm"
            variant={previewMode === 'link' ? 'primary' : 'secondary'}
            onClick={() => setPreviewMode('link')}
          >
            Link
          </Button>
        </div>
      </div>
      <div className="target-preview__content">
        {previewMode === 'iframe' ? (
          <IframePreview url={url} />
        ) : (
          <div className="target-preview__link-info">
            <p>Open the URL in a new tab to view the target</p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="target-preview__link-button"
            >
              Open {url}
              <ExternalLink size={16} />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
