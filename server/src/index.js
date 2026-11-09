// ZBoard server: one Express process serving the API, files and live sync.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import cron from 'node-cron';
import { ZipArchive } from 'archiver';
import { createStore, HttpError, isId, newId } from './db.js';
import { drawingSvg } from './ink.js';
import { importMilanote } from './milanote.js';
import { createCleanup } from './cleanup.js';
import { createBackupPlan } from './plan.js';
import { createDrive, createLocalBackups } from './backup.js';
import { mountUploads } from './uploads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const BACKUP_DIR = path.resolve(ROOT, process.env.BACKUP_DIR || 'backup');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;
const DRIVE_KEEP = 30; // Google Drive snapshots kept
// Unused pictures are removed by a check on this schedule (default: the 1st of each month, 04:00), once
// unused for CLEANUP_AFTER_DAYS and older than every kept backup. "off" disables it.
const CLEANUP_CRON = (process.env.CLEANUP_CRON ?? '0 4 1 * *').trim();
const CLEANUP_AFTER_DAYS = process.env.CLEANUP_AFTER_DAYS !== undefined && process.env.CLEANUP_AFTER_DAYS !== '' ? Math.max(0, Number(process.env.CLEANUP_AFTER_DAYS)) : 30;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const APP_PASSWORD = process.env.APP_PASSWORD;

if (!APP_PASSWORD) {
  console.error('APP_PASSWORD is not set. Copy .env.example to .env and set a password.');
  process.exit(1);
}

const DIRS = Object.fromEntries(['files', 'thumbs', 'minis', 'tmp'].map((d) => [d, path.join(DATA_DIR, d)]));
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(DIRS.tmp)) fs.rmSync(path.join(DIRS.tmp, f), { force: true });

const DB_FILE = path.join(DATA_DIR, 'zboard.db');
let store = createStore(DB_FILE); // replaced by a Google Drive restore

// ---- secrets ----
const secret = (key) => {
  let v = store.getMeta(key);
  if (!v) store.setMeta(key, (v = crypto.randomBytes(32).toString('base64url')));
  return v;
};
const SESSION_SECRET = secret('session_secret');
let apiToken = secret('api_token');

