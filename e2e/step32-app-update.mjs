// A phone app sleeping in the background keeps running the version it loaded. When it comes back to
// the front it checks for a new ZBoard and reloads into it (web/src/main.jsx). And a card of a kind
// this copy doesn't know says "Reload ZBoard" instead of drawing an empty frame.
// Needs a server on ZB_URL serving web/dist, and DIST pointing at that web/dist folder (it is
// changed to look like a new build, then put back).
import fs from 'node:fs';
import path from 'node:path';
import { api, BASE, check, done, launch, login, sleep } from './lib.mjs';

const DIST = process.env.DIST || path.resolve('web/dist');
const swFile = path.join(DIST, 'sw.js');
const htmlFile = path.join(DIST, 'index.html');
const swOld = fs.readFileSync(swFile, 'utf8');
const htmlOld = fs.readFileSync(htmlFile, 'utf8');

const browser = await launch();
const errors = [];
try {
  await api('GET', '/api/me');
  const { page } = await login(browser, { width: 390, height: 844 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.reload();
  await page.waitForSelector('.canvas');
  await sleep(11000); // past the "just opened" window, so the update below waits for the next resume
  await page.evaluate(() => (window.__old = true));

  // A new build lands on the server.
  fs.writeFileSync(swFile, swOld.replace(/const VERSION = '([^']*)'/, "const VERSION = '$1-next'"));
  fs.writeFileSync(htmlFile, htmlOld.replace('</head>', '<meta name="zb-test" content="next" /></head>'));

  // Back to the front: it checks, finds the new version and reloads into it.
  const nav = page.waitForEvent('framenavigated', { timeout: 20000 }).catch(() => null);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await nav;
  await page.waitForSelector('.canvas', { timeout: 15000 });
  check(!(await page.evaluate(() => window.__old)), 'coming back to the front reloads into the new version');
  check((await page.locator('meta[name="zb-test"]').count()) === 1, 'and the page is the new one');

  // A card type from a newer ZBoard.
  const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Future', x: 40, y: 40 }] })).cards[0].data.boardId;
  await api('POST', `/api/boards/${board}/cards`, { cards: [{ type: 'note', x: 20, y: 20, data: { html: 'x' } }] });
  await page.route(new RegExp(`/api/boards/${board}(\\?|$)`), async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    for (const c of j.cards) c.type = 'hologram';
    await route.fulfill({ response: res, json: j });
  });
  await page.goto(`${BASE}/#/b/${board}`);
  await page.waitForSelector('.canvas');
  await page.waitForSelector('.card-unknown', { timeout: 10000 }).catch(() => {});
  check(/Reload ZBoard/.test((await page.locator('.card-unknown').innerText().catch(() => '')) || ''), 'an unknown kind of card asks for a reload instead of showing nothing');
  check(!errors.length, 'no page errors', errors.join(' | '));
} finally {
  fs.writeFileSync(swFile, swOld);
  fs.writeFileSync(htmlFile, htmlOld);
  await browser.close();
}
done();
