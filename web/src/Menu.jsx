import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { DEMO, REPO_URL, resetDemo } from './demo.js';

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
const when = (t) => (t ? new Date(t).toLocaleString() : 'never');

// Files go up one by one, then the database snapshot. Measured in bytes, so big files count for more.
function DriveProgress({ p, label: override }) {
  let label = override || 'Getting ready…';
  let frac = 0;
  if (p?.phase === 'files' && p.total) {
    frac = p.total_bytes ? p.bytes / p.total_bytes : p.done / p.total;
    label = `Uploading files ${p.done} of ${p.total} · ${formatBytes(p.bytes)} of ${formatBytes(p.total_bytes)}`;
  } else if (p?.phase === 'snapshot') {
    frac = 1;
    label = p.total ? `Files done (${p.total}) · uploading the database snapshot…` : 'Uploading the database snapshot…';
  }
  return (
    <div className="drive-progress">
      <div className="progress" role="progressbar" aria-label="Backup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
        <div className={p ? 'progress-fill' : 'progress-fill indeterminate'} style={p ? { width: `${Math.max(2, frac * 100)}%` } : undefined} />
      </div>
      <div className="muted">{label}</div>
    </div>
  );
}

const dateOnly = (t) => new Date(t).toLocaleDateString();
const isPicture = (f) => (f.mime || '').startsWith('image/') || /^\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.ext || '');

// The Google Drive mark, for the Drive buttons.
const DriveLogo = () => (
  <svg className="drive-logo" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path fill="#00ac47" d="M8.6 3.3 1 16.5l3.8 6.6 7.6-13.2z" />
    <path fill="#ffba00" d="M8.6 3.3h6.8L23 16.5h-7.6z" />
    <path fill="#2684fc" d="M4.8 23.1h14.4l3.8-6.6H8.6z" />
  </svg>
);
const mark = (part) => (!part ? null : part.ok ? '✓' : part.skipped ? 'postponed' : '✗');