function writeCliToken() {
  const file = path.join(DATA_DIR, 'cli-token');
  fs.writeFileSync(file, apiToken + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
writeCliToken();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---- live sync (SSE) ----
const streams = new Map(); // board id -> Set of responses

function emit(boardId, type, payload, clientId) {
  const set = streams.get(boardId);
  if (!set?.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...payload, board: boardId, clientId: clientId ?? null })}\n\n`;
  for (const res of set) res.write(msg);
}

function groupBy(list, key) {
  const m = new Map();
  for (const item of list) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();

// ---- app ----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser(SESSION_SECRET));

const COOKIE = 'zb_session';
const clientId = (req) => req.get('x-client-id') || null;

function authed(req) {
  const h = req.get('authorization');
  if (h?.startsWith('Bearer ')) return sameSecret(h.slice(7).trim(), apiToken);
  return req.signedCookies?.[COOKIE] === 'v1';
}

app.post('/api/login', async (req, res) => {
  if (!sameSecret(req.body?.password ?? '', APP_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.cookie(COOKIE, 'v1', { signed: true, httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 400 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.use(['/api', '/files'], (req, res, next) => {
  if (authed(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
});

// Successful writes mark the data dirty for the Google Drive backup (uploaded once edits stop).
const NOT_DATA = /^\/(logout|token|backup|drive|link-preview|uploads)/; // upload pieces: the card made after counts
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !NOT_DATA.test(req.path)) {
    res.on('finish', () => {
      if (res.statusCode < 400) drive.markDirty();
    });
  }
  next();
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ ok: true, max_upload_mb: MAX_UPLOAD_MB }));

app.get('/api/token', (req, res) => res.json({ token: apiToken }));
app.post('/api/token/rotate', (req, res) => {
  apiToken = crypto.randomBytes(32).toString('base64url');
  store.setMeta('api_token', apiToken);
  writeCliToken();
  res.json({ token: apiToken });
});

// ---- boards ----
app.get('/api/boards', (req, res) => res.json({ boards: store.listBoards() }));

app.get('/api/boards/:id', (req, res) => res.json(store.boardPayload(req.params.id, req.query.files === '1')));

app.patch('/api/boards/:id', (req, res) => {
  const board = store.patchBoard(req.params.id, req.body ?? {});
  const msg = { board, breadcrumbs: store.breadcrumbs(board.id) };
  emit(board.id, 'board', msg, clientId(req));
  if (board.parent_id) emit(board.parent_id, 'board', msg, clientId(req));
  res.json({ board });
});

// ---- cards ----
app.post('/api/boards/:id/cards', (req, res) => {
  const body = req.body;
  const single = !Array.isArray(body?.cards) && !Array.isArray(body);
  const list = Array.isArray(body) ? body : single ? [body] : body.cards;
  const cards = store.createCards(req.params.id, list);
  emit(req.params.id, 'cards', { cards }, clientId(req));
  res.status(201).json(single ? { card: cards[0], cards } : { cards });
});

app.patch('/api/cards', (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body?.cards;
  const { changes, arrowsMoved, arrowsDeleted } = store.patchCards(list);
  const cid = clientId(req);
  const left = changes.filter((c) => c.before.board_id !== c.after.board_id);
  for (const [board, items] of groupBy(left, (c) => c.before.board_id)) {
    emit(board, 'delete', { ids: items.map((c) => c.after.id) }, cid);
  }
  for (const [board, items] of groupBy(changes, (c) => c.after.board_id)) {
    emit(board, 'cards', { cards: items.map((c) => c.after) }, cid);
  }
  for (const c of left) {
    if (c.after.type === 'board' && c.after.child) {
      const child = store.getBoard(c.after.child.id);
      emit(child.id, 'board', { board: child, breadcrumbs: store.breadcrumbs(child.id) }, cid);
    }
  }
  for (const [board, items] of groupBy(arrowsMoved, (m) => m.from)) emit(board, 'arrows', { arrows: [], deleted: items.map((m) => m.arrow.id) }, cid);
  for (const [board, items] of groupBy(arrowsMoved, (m) => m.arrow.board_id)) emit(board, 'arrows', { arrows: items.map((m) => m.arrow), deleted: [] }, cid);
  for (const [board, items] of groupBy(arrowsDeleted, (a) => a.board_id)) emit(board, 'arrows', { arrows: [], deleted: items.map((a) => a.id) }, cid);
  res.json({ cards: changes.map((c) => c.after) });
});

app.post('/api/cards/delete', (req, res) => {
  const ids = Array.isArray(req.body) ? req.body : req.body?.ids;
  const { snapshot, removed, removedArrows } = store.deleteCards(ids);
  const cid = clientId(req);
  for (const [board, items] of groupBy(removed, (c) => c.board_id)) emit(board, 'delete', { ids: items.map((c) => c.id) }, cid);
  for (const [board, items] of groupBy(removedArrows, (a) => a.board_id)) emit(board, 'arrows', { arrows: [], deleted: items.map((a) => a.id) }, cid);
  res.json({ snapshot });
});

app.post('/api/restore', (req, res) => {
  const { cards, arrows } = store.restore(req.body?.snapshot ?? req.body);
  const cid = clientId(req);
  for (const [board, items] of groupBy(cards, (c) => c.board_id)) emit(board, 'cards', { cards: items }, cid);
  for (const [board, items] of groupBy(arrows, (a) => a.board_id)) emit(board, 'arrows', { arrows: items, deleted: [] }, cid);
  res.json({ cards, arrows });
});

// ---- arrows ----
app.post('/api/boards/:id/arrows', (req, res) => {
  const arrow = store.createArrow(req.params.id, req.body);
  emit(arrow.board_id, 'arrows', { arrows: [arrow], deleted: [] }, clientId(req));
  res.status(201).json({ arrow });
});

app.patch('/api/arrows/:id', (req, res) => {
  const arrow = store.patchArrow(req.params.id, req.body ?? {});
  emit(arrow.board_id, 'arrows', { arrows: [arrow], deleted: [] }, clientId(req));
  res.json({ arrow });
});

app.delete('/api/arrows/:id', (req, res) => {
  const arrow = store.deleteArrow(req.params.id);
  emit(arrow.board_id, 'arrows', { arrows: [], deleted: [arrow.id] }, clientId(req));
  res.json({ ok: true });
});

// ---- files ----
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

function safeExt(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : MIME_EXT[mime] || '.bin';
}

const upload = multer({ dest: DIRS.tmp, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

const thumbPath = (id) => path.join(DIRS.thumbs, id + '.webp');
const miniPath = (id) => path.join(DIRS.minis, id + '.webp');
const microPath = (id) => path.join(DIRS.minis, id + '-96.webp');
const originalPath = (f) => path.join(DIRS.files, f.id + f.ext);
const displayPath = (f) => path.join(DIRS.files, f.id + (f.display_ext || f.ext));

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

// Display copy (HEIC only) and the upright 800 px thumbnail. Originals are never touched.
async function makeDerivatives(row, isHeic) {
  const out = {};
  let src = originalPath(row);
  if (isHeic) {
    // Browsers can't show HEIC; keep the original and add a JPEG copy for display.
    src = path.join(DIRS.files, row.id + '.jpg');
    await sharp(originalPath(row)).rotate().jpeg({ quality: 90 }).toFile(src);
    out.display_ext = '.jpg';
    out.mime = 'image/heic';
  }
  const meta = await sharp(src).metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  out.width = turned ? meta.height : meta.width;
  out.height = turned ? meta.width : meta.height;
  await sharp(src).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath(row.id));
  out.alpha = await hasTransparency(meta, thumbPath(row.id));
  out.color = await mainColor(thumbPath(row.id));
  return out;
}

// One colour for the whole picture: shown on a card while (or instead of) loading the image far out.
async function mainColor(thumb) {
  const { data } = await sharp(thumb).flatten({ background: '#ffffff' }).resize(1, 1, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  return '#' + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Cut-outs (PNGs with a see-through background) are drawn without a card frame.
async function hasTransparency(meta, thumb) {
  if (!meta.hasAlpha) return 0;
  return (await sharp(thumb).stats()).isOpaque ? 0 : 1;
}

// f: { path, originalname, mimetype, size }; the temp file at f.path is moved into files/.
async function storeUpload(f, { utf8Name = false } = {}) {
  const id = newId();
  const name = utf8Name ? f.originalname : Buffer.from(f.originalname, 'latin1').toString('utf8');
  const ext = safeExt(name, f.mimetype);
  const dest = path.join(DIRS.files, id + ext);
  fs.renameSync(f.path, dest);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  const row = { id, name, mime: f.mimetype, ext, size: f.size, width: null, height: null, sha256: hash, display_ext: null, created_at: Date.now() };

  const isHeic = /^\.(heic|heif)$/.test(ext) || /heic|heif/.test(f.mimetype);
  const isImage = isHeic || f.mimetype.startsWith('image/') || IMAGE_EXTS.includes(ext);
  if (isImage) {
    try {
      Object.assign(row, await makeDerivatives(row, isHeic));
    } catch (e) {
      for (const p of [dest, path.join(DIRS.files, id + '.jpg'), thumbPath(id)]) fs.rmSync(p, { force: true });
      if (isHeic) {
        throw new HttpError(
          415,
          `Can't read the HEIC photo "${name}": this server's image library can't decode HEIC. ` +
            'Set the phone camera to "Most Compatible" (JPEG), or convert the photo to JPEG, and upload it again.'
        );
      }
      throw new HttpError(415, `Can't read the image "${name}": ${e.message}`);
    }
  }
  store.insertFile(row);
  return row;
}

