// PDFs opened in the reader are kept in this browser (IndexedDB) for 7 days after they were last
// opened, so opening one again reads nothing from the server. What is kept is exactly the parts pdf.js
// asked for (the pages that were looked at), so a 100 MB file of which two pages were read takes a few
// MB here. A file never changes once uploaded (a new upload is a new id), so a kept part is never stale.
//
//   files: { fileId, size, openedAt, bytes, parts: [[begin, end], …] }   which parts are kept, and when
//   parts: { key: `${fileId}:${begin}`, fileId, begin, end, data }         the bytes
//
// Anything going wrong here (private browsing, storage full or cleared) just means reading from the
// server as before.
const DB = 'zb-pdf-cache';
const KEEP_DAYS = 7;
const MAX_BYTES = 500 * 1024 * 1024; // beyond this, the files opened longest ago go first

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore('files', { keyPath: 'fileId' });
      d.createObjectStore('parts', { keyPath: 'key' }).createIndex('fileId', 'fileId');
    };
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
    q.onblocked = () => reject(new Error('blocked'));
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}
const done = (tx) => new Promise((res, rej) => ((tx.oncomplete = res), (tx.onerror = tx.onabort = () => rej(tx.error))));
const req = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

async function dropFiles(d, ids) {
  if (!ids.length) return;
  const tx = d.transaction(['files', 'parts'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('files').delete(id);
    const keys = await req(tx.objectStore('parts').index('fileId').getAllKeys(id));
    for (const k of keys) tx.objectStore('parts').delete(k);
  }
  await done(tx);
}

// Forget files not opened for 7 days, then the oldest while over the size limit.
async function sweep(d, keepId) {
  const all = await req(d.transaction('files').objectStore('files').getAll());
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const drop = all.filter((f) => f.openedAt < cutoff && f.fileId !== keepId).map((f) => f.fileId);
  let total = all.filter((f) => !drop.includes(f.fileId)).reduce((s, f) => s + (f.bytes || 0), 0);
  for (const f of all.filter((x) => !drop.includes(x.fileId) && x.fileId !== keepId).sort((a, b) => a.openedAt - b.openedAt)) {
    if (total <= MAX_BYTES) break;
    drop.push(f.fileId);
    total -= f.bytes || 0;
  }
  await dropFiles(d, drop);
}

// The kept parts of one file, for reading and adding to. Returns null if storage can't be used.
export async function openCache(fileId) {
  try {
    const d = await db();
    await sweep(d, fileId).catch(() => {});
    const rec = (await req(d.transaction('files').objectStore('files').get(fileId))) || { fileId, size: 0, bytes: 0, parts: [] };
    rec.openedAt = Date.now();
    await req(d.transaction('files', 'readwrite').objectStore('files').put(rec));
    let saving = Promise.resolve();
    return {
      size: () => rec.size,
      // Bytes [begin, end) if one kept part holds them all.
      async get(begin, end) {
        const p = rec.parts.find(([b, e]) => b <= begin && e >= end);
        if (!p) return null;
        try {
          const row = await req(d.transaction('parts').objectStore('parts').get(`${fileId}:${p[0]}`));
          return row ? new Uint8Array(row.data.slice(begin - p[0], end - p[0])) : null; // its own buffer, as pdf.js expects
        } catch {
          return null;
        }
      },
      // Keep bytes read from the server (one write at a time, so the parts list never loses one).
      put(begin, bytes, size) {
        const data = bytes.slice(); // a copy now: pdf.js may hand the original to its worker (emptying it)
        saving = saving.then(async () => {
          const end = begin + data.length;
          if (rec.parts.some(([b, e]) => b <= begin && e >= end)) return;
          const tx = d.transaction(['files', 'parts'], 'readwrite');
          tx.objectStore('parts').put({ key: `${fileId}:${begin}`, fileId, begin, end, data: data.buffer });
          rec.parts = rec.parts.filter(([b]) => b !== begin).concat([[begin, end]]);
          rec.size = size || rec.size;
          rec.bytes = rec.parts.reduce((s, [b, e]) => s + (e - b), 0);
          tx.objectStore('files').put(rec);
          await done(tx);
        }).catch(() => {});
        return saving;
      },
    };
  } catch {
    return null;
  }
}
