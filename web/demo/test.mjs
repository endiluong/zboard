// Checks the demo's in-browser server (backend.js on the real db.js) in Node, without a browser:
// a new visitor gets an empty Home board; cards, boards, arrows, search, delete/undo and uploads
// work; and everything is still there after a "restart" from the saved bytes.
// Usage (from web/): node demo/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { buildBackendForNode } from './build.mjs';

let fails = 0;
const check = (ok, name, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ' ' + extra}`);
  if (!ok) fails++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-demo-'));
const bundle = path.join(tmp, 'backend.mjs');
await buildBackendForNode(bundle);
const { createBackend } = await import(bundle);
const sqlite3 = await sqlite3InitModule();

// The browser's storage, in memory.
const saved = { db: null, files: new Map() };
const storage = {
  loadDb: async () => saved.db,
  saveDb: async (b) => (saved.db = new Uint8Array(b)),
  putFile: async (k, b) => saved.files.set(k, b),
  getFile: async (k) => saved.files.get(k),
};
const ORIGIN = 'https://endiluong.github.io';
const call = async (b, method, p, body) => {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body instanceof Blob) Object.assign(init, { body: await body.arrayBuffer(), headers: { 'content-type': body.type } });
  else if (body !== undefined) Object.assign(init, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await b.handle(new Request(ORIGIN + p, init));
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.blob() };
};

let b = await createBackend({ sqlite3, storage });
let r = await call(b, 'GET', '/api/me');
check(r.status === 200 && r.body.ok, 'signed in without a password');
r = await call(b, 'GET', '/api/boards/root');
check(r.body.board?.title === 'Home' && r.body.cards.length === 0, 'a new visitor starts with an empty Home board', JSON.stringify(r.body));

r = await call(b, 'POST', '/api/boards/root/cards', { cards: [{ type: 'note', x: 40, y: 40, data: { html: '<p>Gold #nmm recipe</p>' } }, { type: 'board', title: 'Ideas', x: 400, y: 40 }] });
check(r.status === 201 && r.body.cards.length === 2, 'cards are created', JSON.stringify(r.body));
const [note, boardCard] = r.body.cards;
const child = boardCard.data.boardId;
check(!!child && boardCard.child?.title === 'Ideas', 'a board card makes a board inside', JSON.stringify(boardCard));

r = await call(b, 'PATCH', '/api/cards', { cards: [{ id: note.id, x: 120, data: { html: '<p>Gold #nmm recipe, glazed</p>' } }] });
check(r.body.cards[0].x === 120 && /glazed/.test(r.body.cards[0].data.html), 'cards are edited and moved');

r = await call(b, 'GET', '/api/search?q=glaz');
check(r.body.results.some((x) => x.id === note.id && /\u0001/.test(x.snippet)), 'search finds it, with the match marked', JSON.stringify(r.body));
r = await call(b, 'GET', '/api/tags');
check(r.body.tags.some((t) => t.tag === 'nmm'), '#tags are listed', JSON.stringify(r.body));

r = await call(b, 'POST', '/api/boards/root/arrows', { from_card: note.id, to_card: boardCard.id });
check(r.status === 201 && r.body.arrow?.from_card === note.id, 'arrows connect cards', JSON.stringify(r.body));

r = await call(b, 'PATCH', `/api/cards`, { cards: [{ id: note.id, board_id: child }] });
let inner = await call(b, 'GET', `/api/boards/${child}`);
check(inner.body.cards.some((c) => c.id === note.id) && inner.body.breadcrumbs.map((x) => x.title).join('/') === 'Home/Ideas', 'cards move into a board, with breadcrumbs');

r = await call(b, 'POST', '/api/cards/delete', { ids: [note.id] });
const snapshot = r.body.snapshot;
inner = await call(b, 'GET', `/api/boards/${child}`);
check(!inner.body.cards.length && snapshot?.cards?.length === 1, 'delete removes the card and returns an undo snapshot');
r = await call(b, 'POST', '/api/restore', { snapshot });
inner = await call(b, 'GET', `/api/boards/${child}`);
check(inner.body.cards.length === 1, 'undo brings it back');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const fd = new FormData();
fd.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
r = await call(b, 'POST', '/api/upload', fd);
const file = r.body.file;
check(r.status === 201 && file?.name === 'dot.png' && file.size === png.length, 'pictures upload', JSON.stringify(r.body));
r = await call(b, 'POST', '/api/upload?name=IMG%200001.png', new Blob([png], { type: 'image/png' }));
check(r.status === 201 && r.body.file?.name === 'IMG 0001.png' && r.body.file.mime === 'image/png' && r.body.file.size === png.length, 'pictures sent as plain bytes upload too (Safari)', JSON.stringify(r.body));
r = await call(b, 'GET', `/files/${file.id}/thumb`);
check(r.status === 200 && r.body.size === png.length, 'and are served back (the original when there is no preview)');
r = await call(b, 'POST', '/api/upload?name=guide.pdf', new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }));
const pdf = r.body.file;
r = await call(b, 'POST', '/api/boards/root/cards', { type: 'file', x: 0, y: 0, data: { fileId: pdf.id } });
check(r.status === 201 && r.body.card.type === 'file', 'a PDF becomes a file card', JSON.stringify(r.body));
r = await call(b, 'POST', `/api/files/${pdf.id}/preview?pages=4&w=600&h=800`, new Blob([png], { type: 'image/jpeg' }));
check(r.status === 200 && r.body.file.pages === 4 && r.body.file.width === 600, 'its first page, drawn by the app, is kept as its preview', JSON.stringify(r.body));
r = await call(b, 'POST', `/api/files/${file.id}/preview`, new Blob([png], { type: 'image/jpeg' }));
check(r.status === 400, 'only PDFs take a preview');
r = await call(b, 'POST', '/api/cards/delete', { ids: [(await call(b, 'GET', '/api/boards/root')).body.cards.find((c) => c.type === 'file').id] });
r = await call(b, 'GET', '/api/drive');
check(r.status === 404 && /demo/.test(r.body.error), 'server-only features say "not in the demo"');

// Restart: a fresh backend from the saved bytes (the service worker was stopped by the browser).
b = await createBackend({ sqlite3, storage });
inner = await call(b, 'GET', `/api/boards/${child}`);
r = await call(b, 'GET', '/api/boards/root');
check(inner.body.cards.length === 1 && r.body.cards.length === 1 && r.body.arrows.length === 0, 'everything is still there after a restart', JSON.stringify({ inner: inner.body.cards.length, root: r.body.cards.length }));
r = await call(b, 'GET', '/api/search?q=glazed');
check(r.body.results.length === 1, 'search still works after a restart');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`FAILS=${fails}`);
process.exit(fails ? 1 : 0);
