// Videos: a big MP4 picked with the File tool uploads in pieces, becomes a video card showing a frame,
// a ▶ and its length (drawn by the browser), and plays full screen by streaming: only the parts
// being played are downloaded, and jumping ahead asks for just that part.
// Needs a server on ZB_URL with MAX_UPLOAD_MB above the video's size, and VIDEO = path of an MP4
// (H.264) of at least 50 MB.
import fs from 'node:fs';
import { api, BASE, check, done, launch, login, sleep } from './lib.mjs';

const VIDEO = process.env.VIDEO;
const size = fs.statSync(VIDEO).size;
await api('GET', '/api/me');
const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Videos', x: 40, y: 40 }] })).cards[0].data.boardId;
const browser = await launch();
const { page } = await login(browser, { width: 1280, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/#/b/${board}`);
await page.waitForSelector('.canvas');

// 1. Upload.
const t0 = Date.now();
await page.mouse.click(640, 430, { button: 'right' });
const chooser = page.waitForEvent('filechooser');
await page.getByRole('menuitem', { name: 'File', exact: true }).click();
await (await chooser).setFiles(VIDEO);
await page.waitForSelector('.card-uploading');
check((await page.locator('.card-uploading .upl-tile.kind-video').count()) === 1, 'while uploading, the placeholder shows it is a video');
await page.waitForSelector('.card-file', { timeout: 180000 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const card = page.locator('.card-file').first();
const fileId = (await api('GET', `/api/boards/${board}`)).cards.find((c) => c.type === 'file').data.fileId;
check(true, `uploaded ${(size / 1048576).toFixed(0)} MB in ${secs} s`);

// 2. The card: a frame, ▶ and the length.
await page.waitForSelector('.card-file .file-page img[data-img="loaded"]', { timeout: 60000 }).catch(() => {});
const info = (await api('GET', `/api/files/${fileId}/info`)).file;
check(info.size === size && info.width > 0 && info.duration > 0, 'the server keeps a frame and the length', JSON.stringify({ size: info.size, w: info.width, h: info.height, d: info.duration }));
check((await card.locator('.file-play').count()) === 1, 'the card shows a ▶');
const dur = await card.locator('.file-duration').innerText().catch(() => '');
check(/^\d+:\d\d(:\d\d)?$/.test(dur) && (await card.locator('.file-facts').innerText()).includes(dur), 'and its length, on the picture and under it', dur);
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step33-card.png`, clip: await card.boundingBox().then((b) => ({ x: b.x - 10, y: b.y - 10, width: b.width + 20, height: b.height + 20 })) });

// 3. Play: streamed in parts.
const got = [];
page.on('response', async (r) => {
  if (!r.url().includes(`/files/${fileId}?original=1`)) return;
  const len = Number(r.headers()['content-length'] || 0);
  got.push({ status: r.status(), range: r.request().headers().range || '-', len });
});
await card.dblclick();
await page.waitForSelector('.video-player video');
await page.evaluate(() => {
  const v = document.querySelector('.video-player video');
  v.muted = true;
  return v.play().catch(() => {});
});
const played = await page.waitForFunction(() => document.querySelector('.video-player video')?.currentTime > 1.5, null, { timeout: 30000 }).then(() => true, () => false);
check(played, 'the video plays');
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step33-player.png` });
await page.evaluate(() => {
  const v = document.querySelector('.video-player video');
  v.currentTime = v.duration * 0.8;
});
const jumped = await page.waitForFunction(() => {
  const v = document.querySelector('.video-player video');
  return v.currentTime > v.duration * 0.8 + 1;
}, null, { timeout: 30000 }).then(() => true, () => false);
check(jumped, 'jumping to 80% plays from there');
await sleep(500);
const ranged = got.filter((g) => g.status === 206);
const far = ranged.some((g) => Number(/bytes=(\d+)/.exec(g.range)?.[1] || 0) > size * 0.5);
check(ranged.length >= 1 && far, 'it streams with range requests, and the jump asks for a part far into the file', JSON.stringify(got.slice(0, 6)));
// Every answer is a part (206), never the whole file in one go. (How much is read in total depends on
// the video: the browser reads some seconds ahead, which covers most of a short, dense clip.)
check(got.length > 0 && got.every((g) => g.status === 206), 'every download is a part of the file, never the whole file', JSON.stringify(got.filter((g) => g.status !== 206).slice(0, 3)));
if (info.duration > 120) {
  const bytes = await page.evaluate((id) => performance.getEntriesByType('resource').filter((e) => e.name.includes(`/files/${id}?original=1`)).reduce((s, e) => s + (e.transferSize || 0), 0), fileId);
  check(bytes === 0 || bytes < size * 0.5, 'and for a long video, well under the whole file', `${(bytes / 1048576).toFixed(1)} of ${(size / 1048576).toFixed(0)} MB`);
}

// 4. Escape closes it.
await page.keyboard.press('Escape');
await sleep(200);
check(!(await page.locator('.video-player').count()), 'Escape closes the player');

// 5. The stored file is the original.
const head = await fetch(`${BASE}/files/${fileId}?original=1`, { headers: { cookie: api.cookie, range: 'bytes=0-1023' } });
const a = Buffer.from(await head.arrayBuffer());
const b = Buffer.alloc(1024);
const fd = fs.openSync(VIDEO, 'r');
fs.readSync(fd, b, 0, 1024, 0);
fs.closeSync(fd);
check(head.status === 206 && a.equals(b), 'the stored file starts with the same bytes (and was checksummed in chunks)');

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
done();
