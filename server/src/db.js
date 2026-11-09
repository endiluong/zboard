// Schema and data access for boards, cards, arrows, files and meta.
import crypto from 'node:crypto';
import { openDatabase } from './sqlite.js';

export const CARD_TYPES = new Set(['note', 'todo', 'image', 'link', 'board', 'column', 'drawing', 'color', 'file']);
export const newId = () => crypto.randomBytes(9).toString('base64url');
export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  color TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_parent ON boards(parent_id);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  w REAL,
  h REAL,
  z INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  column_id TEXT,
  sort REAL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS cards_column ON cards(column_id);
CREATE TABLE IF NOT EXISTS arrows (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  from_card TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_card TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label TEXT,
  color TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arrows_board ON arrows(board_id);
CREATE INDEX IF NOT EXISTS arrows_from ON arrows(from_card);
CREATE INDEX IF NOT EXISTS arrows_to ON arrows(to_card);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT,
  mime TEXT,
  ext TEXT NOT NULL,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  display_ext TEXT,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  ref UNINDEXED,
  board_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS card_tags (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (card_id, tag)
);
CREATE INDEX IF NOT EXISTS card_tags_tag ON card_tags(tag);
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_board ON clips(board_id);
CREATE TABLE IF NOT EXISTS drive_files (
  local_id TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
`;
const SEARCH_VERSION = '3'; // bump to re-index everything on the next start

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m
  );
const stripHtml = (html) =>
  decodeEntities(String(html || '').replace(/<(br|\/div|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Searchable text of a card. Board cards are found through their board's title.
export function cardText(c) {
  const d = c.data || {};
  switch (c.type) {
    case 'note':
      return stripHtml(d.html);
    case 'todo':
      return [d.title, ...(d.items || []).map((i) => i.text)].filter(Boolean).join('\n');
    case 'image':
      return [d.caption, d.alt, d.source_title, hostOf(d.source_url)].filter(Boolean).join('\n');
    case 'link':
      return [d.title, d.description, d.url].filter(Boolean).join('\n');
    case 'column':
      return d.title || '';
    case 'color':
      return [d.hex, d.name].filter(Boolean).join('\n');
    default:
      return '';
  }
}

const TAG_RE = /(?:^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_-]{1,50})/gu;
// A label as a #tag: lower case, spaces as dashes.
export const labelTag = (label) => String(label).trim().toLowerCase().replace(/\s+/g, '-');

export function tagsOf(c) {
  const fromText = ['note', 'todo', 'image'].includes(c.type) ? [...cardText(c).matchAll(TAG_RE)].map((m) => m[1].toLowerCase()) : [];
  return [...new Set([...fromText, ...(c.data?.labels || []).map(labelTag)])];
}

// Each word becomes a prefix match; all words must match.
const ftsQuery = (q) =>
  (String(q).match(/[\p{L}\p{N}_]+/gu) || [])
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' ');

const CARD_COLS = ['id', 'board_id', 'type', 'x', 'y', 'w', 'h', 'z', 'color', 'column_id', 'sort', 'data', 'created_at', 'updated_at'];
const BOARD_COLS = ['id', 'parent_id', 'title', 'color', 'data', 'created_at', 'updated_at'];
const ARROW_COLS = ['id', 'board_id', 'from_card', 'to_card', 'label', 'color', 'data', 'created_at'];
const insertSql = (table, cols, verb = 'INSERT') =>
  `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`;

const parse = (r) => r && { ...r, data: JSON.parse(r.data || '{}') };
const pack = (o) => ({ ...o, data: typeof o.data === 'string' ? o.data : JSON.stringify(o.data ?? {}) });
const placeholders = (n) => Array(n).fill('?').join(', ');

function num(v, name, { int = false, nullable = true } = {}) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    throw new HttpError(400, `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return int ? Math.round(n) : n;
}
const str = (v, max = 2000) => (v === null || v === undefined ? null : String(v).slice(0, max));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Drawings: at most 2000 strokes of 5000 points; numbers only, hex colours, sane sizes.
const num1 = (v) => Math.round(Number(v) * 10) / 10;
function cleanStrokes(list) {
  return (Array.isArray(list) ? list : []).slice(0, 2000).flatMap((st) => {
    if (!obj(st) || !Array.isArray(st.p)) return [];
    const p = st.p.slice(0, 15000).map(num1);
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return [];
    p.length -= p.length % 3;
    const s = Math.min(200, Math.max(0.5, Number(st.s) || 6));
    return [{ c: HEX.test(st.c) ? st.c.toLowerCase() : '#23221f', s, p }];
  });
}
const size1 = (v) => Math.min(100000, Math.max(1, Number(v) || 1));
// Labels: up to 12 short names per card.
const cleanLabels = (v) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean))].slice(0, 12);
// Image crop is a box in fractions of the (rotated) picture; rotation is a quarter turn.
function cleanCrop(c) {
  if (!obj(c)) return null;
  const f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const x = f(c.x);
  const y = f(c.y);
  const w = Math.min(1 - x, Math.max(0.02, f(c.w)));
  const h = Math.min(1 - y, Math.max(0.02, f(c.h)));
  return x < 0.001 && y < 0.001 && w > 0.999 && h > 0.999 ? null : { x, y, w, h };
}
// Drawing cards hold strokes; images may carry strokes drawn over them (data.ink).
function cleanData(type, data) {
  const labels = 'labels' in data ? { labels: cleanLabels(data.labels) } : {};
  if ('strip' in data) data = { ...data, strip: HEX.test(data.strip) ? data.strip.toLowerCase() : null }; // top-strip colour
  if (type === 'drawing') return { strokes: cleanStrokes(data.strokes), vw: size1(data.vw), vh: size1(data.vh), ...labels };
  // Colour cards: one swatch, its hex and a name.
  if (type === 'color') return { ...data, ...labels, hex: HEX.test(data.hex) ? data.hex.toLowerCase() : '#ecbc1c', name: typeof data.name === 'string' ? data.name.trim().slice(0, 60) : '' };
  data = { ...data, ...labels };
  if (type === 'image') {
    if ('ink' in data) {
      const strokes = obj(data.ink) ? cleanStrokes(data.ink.strokes) : [];
      data.ink = strokes.length ? { strokes, vw: size1(data.ink.vw), vh: size1(data.ink.vh) } : null;
    }
    if ('crop' in data) data.crop = cleanCrop(data.crop);
    if ('rotate' in data) data.rotate = [0, 90, 180, 270].includes(Number(data.rotate)) ? Number(data.rotate) : 0;
  }
  return data;
}