app.post('/api/upload', upload.array('file', 50), async (req, res) => {
  const files = [];
  try {
    for (const f of req.files ?? []) files.push(await storeUpload(f));
  } finally {
    for (const f of req.files ?? []) fs.rmSync(f.path, { force: true });
  }
  if (!files.length) throw new HttpError(400, 'No file sent (use the form field "file")');
  res.status(201).json({ file: files[0], files });
});

// Big files: sent in pieces that survive a dropped connection or a closed page (see uploads.js).
mountUploads(app, { dir: path.join(DATA_DIR, 'uploads'), tmpDir: DIRS.tmp, maxBytes: MAX_UPLOAD_MB * 1024 * 1024, storeUpload, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });

// ---- Milanote import (pictures go through /api/upload first; see milanote.js) ----
app.post('/api/import/milanote', (req, res) => {
  const out = importMilanote(store, req.body ?? {}, { parentId: req.body?.parentId || 'root', newId });
  emit(out.card.board_id, 'cards', { cards: [out.card] }, null);
  res.status(201).json(out);
});

// ---- remote fetches (link previews, images dragged from other sites) ----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 ZBoard';

function httpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u;
  } catch {}
  throw new HttpError(400, 'Not a valid http(s) link');
}

async function fetchCapped(url, maxBytes, accept) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': UA, accept } });
  } catch (e) {
    throw new HttpError(502, `Couldn't reach ${new URL(url).host}: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw new HttpError(502, `${new URL(url).host} answered ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await res.body.cancel?.().catch(() => {});
      throw new HttpError(413, `Download is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }
  return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), finalUrl: res.url || url };
}

async function storeRemoteImage(url) {
  const { buf, type, finalUrl } = await fetchCapped(url, MAX_UPLOAD_MB * 1024 * 1024, 'image/avif,image/webp,image/*,*/*;q=0.8');
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream') throw new HttpError(415, `That link is not an image (${type})`);
  const tmp = path.join(DIRS.tmp, 'dl-' + newId());
  fs.writeFileSync(tmp, buf);
  const base = decodeURIComponent(path.basename(new URL(finalUrl).pathname)) || 'image';
  try {
    return await storeUpload({ path: tmp, originalname: base.slice(0, 200), mimetype: type || 'application/octet-stream', size: buf.length }, { utf8Name: true });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m
  );

function parseMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = decodeEntities(attrs.content).trim();
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) meta['<title>'] = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return meta;
}

app.get('/api/link-preview', async (req, res) => res.json(await linkPreview(req.query.url)));

async function linkPreview(raw) {
  const url = httpUrl(raw);
  const { buf, type, finalUrl } = await fetchCapped(url.href, 3 * 1024 * 1024, 'text/html,application/xhtml+xml,*/*;q=0.5');
  const out = { url: url.href, title: null, description: null, site: new URL(finalUrl).hostname.replace(/^www\./, ''), image: null };
  if (type.startsWith('image/')) {
    out.image = (await storeRemoteImage(url.href)).id;
    out.title = path.basename(url.pathname) || out.site;
    return out;
  }
  const meta = parseMeta(buf.toString('utf8'));
  out.title = meta['og:title'] || meta['twitter:title'] || meta['<title>'] || out.site;
  out.description = meta['og:description'] || meta['twitter:description'] || meta.description || null;
  out.site = meta['og:site_name'] || out.site;
  const img = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
  if (img) {
    try {
      out.image = (await storeRemoteImage(new URL(img, finalUrl).href)).id;
    } catch {
      // A preview without a picture is still useful.
    }
  }
  return out;
}

app.post('/api/upload-url', async (req, res) => {
  const file = await storeRemoteImage(httpUrl(req.body?.url).href);
  res.status(201).json({ file, files: [file] });
});

function fileOr404(id) {
  const f = isId(id) && store.getFile(id);
  if (!f) throw new HttpError(404, 'File not found');
  return f;
}

const IMMUTABLE = { 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };

app.get('/api/files/:id/info', (req, res) => res.json({ file: fileOr404(req.params.id) }));

// For the CLI: a PNG sized for terminal image protocols (mode=png&w=px), or the image drawn
// with truecolor half-blocks (mode=ansi&cols=n): each character is one pixel wide, two tall.
app.get('/api/files/:id/render', async (req, res) => {
  const f = fileOr404(req.params.id);
  const src = fs.existsSync(thumbPath(f.id)) ? thumbPath(f.id) : displayPath(f);
  if (!fs.existsSync(src)) throw new HttpError(404, 'File is missing on disk');
  await sendRender(res, req.query, () => sharp(src).rotate());
});

// Drawing cards, rasterised from their strokes the same way.
app.get('/api/cards/:id/render', async (req, res) => {
  const card = store.getCard(req.params.id);
  if (!card || card.type !== 'drawing') throw new HttpError(404, 'No drawing with that id');
  const svg = Buffer.from(drawingSvg(card.data, 1200));
  await sendRender(res, req.query, () => sharp(svg));
});

async function sendRender(res, query, image) {
  if (query.mode === 'png') {
    const w = Math.min(2000, Math.max(16, Number(query.w) || 800));
    return res.type('png').send(await image().resize(w, w, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());
  }
  const cols = Math.min(400, Math.max(4, Number(query.cols) || 80));
  const { data, info } = await image().resize({ width: cols }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => (y < info.height ? `${data[(y * info.width + x) * 3]};${data[(y * info.width + x) * 3 + 1]};${data[(y * info.width + x) * 3 + 2]}` : '255;255;255');
  let out = '';
  for (let y = 0; y < info.height; y += 2) {
    let fg = '';
    let bg = '';
    for (let x = 0; x < info.width; x++) {
      const top = px(x, y);
      const bottom = px(x, y + 1);
      if (top !== fg) out += `\x1b[38;2;${(fg = top)}m`;
      if (bottom !== bg) out += `\x1b[48;2;${(bg = bottom)}m`;
      out += '▀';
    }
    out += '\x1b[0m\n';
  }
  res.type('text/plain; charset=utf-8').send(out);
}

app.get('/files/:id', (req, res) => {
  const f = fileOr404(req.params.id);
  const original = req.query.original === '1' || !f.display_ext;
  res.type(original ? f.ext : f.display_ext);
  res.sendFile(original ? originalPath(f) : displayPath(f), {
    headers: {
      ...IMMUTABLE,
      'Content-Security-Policy': 'sandbox',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name || f.id + f.ext)}`,
    },
  });
});

