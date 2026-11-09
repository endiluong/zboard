// Resumable uploads. A big file is sent in pieces (PIECE bytes each, the last one shorter); every piece
// is kept on disk as it arrives, so a dropped connection, a closed page or a server restart loses at
// most the piece that was on its way. The browser asks which pieces are here and sends the rest, then
// asks to finish: the pieces are joined, checked against the size, and stored like any other upload.
//
//   POST   /api/uploads                 { name, mime, size, board_id, x, y }  → { upload }
//   GET    /api/uploads                 unfinished uploads (newest first)    → { uploads }
//   GET    /api/uploads/:id             one, with the pieces it has          → { upload }
//   PUT    /api/uploads/:id/pieces/:n   raw bytes; X-Piece-Sha256 optional   → { ok, received }
//   POST   /api/uploads/:id/finish                                          → { file }
//   DELETE /api/uploads/:id                                                 → { ok }
//
// Unfinished uploads untouched for EXPIRE_DAYS are deleted (checked at start and every hour); asking for
// one after that answers 404, which the app shows as "expired".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { HttpError, isId, newId } from './db.js';

export const PIECE = 5 * 1024 * 1024;
const EXPIRE_DAYS = 7;
const EXPIRE_MS = EXPIRE_DAYS * 24 * 3600 * 1000;

