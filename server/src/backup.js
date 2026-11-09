// Backups: nightly local snapshots + file copies, and Google Drive (device sign-in, drive.file scope).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './db.js';

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A consistent copy of the live database, safe to take while the server runs.
export function snapshotTo(store, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  store.db.exec(`VACUUM INTO ${sqlString(file)}`);
}

// ---------- local ----------
export function createLocalBackups({ getStore, dataDir, backupDir, keep, log }) {
  const dbDir = path.join(backupDir, 'db');
  const filesDir = path.join(backupDir, 'files');
  let running = null;

  const status = () => JSON.parse(getStore().getMeta('backup_status') || 'null');

  function list() {
    if (!fs.existsSync(dbDir)) return [];
    return fs
      .readdirSync(dbDir)
      .filter((f) => /^zboard-.*\.db$/.test(f))
      .sort()
      .reverse()
      .map((name) => {
        const st = fs.statSync(path.join(dbDir, name));
        return { name, bytes: st.size, at: st.mtimeMs };
      });
  }

  function run() {
    if (running) return running;
    // `running` is cleared in .finally, which always runs after this assignment. (A try/finally inside
    // the async function did not: with no new files it finished before the assignment, left `running`
    // set to the finished promise, and every later backup, nightly ones too, returned the old result.)
    running = (async () => {
      const started = Date.now();
      try {
        fs.mkdirSync(filesDir, { recursive: true });
        const name = `zboard-${stamp()}.db`;
        const target = path.join(dbDir, name);
        snapshotTo(getStore(), target);
        // Originals never change, so copying new names is enough.
        let copied = 0;
        let bytes = 0;
        const src = path.join(dataDir, 'files');
        for (const f of fs.readdirSync(src)) {
          const from = path.join(src, f);
          const to = path.join(filesDir, f);
          const st = fs.statSync(from);
          if (!st.isFile() || (fs.existsSync(to) && fs.statSync(to).size === st.size)) continue;
          await fs.promises.copyFile(from, to + '.part');
          fs.renameSync(to + '.part', to);
          copied++;
          bytes += st.size;
        }
        for (const old of list().slice(keep)) fs.rmSync(path.join(dbDir, old.name), { force: true });
        const st = { ok: true, at: Date.now(), snapshot: name, snapshot_bytes: fs.statSync(target).size, files_copied: copied, bytes_copied: bytes, ms: Date.now() - started };
        getStore().setMeta('backup_status', JSON.stringify(st));
        log(`Backup: ${name}, ${copied} new file(s)`);
        return st;
      } catch (e) {
        getStore().setMeta('backup_status', JSON.stringify({ ok: false, at: Date.now(), error: e.message }));
        log('Backup failed: ' + e.message);
        throw e;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { run, list, status, dir: backupDir };
}

// ---------- Google Drive ----------
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const MAGIC = Buffer.from('ZBE1');
const qstr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function createDrive({ getStore, dataDir, clientId, clientSecret, passphrase, debounceMs = 90_000, keep = 30, log, onRestore, paused = () => false }) {
  // While the unused-file cleanup removes pictures (cleanup.js), Drive is left to it: Back up now,
  // Restore and Disconnect are refused, and an automatic backup waits until it has finished.
  const PAUSED = 'Google Drive is busy while unused files are being removed. Try again when that has finished.';
  const assertNotPaused = () => {
    if (paused()) throw new HttpError(409, PAUSED);
  };
  const oauthBase = process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
  const apiBase = process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
  const configured = Boolean(clientId && clientSecret);
  const getMeta = (k) => getStore().getMeta(k);
  const setMeta = (k, v) => getStore().setMeta(k, v);
  const state = () => JSON.parse(getMeta('drive_state') || '{}');
  const saveState = (patch) => setMeta('drive_state', JSON.stringify({ ...state(), ...patch }));
  const connected = () => Boolean(getMeta('drive_refresh_token'));

  let pending = null; // device sign-in in progress
  let token = null;
  let timer = null;
  let running = null;
  let dirty = false;
  // While a backup runs: { phase: 'files' | 'snapshot', done, total, bytes, total_bytes } for the progress bar.
  let progress = null;

  function status() {
    const s = state();
    return {
      configured,
      connected: connected(),
      encrypted: Boolean(passphrase),
      pending: pending && { user_code: pending.user_code, verification_url: pending.verification_url, expires_at: pending.expires_at, error: pending.error },
      last_sync: s.last_sync ?? null,
      files_copied: s.files_copied ?? 0,
      last_copied: s.last_copied ?? 0,
      last_snapshot: s.last_snapshot ?? null,
      snapshots: s.snapshots ?? 0,
      last_error: s.last_error ?? null,
      running: Boolean(running),
      progress: running ? progress : null,
      paused: Boolean(paused()),
      dirty,
    };
  }

  async function form(url, params) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function connect() {
    if (!configured) throw new HttpError(400, 'Google Drive is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).');
    const r = await form(`${oauthBase}/device/code`, { client_id: clientId, scope: SCOPE });
    if (!r.ok) throw new HttpError(502, `Google refused the sign-in request: ${r.data.error_description || r.data.error || r.status}`);
    const mine = {
      user_code: r.data.user_code,
      verification_url: r.data.verification_url || r.data.verification_uri,
      expires_at: Date.now() + (r.data.expires_in || 1800) * 1000,
      error: null,
    };
    pending = mine;
    poll(r.data.device_code, (r.data.interval || 5) * 1000, mine);
    return status().pending;
  }

  async function poll(deviceCode, interval, mine) {
    while (pending === mine && Date.now() < mine.expires_at) {
      await sleep(interval);
      if (pending !== mine) return;
      const r = await form(`${oauthBase}/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (r.ok && r.data.refresh_token) {
        setMeta('drive_refresh_token', r.data.refresh_token);
        token = { access_token: r.data.access_token, expires_at: Date.now() + ((r.data.expires_in || 3600) - 60) * 1000 };
        pending = null;
        saveState({ last_error: null, reconciled: false });
        log('Google Drive connected');
        // A fresh, empty server must not upload an empty snapshot over the backup it is about to restore.
        if (getStore().stats().cards > 0) schedule(3000);
        return;
      }
      const err = r.data.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        interval += 5000;
        continue;
      }
      mine.error = err === 'access_denied' ? 'Sign-in was declined.' : err === 'expired_token' ? 'The code expired. Press Connect again.' : `Sign-in failed: ${r.data.error_description || err || r.status}`;
      return;
    }
    if (pending === mine && !mine.error) mine.error = 'The code expired. Press Connect again.';
  }

  async function accessToken() {
    if (token && token.expires_at > Date.now()) return token.access_token;
    const refresh = getMeta('drive_refresh_token');
    if (!refresh) throw new HttpError(400, 'Google Drive is not connected');
    const r = await form(`${oauthBase}/token`, { client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
    if (!r.ok) {
      if (r.data.error === 'invalid_grant') setMeta('drive_refresh_token', '');
      throw new Error(`Google sign-in expired or was revoked (${r.data.error_description || r.data.error || r.status}). Connect again.`);
    }
    token = { access_token: r.data.access_token, expires_at: Date.now() + ((r.data.expires_in || 3600) - 60) * 1000 };
    return token.access_token;
  }

  async function api(method, pathname, { query = {}, json, body, headers = {}, raw = false } = {}) {
    const url = new URL(apiBase + pathname);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
    if (!res.ok) throw new Error(`Drive ${method} ${url.pathname} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  async function listAll(q, orderBy) {
    const out = [];
    let pageToken;
    do {
      const query = { q, fields: 'nextPageToken,files(id,name,createdTime,size)', pageSize: '1000', spaces: 'drive' };
      if (orderBy) query.orderBy = orderBy;
      if (pageToken) query.pageToken = pageToken;
      const r = await api('GET', '/drive/v3/files', { query });
      out.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async function folder(name, parent) {
    const q = `name = ${qstr(name)} and mimeType = '${FOLDER}' and trashed = false${parent ? ` and ${qstr(parent)} in parents` : ''}`;
    const found = await listAll(q, 'createdTime');
    if (found.length) return found[0].id;
    return (await api('POST', '/drive/v3/files', { query: { fields: 'id' }, json: { name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) } })).id;
  }

  async function folders() {
    const cached = JSON.parse(getMeta('drive_folders') || 'null');
    if (cached?.root) return cached;
    const root = await folder('ZBoard Backup');
    const f = { root, files: await folder('files', root), snapshots: await folder('snapshots', root) };
    setMeta('drive_folders', JSON.stringify(f));
    return f;
  }

  async function upload(name, parent, buf) {
    const init = await api('POST', '/upload/drive/v3/files', {
      query: { uploadType: 'resumable', fields: 'id' },
      json: { name, parents: [parent] },
      headers: { 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(buf.length) },
      raw: true,
    });
    const res = await fetch(init.headers.get('location'), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    if (!res.ok) throw new Error(`Drive upload of ${name} failed: ${res.status}`);
    return (await res.json()).id;
  }

  const download = async (id) => Buffer.from(await (await api('GET', `/drive/v3/files/${id}`, { query: { alt: 'media' }, raw: true })).arrayBuffer());

  // ---- optional passphrase encryption: "ZBE1" | salt(16) | iv(12) | tag(16) | ciphertext ----
  const keys = new Map();
  const keyFor = (salt) => {
    const k = salt.toString('hex');
    if (!keys.has(k)) keys.set(k, crypto.scryptSync(passphrase, salt, 32));
    return keys.get(k);
  };
  function encrypt(buf) {
    if (!passphrase) return buf;
    let salt = getMeta('drive_salt');
    if (!salt) setMeta('drive_salt', (salt = crypto.randomBytes(16).toString('hex')));
    const s = Buffer.from(salt, 'hex');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyFor(s), iv);
    const body = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([MAGIC, s, iv, c.getAuthTag(), body]);
  }
  function decrypt(buf) {
    if (!buf.subarray(0, 4).equals(MAGIC)) return buf;
    if (!passphrase) throw new HttpError(400, 'This backup is encrypted: set GOOGLE_BACKUP_PASSPHRASE in .env and restart.');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(buf.subarray(4, 20)), buf.subarray(20, 32));
    d.setAuthTag(buf.subarray(32, 48));
    try {
      return Buffer.concat([d.update(buf.subarray(48)), d.final()]);
    } catch {
      throw new HttpError(400, 'Wrong backup passphrase.');
    }
  }

  // snapshotFile: upload this database snapshot (the one the scheduled backup just saved locally, so
  // both places hold the same backup) instead of making a new one.
  function sync(reason = 'manual', { snapshotFile = null } = {}) {
    if (!connected()) return Promise.reject(new HttpError(400, 'Google Drive is not connected'));
    if (paused()) {
      if (reason === 'manual') return Promise.reject(new HttpError(409, PAUSED));
      dirty = true; // try again a little later
      schedule(debounceMs);
      return Promise.resolve(status());
    }
    if (running) return running;
    if (reason !== 'manual' && getStore().stats().cards === 0) return Promise.resolve(status());
    running = (async () => {
      dirty = false;
      clearTimeout(timer);
      try {
        const f = await folders();
        const suffix = passphrase ? '.enc' : '';
        // After (re)connecting, adopt originals already in Drive instead of uploading twice.
        if (!state().reconciled) {
          const there = new Map((await listAll(`${qstr(f.files)} in parents and trashed = false`)).map((x) => [x.name, x.id]));
          for (const file of getStore().filesNotOnDrive()) {
            const id = there.get(file.id + file.ext + suffix);
            if (id) getStore().markOnDrive(file.id, id);
          }
          saveState({ reconciled: true });
        }
        let copied = 0;
        const todo = getStore()
          .filesNotOnDrive()
          .map((file) => ({ file, p: path.join(dataDir, 'files', file.id + file.ext) }))
          .filter(({ p }) => fs.existsSync(p));
        progress = { phase: 'files', done: 0, total: todo.length, bytes: 0, total_bytes: todo.reduce((n, { file }) => n + (file.size || 0), 0) };
        for (const { file, p } of todo) {
          getStore().markOnDrive(file.id, await upload(file.id + file.ext + suffix, f.files, encrypt(await fs.promises.readFile(p))));
          copied++;
          progress = { ...progress, done: copied, bytes: progress.bytes + (file.size || 0) };
        }
        progress = { ...progress, phase: 'snapshot' };
        const own = !snapshotFile;
        const tmp = snapshotFile || path.join(dataDir, 'tmp', `drive-${Date.now()}.db`);
        if (own) snapshotTo(getStore(), tmp);
        const name = (own ? `zboard-${stamp()}.db` : path.basename(snapshotFile)) + suffix;
        try {
          await upload(name, f.snapshots, encrypt(await fs.promises.readFile(tmp)));
        } finally {
          if (own) fs.rmSync(tmp, { force: true });
        }
        const snaps = await listAll(`${qstr(f.snapshots)} in parents and trashed = false`, 'createdTime desc');
        for (const old of snaps.slice(keep)) await api('DELETE', `/drive/v3/files/${old.id}`);
        saveState({ last_sync: Date.now(), files_copied: (state().files_copied || 0) + copied, last_copied: copied, last_snapshot: name, snapshots: Math.min(snaps.length, keep), last_error: null });
        log(`Drive backup (${reason}): ${name}, ${copied} new file(s)`);
        return status();
      } catch (e) {
        if (/ 404 /.test(e.message)) setMeta('drive_folders', '');
        saveState({ last_error: e.message, last_error_at: Date.now() });
        log('Drive backup failed: ' + e.message);
        throw e;
      } finally {
        running = null;
        progress = null;
        if (dirty) schedule(debounceMs);
      }
    })();
    return running;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => sync('after edits').catch(() => {}), ms);
    timer.unref?.();
  }

  // Called after every successful write; the upload happens once edits have stopped.
  function markDirty() {
    if (!connected()) return;
    dirty = true;
    if (!running) schedule(debounceMs);
  }

  // Restore and Disconnect wait for no upload: cutting Drive off (or replacing everything) halfway
  // through a backup would leave Drive and this server's list of what's on it out of step.
  const assertNotUploading = () => {
    if (running) throw new HttpError(409, 'A backup is uploading to Google Drive. Try again when it has finished.');
  };

  async function disconnect() {
    assertNotPaused();
    assertNotUploading();
    pending = null;
    clearTimeout(timer);
    const refresh = getMeta('drive_refresh_token');
    if (refresh) await fetch(`${oauthBase}/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
    setMeta('drive_refresh_token', '');
    setMeta('drive_folders', '');
    saveState({ reconciled: false, last_error: null });
    getStore().clearDriveFiles();
    token = null;
    return status();
  }

  // Download the newest snapshot and every original it lists, then hand over to the server to swap databases.
  async function restore() {
    assertNotPaused();
    assertNotUploading();
    const f = await folders();
    const snaps = await listAll(`${qstr(f.snapshots)} in parents and trashed = false`, 'createdTime desc');
    if (!snaps.length) throw new HttpError(404, 'No ZBoard snapshots found in Google Drive.');
    const latest = snaps[0];
    const tmp = path.join(dataDir, 'tmp', `restore-${Date.now()}.db`);
    fs.writeFileSync(tmp, decrypt(await download(latest.id)));
    const snap = new DatabaseSync(tmp, { readOnly: true });
    const rows = snap.prepare('SELECT f.id, f.ext, d.drive_id FROM files f LEFT JOIN drive_files d ON d.local_id = f.id').all();
    snap.close();
    let fetched = 0;
    let missing = 0;
    for (const r of rows) {
      const p = path.join(dataDir, 'files', r.id + r.ext);
      if (fs.existsSync(p)) continue;
      if (!r.drive_id) {
        missing++;
        continue;
      }
      fs.writeFileSync(p, decrypt(await download(r.drive_id)));
      fetched++;
    }
    await onRestore(tmp);
    log(`Restored ${latest.name} from Google Drive: ${fetched} file(s) downloaded, ${missing} missing`);
    return { snapshot: latest.name, files_fetched: fetched, files_missing: missing };
  }

  // For the unused-file cleanup: the snapshots kept in Drive (oldest first), one of them decrypted
  // (a SQLite database), and removing one picture's copy (already gone counts as removed).
  async function keptSnapshots() {
    const f = await folders();
    return listAll(`${qstr(f.snapshots)} in parents and trashed = false`, 'createdTime');
  }
  const readSnapshot = async (id) => decrypt(await download(id));
  async function oldestSnapshotAt() {
    const [first] = await keptSnapshots();
    return first ? Date.parse(first.createdTime) : null;
  }
  async function removeFile(driveId) {
    try {
      await api('DELETE', `/drive/v3/files/${driveId}`);
    } catch (e) {
      if (!/ 404 /.test(e.message)) throw e;
    }
  }

  // Resolves once a backup already uploading has finished (the cleanup waits for it before starting).
  const idle = () => (running ? running.then(() => {}, () => {}) : Promise.resolve());

  return { status, connect, disconnect, sync, markDirty, restore, connected, idle, oldestSnapshotAt, keptSnapshots, readSnapshot, removeFile };
}