app.get('/files/:id/thumb', (req, res) => {
  const f = fileOr404(req.params.id);
  if (!fs.existsSync(thumbPath(f.id))) throw new HttpError(404, 'No thumbnail for this file');
  res.sendFile(thumbPath(f.id), { headers: IMMUTABLE });
});

// A PDF's preview: the browser draws the first page with pdf.js (the server has no PDF renderer) and
// sends it here as a picture. It becomes the file's thumbnail, so cards show it like any image.
const isPdf = (f) => f.ext === '.pdf' || f.mime === 'application/pdf';
app.post('/api/files/:id/preview', express.raw({ type: 'image/*', limit: '10mb' }), async (req, res) => {
  const f = fileOr404(req.params.id);
  if (!isPdf(f)) throw new HttpError(400, 'Only PDFs take a preview');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send the preview as an image body');
  let meta;
  try {
    meta = await sharp(req.body).metadata();
    await sharp(req.body).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath(f.id));
  } catch (e) {
    throw new HttpError(415, `Can't read the preview: ${e.message}`);
  }
  for (const p of [miniPath(f.id), microPath(f.id)]) fs.rmSync(p, { force: true });
  const pages = Math.max(1, Math.min(100000, Math.round(Number(req.query.pages)) || 1));
  store.setFilePreview(f.id, { width: meta.width, height: meta.height, color: await mainColor(thumbPath(f.id)), pages });
  res.json({ file: store.getFile(f.id) });
});

