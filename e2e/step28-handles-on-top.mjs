// Touch screens: a selected card's Arrow button and resize circle stay on top of a neighbour that sits
// higher in the stack (the handles live inside the card, so the card comes to the front while selected),
// and the card goes back to its place in the stack once deselected.
// Needs a server on ZB_URL.
import { api, BASE, check, done, launch, sleep, PASSWORD } from './lib.mjs';

await api('GET', '/api/me');
const board = (await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Handles on top', x: 40, y: 40 }] })).cards[0].data.boardId;
// B is made second (higher in the stack) and sits just above A, where A's Arrow button appears.
const [a, b] = (
  await api('POST', `/api/boards/${board}/cards`, {
    cards: [
      { type: 'note', x: 100, y: 260, w: 200, data: { html: '<p>Lower card A</p>' } },
      { type: 'note', x: 100, y: 205, w: 200, data: { html: '<p>Upper card B</p>' } },
    ],
  })
).cards.map((c) => c.id);

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/');
await page.fill('input[type=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForSelector('.canvas');
await page.goto(`${BASE}/#/b/${board}`);
await page.waitForSelector(`[data-card-id="${a}"]`);
await sleep(500);

const cardA = page.locator(`[data-card-id="${a}"]`);
const box = await cardA.boundingBox();
await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForSelector('.card.selected .handle-pill');
await sleep(500);
const hitAt = async (sel) => {
  const r = await page.locator(sel).boundingBox();
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('[data-handle]')?.dataset.handle || el?.closest('.card')?.innerText || String(el?.className);
  }, [r.x + r.width / 2, r.y + r.height / 2]);
};
let hit = await hitAt('.card.selected .pill-arrow');
check(hit === 'arrow', 'the Arrow button is on top of the card above', hit);
hit = await hitAt('.card.selected .handle-resize-touch');
check(hit === 'resize', 'the resize circle is on top too', hit);
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/step28-handles.png` });

await page.touchscreen.tap(30, 700);
await sleep(300);
const z = (id) => page.locator(`[data-card-id="${id}"]`).evaluate((el) => +getComputedStyle(el).zIndex);
const [za, zb] = [await z(a), await z(b)];
check(za < zb, 'deselected, it is back under the card above', `${za} vs ${zb}`);
check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
done();