// Backup & Restore: the full backup (this PC, then Google Drive, every N days; see server/src/plan.js),
// Google Drive's connection and Restore, and the unused-files cleanup, in one section.
// cleanupBusy: unused files are being removed (this tab started it); the server's `paused` covers other tabs.
function BackupSection({ cleanupBusy, onCleanupBusy }) {
  const [b, setB] = useState(null); // /api/backup: the plan and the local backups
  const [d, setD] = useState(null); // /api/drive
  const [busy, setBusy] = useState(null); // 'backup' | 'restore' | 'disconnect' | 'connect' | 'days'
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    api('GET', '/api/backup').then(setB).catch((e) => setError(e.message));
    api('GET', '/api/drive').then(setD).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, cleanupBusy]);
  // Poll while backing up (every second, for the progress bar), signing in, or paused by the cleanup.
  const paused = cleanupBusy || d?.paused;
  const uploading = d?.running || b?.running || busy === 'backup';
  useEffect(() => {
    const active = uploading || (d?.pending && !d.pending.error) || paused;
    if (!active) return;
    const t = setInterval(refresh, uploading ? 1000 : 2500);
    return () => clearInterval(t);
  }, [uploading, d?.pending, paused, refresh]);

  async function act(name, fn) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  const setDays = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 30 && n !== b.every_days) act('days', () => api('PATCH', '/api/backup', { every_days: n }));
  };

  const last = b?.last;
  const driveOn = d?.connected;
  return (
    <section className="menu-section">
      <h4>Backup & Restore</h4>
      {b && d ? (
        <>
          <dl className="kv">
            <dt>Last backup</dt>
            <dd>
              {last ? (
                <>
                  {when(last.at)} · this PC {mark(last.local)}
                  {last.drive && ` · Google Drive ${mark(last.drive)}`}
                </>
              ) : b.status?.ok ? (
                `${when(b.status.at)} · this PC ✓` // made before the full backup existed (or by an older version)
              ) : (
                'never'
              )}
            </dd>
            <dt>
              <label htmlFor="backup-days">Back up every</label>
            </dt>
            <dd>
              <input
                id="backup-days"
                className="days-input"
                type="number"
                min={1}
                max={30}
                key={b.every_days}
                defaultValue={b.every_days}
                disabled={busy === 'days'}
                onBlur={(e) => setDays(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />{' '}
              day{b.every_days === 1 ? '' : 's'} · next {b.next_due && b.next_due > Date.now() ? dateOnly(b.next_due) : 'now'}
            </dd>
            <dt>Kept</dt>
            <dd>
              {b.keep} on this PC{driveOn ? ` · ${b.drive_keep} on Google Drive` : ''}
            </dd>
            <dt>Folder</dt>
            <dd className="path">{b.dir}</dd>
            <dt>Google Drive</dt>
            <dd>
              {!d.configured
                ? 'not set up'
                : driveOn
                  ? `connected${d.encrypted ? ' · encrypted' : ''}${d.last_sync ? ` · last upload ${when(d.last_sync)}` : ''}`
                  : 'not connected'}
            </dd>
          </dl>
          {last?.local && !last.local.ok && <div className="error-text">This PC: {last.local.error}</div>}
          {last?.drive && !last.drive.ok && <div className={last.drive.skipped ? 'muted' : 'error-text'}>Google Drive: {last.drive.error || last.drive.skipped}</div>}
          {d.last_error && driveOn && <div className="error-text">Google Drive: {d.last_error}</div>}
          {!d.configured && <div className="muted backup-note">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to also back up to Google Drive (see README).</div>}
          {d.pending && !d.pending.error && (
            <div className="drive-code">
              <div>
                Open <a href={d.pending.verification_url} target="_blank" rel="noreferrer">{d.pending.verification_url}</a> and enter:
              </div>
              <div className="code">{d.pending.user_code}</div>
              <div className="muted">Waiting for you to approve…</div>
            </div>
          )}
          {d.pending?.error && <div className="error-text">{d.pending.error}</div>}
          {(d.running || busy === 'backup') && <DriveProgress p={d.running ? d.progress : null} label={busy === 'backup' && !d.running ? 'Saving to this PC…' : null} />}
          {paused && <div className="muted drive-paused">Google Drive is paused while unused files are being removed. Restore and Disconnect come back when that has finished.</div>}
          {!paused && uploading && driveOn && <div className="muted drive-paused">Restore and Disconnect come back when the backup has finished.</div>}
          <div className="menu-buttons one-row">
            <button disabled={!!busy || uploading} onClick={() => act('backup', () => api('POST', '/api/backup'))}>
              {uploading ? 'Backing up…' : 'Back up now'}
            </button>
            {driveOn && (
              <button
                disabled={!!busy || paused || uploading}
                aria-label="Restore from Google Drive"
                data-tip="Restore from Google Drive"
                onClick={() => window.confirm('Replace everything on this server with the newest Google Drive backup?') && act('restore', () => api('POST', '/api/drive/restore'))}
              >
                {busy === 'restore' ? 'Restoring…' : 'Restore'} <DriveLogo />
              </button>
            )}
            {driveOn && (
              <button disabled={!!busy || paused || uploading} aria-label="Disconnect Google Drive" data-tip="Disconnect Google Drive" onClick={() => act('disconnect', () => api('POST', '/api/drive/disconnect'))}>
                Disconnect <DriveLogo />
              </button>
            )}
            {d.configured && !driveOn && !(d.pending && !d.pending.error) && (
              <button disabled={!!busy} onClick={() => act('connect', () => api('POST', '/api/drive/connect'))}>
                Connect Google Drive
              </button>
            )}
          </div>
          {error && <div className="error-text">{error}</div>}
          <CleanupSection onBusy={onCleanupBusy} />
        </>
      ) : (
        <div className="muted">Loading…</div>
      )}
    </section>
  );
}

// Files no card uses any more: how many wait, and when they go (see server/src/cleanup.js).
// A "Clean up now" removal runs on the server in the background; this shows its progress and result.
function CleanupSection({ onBusy }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(null); // 'check' | 'find' | null
  const [error, setError] = useState(null);
  const [found, setFound] = useState(null); // what "Clean up now" may remove, shown in the confirm window
  const [done, setDone] = useState(null);
  const removing = useRef(false); // a removal this section started is running
  const refresh = useCallback(() => api('GET', '/api/cleanup').then(setS).catch((e) => setError(e.message)), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    onBusy?.(Boolean(s?.running));
    if (!s?.running) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [s?.running, onBusy, refresh]);
  // The removal finished: say how it went.
  useEffect(() => {
    if (!removing.current || !s || s.running) return;
    removing.current = false;
    if (s.last_error) setError(`Stopped after removing ${s.last_removed}: ${s.last_error}`);
    else setDone(`Removed ${s.last_removed} file${s.last_removed === 1 ? '' : 's'} and freed ${formatBytes(s.last_freed)}.`);
  }, [s]);

  async function runNow() {
    setBusy('check');
    setError(null);
    setDone(null);
    try {
      setS(await api('POST', '/api/cleanup'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Reads every kept backup first (Drive ones are downloaded), then asks before removing anything.
  async function cleanUpNow() {
    setBusy('find');
    setError(null);
    setDone(null);
    try {
      setFound(await api('POST', '/api/cleanup/check'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const schedule = (cron) => (cron === 'off' ? 'never (off)' : cron === '0 4 1 * *' ? 'monthly' : cron);
  return (
    <div className="menu-sub" role="group" aria-labelledby="unused-title">
      <h5 id="unused-title">Unused files</h5>
      {s ? (
        <>
          <dl className="kv">
            <dt>Waiting</dt>
            <dd>{s.unused.count ? `${s.unused.count} (${formatBytes(s.unused.bytes)})` : 'none'}</dd>
            <dt>Removed</dt>
            <dd>
              after {s.after_days} days unused · checked {schedule(s.cron)}
            </dd>
            <dt>Last check</dt>
            <dd className={s.last_error ? 'error-text' : ''}>
              {s.last_run ? `${when(s.last_run)} · removed ${s.last_removed}${s.last_freed ? ` (${formatBytes(s.last_freed)})` : ''}` : 'never'}
              {s.last_error ? ` · ${s.last_error}` : ''}
            </dd>
          </dl>
          <div className="muted cleanup-note">
            Files no card uses any more. Each is removed everywhere (here, local backup, Google Drive) once unused for {s.after_days} days and older
            than every backup still kept, so restoring a backup never misses a file.
          </div>
          {s.job && <CleanupProgress job={s.job} />}
          <div className="menu-buttons">
            <button onClick={runNow} disabled={!!busy || s.running}>
              {busy === 'check' ? 'Checking…' : 'Check now'}
            </button>
            <button className="danger-button" onClick={cleanUpNow} disabled={!!busy || s.running || !s.unused.count}>
              {busy === 'find' ? 'Checking backups…' : 'Clean up now…'}
            </button>
          </div>
        </>
      ) : (
        <div className="muted">Loading…</div>
      )}
      {done && <div className="ok-text">{done}</div>}
      {error && <div className="error-text">{error}</div>}
      {found && (
        <CleanupConfirm
          found={found}
          onClose={() => setFound(null)}
          onStarted={(st) => {
            removing.current = true;
            setFound(null);
            setS(st);
          }}
        />
      )}
    </div>
  );
}

function CleanupProgress({ job }) {
  const removing = job.phase === 'removing';
  const frac = removing && job.total ? job.removed / job.total : 0;
  return (
    <div className="drive-progress">
      <div className="progress" role="progressbar" aria-label="Cleanup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
        <div className={removing ? 'progress-fill' : 'progress-fill indeterminate'} style={removing ? { width: `${Math.max(2, frac * 100)}%` } : undefined} />
      </div>
      <div className="muted">
        {removing ? `Removing ${job.removed} of ${job.total} · ${formatBytes(job.freed)} freed` : 'Checking backups once more…'} · you can keep working
      </div>
    </div>
  );
}

// The confirm window for "Clean up now": what goes, from where, and that it can't be brought back.
// Remove only starts the removal (it runs in the background on the server), so the window closes at once.
function CleanupConfirm({ found, onClose, onStarted }) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && !removing && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, removing]);

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      onStarted(await api('POST', '/api/cleanup/remove', { ids: found.files.map((f) => f.id) }));
    } catch (e) {
      setError(e.message);
      setRemoving(false);
    }
  }

  const n = found.count;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const backups = [plural(found.checked.local, 'local backup', 'local backups'), found.drive && plural(found.checked.drive, 'Google Drive backup', 'Google Drive backups')].filter(Boolean).join(' and ');
  const shown = found.files.slice(0, 18);
  return (
    <div className="overlay confirm-overlay" onPointerDown={(e) => e.target === e.currentTarget && !removing && onClose()}>
      <div className="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="cleanup-title" aria-describedby="cleanup-loss">
        {n ? (
          <>
            <h3 id="cleanup-title">Permanently remove {plural(n, 'unused file', 'unused files')}?</h3>
            <p className="confirm-lead">
              <strong>{formatBytes(found.bytes)}</strong> · no board, card or saved item uses {n === 1 ? 'it' : 'them'},{' '}
              {found.checked.local + found.checked.drive ? `and none of your ${backups} contains ${n === 1 ? 'it' : 'them'}.` : 'and there is no backup that could need them.'}
            </p>
            <div className="confirm-thumbs" aria-label="Files that will be removed">
              {shown.map((f) => {
                const title = `${f.name || f.id} · ${formatBytes(f.size)}`;
                // Pictures show their preview; any other file (PDF, ZIP…) a tile with its type.
                return isPicture(f) ? (
                  <img key={f.id} src={`/files/${f.id}/thumb`} alt={f.name || ''} title={title} loading="lazy" />
                ) : (
                  <div key={f.id} className="confirm-file" title={title}>
                    <span>{(f.ext || '').replace('.', '').toUpperCase() || 'FILE'}</span>
                  </div>
                );
              })}
              {n > shown.length && <div className="confirm-more">+{n - shown.length} more</div>}
            </div>
            <div className="confirm-where">
              <div>Deleted from:</div>
              <ul>
                <li>this computer: the original files and their previews</li>
                <li>the local backup folder</li>
                {found.drive && <li>Google Drive: the encrypted copies in “ZBoard Backup”</li>}
              </ul>
            </div>
            <div className="confirm-loss" id="cleanup-loss">
              <strong>This can’t be undone.</strong> Once removed, {n === 1 ? 'this file' : 'these files'} can’t be brought back: not with Undo, not from a local
              backup{found.drive ? ', not with a Google Drive restore' : ''}. Your boards stay exactly as they are, because none of them uses{' '}
              {n === 1 ? 'it' : 'these files'}.
            </div>
            {found.kept_by_backup > 0 && (
              <p className="muted">
                {plural(found.kept_by_backup, 'other unused file is', 'other unused files are')} still inside a kept backup, so{' '}
                {found.kept_by_backup === 1 ? 'it stays' : 'they stay'} until that backup is replaced.
              </p>
            )}
            {error && <div className="error-text">{error}</div>}
            <div className="confirm-buttons">
              <button ref={cancelRef} onClick={onClose} disabled={removing}>
                Cancel
              </button>
              <button className="danger-solid" onClick={remove} disabled={removing}>
                {removing ? 'Starting…' : `Remove ${plural(n, 'file', 'files')}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 id="cleanup-title">Nothing to remove right now</h3>
            <p id="cleanup-loss">
              {found.kept_by_backup
                ? `${plural(found.kept_by_backup, 'unused file is', 'unused files are')} still inside a kept backup (${backups}), so ${found.kept_by_backup === 1 ? 'it stays' : 'they stay'} until that backup is replaced. The monthly check removes ${found.kept_by_backup === 1 ? 'it' : 'them'} after that.`
                : 'Every file is in use.'}
            </p>
            <div className="confirm-buttons">
              <button ref={cancelRef} onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Copy that also works on plain-http LAN addresses, where navigator.clipboard is missing.
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const t = document.createElement('textarea');
  t.value = text;
  document.body.append(t);
  t.select();
  document.execCommand('copy');
  t.remove();
  return Promise.resolve();
}

function CopyField({ label, value }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-field">
      <label>{label}</label>
      <div className="copy-row">
        <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} />
        <button
          onClick={() =>
            copyText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {done ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function ExtensionSection() {
  const [token, setToken] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !token) api('GET', '/api/token').then((r) => setToken(r.token)).catch(() => {});
  }, [open, token]);
  async function rotate() {
    if (!window.confirm('Make a new token? The browser extension and the CLI stop working until you give them the new one.')) return;
    const r = await api('POST', '/api/token/rotate');
    setToken(r.token);
  }
  return (
    <section className="menu-section">
      <h4>Browser extension</h4>
      {!open ? (
        <div className="menu-buttons">
          <button onClick={() => setOpen(true)}>Set up ZBoard Clipper</button>
        </div>
      ) : (
        <>
          <ol className="steps">
            <li>
              <a href="/api/extension.zip" download>
                Download the extension
              </a>{' '}
              and unzip it.
            </li>
            <li>Open edge://extensions (or chrome://extensions), turn on Developer mode, choose “Load unpacked” and pick the unzipped folder.</li>
            <li>Click the ZBoard Clipper icon and paste these:</li>
          </ol>
          <CopyField label="Server address" value={location.origin} />
          <CopyField label="Token" value={token || '…'} />
          <div className="menu-buttons">
            <button onClick={rotate}>New token</button>
          </div>
        </>
      )}
    </section>
  );
}

export default function Menu({ boardId, boardTitle, onClose, onLogout }) {
  const [stats, setStats] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState(false); // pauses the Google Drive buttons

  useEffect(() => {
    api('GET', '/api/stats').then(setStats).catch(() => {});
  }, []);

  return (
    <div className="overlay clear" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="menu-panel scrolls" role="dialog" aria-label="Menu">
        <section className="menu-section">
          <h4>Stats</h4>
          {stats ? (
            <dl className="kv">
              <dt>Boards</dt>
              <dd>{stats.boards}</dd>
              <dt>Cards</dt>
              <dd>{stats.cards}</dd>
              <dt>Images & files</dt>
              <dd>{stats.files}</dd>
              <dt>Stored</dt>
              <dd>{formatBytes(stats.stored_bytes)}</dd>
              <dt>Database</dt>
              <dd>{formatBytes(stats.db_bytes)}</dd>
            </dl>
          ) : (
            <div className="muted">Loading…</div>
          )}
        </section>

        {DEMO ? (
          <section className="menu-section">
            <h4>About this demo</h4>
            <p className="muted">
              Everything you make is saved only in this browser: nothing is sent anywhere, and other people can't see it. Clearing the browser's site data
              removes it.
            </p>
            <p className="muted">
              Your own ZBoard adds what a server can do: every device in sync, Google Drive backups, the browser clipper, link previews and a terminal client.
            </p>
            <div className="menu-buttons">
              <a className="button" href={REPO_URL} target="_blank" rel="noreferrer">
                Get ZBoard on GitHub
              </a>
              <button onClick={() => confirm('Delete everything in this demo and start with an empty board?') && resetDemo()}>Start over</button>
            </div>
          </section>
        ) : (
          <>
            <BackupSection cleanupBusy={cleanupBusy} onCleanupBusy={setCleanupBusy} />
            <ExtensionSection />
          </>
        )}

        {!DEMO && (
        <section className="menu-section">
          <h4>Export</h4>
          <div className="menu-buttons">
            {boardId !== 'root' && (
              <a className="button" href={`/api/export/${boardId}`} download>
                Export “{boardTitle || 'this board'}”
              </a>
            )}
            <a className="button" href="/api/export/root" download>
              Export everything
            </a>
          </div>
        </section>
        )}

        {!DEMO && (
          <section className="menu-section">
            <div className="menu-buttons">
              <button onClick={onLogout}>Log out</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
