// Touch: a selected card shows a move handle that drags at once (no long press), and holding
// a card doesn't bring up the browser's image menu. Needs a server on ZB_URL from an empty data dir.
import { api, BASE, check, done, launch, login, sleep, solidPng } from './lib.mjs';

const holder = await api('POST', '/api/boards/root/cards', { cards: [{ type: 'board', title: 'Touch', x: 40, y: 40 }] });
const boardId = holder.cards[0].data.boardId;
const fd = new FormData();
fd.append('file', new Blob([solidPng(400, 300, [200, 80, 60])], { type: 'image/png' }), 'red.png');
const { file } = await (await fetch(BASE + '/api/upload', { method: 'POST', headers: { cookie: api.cookie }, body: fd })).json();
const { cards } = await api('POST', `/api/boards/${boardId}/cards`, { cards: [{ type: 'image', x: 120, y: 160, w: 200, data: { fileId: file.id } }] });
const id = cards[0].id;

const browser = await launch();
const { context, page } = await login(browser, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/#/b/${boardId}`);
await page.waitForSelector(`[data-card-id="${id}"] img`);
await sleep(600);
const card = page.locator(`[data-card-id="${id}"]`);

check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'phone emulation has a coarse pointer');
const img = card.locator('img').first();
check((await img.evaluate((e) => getComputedStyle(e).userSelect)) === 'none', 'card images cannot be selected or long-pressed into the browser menu');

// Tap selects. Moving is hold-and-drag on the card itself: there is no separate move handle.
const box0 = await card.boundingBox();
await page.touchscreen.tap(box0.x + box0.width / 2, box0.y + box0.height / 2);
await sleep(400);
check((await card.locator('[data-handle="move"]').count()) === 0 && (await card.locator('[data-handle="arrow"]').isVisible()), 'a selected card shows the arrow and resize handles, no move handle');

// Hold the card, then drag it with a real touch: it follows the finger.
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const sx = box0.x + box0.width / 2;
const sy = box0.y + box0.height / 2;
const lift = () => card.evaluate((el) => el.dataset.lift || '');
await touch('touchStart', sx, sy);
await sleep(120);
check((await lift()) === 'hold', 'while held, the card swells and wobbles', await lift());
await sleep(380);
check((await lift()) === 'pop', 'when it comes free, it pops with a big shake', await lift());
await sleep(200);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', sx + i * 8, sy + i * 12);
  await sleep(16);
}
check((await lift()) === 'pop', 'and stays lifted while dragged');
await touch('touchEnd');
await sleep(800);
check((await lift()) === '', 'letting go puts it down');
const box1 = await card.boundingBox();
check(Math.abs(box1.x - box0.x - 80) < 4 && Math.abs(box1.y - box0.y - 120) < 4, 'holding and dragging the card moves it with the finger', JSON.stringify({ dx: box1.x - box0.x, dy: box1.y - box0.y }));
const saved = (await api('GET', `/api/boards/${boardId}`)).cards.find((c) => c.id === id);
check(saved.x !== 120 || saved.y !== 160, 'the new spot is saved', JSON.stringify([saved.x, saved.y]));

