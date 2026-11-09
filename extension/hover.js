// Quick save: a ZBoard button on the image under the mouse. Clicking it opens a board picker
// right there; the service worker does the upload. Everything lives in a closed shadow root so
// the page's styles can't reach it (and ours can't leak into the page).
(() => {
  if (window.__zboardHover) return;
  window.__zboardHover = true;
  // Never on ZBoard itself, whatever address it is opened at (localhost, Tailscale, the demo):
  // its page says so in web/index.html.
  if (document.querySelector('meta[name="application-name"][content="ZBoard"]')) return;

  const MIN = 120; // smaller images (icons, avatars) get no button
  let enabled = true;
  let server = '';
  chrome.storage.local.get(['hover', 'server']).then((s) => {
    enabled = s.hover !== false;
    server = (s.server || '').replace(/\/+$/, '');
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.hover) enabled = c.hover.newValue !== false;
    if (c.server) server = (c.server.newValue || '').replace(/\/+$/, '');
    if (!enabled) hide(true);
  });

  const host = document.createElement('zboard-clipper');
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .btn { position: fixed; display: none; align-items: center; gap: 6px; height: 30px; padding: 0 11px 0 7px; border: 0; border-radius: 15px;
         background: #23221f; color: #fff; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.3); font-weight: 600; opacity: .92; }
  .btn:hover { opacity: 1; background: #000; }
  .btn img { width: 18px; height: 18px; border-radius: 4px; }
  .panel { position: fixed; display: none; flex-direction: column; width: 270px; max-height: 360px; background: #fff; color: #23221f;
           border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.28); overflow: hidden; }
  .head { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid #ecebe8; }
  .thumb { width: 38px; height: 38px; border-radius: 6px; object-fit: cover; background: #f1f0ed; flex: none; }
  .search { flex: 1; min-width: 0; height: 32px; padding: 0 9px; border: 1px solid #d9d7d2; border-radius: 7px; outline: none; color: #23221f; background: #fff; }
  .search:focus { border-color: #23221f; }
  .list { overflow: auto; padding: 4px 0; }
  .row { display: block; width: 100%; padding: 7px 12px; border: 0; background: none; text-align: left; cursor: pointer; color: #23221f;
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row:hover, .row.on { background: #f1f0ed; }
  .row .hint { color: #8e8e93; font-size: 12px; margin-left: 6px; }
  .label { padding: 6px 12px 2px; color: #8e8e93; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .msg { padding: 14px 12px; color: #5b5a57; }
  .msg.err { color: #c93a32; }
</style>
<button class="btn" title="Save to ZBoard"><img alt="" />Save</button>
<div class="panel" role="dialog" aria-label="Save to ZBoard">
  <div class="head"><img class="thumb" alt="" /><input class="search" placeholder="Find a board…" /></div>
  <div class="list"></div>
</div>`;
  const btn = root.querySelector('.btn');
  const panel = root.querySelector('.panel');
  const list = root.querySelector('.list');
  const search = root.querySelector('.search');
  btn.querySelector('img').src = chrome.runtime.getURL('icons/icon-32.png');
  (document.body || document.documentElement).append(host);

  let target = null; // the hovered <img>
  let picked = null; // { src, alt } being saved
  let boards = null;
  let hideTimer = 0;

  // The largest picture the <img> offers (srcset), so a thumbnail on the page saves full size.
  function bestSrc(img) {
    let best = img.currentSrc || img.src;
    let bestW = 0;
    for (const part of (img.srcset || '').split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 0;
      if (u && w > bestW) (bestW = w), (best = u);
    }
    try {
      return new URL(best, location.href).href;
    } catch {
      return best;
    }
  }

  // `gap` px inside the top-left corner of the part of `r` that is on screen, kept on screen.
  function place(el, r, w, h, gap = 8) {
    const left = Math.max(r.left, 0) + gap;
    const top = Math.max(r.top, 0) + gap;
    el.style.left = Math.max(2, Math.min(innerWidth - w - 2, left)) + 'px';
    el.style.top = Math.max(2, Math.min(innerHeight - h - 2, top)) + 'px';
  }

  function show(img) {
    target = img;
    clearTimeout(hideTimer);
    btn.style.display = 'flex';
    place(btn, img.getBoundingClientRect(), 80, 30, 2); // 2 px inside the image's (visible) top-left corner
  }

  function hide(all) {
    clearTimeout(hideTimer);
    btn.style.display = 'none';
    target = null;
    if (all) {
      panel.style.display = 'none';
      picked = null;
    }
  }

  const usable = (img) => {
    if (!enabled || !(img instanceof HTMLImageElement)) return false;
    if (server && location.origin === new URL(server).origin) return false; // not on ZBoard itself
    const r = img.getBoundingClientRect();
    return r.width >= MIN && r.height >= MIN && img.naturalWidth >= MIN && !!(img.currentSrc || img.src);
  };

  // Many sites cover images with a transparent layer, so look under the pointer, not at the event target.
  // The <img> you are actually looking at: walk down from the top, skipping see-through layers, and
  // give up at the first thing that is itself visible (an opaque panel, a CSS background picture,
  // a canvas or video): then the pointer is not on an <img>, even if one lies further below.
  function covers(el) {
    if (/^(CANVAS|VIDEO|IFRAME|EMBED|OBJECT)$/.test(el.tagName) || el instanceof SVGSVGElement) return true;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || Number(st.opacity) < 0.1) return false;
    if (/url\(/.test(st.backgroundImage)) return true;
    const a = st.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const alpha = a ? Number(a[1].split(',')[3] ?? 1) : 0;
    return alpha >= 0.9;
  }
  function imageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y).slice(0, 12)) {
      if (el === host) continue;
      if (el instanceof HTMLImageElement) return el;
      if (covers(el)) return null;
    }
    return null;
  }

  // Looks at most every 60 ms, and always once more where the pointer stopped (a move inside the
  // 60 ms was dropped before, so the button could stay on the image the pointer had just left).
  let lastMove = 0;
  let pending = null; // the newest move not looked at yet
  let trailing = 0;
  function look({ x, y, onButton }) {
    lastMove = performance.now();
    if (onButton) return clearTimeout(hideTimer);
    const img = imageAt(x, y);
    if (img && usable(img)) show(img);
    else if (target) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => hide(false), 250);
    }
  }
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!enabled || panel.style.display === 'flex') return;
      pending = { x: e.clientX, y: e.clientY, onButton: e.composedPath().includes(host) };
      const wait = 60 - (performance.now() - lastMove);
      if (wait <= 0) {
        clearTimeout(trailing);
        trailing = 0;
        look(pending);
        pending = null;
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = 0;
          if (pending && enabled && panel.style.display !== 'flex') look(pending);
          pending = null;
        }, wait);
      }
    },
    { passive: true, capture: true }
  );
  addEventListener('scroll', () => panel.style.display !== 'flex' && hide(false), { passive: true, capture: true });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target) return;
    picked = { src: bestSrc(target), alt: (target.alt || target.title || '').trim().slice(0, 500) };
    const r = btn.getBoundingClientRect();
    btn.style.display = 'none';
    root.querySelector('.thumb').src = target.currentSrc || target.src;
    panel.style.display = 'flex';
    place(panel, r, 270, 360);
    search.value = '';
    list.innerHTML = '<div class="msg">Loading boards…</div>';
    search.focus();
    const res = await chrome.runtime.sendMessage({ type: 'boards' }).catch((err) => ({ error: err.message }));
    if (res?.error) {
      list.innerHTML = '';
      const m = document.createElement('div');
      m.className = 'msg err';
      m.textContent = res.error;
      return list.append(m);
    }
    boards = res;
    render();
  });

  function row(b, hint) {
    const r = document.createElement('button');
    r.className = 'row';
    r.style.paddingLeft = 12 + (hint ? 0 : b.depth * 14) + 'px';
    r.textContent = b.title || 'Untitled';
    if (hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = hint;
      r.append(h);
    }
    r.onclick = () => save(b);
    return r;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const tree = boards.tree;
    if (!q) {
      const last = tree.find((b) => b.id === boards.last);
      if (last) list.append(row(last, 'last used'));
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = 'All boards';
      list.append(l);
    }
    const shown = q ? tree.filter((b) => (b.title || '').toLowerCase().includes(q)) : tree;
    for (const b of shown) list.append(row(b, q && b.path ? b.path : ''));
    if (!shown.length) list.innerHTML = '<div class="msg">No board with that name.</div>';
    list.firstElementChild?.classList?.contains('row') && list.firstElementChild.classList.add('on');
  }
  search.addEventListener('input', () => boards && render());
  search.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the page's own shortcuts out of it
    if (e.key === 'Escape') hide(true);
    const rows = [...list.querySelectorAll('.row')];
    const i = rows.findIndex((r) => r.classList.contains('on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      rows.forEach((r) => r.classList.toggle('on', r === n));
      n?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') rows[Math.max(0, i)]?.click();
  });

  function save(b) {
    if (!picked) return;
    chrome.runtime.sendMessage({ type: 'quickSave', src: picked.src, alt: picked.alt, board: b.id, page: { url: location.href, title: document.title } });
    hide(true);
  }

  document.addEventListener('mousedown', (e) => panel.style.display === 'flex' && !e.composedPath().includes(host) && hide(true), true);
  addEventListener('keydown', (e) => e.key === 'Escape' && panel.style.display === 'flex' && hide(true), true);
})();
