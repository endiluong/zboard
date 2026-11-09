import { DEMO } from './demo.js';
import { uid } from './util.js';

// Every write carries this tab's id; the server echoes it in events so we can drop our own.
export const clientId = uid();

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

export async function api(method, url, body, type) {
  const opts = { method, headers: { 'X-Client-Id': clientId }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body instanceof ArrayBuffer) {
    opts.headers['Content-Type'] = type || 'application/octet-stream';
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error("Can't reach the ZBoard server");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && url !== '/api/login') onUnauthorized();
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function uploadFiles(files) {
  // The online demo's server is a service worker, and Safari can't read a file sent to one inside
  // FormData (request.formData() throws "Type error"): send each file's bytes on their own.
  if (DEMO) {
    const out = [];
    for (const f of files) {
      const name = encodeURIComponent(f.name || 'pasted.png');
      out.push(...(await api('POST', `/api/upload?name=${name}`, await f.arrayBuffer(), f.type)).files);
    }
    return out;
  }
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name || 'pasted.png');
  return (await api('POST', '/api/upload', fd)).files;
}

// Largest upload the server takes, in bytes (from /api/me; cached for the visit).
let maxUpload = null;
export function uploadLimit() {
  maxUpload ??= api('GET', '/api/me')
    .then((r) => (r.max_upload_mb || 50) * 1024 * 1024)
    .catch(() => {
      maxUpload = null;
      return Infinity; // unknown: let the server decide
    });
  return maxUpload;
}

// One file, with progress: onProgress(sentBytes, totalBytes). Returns the stored file row.
// The returned promise has .abort() to stop the upload. fetch() can't report upload progress,
// so this uses XMLHttpRequest. The demo's in-browser server gets the bytes in one go (see above).
export function uploadFile(file, onProgress = () => {}) {
  const name = file.name || 'pasted.png';
  if (DEMO) {
    const p = (async () => {
      const r = await api('POST', `/api/upload?name=${encodeURIComponent(name)}`, await file.arrayBuffer(), file.type);
      onProgress(file.size, file.size);
      return r.file;
    })();
    p.abort = () => {};
    return p;
  }
  const xhr = new XMLHttpRequest();
  const p = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Client-Id', clientId);
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300 && data?.file) return resolve(data.file);
      const err = new Error(data?.error || `Upload failed (${xhr.status || 'no answer'})`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Can't reach the ZBoard server"));
    xhr.onabort = () => {
      const err = new Error('Upload cancelled');
      err.cancelled = true;
      reject(err);
    };
    const fd = new FormData();
    fd.append('file', file, name);
    xhr.send(fd);
  });
  p.abort = () => xhr.abort();
  return p;
}

// Live updates for one board. Handlers: cards, delete, arrows, board, resync.
export function openEvents(boardId, handlers) {
  const es = new EventSource(`/api/events?board=${encodeURIComponent(boardId)}`);
  let dropped = false;
  for (const type of ['cards', 'delete', 'arrows', 'board', 'reload', 'clips']) {
    es.addEventListener(type, (e) => {
      const d = JSON.parse(e.data);
      if (d.clientId === clientId) return;
      handlers[type]?.(d);
    });
  }
  es.onerror = () => {
    dropped = true;
  };
  es.onopen = () => {
    if (dropped) {
      dropped = false;
      handlers.resync?.();
    }
  };
  return () => es.close();
}