// A one-finger swipe on the board (not the handle) still pans instead of moving the card.
const view0 = await card.boundingBox();
await touch('touchStart', 200, 700);
for (let i = 1; i <= 6; i++) {
  await touch('touchMove', 200 - i * 10, 700);
  await sleep(16);
}
await touch('touchEnd');
await sleep(400);
const view1 = await card.boundingBox();
const after = (await api('GET', `/api/boards/${boardId}`)).cards.find((c) => c.id === id);
check(view1.x < view0.x - 40 && after.x === saved.x, 'swiping empty space pans the board', JSON.stringify({ dx: view1.x - view0.x }));
// The big resize handle off the bottom-right corner: drag it and the card gets wider.
await api('PATCH', '/api/cards', { cards: [{ id, x: 40, y: 80 }] });
await page.reload();
await page.waitForSelector(`[data-card-id="${id}"] img`);
await sleep(600);
const pre = await card.boundingBox();
await page.touchscreen.tap(pre.x + pre.width / 2, pre.y + pre.height / 2);
await sleep(400);
const rb0 = await card.boundingBox(); // selected: the caption row makes an image card taller
const rh =await card.locator('[data-handle="resize"]').boundingBox();
check(rh && rh.width >= 36 && Math.abs(rh.x + rh.width / 2 - (rb0.x + rb0.width)) < 3 && Math.abs(rh.y + rh.height / 2 - (rb0.y + rb0.height)) < 3, 'tapping a card shows a large resize handle centred on its bottom-right corner', JSON.stringify({ rh, rb0 }));
const hit = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.closest('[data-handle]')?.dataset.handle || e.className?.baseVal || e.className); }, [rh.x + rh.width / 2, rh.y + rh.height / 2]);
check(hit === 'resize', 'the finger lands on the resize handle', String(hit));
await touch('touchStart', rh.x + rh.width / 2, rh.y + rh.height / 2);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', rh.x + rh.width / 2 + i * 8, rh.y + rh.height / 2 + i * 4);
  await sleep(16);
}
await touch('touchEnd');
await sleep(800);
const rb1 = await card.boundingBox();
check(rb1.width > rb0.width + 30, 'dragging it makes the card wider', JSON.stringify({ before: rb0.width, after: rb1.width }));
const savedW = (await api('GET', `/api/boards/${boardId}`)).cards.find((c) => c.id === id).w;
check(savedW > 200, 'the new width is saved', String(savedW));

// The connect handle on the top-right corner: drag it onto another card to draw an arrow.
const other = (await api('POST', `/api/boards/${boardId}/cards`, { cards: [{ type: 'note', x: 60, y: 420, data: { html: '<p>Target</p>' } }] })).cards[0];
await page.reload();
await page.waitForSelector(`[data-card-id="${other.id}"]`);
await sleep(600);
const pre2 = await card.boundingBox();
await page.touchscreen.tap(pre2.x + pre2.width / 2, pre2.y + 40);
await sleep(400);
const cb = await card.boundingBox();
const ah = await card.locator('[data-handle="arrow"]').boundingBox();
check(ah && ah.width >= 44 && ah.y + ah.height <= cb.y && Math.abs(ah.x + ah.width / 2 - (cb.x + cb.width / 2)) < 60, 'a finger-sized connect handle sits in the pill above the card', JSON.stringify({ ah, cb }));
const tb = await page.locator(`[data-card-id="${other.id}"]`).boundingBox();
const ax = ah.x + ah.width / 2;
const ay = ah.y + ah.height / 2;
const tx = tb.x + tb.width / 2;
const ty = tb.y + tb.height / 2;
await touch('touchStart', ax, ay);
for (let i = 1; i <= 12; i++) {
  await touch('touchMove', ax + ((tx - ax) * i) / 12, ay + ((ty - ay) * i) / 12);
  await sleep(16);
}
await touch('touchEnd');
await sleep(800);
const arrows = (await api('GET', `/api/boards/${boardId}`)).arrows;
check(arrows.length === 1 && arrows[0].from_card === id && arrows[0].to_card === other.id, 'dragging it onto another card draws an arrow between them', JSON.stringify(arrows.map((a) => [a.from_card, a.to_card])));

// Inside a board the top bar has a back arrow to the board above (the installed app has no browser Back).
const back = page.locator('.back-btn');
check(await back.isVisible(), 'back arrow shows inside a board');
await back.tap();
await sleep(800);
check((await page.evaluate(() => location.hash)) === '#/b/root' && (await back.count()) === 0, 'back arrow goes up to Home, where it disappears');
await page.goto(`${BASE}/#/b/${boardId}`);
await page.waitForSelector(`[data-card-id="${id}"] img`);
await sleep(500);

