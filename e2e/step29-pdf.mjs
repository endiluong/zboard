// PDFs and other files on a board: a PDF picked with the File tool becomes a file card showing its
// first page and page count; it opens in the reader (lazy-loaded pdf.js), which draws pages as they
// scroll into view, counts pages, zooms and closes with Escape. A PDF added elsewhere (no preview yet)
// gets its preview drawn by the first browser that shows it. Other files get a tile with their type.
// Needs a server on ZB_URL.
import { api, BASE, check, done, launch, login, sleep } from './lib.mjs';

// A small real PDF: `pages` pages, each with a big "Page N" in Helvetica (a standard font pdf.js
// draws from its font files) and a coloured block.
function makePdf(pages) {
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pages; i++) {
    const pageNo = 4 + i * 2;
    const content = `0.2 0.45 0.85 rg 72 560 450 160 re f 0 0 0 rg BT /F1 48 Tf 72 460 Td (Page ${i + 1}) Tj ET BT /F1 18 Tf 72 400 Td (ZBoard PDF reader check) Tj ET`;
    objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
    objs[pageNo + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    kids.push(`${pageNo} 0 R`);
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
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
const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'PDFs', x: 40, y: 40 }] })).cards[0].data.boardId;

const browser = await launch();
const { page } = await login(browser, { width: 1280, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const loaded = [];
page.on('request', (r) => loaded.push(r.url()));
await page.goto(`${BASE}/#/b/${board}`);
await page.waitForSelector('.canvas');
await sleep(400);
check(!loaded.some((u) => /pdf\.worker|PdfReader/.test(u)), 'pdf.js is not downloaded before a PDF is shown');

// 1. The File tool takes a PDF.
await page.mouse.click(640, 500, { button: 'right' });
const chooser = page.waitForEvent('filechooser');
await page.getByRole('menuitem', { name: 'File', exact: true }).click();
const fc = await chooser;
check((await fc.element().getAttribute('accept')) === '', 'the File tool takes any file, not only pictures');
await fc.setFiles({ name: 'Paint guide.pdf', mimeType: 'application/pdf', buffer: makePdf(3) });
await page.waitForSelector('.card-file');
await page.waitForSelector('.card-file .file-page img[data-img="loaded"]', { timeout: 15000 });
const card = page.locator('.card-file').first();
check((await card.locator('.file-name').innerText()) === 'Paint guide.pdf', 'the card shows the file name');
check(/3 pages/.test(await card.locator('.file-facts').innerText()), 'and the page count', await card.locator('.file-facts').innerText());
const cardId = await card.getAttribute('data-card-id');
const fileId = (await api('GET', `/api/boards/${board}`)).cards.find((c) => c.id === cardId).data.fileId;
const info = (await api('GET', `/api/files/${fileId}/info`)).file;
check(info.width > 0 && info.height > info.width && info.pages === 3, 'the server keeps the first page as the preview (portrait, 3 pages)', JSON.stringify(info));
const thumb = await fetch(`${BASE}/files/${fileId}/thumb`, { headers: { cookie: api.cookie } });
check(thumb.ok && thumb.headers.get('content-type') === 'image/webp', 'the preview is served like a picture thumbnail');
const ratio = await card.locator('.file-page').evaluate((el) => el.clientHeight / el.clientWidth);
check(Math.abs(ratio - 792 / 612) < 0.03, 'the card has the page shape', ratio.toFixed(3));
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step29-card.png` });

// 2. The reader.
await card.dblclick();
await page.waitForSelector('.pdf-reader');
await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 15000 });
check(/\/ 3/.test(await page.locator('.pdf-count').innerText()), 'the reader counts 3 pages');
await page.waitForFunction(() => /Page 1/.test(document.querySelector('.pdf-page[data-page="1"] .textLayer')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
check(/Page 1/.test((await page.locator('.pdf-page[data-page="1"] .textLayer').textContent().catch(() => '')) || ''), 'page text is selectable (text layer)');
check((await page.locator('.pdf-title').innerText()) === 'Paint guide.pdf', 'the bar shows the name');
const canvasW = await page.locator('.pdf-page[data-page="1"] canvas').evaluate((c) => c.width);
check(canvasW > 0, 'page 1 is drawn', canvasW);
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step29-reader.png` });
await page.locator('.pdf-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForSelector('.pdf-page[data-page="3"] canvas', { timeout: 10000 });
await sleep(300);
check((await page.locator('.pdf-goto').inputValue()) === '3', 'scrolled to the end, the counter says page 3', await page.locator('.pdf-goto').inputValue());
const w1 = await page.locator('.pdf-page[data-page="3"]').evaluate((el) => el.clientWidth);
await page.locator(".pdf-reader button[aria-label=\"Zoom in\"]").click();
await sleep(300);
const w2 = await page.locator('.pdf-page[data-page="3"]').evaluate((el) => el.clientWidth);
check(Math.abs(w2 / w1 - 1.25) < 0.02, 'Zoom in makes pages 25% bigger', `${w1} → ${w2}`);
check((await page.locator('.pdf-pct').innerText()) === '125%', 'and says 125%');
await page.locator('.pdf-goto').fill('1');
await page.locator('.pdf-goto').press('Enter');
await sleep(400);
check((await page.locator('.pdf-goto').inputValue()) === '1', 'typing a page number jumps there');
check(await page.locator('.pdf-reader a[download]').getAttribute('href') === `/files/${fileId}?original=1`, 'Download points at the original');
await page.keyboard.press('Delete'); // must not reach the board behind
await page.keyboard.press('Escape');
await sleep(200);
check(!(await page.locator('.pdf-reader').count()), 'Escape closes the reader');
check((await page.locator('.card-file').count()) === 1, 'keys pressed in the reader never reached the board');

// 3. A PDF that arrived without a preview (another way in): the board draws it on first view.
const fd = new FormData();
fd.append('file', new Blob([makePdf(1)], { type: 'application/pdf' }), 'one page.pdf');
const up = await (await fetch(BASE + '/api/upload', { method: 'POST', headers: { cookie: api.cookie }, body: fd })).json();
await api('POST', `/api/boards/${board}/cards`, { cards: [{ type: 'file', x: 400, y: 80, data: { fileId: up.file.id } }] });
// 4. Any other file: a tile with its type.
const fd2 = new FormData();
fd2.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
const txt = await (await fetch(BASE + '/api/upload', { method: 'POST', headers: { cookie: api.cookie }, body: fd2 })).json();
await api('POST', `/api/boards/${board}/cards`, { cards: [{ type: 'file', x: 700, y: 80, data: { fileId: txt.file.id } }] });
await page.reload();
await page.waitForSelector('.card-file');
await page.waitForFunction((id) => document.querySelectorAll('.card-file .file-page img[data-img="loaded"]').length >= 2, null, { timeout: 15000 }).catch(() => {});
check((await api('GET', `/api/files/${up.file.id}/info`)).file.pages === 1, 'a PDF with no preview gets one drawn when the board shows it');
check((await page.locator('.card-file .file-page img[data-img="loaded"]').count()) === 2, 'both PDFs show their first page');
const txtCard = page.locator('.card-file', { hasText: 'notes.txt' });
check((await txtCard.locator('.file-ext').innerText()) === 'TXT' && /TXT · 5 B/.test(await txtCard.locator('.file-facts').innerText()), 'another file shows a tile with its type and size');

// 5. Found by file name.
const found = (await api('GET', '/api/search?q=guide')).results;
check(found.some((r) => r.id === cardId || r.ref === cardId || r.card?.id === cardId), 'search finds the PDF by its file name', JSON.stringify(found).slice(0, 200));

// 5b. A part of the file that never arrives (seen on iPhones) is asked for again, and the PDF opens.
const fd3 = new FormData();
fd3.append('file', new Blob([makePdf(400)], { type: 'application/pdf' }), 'long.pdf');
const long = (await (await fetch(BASE + '/api/upload', { method: 'POST', headers: { cookie: api.cookie }, body: fd3 })).json()).file;
const longCard = (await api('POST', `/api/boards/${board}/cards`, { cards: [{ type: 'file', x: 1000, y: 80, data: { fileId: long.id } }] })).cards[0];
await sleep(500);
let hung = 0;
const ranges = [];
await page.route(`**/files/${long.id}?original=1`, (route) => {
  const range = route.request().headers().range || '-';
  ranges.push(range);
  if (!hung && !/^bytes=0-/.test(range)) return hung++; // never answered
  return route.continue();
});
await page.locator(`[data-card-id="${longCard.id}"]`).dblclick();
await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 40000 }).catch(() => {});
check((await page.locator('.pdf-page[data-page="1"] canvas').count()) === 1 && hung === 1, 'a part that never arrives is asked for again and the PDF opens', `hung=${hung} ranges=${ranges.join(' ')}`);
check(ranges.length > 1 && ranges.every((r) => r.startsWith('bytes=')) && long.size > 65536, 'it is read in parts, never whole', `${ranges.length} requests, ${long.size} bytes`);
await page.keyboard.press('Escape');
await page.unroute(`**/files/${long.id}?original=1`);

