// Full-screen video player: the browser's own <video> (on an iPhone, its native controls and
// picture-in-picture). It streams from the server: only the part about to play is downloaded, and
// jumping ahead asks for that part. Nothing is kept afterwards (videos are too big to store here).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { videoUrl } from './video.js';

export default function VideoPlayer({ file, onClose }) {
  const [error, setError] = useState(false);
  const name = file.name || 'Video';

  useEffect(() => {
    const down = (e) => {
      if (e.key !== 'Escape') return; // other keys go to the video (space, arrows)
      e.preventDefault();
      e.stopPropagation();
      if (document.fullscreenElement) return; // the browser leaves full screen first
      onClose();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [onClose]);

  return createPortal(
    <div className="video-player" role="dialog" aria-label={name} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <header className="pdf-bar">
        <button className="pdf-btn" onClick={onClose} aria-label="Close" data-tip="Close (Esc)">
          <Icon name="x" size={20} />
        </button>
        <div className="pdf-title" title={name}>
          {name}
        </div>
        {/* target=_blank: on an iPhone home-screen app it opens over the app instead of replacing it. */}
        <a className="pdf-btn" href={videoUrl(file.id)} download={name} target="_blank" rel="noopener noreferrer" aria-label="Download" data-tip="Download">
          <Icon name="download" size={19} />
        </a>
      </header>
      <div className="video-stage">
        {error ? (
          <div className="pdf-msg">
            This video can&apos;t be played in this browser (its format isn&apos;t supported here).{' '}
            <a href={videoUrl(file.id)} target="_blank" rel="noopener noreferrer">
              Open it in a new window
            </a>
          </div>
        ) : (
          <video
            className="video-el"
            src={videoUrl(file.id)}
            poster={file.width ? `/files/${file.id}/thumb` : undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            onError={() => setError(true)}
          />
        )}
      </div>
    </div>,
    document.body
  );
}