// Smaller copies made from the thumbnail on first request and kept: 256 px "mini" for zoomed-out
// boards, 96 px "micro" for very far out, where cards are only a few dozen pixels wide.
const sizeJobs = new Map();
function smallCopy(name, px, quality, pathOf) {
  app.get(`/files/:id/${name}`, async (req, res) => {
    const f = fileOr404(req.params.id);
    const out = pathOf(f.id);
    if (!fs.existsSync(out)) {
      if (!fs.existsSync(thumbPath(f.id))) throw new HttpError(404, 'No thumbnail for this file');
      const key = `${name}:${f.id}`;
      if (!sizeJobs.has(key)) {
        const job = sharp(thumbPath(f.id))
          .resize(px, px, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toBuffer()
          .then((buf) => {
            const tmp = path.join(DIRS.tmp, `${name}-${f.id}`);
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, out);
          })
          .finally(() => sizeJobs.delete(key));
        sizeJobs.set(key, job);
      }
      await sizeJobs.get(key);
    }
    res.sendFile(out, { headers: IMMUTABLE });
  });
}
smallCopy('mini', 256, 70, miniPath);
smallCopy('micro', 96, 60, microPath);

// ---- saved items (clips) from the browser extension ----
// Clips are shown on every board (all boards / this board), so their events go to every stream.
const emitAll = (type, payload, cid) => {
  for (const board of streams.keys()) emit(board, type, payload, cid);
};

const str = (v, max = 2000) => (v == null || v === '' ? null : String(v).slice(0, max));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

app.get('/api/clips', (req, res) => res.json({ clips: store.listClips() }));
app.get('/api/boards/:id/clips', (req, res) => {
  if (!store.getBoard(req.params.id)) throw new HttpError(404, 'Board not found');
  res.json({ clips: store.listClips(req.params.id) });
});

