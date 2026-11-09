// Resumable uploads (web/src/uploads.js, server/src/uploads.js). A big file goes up in 5 MB pieces:
// closing the page mid-way and opening it again carries on from the last piece the server has, and the
// stored file is byte-for-byte the original; a lost connection pauses it until the connection is back;
// an upload whose browser copy is gone shows as failed (red, ✕), and choosing the same file finishes it
// without sending the rest again; an expired one says so; Cancel removes it everywhere.
// Needs a server on ZB_URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, BASE, check, done, launch, login, sleep } from './lib.mjs';

const MB = 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-resume-'));
const makeFile = (name, mb) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(mb * MB)]));
  return p;
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const uploadsNow = async () => (await api('GET', '/api/uploads')).uploads;
const waitFor = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
};

await api('GET', '/api/me');
const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Resume', x: 40, y: 40 }] })).cards[0].data.boardId;
const browser = await launch();
const errors = [];

// Opens the test board; a slow upload speed (bytes/s) is set before the page loads, so an upload the
// page resumes on its own is slow from its first byte too.
async function openBoard(context, page, bps = -1) {
  page ??= await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  const throttle = (b, offline = false) => cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: b });
  await throttle(bps);
  const puts = [];
  page.on('request', (r) => r.method() === 'PUT' && /\/api\/uploads\/[^/]+\/pieces\//.test(r.url()) && puts.push(r.url()));
  await page.goto(`${BASE}/#/b/${board}`);
  await page.waitForSelector('.canvas');
  return { page, throttle, puts, offline: (on) => throttle(on ? 0 : 3 * MB, on) };
}
async function pick(page, file) {
  await page.mouse.click(640, 430, { button: 'right' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await (await chooser).setFiles(file);
}
const fileCards = async () => (await api('GET', `/api/boards/${board}`)).cards.filter((c) => c.type === 'file');

// ---------- A. Close the page half-way; open it again ----------
const { context } = await login(browser, { width: 1280, height: 860 });
let s = await openBoard(context, (await context.pages())[0]);
const aPath = makeFile('Resume me.pdf', 30); // 7 pieces
await s.throttle(6 * MB);
await pick(s.page, aPath);
await s.page.waitForSelector('.card-uploading');
const half = await waitFor(async () => (await uploadsNow()).find((u) => u.received.length >= 3));
check(!!half, 'pieces arrive and are kept by the server', JSON.stringify(await uploadsNow()).slice(0, 200));
const box = await s.page.locator('.card-uploading').boundingBox();
await s.page.close();
await sleep(500);
const left = (await uploadsNow())[0];
check(left && left.received.length >= 3 && left.received.length < left.pieces, 'after closing the page the server still has what arrived', left && `${left.received.length}/${left.pieces}`);

s = await openBoard(context, null, 6 * MB);
await s.page.waitForSelector('.card-uploading.st-resuming, .card-uploading.st-uploading', { timeout: 10000 });
const resumeText = await s.page.locator('.card-uploading .upl-facts').innerText().catch(() => '');
check(/Resuming from \d|of 30/.test(resumeText), 'opening ZBoard again shows the upload carrying on', resumeText);
await s.page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step31-resuming.png` });
await s.page.waitForSelector('.card-file', { timeout: 60000 });
check(s.puts.length <= left.pieces - left.received.length + 1, 'only the missing pieces are sent', `${s.puts.length} sent, ${left.pieces - left.received.length} were missing`);
let cards = await fileCards();
const aFile = (await api('GET', `/api/files/${cards[0].data.fileId}/info`)).file;
const stored = Buffer.from(await (await fetch(`${BASE}/files/${aFile.id}?original=1`, { headers: { cookie: api.cookie } })).arrayBuffer());
check(sha(stored) === sha(fs.readFileSync(aPath)), 'the stored file is exactly the original', `${stored.length} bytes`);
check(Math.abs(cards[0].x - (box.x - 0)) >= 0 && cards.length === 1, 'one card was made');
check(!(await uploadsNow()).length, 'the finished upload is gone from the server');
check((await s.page.evaluate(() => new Promise((r) => { const q = indexedDB.open('zb-uploads'); q.onsuccess = () => { const g = q.result.transaction('jobs').objectStore('jobs').count(); g.onsuccess = () => r(g.result); }; }))) === 0, "and the browser's copy is deleted");

// ---------- B. Connection lost mid-way ----------
const bPath = makeFile('Offline.pdf', 12);
await s.throttle(3 * MB);
await pick(s.page, bPath);
await waitFor(async () => (await uploadsNow()).find((u) => u.received.length >= 1));
await s.offline(true);
await s.page.waitForSelector('.card-uploading.st-paused', { timeout: 15000 });
check(/resumes when back online/.test(await s.page.locator('.card-uploading .upl-facts').innerText()), 'losing the connection pauses it, and says so');
await s.page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step31-paused.png` });
await sleep(1500);
await s.offline(false);
await s.throttle(-1);
await waitFor(async () => (await fileCards()).length === 2, 60000);
check((await fileCards()).length === 2, 'back online, it finishes by itself');

