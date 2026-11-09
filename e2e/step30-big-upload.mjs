// Big files upload in the background: each shows on the board as a placeholder card with its type and a
// progress bar, can be cancelled, and becomes the real card where it stood. A file over the server's
// limit is turned away before anything is sent. A big PDF's preview is read from the server in pieces
// (range requests), not loaded whole into the page. Needs a server on ZB_URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, BASE, check, done, launch, login, sleep } from './lib.mjs';

// A one-page PDF padded to `mb` megabytes with an unused stream of random bytes.
function bigPdf(mb) {
  const content = '0.85 0.25 0.2 rg 72 560 450 160 re f 0 0 0 rg BT /F1 40 Tf 72 460 Td (Big file) Tj ET';
  const pad = crypto.randomBytes(mb * 1024 * 1024).toString('latin1');
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${pad.length} >>\nstream\n${pad}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

await api('GET', '/api/me');
const limitMb = (await api('GET', '/api/me')).max_upload_mb;
check(limitMb > 0, 'the server says its upload limit', limitMb);
const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Big files', x: 40, y: 40 }] })).cards[0].data.boardId;

const browser = await launch();
const { page, context } = await login(browser, { width: 1280, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/#/b/${board}`);
await page.waitForSelector('.canvas');
await sleep(300);
const cdp = await context.newCDPSession(page);
const throttle = (bytesPerSec) =>
  cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSec });

const pick = async (files) => {
  await page.mouse.click(640, 430, { button: 'right' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await (await chooser).setFiles(files);
};
const ranged = []; // statuses of PDF reads (for step 3; listening from the start, the preview begins at once)
page.on('response', (r) => /\/files\/[^/]+\?original=1/.test(r.url()) && ranged.push(r.status()));
let uploads = 0;
page.on('request', (r) => r.url().endsWith('/api/upload') && uploads++);

// 1. Over the limit: refused at once, nothing sent.
// Files go to a temp folder: the test browser can't be handed more than 50 MB from memory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-big-'));
const hugePath = path.join(tmp, 'huge.pdf');
fs.writeFileSync(hugePath, Buffer.alloc((limitMb + 1) * 1024 * 1024, 32));
await pick(hugePath);
await page.waitForSelector('.toast');
check(/huge\.pdf.*largest upload is/.test(await page.locator('.toast').innerText()), 'a file over the limit is turned away with its size and the limit', await page.locator('.toast').innerText());
check(uploads === 0 && !(await page.locator('.card-uploading').count()), 'and nothing is uploaded');

// 2. A 30 MB PDF on a slow link: placeholder with a progress bar that moves.
const bigPath = path.join(tmp, 'Big guide.pdf');
fs.writeFileSync(bigPath, bigPdf(30));
const cancelPath = path.join(tmp, 'Cancel me.pdf');
fs.copyFileSync(bigPath, cancelPath);
await throttle(8 * 1024 * 1024);
await pick(bigPath);
await page.waitForSelector('.card-uploading');
const ph = page.locator('.card-uploading');
check((await ph.locator('.upl-name').innerText()) === 'Big guide.pdf' && (await ph.locator('.upl-doc b').innerText()) === 'PDF', 'a placeholder card shows the name and a PDF icon');
await sleep(1200);
const w1 = await ph.locator('.upl-bar i').evaluate((el) => parseFloat(el.style.width));
await sleep(1200);
const w2 = await ph.locator('.upl-bar i').evaluate((el) => parseFloat(el.style.width));
check(w1 > 0 && w2 > w1 && w2 < 100, 'its progress bar moves', `${w1}% → ${w2}%`);
check(/of 30\.\d MB · \d+%/.test(await ph.locator('.upl-facts').innerText()), 'and says how much is sent', await ph.locator('.upl-facts').innerText());
const box = await ph.boundingBox();
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step30-uploading.png` });
// The board stays usable: add a note while it uploads.
await page.locator('.tool', { hasText: 'Note' }).first().click();
await sleep(300);
check((await page.locator('.card-note').count()) === 1, 'the board stays usable during the upload (a note was added)');
await page.keyboard.press('Escape');

await page.waitForSelector('.card-file', { timeout: 30000 });
await throttle(-1);
check(!(await page.locator('.card-uploading').count()), 'the placeholder is gone once stored');
const cardBox = await page.locator('.card-file').boundingBox();
check(Math.abs(cardBox.x - box.x) < 2 && Math.abs(cardBox.y - box.y) < 2, 'the card appears where the placeholder was');

// 3. Its preview: read from the server in pieces.
await page.waitForSelector('.card-file .file-page img[data-img="loaded"]', { timeout: 30000 });
check(ranged.includes(206), 'a big PDF\'s preview is read in pieces (206 Partial Content)', ranged.join(','));
const cardId = await page.locator('.card-file').getAttribute('data-card-id');
const fileId = (await api('GET', `/api/boards/${board}`)).cards.find((c) => c.id === cardId).data.fileId;
check((await api('GET', `/api/files/${fileId}/info`)).file.pages === 1, 'and the preview is stored');

// 4. Cancel.
await throttle(2 * 1024 * 1024);
await pick(cancelPath);
await page.waitForSelector('.card-uploading .upl-cancel');
const before = (await api('GET', '/api/stats')).files;
await sleep(500);
await page.locator('.card-uploading .upl-cancel').click();
await sleep(500);
await throttle(-1);
check(!(await page.locator('.card-uploading').count()), 'Cancel removes the placeholder');
await sleep(500);
check((await api('GET', '/api/stats')).files === before && (await page.locator('.card-file').count()) === 1, 'and nothing is stored or added');

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
done();