// 5d. Opened again: the parts read the first time are kept in this browser, so nothing is fetched.
const idb = (fn, arg) => page.evaluate(([src, a]) => new Promise((res) => { const q = indexedDB.open('zb-pdf-cache'); q.onsuccess = () => res(new Function('db', 'a', src)(q.result, a)); }), [fn, arg]);
const keptFiles = () => idb("return new Promise((r) => { const g = db.transaction('files').objectStore('files').getAll(); g.onsuccess = () => r(g.result.map((f) => ({ id: f.fileId, bytes: f.bytes, parts: f.parts.length }))); })");
await sleep(500);
const kept = (await keptFiles()).find((f) => f.id === long.id);
check(kept && kept.parts > 0 && kept.bytes < long.size * 2, 'the parts read are kept in the browser', JSON.stringify(kept));
const again = [];
const countAgain = (r) => r.url().includes(`/files/${long.id}?original=1`) && again.push(r.headers().range);
page.on('request', countAgain);
await page.locator(`[data-card-id="${longCard.id}"]`).dblclick();
await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 15000 }).catch(() => {});
check((await page.locator('.pdf-page[data-page="1"] canvas').count()) === 1 && again.length === 0, 'opened again, page 1 shows without asking the server', `${again.length} requests: ${again.join(' ')}`);
await page.keyboard.press('Escape');
page.off('request', countAgain);

