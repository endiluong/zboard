// Resumable uploads for big files (more than one piece). The file is first copied into this browser's
// storage (IndexedDB), then sent to the server in pieces (server/src/uploads.js). A dropped connection
// pauses it and it carries on when the connection is back; a closed page, a reload or iOS stopping the
// app carries on the next time ZBoard is opened, from the last piece the server has. Once the server
// has every piece, the card is made on the board it was dropped on, and the copy is deleted.
//
// Jobs live here, not in a board, so an upload keeps going while you move between boards. Boards show
// their own jobs as placeholder cards (subscribe) and place the card when one finishes (onFinished).
import { api, clientId } from './api.js';
import { isPdf } from './pdf.js';

export const PIECE = 5 * 1024 * 1024; // same as the server's
// An unfinished upload this browser knows nothing about (its copy was cleared, or it belongs to another
// device that went quiet) is shown as failed, so it can be finished by choosing the file again.
const QUIET_ELSEWHERE_MS = 20_000;
const RETRY_MS = [2000, 5000, 10000, 30000];

// ---------- the copy in IndexedDB ----------
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('zb-uploads', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('jobs', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('jobs', mode);
    const req = fn(tx.objectStore('jobs'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
const saveCopy = (rec) => idb('readwrite', (s) => s.put(rec));
const loadCopy = (id) => idb('readonly', (s) => s.get(id)).catch(() => null);
const dropCopy = (id) => idb('readwrite', (s) => s.delete(id)).catch(() => {});
const allCopies = () => idb('readonly', (s) => s.getAll()).catch(() => []);

// ---------- state ----------
// job: { id, name, mime, size, kind, board_id, x, y, sent, total, status, reason, message, hasCopy }
// status: uploading | resuming | paused | waiting (another tab has it) | failed
const jobs = new Map();
const blobs = new Map(); // id → the File/Blob being sent
const aborts = new Map(); // id → abort the piece on its way
const cancelled = new Set();
const listeners = new Set();
const finishers = new Set();

const kindOf = (name, mime) => (/^image\//.test(mime || '') ? 'image' : isPdf({ name, mime }) ? 'pdf' : 'file');
const emit = () => {
  const list = [...jobs.values()];
  for (const fn of listeners) fn(list);
};
const set = (id, patch) => {
  const j = jobs.get(id);
  if (!j) return;
  jobs.set(id, { ...j, ...patch });
  emit();
};
export const getJobs = () => [...jobs.values()];
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// fn({ card, file, movedHome }) when an upload has become a card.
export function onFinished(fn) {
  finishers.add(fn);
  return () => finishers.delete(fn);
}

// ---------- sending ----------
async function sha256(buf) {
  if (!crypto?.subtle) return ''; // plain http on a LAN address: the server still checks sizes
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function putPiece(id, n, buf, hash, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${id}/pieces/${n}`);
    xhr.setRequestHeader('X-Client-Id', clientId);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (hash) xhr.setRequestHeader('X-Piece-Sha256', hash);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = '';
      try {
        msg = JSON.parse(xhr.responseText).error;
      } catch {}
      const err = new Error(msg || `Upload failed (${xhr.status})`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Connection lost'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    aborts.set(id, () => xhr.abort());
    xhr.send(buf);
  });
}

// Wait before trying again: until the connection is back, or a growing delay.
function pause(tries) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      removeEventListener('online', done);
      resolve();
    };
    const t = navigator.onLine === false ? null : setTimeout(done, RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]);
    addEventListener('online', done);
  });
}

const FAIL = {
  expired: 'This upload expired after 7 days. Tap to choose the file again.',
  lost: "This upload didn't finish, and this browser no longer has its copy. Tap to choose the file and finish it.",
  space: 'The server is out of space. Free some, then tap to try again.',
};
const fail = (id, reason, message) => set(id, { status: 'failed', reason, message: message || FAIL[reason] });

async function placeCard(r) {
  const card = {
    type: r.file.width && !isPdf(r.file) ? 'image' : 'file',
    x: r.x,
    y: r.y,
    w: r.file.width && !isPdf(r.file) ? 240 : 220,
    data: { fileId: r.file.id, caption: '' },
  };
  try {
    return { card: (await api('POST', `/api/boards/${encodeURIComponent(r.board_id)}/cards`, { cards: [card] })).cards[0], movedHome: false };
  } catch (e) {
    if (e.status !== 404) throw e;
    // The board was deleted meanwhile: the file goes to Home rather than nowhere.
    return { card: (await api('POST', '/api/boards/root/cards', { cards: [card] })).cards[0], movedHome: true };
  }
}

// One upload, from wherever the server is. verify: the file was chosen again, so pieces the server
// already has are compared with it (by checksum) and sent again if they differ.
async function send(id, { verify = false, fresh = false } = {}) {
  const blob = blobs.get(id);
  let tries = 0;
  let firstPiece = true;
  for (;;) {
    if (cancelled.has(id)) return;
    try {
      const up = (await api('GET', `/api/uploads/${id}`)).upload;
      const have = new Set(up.received);
      let sent = up.received_bytes;
      const todo = [];
      for (let n = 0; n < up.pieces; n++) {
        if (!have.has(n)) todo.push(n);
        else if (verify && crypto?.subtle) {
          const buf = await blob.slice(n * up.piece_size, (n + 1) * up.piece_size).arrayBuffer();
          if ((await sha256(buf)) !== up.hashes[n]) {
            todo.push(n);
            sent -= buf.byteLength;
          }
        }
      }
      todo.sort((a, b) => a - b);
      verify = false;
      set(id, { sent, total: up.size, status: !fresh && firstPiece && sent > 0 ? 'resuming' : 'uploading', reason: null, message: null, resumedFrom: !fresh && sent > 0 ? sent : null });
      for (const n of todo) {
        if (cancelled.has(id)) return;
        const buf = await blob.slice(n * up.piece_size, Math.min(up.size, (n + 1) * up.piece_size)).arrayBuffer();
        const hash = await sha256(buf);
        const base = sent;
        await putPiece(id, n, buf, hash, (loaded) => set(id, { sent: base + loaded }));
        sent = base + buf.byteLength;
        firstPiece = false;
        tries = 0;
        set(id, { sent, status: 'uploading' });
      }
      const r = await api('POST', `/api/uploads/${id}/finish`);
      const placed = await placeCard(r);
      jobs.delete(id);
      blobs.delete(id);
      await dropCopy(id);
      emit();
      for (const fn of finishers) fn({ ...placed, file: r.file, picked: blob });
      return;
    } catch (e) {
      if (e.cancelled || cancelled.has(id)) return;
      if (e.status === 404) {
        await dropCopy(id);
        blobs.delete(id);
        return fail(id, 'expired');
      }
      if (e.status === 507) return fail(id, 'space');
      if (e.status === 413 || e.status === 400 || e.status === 409) return fail(id, 'other', `${e.message}. Tap to choose a file.`);
      if (e.status === 422 && tries < 5) {
        tries++; // a damaged piece: send it again straight away
        continue;
      }
      // No connection, the server restarting, a timeout: wait, then carry on.
      set(id, { status: 'paused' });
      await pause(tries++);
    } finally {
      aborts.delete(id);
    }
  }
}

// Only one tab sends a given upload; another tab shows it as waiting and takes over if that tab closes.
function run(id, opts) {
  if (!navigator.locks) return send(id, opts);
  const name = 'zb-upload-' + id;
  return navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) return send(id, opts);
    set(id, { status: 'waiting' });
    return navigator.locks.request(name, () => (jobs.get(id)?.status === 'waiting' ? send(id, opts) : null));
  });
}

// ---------- what the board calls ----------
export async function startUpload(file, { boardId, x, y }) {
  const name = file.name || 'file';
  const mime = file.type || 'application/octet-stream';
  const up = (await api('POST', '/api/uploads', { name, mime, size: file.size, board_id: boardId, x, y })).upload;
  let hasCopy = true;
  try {
    await saveCopy({ id: up.id, name, mime, size: file.size, board_id: boardId, x, y, blob: file, created_at: Date.now() });
  } catch {
    hasCopy = false; // no room to keep a copy: it still uploads, but can't resume after the page closes
  }
  blobs.set(up.id, file);
  jobs.set(up.id, { id: up.id, name, mime, size: file.size, kind: kindOf(name, mime), board_id: boardId, x, y, sent: 0, total: file.size, status: 'uploading', hasCopy });
  emit();
  run(up.id, { fresh: true });
  return up.id;
}

// × on an uploading or paused card, or the bin on a failed one: stop, and forget it everywhere.
export async function cancelUpload(id) {
  cancelled.add(id);
  aborts.get(id)?.();
  jobs.delete(id);
  blobs.delete(id);
  emit();
  await dropCopy(id);
  await api('DELETE', `/api/uploads/${id}`).catch(() => {});
}

// Tap on a failed card with its copy still here (server was full): try again.
export function retryUpload(id) {
  if (!blobs.has(id)) return false;
  set(id, { status: 'uploading', reason: null, message: null });
  run(id);
  return true;
}

// A file chosen for a failed card. The same file (same size) continues where the server got to;
// a different one starts over in the same spot.
export async function repickUpload(id, file) {
  const j = jobs.get(id);
  if (!j) return;
  if (j.reason !== 'expired' && file.size === j.size) {
    blobs.set(id, file);
    let hasCopy = true;
    await saveCopy({ id, name: j.name, mime: j.mime, size: j.size, board_id: j.board_id, x: j.x, y: j.y, blob: file, created_at: Date.now() }).catch(() => (hasCopy = false));
    set(id, { status: 'uploading', reason: null, message: null, hasCopy });
    run(id, { verify: true });
    return;
  }
  await cancelUpload(id);
  cancelled.delete(id);
  return startUpload(file, { boardId: j.board_id, x: j.x, y: j.y });
}

// Called whenever a board opens. Once per page: carry on with uploads this browser kept a copy of.
// Every time: show unfinished uploads it has no copy of (and that have gone quiet) as failed.
let resumed = null;
export async function resumeUploads() {
  resumed ??= (async () => {
    const copies = await allCopies();
    for (const c of copies) {
      if (jobs.has(c.id) || !c.blob) continue;
      blobs.set(c.id, c.blob);
      jobs.set(c.id, { id: c.id, name: c.name, mime: c.mime, size: c.size, kind: kindOf(c.name, c.mime), board_id: c.board_id, x: c.x, y: c.y, sent: 0, total: c.size, status: 'resuming', hasCopy: true });
      emit();
      run(c.id);
    }
  })();
  await resumed;
  {
    let list = [];
    try {
      list = (await api('GET', '/api/uploads')).uploads;
    } catch {
      return;
    }
    for (const u of list) {
      if (jobs.has(u.id) || Date.now() - u.touched_at < QUIET_ELSEWHERE_MS) continue;
      jobs.set(u.id, {
        id: u.id,
        name: u.name,
        mime: u.mime,
        size: u.size,
        kind: kindOf(u.name, u.mime),
        board_id: u.board_id,
        x: u.x,
        y: u.y,
        sent: u.received_bytes,
        total: u.size,
        status: 'failed',
        reason: 'lost',
        message: FAIL.lost,
        hasCopy: false,
      });
    }
    emit();
  }
}
