// A file on its way up, drawn where its card will appear. States (see uploads.js):
//   uploading  the file's type and a progress bar; × cancels
//   resuming   picked up again after a reload: "Resuming from 50 MB"
//   paused     no connection: amber, "resumes when back online"
//   waiting    another tab of ZBoard is sending it
//   failed     red, a ✕ in the middle and why; tapping it chooses the file again (or retries), the bin removes it
import { Icon } from './icons.jsx';
import { formatBytes } from './Menu.jsx';
import { DEFAULT_W } from './util.js';

export default function UploadCard({ u, onCancel, onFailedTap, onRemove }) {
  const pct = u.total ? Math.min(100, Math.floor((u.sent / u.total) * 100)) : 0;
  const ext = u.kind === 'pdf' ? 'PDF' : u.kind === 'image' ? 'IMG' : (/\.([a-z0-9]{1,5})$/i.exec(u.name)?.[1] || 'FILE').toUpperCase();
  const failed = u.status === 'failed';
  const stop = (e) => e.stopPropagation();
  const of = `${formatBytes(u.sent)} of ${formatBytes(u.total)}`;
  const facts =
    u.status === 'paused'
      ? `${of} · resumes when back online`
      : u.status === 'waiting'
        ? `${of} · uploading in another tab`
        : u.status === 'resuming'
          ? `Resuming from ${formatBytes(u.resumedFrom ?? u.sent)} · ${pct}%`
          : pct >= 100
            ? 'Saving…'
            : `${of} · ${pct}%`;
  const tile = failed ? (
    <span className="upl-fail-x">
      <Icon name="x" size={24} />
    </span>
  ) : u.status === 'paused' ? (
    <span className="upl-doc">
      <Icon name="wifiOff" size={30} />
      <b>Paused</b>
    </span>
  ) : u.status === 'resuming' || u.status === 'waiting' ? (
    <span className="upl-doc">
      <Icon name="refresh" size={30} />
      <b>{u.status === 'waiting' ? 'Waiting' : 'Resuming'}</b>
    </span>
  ) : (
    <span className="upl-doc">
      <Icon name={u.kind === 'image' ? 'image' : 'file'} size={34} />
      <b>{ext}</b>
    </span>
  );
  return (
    <div
      className={`card card-uploading st-${u.status}${failed && onFailedTap ? ' tappable' : ''}`}
      style={{ left: u.x, top: u.y, width: DEFAULT_W.file, zIndex: 1e6 }}
      data-upload={u.id}
      role={failed && onFailedTap ? 'button' : 'status'}
      tabIndex={failed && onFailedTap ? 0 : undefined}
      aria-label={failed ? `${u.name}: ${u.message}` : `Uploading ${u.name}, ${pct}%`}
      onPointerDown={failed && onFailedTap ? stop : undefined}
      onClick={failed && onFailedTap ? onFailedTap : undefined}
      onKeyDown={failed && onFailedTap ? (e) => (e.key === 'Enter' || e.key === ' ') && onFailedTap() : undefined}
    >
      <div className={'upl-tile kind-' + u.kind}>{tile}</div>
      <div className="upl-meta">
        <div className="upl-name">{u.name}</div>
        {failed ? (
          <div className="upl-reason">{u.message}</div>
        ) : (
          <>
            <div className="upl-bar">
              <i style={{ width: pct + '%' }} />
            </div>
            <div className="upl-facts">{facts}</div>
          </>
        )}
      </div>
      {failed
        ? onRemove && (
            <button
              className="upl-cancel"
              aria-label={`Remove ${u.name}`}
              data-tip="Remove"
              onPointerDown={stop}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )
        : pct < 100 &&
          onCancel && (
            <button className="upl-cancel" aria-label={`Cancel uploading ${u.name}`} data-tip="Cancel" onPointerDown={stop} onClick={onCancel}>
              <Icon name="x" size={14} />
            </button>
          )}
    </div>
  );
}