// 5e. Not opened for over 7 days: forgotten the next time any PDF is opened.
await idb("return new Promise((r) => { const s = db.transaction('files', 'readwrite').objectStore('files'); const g = s.get(a); g.onsuccess = () => { g.result.openedAt = Date.now() - 8 * 864e5; s.put(g.result).onsuccess = r; }; })", long.id);
await card.dblclick();
await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 15000 }).catch(() => {});
await sleep(300);
const after = await keptFiles();
const partsLeft = await idb("return new Promise((r) => { const g = db.transaction('parts').objectStore('parts').index('fileId').count(a); g.onsuccess = () => r(g.result); })", long.id);
check(!after.some((f) => f.id === long.id) && partsLeft === 0 && after.some((f) => f.id === fileId), 'a PDF not opened for 8 days is dropped (the one just opened is kept)', JSON.stringify(after));
await page.keyboard.press('Escape');

// 5c. A browser pdf.js can't run in (no OffscreenCanvas, like iOS before 16.4): the PDF opens in the
// browser's own viewer in a new window, the reader never shows (not even for a frame), and pdf.js is
// never downloaded.
{
  const ctx2 = page.context();
  const old = await ctx2.newPage();
  await old.addInitScript(() => {
    delete window.OffscreenCanvas;
    const mo = new MutationObserver(() => document.querySelector('.pdf-reader') && (window.__readerShown = true));
    addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
  });
  const pdfjsLoads = [];
  old.on('request', (r) => /pdf\.worker|PdfReader|\/assets\/dist-/.test(r.url()) && pdfjsLoads.push(r.url()));
  await old.goto(`${BASE}/#/b/${board}`);
  await old.waitForSelector('.card-file');
  const popup = old.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await old.locator(`[data-card-id="${cardId}"]`).dblclick();
  const win = await popup;
  await sleep(500);
  check(!!win && win.url().endsWith(`/files/${fileId}?original=1`), 'without pdf.js support the PDF opens in a new window', win?.url());
  check(!(await old.evaluate(() => window.__readerShown)), 'and the reader never shows, not even for a moment');
  check(!pdfjsLoads.length, 'and pdf.js is never downloaded', pdfjsLoads.join(' '));
  await win?.close();
  await old.close();
}

// 6. Startup cache leaves pdf.js out.
const sw = await (await fetch(BASE + '/sw.js')).text();
check(!/PdfReader|pdf\.worker/.test(sw.match(/SHELL = .*/)?.[0] || ''), "the offline startup cache doesn't hold the PDF reader");
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step29-board.png` });
check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
done();
