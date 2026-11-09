// The ZBoard server, inside the browser, for the online demo. Same data layer as the real server
// (server/src/db.js on SQLite compiled to WebAssembly); the routes below mirror server/src/index.js
// for everything a board needs. Nothing leaves the visitor's browser: the database and the pictures
// are kept in its own storage (see sw.js). Server-only features (Google Drive, backups, the browser
// extension, link previews from other sites) answer "not in the demo".
import { createStore, HttpError, newId } from '../../server/src/db.js';
import { useSqlite, exportBytes } from './sqlite.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg' };

// storage: { loadDb(), saveDb(bytes), putFile(key, blob), getFile(key) }
// images: optional { describe(blob) -> { width, height, alpha, color, thumb } } (browser only)
export async function createBackend({ sqlite3, storage, images }) {
  useSqlite(sqlite3, await storage.loadDb());
  const store = createStore('demo');
  const save = () => storage.saveDb(exportBytes());

  async function storeUpload(blob, name) {
    const id = newId();
    const mime = blob.type || 'application/octet-stream';
    const ext = (/\.[a-z0-9]{1,8}$/i.exec(name || '')?.[0] || IMAGE_EXT[mime] || '.bin').toLowerCase();
    const row = { id, name: name || id + ext, mime, ext, size: blob.size, width: null, height: null, sha256: null, display_ext: null, created_at: Date.now() };
    await storage.putFile(id, blob);
    if (mime.startsWith('image/') && images) {
      try {
        const d = await images.describe(blob);
        Object.assign(row, { width: d.width, height: d.height, alpha: d.alpha, color: d.color });
        if (d.thumb) await storage.putFile(id + ':thumb', d.thumb);
      } catch {
        throw new HttpError(415, `Can't read the image "${row.name}" in this browser.`);
      }
    }
    store.insertFile(row);
    return row;
  }

  const routes = [
    ['GET', /^\/api\/me$/, () => ({ ok: true, demo: true })],
    ['POST', /^\/api\/(login|logout)$/, () => ({ ok: true })],
    ['GET', /^\/api\/events$/, () => sse()],
    ['GET', /^\/api\/boards$/, () => ({ boards: store.listBoards() })],
    ['GET', /^\/api\/boards\/([^/]+)$/, (m, q) => store.boardPayload(m[1], q.get('files') === '1')],
    ['PATCH', /^\/api\/boards\/([^/]+)$/, (m, q, body) => ({ board: store.patchBoard(m[1], body ?? {}) })],
    [
      'POST',
      /^\/api\/boards\/([^/]+)\/cards$/,
      (m, q, body) => {
        const single = !Array.isArray(body?.cards) && !Array.isArray(body);
        const list = Array.isArray(body) ? body : single ? [body] : body.cards;
        const cards = store.createCards(m[1], list);
        return json(single ? { card: cards[0], cards } : { cards }, 201);
      },
    ],
    ['PATCH', /^\/api\/cards$/, (m, q, body) => ({ cards: store.patchCards(Array.isArray(body) ? body : body?.cards).changes.map((c) => c.after) })],
    ['POST', /^\/api\/cards\/delete$/, (m, q, body) => ({ snapshot: store.deleteCards(Array.isArray(body) ? body : body?.ids).snapshot })],
    ['POST', /^\/api\/restore$/, (m, q, body) => store.restore(body?.snapshot ?? body)],
    ['POST', /^\/api\/boards\/([^/]+)\/arrows$/, (m, q, body) => json({ arrow: store.createArrow(m[1], body) }, 201)],
    ['PATCH', /^\/api\/arrows\/([^/]+)$/, (m, q, body) => ({ arrow: store.patchArrow(m[1], body ?? {}) })],
    ['DELETE', /^\/api\/arrows\/([^/]+)$/, (m) => (store.deleteArrow(m[1]), { ok: true })],
    ['GET', /^\/api\/search$/, (m, q) => ({ results: q.get('tag') ? store.byTag(q.get('tag')) : store.search(q.get('q') || '') })],
    ['GET', /^\/api\/tags$/, () => ({ tags: store.listTags() })],
    ['GET', /^\/api\/labels$/, () => ({ labels: store.listLabels() })],
    ['GET', /^\/api\/stats$/, () => ({ ...store.stats(), db_bytes: exportBytes().length, thumbs_bytes: 0, demo: true })],
    ['GET', /^\/api\/(boards\/[^/]+\/)?clips$/, () => ({ clips: [] })],
    ['GET', /^\/api\/files\/([^/]+)\/info$/, (m) => ({ file: fileOr404(m[1]) })],
    // Other sites can't be read from the browser (CORS): links keep their address as the title.
    ['GET', /^\/api\/link-preview$/, (m, q) => ({ site: hostOf(q.get('url')) })],
    [
      'POST',
      /^\/api\/upload$/,
      async (m, q, body, req) => {
        const files = [];
        const ct = req.headers.get('content-type') || '';
        if (ct.startsWith('multipart/form-data')) {
          for (const f of (await req.formData()).getAll('file')) if (f && typeof f === 'object') files.push(await storeUpload(f, f.name));
        } else {
          // The demo app sends one file's bytes per request (uploadFiles in src/api.js): Safari
          // can't read files in FormData inside a service worker.
          const blob = new Blob([await req.arrayBuffer()], { type: ct.split(';')[0].trim() || 'application/octet-stream' });
          if (blob.size) files.push(await storeUpload(blob, q.get('name') || ''));
        }
        if (!files.length) throw new HttpError(400, 'No file sent');
        return json({ file: files[0], files }, 201);
      },
    ],
    [
      'POST',
      /^\/api\/upload-url$/,
      async (m, q, body) => {
        let res;
        try {
          res = await fetch(body?.url, { mode: 'cors' });
        } catch {
          res = null;
        }
        if (!res?.ok) throw new HttpError(400, "That site doesn't let other pages copy its pictures. Save the picture and drop the file in instead.");
        const blob = await res.blob();
        return json({ file: await storeUpload(blob, decodeURIComponent(new URL(body.url).pathname.split('/').pop() || '')) }, 201);
      },
    ],
  ];

  const fileOr404 = (id) => {
    const f = store.getFile(id);
    if (!f) throw new HttpError(404, 'File not found');
    return f;
  };
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  // Live updates come from other devices; the demo has only this one, so the stream stays quiet.
  const sse = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(': demo\n\n'));
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }
    );

  async function serveFile(id, size) {
    const f = fileOr404(id);
    const blob = (size && (await storage.getFile(id + ':thumb'))) || (await storage.getFile(id));
    if (!blob) throw new HttpError(404, 'File is missing');
    return new Response(blob, { headers: { 'content-type': blob.type || f.mime, 'cache-control': 'no-cache' } });
  }

  // One request at a time, so a write and the save that follows it never interleave with another.
  let queue = Promise.resolve();
  function handle(req) {
    const run = queue.then(() => route(req));
    queue = run.catch(() => {});
    return run;
  }

  async function route(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*?(?=\/(api|files)\/)/, '');
    try {
      const fm = /^\/files\/([^/]+)(?:\/(thumb|mini|micro))?$/.exec(path);
      if (fm && req.method === 'GET') return await serveFile(fm[1], fm[2]);
      for (const [method, re, fn] of routes) {
        const m = re.exec(path);
        if (!m || method !== req.method) continue;
        const ct = req.headers.get('content-type') || '';
        const body = ct.includes('application/json') ? await req.json().catch(() => null) : null;
        const out = await fn(m, url.searchParams, body, req);
        if (method !== 'GET') await save();
        return out instanceof Response ? out : json(out);
      }
      return json({ error: 'Not available in the demo' }, 404);
    } catch (e) {
      if (e instanceof HttpError || e?.status) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: e?.message || 'Something went wrong' }, 500);
    }
  }

  return { handle, store };
}