// multipart (field "file", sent by the browser after it fetched the image itself) or JSON:
//   { board_id, kind: 'image', src_url }   → the server downloads the image
//   { board_id, kind: 'link', url, title } | { board_id, kind: 'text', text }
// Optional page_url / page_title say where it came from.
app.post('/api/clips', upload.single('file'), async (req, res) => {
  const b = req.body || {};
  const boardId = b.board_id || 'root';
  if (!store.getBoard(boardId)) throw new HttpError(404, 'That board no longer exists. Pick another board in the extension.');
  const source = { page_url: str(b.page_url), page_title: str(b.page_title) };
  const alt = str(b.alt)?.slice(0, 500) || null; // the image's alt text on the page
  let clip;
  if (req.file) {
    let file;
    try {
      file = await storeUpload(req.file);
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
    clip = store.createClip(boardId, 'image', { fileId: file.id, src_url: str(b.src_url), alt, ...source });
  } else if (b.kind === 'image') {
    const file = await storeRemoteImage(httpUrl(b.src_url).href);
    clip = store.createClip(boardId, 'image', { fileId: file.id, src_url: b.src_url, alt, ...source });
  } else if (b.kind === 'link') {
    const url = httpUrl(b.url).href;
    clip = store.createClip(boardId, 'link', { url, title: str(b.title) || url, ...source });
    // Fill in the preview afterwards so the extension gets its answer at once.
    linkPreview(url)
      .then((p) => {
        const next = store.patchClip(clip.id, { data: { title: str(b.title) || p.title, description: p.description, site: p.site, image: p.image } });
        emitAll('clips', { clips: [next], deleted: [] });
      })
      .catch(() => {});
  } else if (b.kind === 'text') {
    if (!String(b.text || '').trim()) throw new HttpError(400, 'Nothing to save: the selection is empty');
    clip = store.createClip(boardId, 'text', { text: String(b.text).slice(0, 20000), ...source });
  } else {
    throw new HttpError(400, 'Send a file, or kind image/link/text');
  }
  emitAll('clips', { clips: [clip], deleted: [] }, clientId(req));
  res.status(201).json({ clip });
});

function clipToCard(clip) {
  const d = clip.data;
  // Images keep the page they came from (shown as "From site") and the page's alt text.
  if (clip.kind === 'image') return { type: 'image', data: { fileId: d.fileId, caption: '', alt: d.alt || null, source_url: d.page_url || null, source_title: d.page_title || null } };
  if (clip.kind === 'link') return { type: 'link', data: { url: d.url, title: d.title, description: d.description ?? null, site: d.site ?? null, image: d.image ?? null } };
  const source = d.page_url ? `<div><a href="${escapeHtml(d.page_url)}">${escapeHtml(d.page_title || d.page_url)}</a></div>` : '';
  const text = escapeHtml(d.text)
    .split(/\r?\n/)
    .map((l) => `<div>${l || '<br>'}</div>`)
    .join('');
  return { type: 'note', data: { html: text + source } };
}

app.post('/api/clips/:id/place', (req, res) => {
  const clip = store.getClip(req.params.id);
  if (!clip) throw new HttpError(404, 'Saved item not found');
  const b = req.body || {};
  const { card } = store.placeClip(clip.id, b.board_id, Number(b.x) || 0, Number(b.y) || 0, clipToCard(clip));
  emit(card.board_id, 'cards', { cards: [card] }, clientId(req));
  emitAll('clips', { clips: [], deleted: [clip.id] }, clientId(req));
  res.status(201).json({ card });
});

app.patch('/api/clips/:id', (req, res) => {
  const clip = store.patchClip(req.params.id, { board_id: req.body?.board_id });
  emitAll('clips', { clips: [clip], deleted: [] }, clientId(req));
  res.json({ clip });
});

app.delete('/api/clips/:id', (req, res) => {
  store.deleteClip(req.params.id);
  emitAll('clips', { clips: [], deleted: [req.params.id] }, clientId(req));
  res.json({ ok: true });
});

app.get('/api/extension.zip', (req, res) => {
  const dir = path.join(ROOT, 'extension');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new HttpError(404, 'extension/ folder is missing');
  res.attachment('zboard-clipper.zip');
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  zip.directory(dir, 'zboard-clipper');
  zip.finalize();
});

// ---- search and tags ----
app.get('/api/search', (req, res) => {
  if (req.query.tag) return res.json({ results: store.byTag(String(req.query.tag)) });
  res.json({ results: store.search(String(req.query.q || '')) });
});
app.get('/api/tags', (req, res) => res.json({ tags: store.listTags() }));
app.get('/api/labels', (req, res) => res.json({ labels: store.listLabels() }));

// ---- stats, backups, export ----
const dirSize = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile()) n += fs.statSync(path.join(dir, f.name)).size;
  return n;
};
app.get('/api/stats', (req, res) => {
  const dbBytes = ['', '-wal'].reduce((n, s) => n + (fs.existsSync(DB_FILE + s) ? fs.statSync(DB_FILE + s).size : 0), 0);
  res.json({ ...store.stats(), db_bytes: dbBytes, thumbs_bytes: dirSize(DIRS.thumbs) + dirSize(DIRS.minis), data_dir: DATA_DIR });
});

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const local = createLocalBackups({ getStore: () => store, dataDir: DATA_DIR, backupDir: BACKUP_DIR, keep: BACKUP_KEEP, log });

const slug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);