export function mountUploads(app, { dir, tmpDir, maxBytes, storeUpload, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const dirOf = (id) => path.join(dir, id);
  const metaPath = (id) => path.join(dirOf(id), 'meta.json');
  const piecePath = (id, n) => path.join(dirOf(id), `${n}.part`);
  const pieceCount = (size) => Math.max(1, Math.ceil(size / PIECE));
  const pieceSize = (m, n) => (n < pieceCount(m.size) - 1 ? PIECE : m.size - PIECE * (pieceCount(m.size) - 1));

  const readMeta = (id) => {
    if (!isId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  };
  const writeMeta = (m) => {
    const tmp = metaPath(m.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, metaPath(m.id));
  };
  const metaOr404 = (id) => {
    const m = readMeta(id);
    if (!m) throw new HttpError(404, 'This upload has expired or was removed');
    return m;
  };
  const view = (m) => ({
    id: m.id,
    name: m.name,
    mime: m.mime,
    size: m.size,
    piece_size: PIECE,
    pieces: pieceCount(m.size),
    received: Object.keys(m.hashes).map(Number).sort((a, b) => a - b),
    hashes: m.hashes,
    received_bytes: Object.keys(m.hashes).reduce((s, n) => s + pieceSize(m, Number(n)), 0),
    board_id: m.board_id,
    x: m.x,
    y: m.y,
    created_at: m.created_at,
    touched_at: m.touched_at,
    expires_at: m.touched_at + EXPIRE_MS,
  });
  // Disk full shows as its own message: the browser keeps its copy and the person can free space.
  const diskError = (e) => (e.code === 'ENOSPC' ? new HttpError(507, 'The server is out of space') : e);

  app.post('/api/uploads', (req, res) => {
    const b = req.body || {};
    const size = Number(b.size);
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'size must be a positive number of bytes');
    if (size > maxBytes) throw new HttpError(413, `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const now = Date.now();
    const m = {
      id: newId(),
      name: String(b.name || 'file').slice(0, 300),
      mime: String(b.mime || 'application/octet-stream').slice(0, 200),
      size,
      board_id: typeof b.board_id === 'string' ? b.board_id.slice(0, 64) : 'root',
      x: Number.isFinite(Number(b.x)) ? Math.round(Number(b.x)) : 0,
      y: Number.isFinite(Number(b.y)) ? Math.round(Number(b.y)) : 0,
      hashes: {},
      created_at: now,
      touched_at: now,
    };
    try {
      fs.mkdirSync(dirOf(m.id), { recursive: true });
      writeMeta(m);
    } catch (e) {
      throw diskError(e);
    }
    res.status(201).json({ upload: view(m) });
  });

  app.get('/api/uploads', (req, res) => {
    const list = fs
      .readdirSync(dir)
      .map(readMeta)
      .filter(Boolean)
      .sort((a, b) => b.created_at - a.created_at);
    res.json({ uploads: list.map(view) });
  });

  app.get('/api/uploads/:id', (req, res) => res.json({ upload: view(metaOr404(req.params.id)) }));

  app.put('/api/uploads/:id/pieces/:n', express.raw({ type: () => true, limit: PIECE + 1024 }), (req, res) => {
    const m = metaOr404(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= pieceCount(m.size)) throw new HttpError(400, 'No such piece');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length !== pieceSize(m, n)) throw new HttpError(400, `Piece ${n} should be ${pieceSize(m, n)} bytes, got ${buf.length}`);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const claimed = String(req.get('x-piece-sha256') || '').toLowerCase();
    if (claimed && claimed !== hash) throw new HttpError(422, `Piece ${n} arrived damaged`);
    // A piece sent twice (its answer was lost) is simply accepted again.
    if (m.hashes[n] !== hash) {
      try {
        const tmp = piecePath(m.id, n) + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, piecePath(m.id, n));
        m.hashes[n] = hash;
      } catch (e) {
        throw diskError(e);
      }
    }
    m.touched_at = Date.now();
    writeMeta(m);
    res.json({ ok: true, received: Object.keys(m.hashes).length });
  });

  const finishing = new Map();
  app.post('/api/uploads/:id/finish', async (req, res) => {
    const id = req.params.id;
    // Two tabs (or a retried request) finishing at once get the same result.
    if (!finishing.has(id)) {
      finishing.set(
        id,
        (async () => {
          const m = metaOr404(id);
          const missing = [];
          for (let n = 0; n < pieceCount(m.size); n++) if (!m.hashes[n] || !fs.existsSync(piecePath(id, n))) missing.push(n);
          if (missing.length) throw new HttpError(409, `Pieces still missing: ${missing.slice(0, 20).join(', ')}`);
          const joined = path.join(tmpDir, 'join-' + id);
          try {
            const out = fs.openSync(joined, 'w');
            try {
              for (let n = 0; n < pieceCount(m.size); n++) fs.writeSync(out, fs.readFileSync(piecePath(id, n)));
            } finally {
              fs.closeSync(out);
            }
          } catch (e) {
            fs.rmSync(joined, { force: true });
            throw diskError(e);
          }
          if (fs.statSync(joined).size !== m.size) {
            fs.rmSync(joined, { force: true });
            throw new HttpError(500, 'The joined file has the wrong size');
          }
          try {
            const file = await storeUpload({ path: joined, originalname: m.name, mimetype: m.mime, size: m.size }, { utf8Name: true });
            fs.rmSync(dirOf(id), { recursive: true, force: true });
            return { file, board_id: m.board_id, x: m.x, y: m.y };
          } finally {
            fs.rmSync(joined, { force: true });
          }
        })().finally(() => setTimeout(() => finishing.delete(id), 60_000))
      );
    }
    res.json(await finishing.get(id));
  });

  app.delete('/api/uploads/:id', (req, res) => {
    if (isId(req.params.id)) fs.rmSync(dirOf(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  function expire() {
    const cutoff = Date.now() - EXPIRE_MS;
    let n = 0;
    for (const id of fs.readdirSync(dir)) {
      const m = readMeta(id);
      const touched = m?.touched_at ?? fs.statSync(dirOf(id)).mtimeMs;
      if (touched < cutoff) {
        fs.rmSync(dirOf(id), { recursive: true, force: true });
        n++;
      }
    }
    if (n) log(`Removed ${n} unfinished upload(s) older than ${EXPIRE_DAYS} days`);
  }
  expire();
  setInterval(expire, 3600 * 1000).unref();
}