// Bottom bar on an iPhone 13 width: every button on screen, no sideways scrolling, extras under More.
await page.locator('.canvas').tap({ position: { x: 300, y: 600 } });
await sleep(500);
const bar = await page.evaluate(() => {
  const panel = document.querySelector('.tb-tools');
  const shown = [...panel.querySelectorAll('button')].filter((b) => b.offsetParent);
  return { overflow: panel.scrollWidth - panel.clientWidth, labels: shown.map((b) => b.getAttribute('aria-label')), out: shown.filter((b) => b.getBoundingClientRect().right > innerWidth + 0.5 || b.getBoundingClientRect().left < -0.5).length, minW: Math.min(...shown.map((b) => b.getBoundingClientRect().width)), widths: shown.map((b) => Math.round(b.getBoundingClientRect().width)) };
});
check(bar.overflow <= 0 && bar.out === 0, 'bottom bar fits the screen without scrolling', JSON.stringify(bar));
check(bar.labels.join() === 'Note,Image,Board,Draw,Camera,Undo,More things to add' && bar.minW >= 44, 'phone bar: the main tools plus More, each at least 44 px wide', JSON.stringify(bar));
await page.locator('[aria-label="More things to add"]').tap();
await page.waitForSelector('.action-pop .pop-row');
const extras = await page.locator('.action-pop .pop-row').allTextContents();
check(extras.join() === 'To-do,Link,File,Color,Column', 'More lists To-do, Link, File, Color and Column', extras.join());
await page.locator('.action-pop .pop-row', { hasText: 'To-do' }).tap();
await sleep(800);
check((await api('GET', `/api/boards/${boardId}`)).cards.some((c) => c.type === 'todo'), 'a to-do added from More lands on the board');
await page.keyboard.press('Escape');
await sleep(300);

// The selected-card bar fits too, and the More menu shows no keyboard shortcuts on touch.
const box2 = await card.boundingBox();
await page.touchscreen.tap(box2.x + box2.width / 2, box2.y + 40);
await sleep(500);
const acts = await page.evaluate(() => {
  const panel = document.querySelector('.tb-actions');
  return { overflow: panel.scrollWidth - panel.clientWidth, n: panel.querySelectorAll('button').length };
});
check(acts.n >= 5 && acts.overflow <= 0, 'selected-card bar fits the screen', JSON.stringify(acts));
await page.locator('[aria-label="More actions"]').tap();
await page.waitForSelector('.action-pop .pop-row');
check(!(await page.locator('.action-pop kbd').first().isVisible().catch(() => false)), 'no keyboard shortcut hints on a touch screen');
await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/step18-phone.png' });

// Saved items on a phone: a short strip above the bottom bar, swiped sideways; deleting can be undone.
for (let i = 0; i < 4; i++) await api('POST', '/api/clips', { board_id: boardId, kind: 'text', text: `Saved note ${i + 1}` });
await page.reload();
await page.waitForSelector('.saved-panel');
await sleep(600);
const strip = await page.evaluate(() => {
  const p = document.querySelector('.saved-panel').getBoundingClientRect();
  const bar = document.querySelector('.toolbar').getBoundingClientRect();
  const list = document.querySelector('.saved-list');
  return { top: p.top, bottom: p.bottom, h: p.height, left: p.left, w: p.width, barTop: bar.top, vh: innerHeight, vw: innerWidth, sideways: list.scrollWidth > list.clientWidth };
});
check(Math.abs(strip.bottom - strip.barTop) < 2 && strip.left === 0 && strip.w === strip.vw, 'saved items sit as a full-width strip right above the bottom bar', JSON.stringify(strip));
check(strip.h < strip.vh * 0.4, 'the strip takes less than 40% of the screen', JSON.stringify(strip));
check(strip.sideways, 'more saved items than fit scroll sideways');
const clipCount = async () => (await api('GET', '/api/clips')).clips.filter((c) => c.board_id === boardId).length;
await page.locator('.saved-item [aria-label="Delete saved item"]').first().tap();
await sleep(300);
check((await page.locator('.saved-item').count()) === 3 && (await page.locator('.toast-action').textContent()) === 'Undo', 'delete hides the item and offers Undo');
await page.locator('.toast-action').tap();
await sleep(300);
check((await page.locator('.saved-item').count()) === 4, 'Undo brings it back at once');
await sleep(5500);
check((await clipCount()) === 4, 'an undone delete never reaches the server');
await page.locator('.saved-item [aria-label="Delete saved item"]').first().tap();
await sleep(5800);
check((await clipCount()) === 3, 'without Undo it is deleted after the message goes');
await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/step18-saved.png' });

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();

// Desktop: no move handle (the mouse drags the card itself).
const desk = await launch();
const { page: dp } = await login(desk);
await dp.goto(`${BASE}/#/b/${boardId}`);
await dp.waitForSelector(`[data-card-id="${id}"] img`);
await dp.locator(`[data-card-id="${id}"] img`).click();
await sleep(300);
check((await dp.locator(`[data-card-id="${id}"] [data-handle="move"]`).count()) === 0, 'no move handle with a mouse');
await desk.close();
done();