app.get('/api/export/:boardId', (req, res) => {
  const tree = store.exportTree(req.params.boardId);
  const root = tree.boards[0];
  res.attachment(`zboard-${slug(root.title) || 'board'}-${new Date().toISOString().slice(0, 10)}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('warning', (e) => log('export warning: ' + e.message));
  zip.on('error', (e) => {
    log('export failed: ' + e.message);
    res.destroy(e);
  });
  zip.pipe(res);
  const doc = { format: 'zboard-export', version: 1, exported_at: new Date().toISOString(), root: root.id, ...tree };
  zip.append(JSON.stringify(doc, null, 2), { name: 'board.json' });
  for (const f of tree.files) {
    if (fs.existsSync(originalPath(f))) zip.file(originalPath(f), { name: `files/${f.id}${f.ext}` });
  }
  zip.finalize();
});

// ---- Google Drive ----
const KEEP_ON_RESTORE = ['session_secret', 'api_token', 'drive_refresh_token', 'drive_folders', 'drive_salt', 'drive_state'];

// Swap in a restored database, keeping this server's secrets and Drive connection.
async function replaceDatabase(tmp) {
  const incoming = createStore(tmp);
  for (const k of KEEP_ON_RESTORE) incoming.setMeta(k, store.getMeta(k) ?? '');
  incoming.close();
  store.close();
  for (const s of ['-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
  fs.renameSync(tmp, DB_FILE);
  for (const s of ['-wal', '-shm']) fs.rmSync(tmp + s, { force: true });
  store = createStore(DB_FILE);
  await rebuildMissingThumbs();
  for (const [board] of streams) emit(board, 'reload', {}, null);
}

let cleanupBusy = () => false; // set once the cleanup exists
const drive = createDrive({
  getStore: () => store,
  dataDir: DATA_DIR,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  passphrase: process.env.GOOGLE_BACKUP_PASSPHRASE || '',
  debounceMs: Number(process.env.DRIVE_DEBOUNCE_MS) || 90_000,
  keep: DRIVE_KEEP,
  log,
  onRestore: replaceDatabase,
  paused: () => cleanupBusy(), // Drive waits while unused pictures are removed (below)
});

app.get('/api/drive', (req, res) => res.json(drive.status()));
app.post('/api/drive/connect', async (req, res) => res.json({ pending: await drive.connect() }));
app.post('/api/drive/disconnect', async (req, res) => res.json(await drive.disconnect()));
app.post('/api/drive/sync', async (req, res) => res.json(await drive.sync('manual')));
app.post('/api/drive/restore', async (req, res) => res.json(await drive.restore()));

// ---- unused files (see cleanup.js) ----
const cleanup = createCleanup({
  getStore: () => store,
  afterDays: CLEANUP_AFTER_DAYS,
  localSnapshots: () => local.list(),
  localDir: path.join(BACKUP_DIR, 'db'),
  tmpDir: DIRS.tmp,
  drive,
  // Every copy of a file: the original (and its JPEG for HEIC), its previews, and the local backup copy.
  pathsOf: (f) => [
    ...new Set([f.ext, f.display_ext].filter(Boolean).flatMap((ext) => [path.join(DIRS.files, f.id + ext), path.join(BACKUP_DIR, 'files', f.id + ext)])),
    thumbPath(f.id),
    miniPath(f.id),
    microPath(f.id),
  ],
  log,
});
app.get('/api/cleanup', (req, res) => res.json({ ...cleanup.status(), cron: CLEANUP_CRON }));
app.post('/api/cleanup', async (req, res) => res.json({ ...(await cleanup.run('manual')), cron: CLEANUP_CRON }));
// "Clean up now": what is safe to remove right away (checks every kept backup), then remove what was confirmed.
app.post('/api/cleanup/check', async (req, res) => res.json(await cleanup.check()));
// Starts the removal and answers at once (202): it runs in the background; GET /api/cleanup shows its progress.
app.post('/api/cleanup/remove', (req, res) => res.status(202).json({ ...cleanup.startRemove(req.body?.ids), cron: CLEANUP_CRON }));
cleanupBusy = cleanup.busy;

if (CLEANUP_CRON !== 'off') {
  if (!cron.validate(CLEANUP_CRON)) {
    console.error(`CLEANUP_CRON "${CLEANUP_CRON}" is not a valid cron expression (use "off" to disable).`);
    process.exit(1);
  }
  cron.schedule(CLEANUP_CRON, () => cleanup.run('scheduled').catch(() => {}));
  // Catch up a monthly run missed while ZBoard was off (a minute after start, out of the way).
  if (cleanup.due(31)) setTimeout(() => cleanup.run('catch-up').catch(() => {}), 60_000).unref();
}

// ---- the full backup (see plan.js): every N days, this PC first, then Google Drive ----
const plan = createBackupPlan({
  getStore: () => store,
  local,
  drive,
  log,
  // Test-only: shorter "days" and checks.
  dayMs: Number(process.env.ZB_TEST_DAY_MS) || undefined,
  checkMs: Number(process.env.ZB_TEST_CHECK_MS) || undefined,
});
const backupStatus = () => ({
  ...plan.status(),
  status: local.status(), // the last local backup (kept for the CLI and older clients)
  dir: BACKUP_DIR,
  keep: BACKUP_KEEP,
  drive_keep: DRIVE_KEEP,
  snapshots: local.list().slice(0, BACKUP_KEEP),
});
app.get('/api/backup', (req, res) => res.json(backupStatus()));
app.post('/api/backup', async (req, res) => {
  const result = await plan.run('manual');
  res.json({ ...backupStatus(), result, status: result.local.ok ? local.status() : { ok: false, error: result.local.error } });
});
app.patch('/api/backup', (req, res) => {
  plan.setEveryDays(req.body?.every_days);
  res.json(backupStatus());
});
if (process.env.BACKUP_AUTO !== 'off') plan.start(); // BACKUP_AUTO=off: only "Back up now"
if (process.env.BACKUP_CRON) log('BACKUP_CRON is no longer used: set how often to back up in Menu → Backup & Restore.');

// ---- events ----
app.get('/api/events', (req, res) => {
  const board = String(req.query.board || 'root');
  if (!store.getBoard(board)) throw new HttpError(404, 'Board not found');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n: connected\n\n');
  if (!streams.has(board)) streams.set(board, new Set());
  streams.get(board).add(res);
  req.on('close', () => {
    const set = streams.get(board);
    set?.delete(res);
    if (set && !set.size) streams.delete(board);
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- web app (only if built before start-up) ----
const WEB_DIST = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  app.use(
    express.static(WEB_DIST, {
      index: false,
      setHeaders(res, file) {
        const hashed = file.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    })
  );
  app.get(/^\/(?!api\/|files\/).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
} else {
  console.log('web/dist not found: serving the API only (run "npm run build" in web/ and restart).');
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB` : err.message;
    return res.status(status).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

// Thumbnails are not backed up (only originals are), so rebuild any that are missing,
// e.g. after restoring data/ from a local backup.
async function rebuildMissingThumbs() {
  let n = 0;
  for (const f of store.allFiles()) {
    const image = IMAGE_EXTS.includes(f.ext) || f.display_ext;
    if (!image || fs.existsSync(thumbPath(f.id)) || !fs.existsSync(originalPath(f))) continue;
    try {
      await makeDerivatives(f, Boolean(f.display_ext));
      n++;
    } catch (e) {
      log(`thumbnail for ${f.id} failed: ${e.message}`);
    }
  }
  if (n) log(`Rebuilt ${n} missing thumbnail(s)`);
  // A PDF's preview comes from a browser: forget a lost one so the next browser to show it draws it again.
  for (const f of store.allFiles()) {
    if (isPdf(f) && f.width && !fs.existsSync(thumbPath(f.id))) store.setFilePreview(f.id, { width: null, height: null, color: null, pages: f.pages });
  }
  // Files uploaded before cut-out detection existed.
  for (const f of store.allFiles()) {
    if (f.alpha != null || isPdf(f) || !fs.existsSync(thumbPath(f.id))) continue; // a PDF's page preview is never a cut-out
    try {
      const src = fs.existsSync(displayPath(f)) ? displayPath(f) : thumbPath(f.id);
      store.setFileAlpha(f.id, await hasTransparency(await sharp(src).metadata(), thumbPath(f.id)));
    } catch (e) {
      log(`transparency check for ${f.id} failed: ${e.message}`);
    }
  }
  // ... and before the main colour was kept.
  for (const f of store.allFiles()) {
    if (f.color != null || !fs.existsSync(thumbPath(f.id))) continue;
    try {
      store.setFileColor(f.id, await mainColor(thumbPath(f.id)));
    } catch (e) {
      log(`colour for ${f.id} failed: ${e.message}`);
    }
  }
}

const server = app.listen(PORT);
server.on('listening', () => {
  console.log(`ZBoard listening on http://localhost:${PORT} (data: ${DATA_DIR})`);
  rebuildMissingThumbs();
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is another ZBoard (or another app) running? Stop it first.`);
  else console.error('Server failed to start:', e.message);
  process.exit(1);
});

function shutdown() {
  server.close();
  for (const set of streams.values()) for (const res of set) res.end();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