// Board cover: an icon (emoji) or a few letters, on a background colour with a text colour.
const HEX = /^#[0-9a-f]{6}$/i;
function cleanCover(c) {
  if (!obj(c)) return null;
  const kind = c.kind === 'text' ? 'text' : c.kind === 'icon' ? 'icon' : null;
  const value = typeof c.value === 'string' ? [...c.value.trim()].slice(0, kind === 'text' ? 4 : 8).join('') : '';
  return {
    kind: value ? kind : null,
    value: kind ? value : '',
    bg: HEX.test(c.bg) ? c.bg.toLowerCase() : null,
    fg: HEX.test(c.fg) ? c.fg.toLowerCase() : null,
  };
}

export function createStore(file) {
  const db = openDatabase(file);
  db.exec(SCHEMA);
  // Columns added after the first release.
  const fileCols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
  if (!fileCols.includes('alpha')) db.exec('ALTER TABLE files ADD COLUMN alpha INTEGER');
  if (!fileCols.includes('color')) db.exec('ALTER TABLE files ADD COLUMN color TEXT');
  if (!fileCols.includes('unused_since')) db.exec('ALTER TABLE files ADD COLUMN unused_since INTEGER'); // see cleanup.js
  if (!fileCols.includes('pages')) db.exec('ALTER TABLE files ADD COLUMN pages INTEGER'); // PDFs
  const now = () => Date.now();

  if (!db.prepare('SELECT 1 FROM boards WHERE id = ?').get('root')) {
    db.prepare(insertSql('boards', BOARD_COLS)).run(
      pack({ id: 'root', parent_id: null, title: 'Home', color: null, data: {}, created_at: now(), updated_at: now() })
    );
  }

  // ---- meta ----
  const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) =>
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  // ---- reads ----
  const getBoard = (id) => parse(db.prepare('SELECT * FROM boards WHERE id = ?').get(id));
  const getCard = (id) => parse(db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
  const getArrow = (id) => parse(db.prepare('SELECT * FROM arrows WHERE id = ?').get(id));
  const countCards = (boardId) => db.prepare('SELECT COUNT(*) AS n FROM cards WHERE board_id = ?').get(boardId).n;

  // Board cards carry their child board's title and size for display.
  function decorate(card) {
    if (card?.type === 'board') {
      const b = getBoard(card.data.boardId);
      card.child = b ? { id: b.id, title: b.title, color: b.color, cover: b.data?.cover ?? null, count: countCards(b.id) } : null;
    }
    return card;
  }

  const listBoards = () =>
    db.prepare('SELECT id, parent_id, title, color, updated_at FROM boards ORDER BY title COLLATE NOCASE').all();

  function breadcrumbs(id) {
    const out = [];
    const seen = new Set();
    let b = getBoard(id);
    while (b && !seen.has(b.id)) {
      seen.add(b.id);
      out.unshift({ id: b.id, title: b.title });
      b = b.parent_id ? getBoard(b.parent_id) : null;
    }
    return out;
  }

  // The board and every board nested under it, parents first.
  const subtreeIds = (boardId) =>
    db
      .prepare('WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT b.id FROM boards b JOIN t ON b.parent_id = t.id) SELECT id FROM t')
      .all(boardId)
      .map((r) => r.id);

  const cardsOf = (boardId) => db.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY z').all(boardId).map(parse);
  const arrowsOf = (boardId) => db.prepare('SELECT * FROM arrows WHERE board_id = ?').all(boardId).map(parse);

  function filesByIds(ids) {
    const list = [...new Set(ids.filter(isId))];
    if (!list.length) return {};
    const rows = db.prepare(`SELECT * FROM files WHERE id IN (${placeholders(list.length)})`).all(...list);
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  function boardPayload(id, withFiles) {
    const board = getBoard(id);
    if (!board) throw new HttpError(404, 'Board not found');
    const cards = cardsOf(id).map(decorate);
    const out = { board, cards, arrows: arrowsOf(id), breadcrumbs: breadcrumbs(id) };
    if (withFiles) out.files = filesByIds(cards.map((c) => c.data.fileId));
    return out;
  }

  // ---- search index (search_fts + card_tags), refreshed on every write ----
  function indexCard(id) {
    db.prepare("DELETE FROM search_fts WHERE kind = 'card' AND ref = ?").run(id);
    db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(id);
    const c = getCard(id);
    if (!c) return;
    // Pictures and files are also found by their file name.
    const name = (c.type === 'image' || c.type === 'file') && c.data?.fileId ? db.prepare('SELECT name FROM files WHERE id = ?').get(c.data.fileId)?.name : null;
    const text = [cardText(c), name, ...(c.data?.labels || [])].filter(Boolean).join('\n');
    if (text) db.prepare("INSERT INTO search_fts (ref, board_id, kind, text) VALUES (?, ?, 'card', ?)").run(id, c.board_id, text);
    for (const tag of tagsOf(c)) db.prepare('INSERT OR IGNORE INTO card_tags (card_id, board_id, tag) VALUES (?, ?, ?)').run(id, c.board_id, tag);
  }
  function indexBoard(id) {
    db.prepare("DELETE FROM search_fts WHERE kind = 'board' AND ref = ?").run(id);
    const b = getBoard(id);
    if (b?.title) db.prepare("INSERT INTO search_fts (ref, board_id, kind, text) VALUES (?, ?, 'board', ?)").run(id, b.id, b.title);
  }
  const unindex = (kind, ids) => {
    for (const id of ids) db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref = ?').run(kind, id);
  };

  if (getMeta('search_version') !== SEARCH_VERSION) {
    db.transaction(() => {
      db.exec('DELETE FROM search_fts; DELETE FROM card_tags;');
      for (const { id } of db.prepare('SELECT id FROM boards').all()) indexBoard(id);
      for (const { id } of db.prepare('SELECT id FROM cards').all()) indexCard(id);
      setMeta('search_version', SEARCH_VERSION);
    })();
  }

  const boardTitle = (id) => getBoard(id)?.title ?? null;
  function cardHit(id, snippet) {
    const c = getCard(id);
    if (!c) return null;
    return { kind: 'card', id: c.id, type: c.type, board_id: c.board_id, board_title: boardTitle(c.board_id), snippet: snippet ?? cardText(c).slice(0, 160) };
  }

  // Snippets mark matches with \u0001 … \u0002 so the client can highlight without HTML.
  function search(q) {
    const match = ftsQuery(q);
    if (!match) return [];
    const rows = db
      .prepare(
        "SELECT ref, board_id, kind, snippet(search_fts, 3, char(1), char(2), '…', 14) AS snippet FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 60"
      )
      .all(match);
    return rows
      .map((r) => {
        if (r.kind === 'card') return cardHit(r.ref, r.snippet);
        const b = getBoard(r.ref);
        return b && { kind: 'board', id: b.id, type: 'board', board_id: b.id, board_title: b.parent_id ? boardTitle(b.parent_id) : null, snippet: r.snippet };
      })
      .filter(Boolean);
  }

  const byTag = (tag) =>
    db
      .prepare('SELECT card_id FROM card_tags WHERE tag = ? ORDER BY rowid DESC LIMIT 200')
      .all(String(tag).replace(/^#/, '').toLowerCase())
      .map((r) => cardHit(r.card_id))
      .filter(Boolean);

  // Labels in use anywhere, most used first (for the label picker).
  const listLabels = () =>
    db.prepare("SELECT j.value AS label, COUNT(*) AS count FROM cards, json_each(cards.data, '$.labels') AS j GROUP BY j.value ORDER BY count DESC, j.value COLLATE NOCASE LIMIT 300").all();
  const listTags = () => db.prepare('SELECT tag, COUNT(*) AS count FROM card_tags GROUP BY tag ORDER BY count DESC, tag LIMIT 300').all();

  // ---- unused files (cleanup.js) ----
  // A file is in use while any card, saved item or board mentions its id anywhere in its data
  // (fileId, link preview image, ...). Starts the clock on files that just became unused, stops it
  // on files used again (undo, restore), and returns every unused file with its clock.
  const sweepUnused = db.transaction((now) => {
    const ids = new Set(db.prepare('SELECT id FROM files').all().map((r) => r.id));
    const used = new Set();
    const walk = (v) => {
      if (typeof v === 'string') ids.has(v) && used.add(v);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    for (const t of ['cards', 'clips', 'boards']) for (const r of db.prepare(`SELECT data FROM ${t}`).all()) walk(JSON.parse(r.data || '{}'));
    const start = db.prepare('UPDATE files SET unused_since = ? WHERE id = ? AND unused_since IS NULL');
    const stop = db.prepare('UPDATE files SET unused_since = NULL WHERE id = ? AND unused_since IS NOT NULL');
    for (const id of ids) used.has(id) ? stop.run(id) : start.run(now, id);
    return db.prepare('SELECT f.*, d.drive_id FROM files f LEFT JOIN drive_files d ON d.local_id = f.id WHERE f.unused_since IS NOT NULL ORDER BY f.unused_since').all();
  });
  const unusedSummary = () => db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MIN(unused_since) AS oldest FROM files WHERE unused_since IS NOT NULL').get();
  const forgetFile = db.transaction((id) => {
    db.prepare('DELETE FROM drive_files WHERE local_id = ?').run(id);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
  });

  function stats() {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const stored = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM (SELECT MAX(size) AS size FROM files GROUP BY COALESCE(sha256, id))').get().n;
    return { boards: count('boards'), cards: count('cards'), arrows: count('arrows'), files: count('files'), stored_bytes: stored };
  }

  // ---- boards ----
  function createBoard(parentId, title) {
    const id = newId();
    const t = now();
    db.prepare(insertSql('boards', BOARD_COLS)).run(
      pack({ id, parent_id: parentId, title: str(title, 500) ?? 'New board', color: null, data: {}, created_at: t, updated_at: t })
    );
    indexBoard(id);
    return id;
  }

  function patchBoard(id, p) {
    const board = getBoard(id);
    if (!board) throw new HttpError(404, 'Board not found');
    const next = {};
    if ('title' in p) next.title = str(p.title, 500) ?? '';
    if ('color' in p) next.color = str(p.color, 50);
    if (obj(p.data)) next.data = JSON.stringify({ ...board.data, ...p.data, ...('cover' in p.data ? { cover: cleanCover(p.data.cover) } : {}) });
    if (!Object.keys(next).length) return board;
    next.updated_at = now();
    const sets = Object.keys(next).map((k) => `${k} = :${k}`).join(', ');
    db.prepare(`UPDATE boards SET ${sets} WHERE id = :id`).run({ ...next, id });
    indexBoard(id);
    return getBoard(id);
  }

  // Deep copy of a board and everything inside it, under a new parent.
  function copyBoard(srcId, parentId) {
    const src = getBoard(srcId);
    if (!src) throw new HttpError(404, 'Board to copy not found');
    const id = newId();
    const t = now();
    db.prepare(insertSql('boards', BOARD_COLS)).run(pack({ ...src, id, parent_id: parentId, created_at: t, updated_at: t }));
    indexBoard(id);
    const cards = cardsOf(srcId);
    const map = new Map(cards.map((c) => [c.id, newId()]));
    for (const c of cards) {
      const data = { ...c.data };
      if (c.type === 'board' && data.boardId) data.boardId = copyBoard(data.boardId, id);
      db.prepare(insertSql('cards', CARD_COLS)).run(
        pack({ ...c, id: map.get(c.id), board_id: id, column_id: c.column_id ? map.get(c.column_id) ?? null : null, data, created_at: t, updated_at: t })
      );
      indexCard(map.get(c.id));
    }
    for (const a of arrowsOf(srcId)) {
      if (!map.has(a.from_card) || !map.has(a.to_card)) continue;
      db.prepare(insertSql('arrows', ARROW_COLS)).run(
        pack({ ...a, id: newId(), board_id: id, from_card: map.get(a.from_card), to_card: map.get(a.to_card), created_at: t })
      );
    }
    return id;
  }

  // ---- cards ----
  const nextZ = (boardId) => db.prepare('SELECT COALESCE(MAX(z), 0) + 1 AS z FROM cards WHERE board_id = ?').get(boardId).z;
  const nextSort = (columnId) => db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM cards WHERE column_id = ?').get(columnId).s;

  function validColumn(columnId, boardId) {
    if (!columnId) return null;
    const col = getCard(columnId);
    return col && col.type === 'column' && col.board_id === boardId ? columnId : null;
  }

  function insertCard(boardId, c) {
    if (!obj(c)) throw new HttpError(400, 'Card must be an object');
    if (!CARD_TYPES.has(c.type)) throw new HttpError(400, `Unknown card type: ${c.type}`);
    if (c.id != null && !isId(c.id)) throw new HttpError(400, 'Bad card id');
    const id = c.id || newId();
    if (getCard(id)) throw new HttpError(409, `Card ${id} already exists`);
    const data = cleanData(c.type, { ...(obj(c.data) ?? {}) });
    if (c.type === 'board') {
      data.boardId = c.copyFrom ? copyBoard(String(c.copyFrom), boardId) : createBoard(boardId, c.title ?? data.title ?? 'New board');
      delete data.title;
    }
    const column_id = validColumn(c.column_id, boardId);
    const t = now();
    db.prepare(insertSql('cards', CARD_COLS)).run(
      pack({
        id,
        board_id: boardId,
        type: c.type,
        x: num(c.x, 'x') ?? 0,
        y: num(c.y, 'y') ?? 0,
        w: num(c.w, 'w'),
        h: num(c.h, 'h'),
        z: num(c.z, 'z', { int: true }) ?? nextZ(boardId),
        color: str(c.color, 50),
        column_id,
        sort: num(c.sort, 'sort') ?? (column_id ? nextSort(column_id) : null),
        data,
        created_at: t,
        updated_at: t,
      })
    );
    indexCard(id);
    return decorate(getCard(id));
  }

  const createCards = db.transaction((boardId, list) => {
    if (!getBoard(boardId)) throw new HttpError(404, 'Board not found');
    return list.map((c) => insertCard(boardId, c));
  });

  // Move one card (and, for a column, the cards stacked in it) to another board.
  function moveCard(card, target, moved) {
    if (card.type === 'board' && card.data.boardId) {
      if (subtreeIds(card.data.boardId).includes(target)) throw new HttpError(400, "Can't move a board inside itself");
      db.prepare('UPDATE boards SET parent_id = ?, updated_at = ? WHERE id = ?').run(target, now(), card.data.boardId);
    }
    db.prepare('UPDATE cards SET board_id = ?, updated_at = ? WHERE id = ?').run(target, now(), card.id);
    moved.set(card.id, card);
    if (card.type === 'column') {
      for (const child of db.prepare('SELECT * FROM cards WHERE column_id = ?').all(card.id).map(parse)) {
        if (child.board_id !== target) moveCard(child, target, moved);
      }
    }
  }

  const FIELDS = { x: {}, y: {}, w: {}, h: {}, z: { int: true }, sort: {} };

  // Batch update. Returns each touched card's old and new state plus arrow changes.
  const patchCards = db.transaction((patches) => {
    if (!Array.isArray(patches)) throw new HttpError(400, 'Expected a list of card changes');
    const before = new Map();
    const moved = new Map();
    for (const p of patches) {
      const card = getCard(p?.id);
      if (!card) continue;
      if (!before.has(card.id)) before.set(card.id, card);
      if (p.board_id && p.board_id !== card.board_id) {
        if (!getBoard(p.board_id)) throw new HttpError(404, 'Target board not found');
        moveCard(card, p.board_id, moved);
        if (!('column_id' in p)) p.column_id = null;
      }
      const next = {};
      for (const [f, opts] of Object.entries(FIELDS)) if (f in p) next[f] = num(p[f], f, opts);
      if ('color' in p) next.color = str(p.color, 50);
      if ('column_id' in p) next.column_id = p.column_id || null;
      if (obj(p.data)) next.data = JSON.stringify(cleanData(card.type, { ...card.data, ...p.data, ...(card.type === 'board' ? { boardId: card.data.boardId } : {}) }));
      if (!Object.keys(next).length) continue;
      next.updated_at = now();
      const sets = Object.keys(next).map((k) => `${k} = :${k}`).join(', ');
      db.prepare(`UPDATE cards SET ${sets} WHERE id = :id`).run({ ...next, id: card.id });
    }
    for (const [id, card] of moved) if (!before.has(id)) before.set(id, card);
    for (const id of before.keys()) indexCard(id);

    // A card can only sit in a column on its own board.
    for (const id of before.keys()) {
      const c = getCard(id);
      if (c.column_id && !validColumn(c.column_id, c.board_id)) db.prepare('UPDATE cards SET column_id = NULL WHERE id = ?').run(id);
    }

    // Arrows follow moved cards when both ends land on one board; otherwise they go.
    const arrowsMoved = [];
    const arrowsDeleted = [];
    if (moved.size) {
      const ids = [...moved.keys()];
      const q = placeholders(ids.length);
      const touching = db.prepare(`SELECT * FROM arrows WHERE from_card IN (${q}) OR to_card IN (${q})`).all(...ids, ...ids).map(parse);
      for (const a of touching) {
        const fb = getCard(a.from_card).board_id;
        const tb = getCard(a.to_card).board_id;
        if (fb !== tb) {
          db.prepare('DELETE FROM arrows WHERE id = ?').run(a.id);
          arrowsDeleted.push({ id: a.id, board_id: a.board_id });
        } else if (fb !== a.board_id) {
          db.prepare('UPDATE arrows SET board_id = ? WHERE id = ?').run(fb, a.id);
          arrowsMoved.push({ arrow: getArrow(a.id), from: a.board_id });
        }
      }
    }
    const changes = [...before].map(([id, old]) => ({ before: old, after: decorate(getCard(id)) }));
    return { changes, arrowsMoved, arrowsDeleted };
  });

  // Delete cards; columns take their stacked cards, board cards take their whole board tree.
  // Returns a snapshot that restore() can put back.
  const deleteCards = db.transaction((ids) => {
    if (!Array.isArray(ids)) throw new HttpError(400, 'Expected a list of card ids');
    const cards = new Map();
    const roots = [];
    const queue = ids.filter(isId);
    while (queue.length) {
      const id = queue.shift();
      if (cards.has(id)) continue;
      const c = getCard(id);
      if (!c) continue;
      cards.set(id, c);
      if (c.type === 'column') queue.push(...db.prepare('SELECT id FROM cards WHERE column_id = ?').all(id).map((r) => r.id));
      if (c.type === 'board' && c.data.boardId && c.data.boardId !== 'root') roots.push(c.data.boardId);
    }
    const boardIds = [...new Set(roots.flatMap(subtreeIds))];
    const snapshot = { boards: boardIds.map(getBoard).filter(Boolean), cards: [...cards.values()], arrows: [] };
    for (const b of boardIds) snapshot.cards.push(...cardsOf(b));
    const arrows = new Map();
    for (const b of boardIds) for (const a of arrowsOf(b)) arrows.set(a.id, a);
    if (cards.size) {
      const list = [...cards.keys()];
      const q = placeholders(list.length);
      for (const a of db.prepare(`SELECT * FROM arrows WHERE from_card IN (${q}) OR to_card IN (${q})`).all(...list, ...list)) {
        arrows.set(a.id, parse(a));
      }
    }
    snapshot.arrows = [...arrows.values()];
    const removed = [...cards.values()].map((c) => ({ id: c.id, board_id: c.board_id }));
    const removedArrows = snapshot.arrows.filter((a) => !boardIds.includes(a.board_id)).map((a) => ({ id: a.id, board_id: a.board_id }));
    unindex('card', snapshot.cards.map((c) => c.id));
    unindex('board', boardIds);
    for (const b of roots) db.prepare('DELETE FROM boards WHERE id = ?').run(b);
    for (const id of cards.keys()) db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    return { snapshot, removed, removedArrows };
  });

  // Put back what deleteCards removed. Rows that already exist are left alone.
  const restore = db.transaction((snapshot) => {
    if (!obj(snapshot)) throw new HttpError(400, 'Expected a snapshot');
    const boards = Array.isArray(snapshot.boards) ? [...snapshot.boards] : [];
    const restoredBoards = [];
    while (boards.length) {
      const before = boards.length;
      for (let i = boards.length - 1; i >= 0; i--) {
        const b = boards[i];
        if (getBoard(b.id)) {
          boards.splice(i, 1);
        } else if (!b.parent_id || getBoard(b.parent_id)) {
          db.prepare(insertSql('boards', BOARD_COLS)).run(pack(b));
          restoredBoards.push(b.id);
          boards.splice(i, 1);
        }
      }
      if (boards.length === before) throw new HttpError(409, 'Cannot restore: a parent board no longer exists');
    }
    const cards = [];
    for (const c of snapshot.cards ?? []) {
      if (getCard(c.id)) continue;
      if (!getBoard(c.board_id)) throw new HttpError(409, 'Cannot restore: the board this card was on no longer exists');
      db.prepare(insertSql('cards', CARD_COLS)).run(pack(c));
      cards.push(c.id);
    }
    const arrows = [];
    for (const a of snapshot.arrows ?? []) {
      if (getArrow(a.id) || !getCard(a.from_card) || !getCard(a.to_card) || !getBoard(a.board_id)) continue;
      db.prepare(insertSql('arrows', ARROW_COLS)).run(pack(a));
      arrows.push(a.id);
    }
    for (const id of restoredBoards) indexBoard(id);
    for (const id of cards) indexCard(id);
    return {
      boards: restoredBoards,
      cards: cards.map(getCard).map(decorate),
      arrows: arrows.map(getArrow),
    };
  });

  // ---- arrows ----
  function createArrow(boardId, a) {
    if (!getBoard(boardId)) throw new HttpError(404, 'Board not found');
    if (!obj(a)) throw new HttpError(400, 'Arrow must be an object');
    if (a.id != null && !isId(a.id)) throw new HttpError(400, 'Bad arrow id');
    const from = getCard(a.from_card);
    const to = getCard(a.to_card);
    if (!from || !to || from.board_id !== boardId || to.board_id !== boardId) {
      throw new HttpError(400, 'Both ends of an arrow must be cards on this board');
    }
    const id = a.id || newId();
    if (getArrow(id)) throw new HttpError(409, `Arrow ${id} already exists`);
    db.prepare(insertSql('arrows', ARROW_COLS)).run(
      pack({ id, board_id: boardId, from_card: from.id, to_card: to.id, label: str(a.label, 500), color: str(a.color, 50), data: obj(a.data) ?? {}, created_at: now() })
    );
    return getArrow(id);
  }

  function patchArrow(id, p) {
    const arrow = getArrow(id);
    if (!arrow) throw new HttpError(404, 'Arrow not found');
    const next = {};
    if ('label' in p) next.label = str(p.label, 500);
    if ('color' in p) next.color = str(p.color, 50);
    if (obj(p.data)) next.data = JSON.stringify({ ...arrow.data, ...p.data });
    if (!Object.keys(next).length) return arrow;
    const sets = Object.keys(next).map((k) => `${k} = :${k}`).join(', ');
    db.prepare(`UPDATE arrows SET ${sets} WHERE id = :id`).run({ ...next, id });
    return getArrow(id);
  }

  function deleteArrow(id) {
    const arrow = getArrow(id);
    if (!arrow) throw new HttpError(404, 'Arrow not found');
    db.prepare('DELETE FROM arrows WHERE id = ?').run(id);
    return arrow;
  }

  // ---- saved items (clips): things saved from web pages, waiting in a board's inbox ----
  const CLIP_KINDS = new Set(['image', 'link', 'text']);
  const getClip = (id) => parse(db.prepare('SELECT * FROM clips WHERE id = ?').get(id));
  function createClip(boardId, kind, data) {
    if (!getBoard(boardId)) throw new HttpError(404, 'Board not found');
    if (!CLIP_KINDS.has(kind)) throw new HttpError(400, `Unknown kind: ${kind}`);
    const id = newId();
    db.prepare('INSERT INTO clips (id, board_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)').run(id, boardId, kind, JSON.stringify(data || {}), now());
    return getClip(id);
  }
  const listClips = (boardId) =>
    (boardId ? db.prepare('SELECT * FROM clips WHERE board_id = ? ORDER BY created_at DESC').all(boardId) : db.prepare('SELECT * FROM clips ORDER BY created_at DESC').all()).map(parse);
  function patchClip(id, p) {
    const clip = getClip(id);
    if (!clip) throw new HttpError(404, 'Saved item not found');
    if (p.board_id && !getBoard(p.board_id)) throw new HttpError(404, 'Board not found');
    const data = obj(p.data) ? JSON.stringify({ ...clip.data, ...p.data }) : JSON.stringify(clip.data);
    db.prepare('UPDATE clips SET board_id = ?, data = ? WHERE id = ?').run(p.board_id || clip.board_id, data, id);
    return getClip(id);
  }
  function deleteClip(id) {
    const clip = getClip(id);
    if (!clip) throw new HttpError(404, 'Saved item not found');
    db.prepare('DELETE FROM clips WHERE id = ?').run(id);
    return clip;
  }
  // Turn a clip into a card at (x, y) and take it out of the inbox, in one transaction.
  const placeClip = db.transaction((id, boardId, x, y, card) => {
    const clip = deleteClip(id);
    const [made] = createCards(boardId || clip.board_id, [{ ...card, x, y }]);
    return { clip, card: made };
  });

  // A board with everything nested under it, plus the files its cards use.
  function exportTree(boardId) {
    if (!getBoard(boardId)) throw new HttpError(404, 'Board not found');
    const ids = subtreeIds(boardId);
    const cards = ids.flatMap(cardsOf);
    const fileIds = cards.flatMap((c) => [c.data.fileId, c.data.image]).filter(Boolean);
    return { boards: ids.map(getBoard), cards, arrows: ids.flatMap(arrowsOf), files: Object.values(filesByIds(fileIds)) };
  }

  // ---- files ----
  const insertFile = (f) =>
    db.prepare(insertSql('files', ['id', 'name', 'mime', 'ext', 'size', 'width', 'height', 'sha256', 'display_ext', 'alpha', 'color', 'created_at'])).run({ alpha: null, color: null, ...f });
  const setFileAlpha = (id, alpha) => db.prepare('UPDATE files SET alpha = ? WHERE id = ?').run(alpha ? 1 : 0, id);
  const setFileColor = (id, color) => db.prepare('UPDATE files SET color = ? WHERE id = ?').run(color, id);
  // A PDF's first page, drawn by the browser (see web/src/pdf.js): its size and the page count.
  const setFilePreview = (id, { width, height, color, pages }) =>
    db.prepare('UPDATE files SET width = ?, height = ?, color = ?, pages = ? WHERE id = ?').run(width, height, color, pages, id);
  const getFile = (id) => db.prepare('SELECT * FROM files WHERE id = ?').get(id) ?? null;

  return {
    db,
    getMeta,
    setMeta,
    getBoard,
    getCard,
    listBoards,
    breadcrumbs,
    boardPayload,
    patchBoard,
    createCards,
    patchCards,
    deleteCards,
    restore,
    createArrow,
    patchArrow,
    deleteArrow,
    insertFile,
    setFileAlpha,
    setFileColor,
    setFilePreview,
    getFile,
    getClip,
    createClip,
    listClips,
    patchClip,
    deleteClip,
    placeClip,
    exportTree,
    allFiles: () => db.prepare('SELECT * FROM files').all(),
    filesNotOnDrive: () => db.prepare('SELECT f.* FROM files f LEFT JOIN drive_files d ON d.local_id = f.id WHERE d.local_id IS NULL').all(),
    markOnDrive: (localId, driveId) =>
      db.prepare('INSERT OR REPLACE INTO drive_files (local_id, drive_id, uploaded_at) VALUES (?, ?, ?)').run(localId, driveId, Date.now()),
    clearDriveFiles: () => db.exec('DELETE FROM drive_files'),
    sweepUnused,
    unusedSummary,
    forgetFile,
    search,
    byTag,
    listTags,
    listLabels,
    stats,
    close: () => db.close(),
  };
}
