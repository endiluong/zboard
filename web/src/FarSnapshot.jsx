import { useEffect, useRef } from 'react';
import { strokePath } from './ink.js';

// Far out (cards only a few dozen pixels wide) Chrome repaints every image on every pan frame,
// whatever we do with layers: ~34 ms a frame with 1,500 images. So the board is drawn once into
// a single canvas and the real cards are made invisible (still there, so clicks and drags work).
// Panning then moves one picture: ~17 ms a frame. Selected and dragged cards are left out of the
// picture and shown live. Text is not drawn; it is unreadable at this size anyway.

const CARD_BG = { null: '#ffffff', yellow: '#fff3b8', green: '#d8f2d0', blue: '#d6e6ff', pink: '#ffd9e4', purple: '#e7dcff', grey: '#e6e4df' };
const HEXC = /^#[0-9a-f]{6}$/i;
const MAX_SIDE = 4096; // canvas size limit, in device pixels

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
  g.fill();
}

export default function FarSnapshot({ active, scale, worldRef, rects, cards, files, skip, version }) {
  const canvasRef = useRef(null);
  const timer = useRef(0);
  const shown = useRef(false); // drawn since it became active

  useEffect(() => {
    const cv = canvasRef.current;
    if (!active || !cv) return;
    const draw = () => {
      const world = worldRef.current;
      if (!world) return;
      // Everything measured, in stacking order: the DOM order of the cards.
      const els = [...world.querySelectorAll('[data-card-id]')];
      const items = [];
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const el of els) {
        const id = el.dataset.cardId;
        const r = rects.current.get(id);
        const c = cards[id];
        if (!r || !c) continue;
        x1 = Math.min(x1, r.x);
        y1 = Math.min(y1, r.y);
        x2 = Math.max(x2, r.x + r.w);
        y2 = Math.max(y2, r.y + r.h);
        if (skip.has(id) || (c.column_id && skip.has(c.column_id))) continue;
        items.push({ el, r, c });
      }
      if (!items.length) {
        cv.width = cv.height = 0;
        return;
      }
      // A little sharper than needed, so a small zoom-in before the next redraw still looks fine.
      let k = scale * (window.devicePixelRatio || 1) * 2;
      k = Math.min(k, MAX_SIDE / (x2 - x1), MAX_SIDE / (y2 - y1));
      cv.width = Math.ceil((x2 - x1) * k);
      cv.height = Math.ceil((y2 - y1) * k);
      Object.assign(cv.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      const g = cv.getContext('2d');
      g.setTransform(k, 0, 0, k, -x1 * k, -y1 * k);
      for (const { el, r, c } of items) {
        const file = files[c.data?.fileId];
        if (c.type === 'drawing') {
          const s = r.w / (c.data.vw || 1);
          g.save();
          g.translate(r.x, r.y);
          g.scale(s, s);
          for (const st of c.data.strokes || []) {
            g.fillStyle = st.c;
            g.fill(new Path2D(strokePath(st)));
          }
          g.restore();
          continue;
        }
        if (c.type === 'board') {
          const tile = el.querySelector('.board-icon');
          const tr = tile && { x: r.x + tile.offsetLeft, y: r.y + tile.offsetTop, w: tile.offsetWidth, h: tile.offsetHeight };
          g.fillStyle = c.child?.cover?.bg || (HEXC.test(c.color || '') ? c.color : CARD_BG[c.color ?? 'null']) || '#ffffff';
          if (tr) roundRect(g, tr.x, tr.y, tr.w, tr.h, 12);
          continue;
        }
        const cutout = c.type === 'image' && file?.alpha === 1;
        const hexBg = HEXC.test(c.color || '') ? c.color : null;
        if (!cutout || hexBg) {
          g.fillStyle = hexBg || (c.type === 'column' ? 'rgba(255,255,255,0.55)' : CARD_BG[c.color ?? 'null'] || '#ffffff');
          roundRect(g, r.x, r.y, r.w, r.h, 6);
        }
        if (HEXC.test(c.data?.strip || '')) {
          g.fillStyle = c.data.strip;
          g.fillRect(r.x, r.y, r.w, Math.max(6, r.h * 0.03));
        }
        if (c.type === 'color') {
          const sw = el.querySelector('.color-swatch');
          g.fillStyle = HEXC.test(c.data?.hex || '') ? c.data.hex : '#ecbc1c';
          g.fillRect(r.x, r.y, r.w, sw ? sw.offsetHeight : r.h * 0.7);
          continue;
        }
        const img = el.querySelector(c.type === 'image' || c.type === 'file' ? '.img-wrap img' : '.link-img, .video-frame img');
        const wrap = img?.closest('.img-wrap, .video-frame') || img;
        if (!img || !wrap) continue;
        const wx = r.x + (wrap.offsetParent === el ? wrap.offsetLeft : 0);
        const wy = r.y + (wrap.offsetParent === el ? wrap.offsetTop : 0);
        if (img.complete && img.naturalWidth) {
          try {
            g.drawImage(img, wx, wy, wrap.offsetWidth, wrap.offsetHeight);
          } catch {}
        } else if (file?.color) {
          g.fillStyle = file.color;
          g.fillRect(wx, wy, wrap.offsetWidth, wrap.offsetHeight);
        }
      }
    };
    // Redraw shortly after changes, and as previews finish loading.
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(draw, 120);
    };
    // First time: right away. After that, once changes settle (never per frame while dragging).
    if (!shown.current) {
      shown.current = true;
      draw();
    } else soon();
    const world = worldRef.current;
    world?.addEventListener('load', soon, true);
    return () => {
      clearTimeout(timer.current);
      world?.removeEventListener('load', soon, true);
    };
  }, [active, scale, cards, files, skip, version, worldRef, rects]);

  if (!active) {
    shown.current = false;
    return null;
  }
  return <canvas ref={canvasRef} className="far-snapshot" aria-hidden="true" />;
}