// ---------- C. The browser copy is gone: failed card, choose the file again ----------
const cPath = makeFile('Lost copy.pdf', 30);
await s.throttle(6 * MB);
await pick(s.page, cPath);
await waitFor(async () => (await uploadsNow()).find((u) => u.received.length >= 3));
await s.page.close();
await context.close(); // its storage (with the copy) goes with it
const fresh = await login(browser, { width: 1280, height: 860 });
const c0 = (await uploadsNow())[0];
await sleep(21000); // an unfinished upload counts as abandoned after 20 quiet seconds
s = await openBoard(fresh.context, fresh.page);
await s.page.waitForSelector('.card-uploading.st-failed', { timeout: 10000 });
const failed = s.page.locator('.card-uploading.st-failed');
check((await failed.locator('.upl-fail-x').count()) === 1 && /no longer has its copy/.test(await failed.locator('.upl-reason').innerText()), 'with no copy left, the card is red with a ✕ and says why');
const bg = await failed.evaluate((el) => getComputedStyle(el).backgroundColor);
check(bg === 'rgb(253, 236, 235)', 'red background', bg);
await sleep(400); // let it finish fading in
await s.page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step31-failed.png` });
const chooser = s.page.waitForEvent('filechooser');
await failed.click();
await (await chooser).setFiles(cPath);
await waitFor(async () => (await fileCards()).length === 3, 60000);
check((await fileCards()).length === 3, 'choosing the same file finishes it');
check(s.puts.length <= c0.pieces - c0.received.length + 1, 'without sending again what the server had', `${s.puts.length} sent, ${c0.pieces - c0.received.length} were missing`);

// ---------- D. Expired ----------
const dPath = makeFile('Expired.pdf', 20);
await s.throttle(4 * MB);
await pick(s.page, dPath);
const d0 = await waitFor(async () => (await uploadsNow()).find((u) => u.received.length >= 1));
await s.page.close();
await api('DELETE', `/api/uploads/${d0.id}`); // what the 7-day clean-up does
s = await openBoard(fresh.context);
await s.page.waitForSelector('.card-uploading.st-failed', { timeout: 15000 });
check(/expired/.test(await s.page.locator('.card-uploading.st-failed .upl-reason').innerText()), 'an expired upload says so');
await s.page.locator('.card-uploading.st-failed .upl-cancel').click();
await sleep(300);
check(!(await s.page.locator('.card-uploading').count()), 'the bin removes a failed card');

// ---------- E. Cancel ----------
await s.throttle(2 * MB);
await pick(s.page, makeFile('Cancel.pdf', 20));
await waitFor(async () => (await uploadsNow()).length === 1);
await s.page.locator('.card-uploading .upl-cancel').click();
await sleep(800);
check(!(await s.page.locator('.card-uploading').count()) && !(await uploadsNow()).length, 'Cancel removes the placeholder and the pieces on the server');

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
done();
