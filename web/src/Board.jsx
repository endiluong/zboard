import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, openEvents, uploadFile, uploadFiles, uploadLimit } from './api.js';
import { PIECE, cancelUpload, getJobs, onFinished, repickUpload, resumeUploads, retryUpload, startUpload, subscribe } from './uploads.js';
import { bootDone } from './boot.js';
import { CardView, SafeImg, youtubeId } from './Cards.jsx';
import ContextMenu from './ContextMenu.jsx';
import CoverPicker from './Cover.jsx';
import ImageEditor from './ImageEditor.jsx';
import FarSnapshot from './FarSnapshot.jsx';
import LabelPicker from './Labels.jsx';
import ColorPicker from './ColorPicker.jsx';
import DrawLayer from './Draw.jsx';
import { inkBounds, mapStrokes } from './ink.js';
import SavedPanel, { CLIP_DRAG_TYPE } from './SavedPanel.jsx';
import { cachedBoard, fetchBoard, prefetchBoard, remember } from './boardCache.js';
import { Icon } from './icons.jsx';
import { PDF_SUPPORTED, fileUrl, isPdf, makePdfPreview } from './pdf.js';
import { formatBytes } from './Menu.jsx';
import { DEMO } from './demo.js';
import UploadCard from './UploadCard.jsx';

// PDFs up to this size get their preview drawn from the picked file itself; bigger ones from the
// server copy, read in pieces (a phone can't comfortably hold 80 MB in memory).
const PREVIEW_FROM_MEMORY = 20 * 1024 * 1024;

// The PDF reader and pdf.js load only when a PDF is opened.
const PdfReader = lazy(() => import('./PdfReader.jsx'));
import { COLORS, DEFAULT_W, byId, clamp, htmlText, isImageFile, isUrl, sortBetween, textToHtml, uid } from './util.js';

const MIN_S = 0.1;
const MAX_S = 4;
const GRID = 24;
const EMPTY = new Set();
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Copied cards live in localStorage (shared by every tab) and, as application/x-zboard, on the system clipboard.
const CLIP_KEY = 'zb:clipboard';
const CLIP_TYPE = 'application/x-zboard';
function readClip() {
  try {
    const c = JSON.parse(localStorage.getItem(CLIP_KEY));
    return c?.zboard ? c : null;
  } catch {
    return null;
  }
}

function loadView(id) {
  try {
    const v = JSON.parse(localStorage.getItem('zb:view:' + id));
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.s)) return v;
  } catch {}
  return null;
}

// extra: on a phone-width bar these sit under "More" so the rest fit without scrolling.
const TOOLS = [
  { kind: 'note', label: 'Note', icon: 'note' },
  { kind: 'todo', label: 'To-do', icon: 'todo', extra: true },
  { kind: 'link', label: 'Link', icon: 'link', extra: true },
  { kind: 'image', label: 'Image', icon: 'image' },
  ...(DEMO ? [] : [{ kind: 'file', label: 'File', icon: 'file', extra: true }]), // no PDFs or files in the demo
  { kind: 'color', label: 'Color', icon: 'swatch', extra: true },
  { kind: 'board', label: 'Board', icon: 'board' },
  { kind: 'column', label: 'Column', icon: 'column', extra: true },
];

// Where the edge of a w×h box centred at (cx, cy) meets the line towards (tx, ty).
// Arrow look from its data: heads at start/end, dashed, weight 1-3 (thin, normal, thick).
const ARROW_WEIGHTS = { 1: 1.25, 2: 2, 3: 3.5 };
const ARROW_COLORS = [null, '#23221f', '#ef4444', '#f2783c', '#f6c445', '#6dd36d', '#38bdb0', '#4f7cf7', '#a26bf0', '#ec6fcf'];
function arrowStyle(a) {
  const d = a.data || {};
  const weight = [1, 2, 3].includes(d.weight) ? d.weight : 2;
  return { start: !!d.start, end: d.end !== false, dashed: !!d.dashed, weight, width: ARROW_WEIGHTS[weight] };
}

function edgePoint(r, tx, ty) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const k = Math.min(Math.abs(r.w / 2 / (dx || 1e-9)), Math.abs(r.h / 2 / (dy || 1e-9)));
  return { x: cx + dx * Math.min(k, 1), y: cy + dy * Math.min(k, 1) };
}

export default function Board({ boardId, focus, onInfo, savedOpen, onCloseSaved, onClipCount }) {
  // A board fetched ahead or seen before draws at once; load() below refreshes it from the server.
  const [cached] = useState(() => cachedBoard(boardId));
  const [cards, setCards] = useState(() => byId(cached?.cards));
  const [arrows, setArrows] = useState(() => byId(cached?.arrows));
  const [files, setFiles] = useState(() => cached?.files || {});
  const [loaded, setLoaded] = useState(!!cached);
  useEffect(() => {
    if (loaded) bootDone(); // the first board is on screen: the boot intro can go
  }, [loaded]);
  const [panelHold, setPanelHold] = useState(false); // see the touch tap handler
  const panelHoldTimer = useRef(0);
  const [view, setView] = useState(() => loadView(boardId) || { x: 80, y: 40, s: 1 });
  const [sel, setSel] = useState(EMPTY);
  const [selArrow, setSelArrow] = useState(null);
  const [arrowLabel, setArrowLabel] = useState(false); // label box open in the arrow bar
  const [arrowColorOpen, setArrowColorOpen] = useState(false);
  useEffect(() => {
    setArrowLabel(false);
    setArrowColorOpen(false);
  }, [selArrow]);
  const [editing, setEditing] = useState(null);
  const [box, setBox] = useState(null);
  const [hint, setHint] = useState(null);
  const [dragIds, setDragIds] = useState(EMPTY);
  const [tempArrow, setTempArrow] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [reader, setReader] = useState(null); // fileId of the PDF open in the reader
  const [uploads, setUploads] = useState([]); // files on their way up, shown as placeholder cards
  const uploadAborts = useRef(new Map());
  const [toast, setToast] = useState(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [coverFor, setCoverFor] = useState(null); // board card whose cover picker is open
  const [drawing, setDrawing] = useState(null); // { cardId, strokes } while drawing mode is open
  const [pop, setPop] = useState(null); // open popover of the action panel: { kind, top, left, bottom }
  const [imgEdit, setImgEdit] = useState(null); // image card in the crop/rotate editor
  const wrapRef = useRef(null);
  const replaceInput = useRef(null);
  const replaceFor = useRef(null);
  useEffect(() => {
    if (coverFor && !sel.has(coverFor)) setCoverFor(null);
  }, [sel, coverFor]);
  useEffect(() => setPop(null), [sel, selArrow]);
  const [ctx, setCtx] = useState(null); // open context menu: { x, y, ids, at }
  const [boardList, setBoardList] = useState([]);
  const [clips, setClips] = useState([]);
  const [cutIds, setCutIds] = useState(() => {
    const clip = readClip();
    return clip?.cut && clip.board === boardId ? new Set(clip.cards.map((c) => c.id)) : EMPTY;
  });
  const [rectsVersion, setRectsVersion] = useState(0);

  const S = useRef({});
  S.current = { cards, arrows, files, view, sel, selArrow, editing, drawing };

  // Top bar: the cached board's name and path at once. On leaving, remember the board as it is
  // now, so coming back never flashes an older copy.
  const info = useRef(cached && { board: cached.board, breadcrumbs: cached.breadcrumbs });
  useLayoutEffect(() => {
    if (info.current) onInfo(info.current);
    return () => {
      if (info.current) remember(boardId, { ...info.current, cards: Object.values(S.current.cards), arrows: Object.values(S.current.arrows), files: S.current.files });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A selected board card is probably about to be opened (the first tap of a double tap).
  useEffect(() => {
    const c = sel.size === 1 ? cards[[...sel][0]] : null;
    if (c?.type === 'board' && c.data.boardId) prefetchBoard(c.data.boardId);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const canvasRef = useRef(null);
  const worldRef = useRef(null);
  const fileInput = useRef(null);
  const cameraInput = useRef(null);
  const rects = useRef(new Map());
  const undoStack = useRef([]);
  const fresh = useRef(new Set());
  const creating = useRef(new Map());
  const gesture = useRef(null);
  const space = useRef(false);
  const pointer = useRef(null);
  const toastTimer = useRef(null);
  const pendingFocus = useRef(focus);

  // action: optional { label, run } shown as a button in the message (e.g. Undo).
  const notify = useCallback((msg, action = null) => {
    setToast({ text: String(msg?.message || msg), action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), action ? 5000 : 4000);
  }, []);

  // ---------- loading + live sync ----------
  const applyCards = useCallback(
    (list) =>
      setCards((prev) => {
        const n = { ...prev };
        for (const c of list) {
          if (c.board_id === boardId) n[c.id] = c;
          else delete n[c.id];
        }
        return n;
      }),
    [boardId]
  );
  const applyArrows = useCallback(
    (list, deleted = []) =>
      setArrows((prev) => {
        const n = { ...prev };
        for (const a of list) n[a.id] = a;
        for (const id of deleted) delete n[id];
        return n;
      }),
    []
  );

  const load = useCallback(async () => {
    try {
      const d = await fetchBoard(boardId);
      setCards(byId(d.cards));
      setArrows(byId(d.arrows));
      setFiles((f) => ({ ...f, ...d.files }));
      info.current = { board: d.board, breadcrumbs: d.breadcrumbs };
      onInfo(info.current);
      setLoaded(true);
    } catch (e) {
      if (e.status === 404) {
        notify('That board no longer exists');
        location.hash = '#/b/root';
      } else if (e.status !== 401) notify(e);
    }
  }, [boardId, onInfo, notify]);

  useEffect(() => {
    load();
    return openEvents(boardId, {
      cards: ({ cards: list }) => applyCards(list),
      delete: ({ ids }) =>
        setCards((prev) => {
          const n = { ...prev };
          for (const id of ids) delete n[id];
          return n;
        }),
      arrows: ({ arrows: list, deleted }) => applyArrows(list, deleted),
      board: ({ board: b, breadcrumbs }) => {
        if (b.id === boardId) onInfo({ board: b, breadcrumbs });
        else
          setCards((prev) => {
            const n = { ...prev };
            for (const c of Object.values(prev)) if (c.child?.id === b.id) n[c.id] = { ...c, child: { ...c.child, title: b.title, color: b.color, cover: b.data?.cover ?? null } };
            return n;
          });
      },
      resync: () => {
        load();
        loadClips();
      },
      reload: () => location.reload(), // the server swapped its database (Drive restore)
      clips: ({ clips: list, deleted }) =>
        setClips((prev) => {
          const gone = new Set([...deleted, ...list.map((c) => c.id)]);
          return [...list, ...prev.filter((c) => !gone.has(c.id))].sort((a, b) => b.created_at - a.created_at);
        }),
    });
  }, [boardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadClips = useCallback(() => {
    api('GET', '/api/clips')
      .then((r) => setClips(r.clips))
      .catch(() => {});
    api('GET', '/api/boards')
      .then((r) => setBoardList(r.boards))
      .catch(() => {});
  }, []);
  useEffect(loadClips, [loadClips]);
  const clipCount = clips.filter((c) => c.board_id === boardId).length;
  useEffect(() => onClipCount?.(clipCount), [clipCount, onClipCount]);

  // A search result on this same board only changes ?focus=.
  useEffect(() => {
    if (focus) {
      pendingFocus.current = focus;
      setRectsVersion((v) => v + 1);
    }
  }, [focus]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem('zb:view:' + boardId, JSON.stringify(view));
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [view, boardId]);

  // ---------- geometry ----------
  const toWorld = useCallback((cx, cy) => {
    const r = canvasRef.current.getBoundingClientRect();
    const v = S.current.view;
    return { x: (cx - r.left - v.x) / v.s, y: (cy - r.top - v.y) / v.s };
  }, []);
  const centerWorld = useCallback(() => {
    const r = canvasRef.current.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }, [toWorld]);

  // Card rectangles in world units, measured from offsets (never on pan). Cards culled off
  // screen keep their last size; while dragging, only the dragged cards are measured again.
  const measureFrame = useRef(0);
  const measure = useCallback((only) => {
    const world = worldRef.current;
    if (!world) return;
    const m = new Map(rects.current);
    const els = only ? [...only].map((id) => world.querySelector(`[data-card-id="${CSS.escape(id)}"]`)).filter(Boolean) : world.querySelectorAll('[data-card-id]');
    let changed = false;
    for (const el of els) {
      let x = 0;
      let y = 0;
      let e = el;
      while (e && e !== world) {
        x += e.offsetLeft;
        y += e.offsetTop;
        e = e.offsetParent;
      }
      const id = el.dataset.cardId;
      const old = m.get(id);
      if (old && old.x === x && old.y === y && old.w === el.offsetWidth && old.h === el.offsetHeight) continue;
      m.set(id, { x, y, w: el.offsetWidth, h: el.offsetHeight });
      changed = true;
    }
    if (!only) {
      for (const id of m.keys()) {
        if (!S.current.cards[id]) {
          m.delete(id);
          changed = true;
        }
      }
    }
    // Re-render only when something moved, so measuring can never feed itself.
    if (!changed) return;
    rects.current = m;
    setRectsVersion((v) => v + 1);
  }, []);
  // Measured rectangle, or a guess for a card that was never on screen.
  const rectOf = (c) => rects.current.get(c.id) || { x: c.x, y: c.y, w: c.w || DEFAULT_W[c.type], h: 200 };
  const scheduleMeasure = useCallback(() => {
    cancelAnimationFrame(measureFrame.current);
    measureFrame.current = requestAnimationFrame(() => measure());
  }, [measure]);
  useLayoutEffect(() => {
    const g = gesture.current;
    measure(g?.type === 'drag' || g?.type === 'resize' ? new Set(g.ids || [g.id]) : null);
  }, [cards, measure]);

  // The board content is always its own GPU layer (.world has will-change: transform), so panning
  // just moves pixels instead of repainting every visible card, which at high zoom costs ~85 ms a
  // frame. Building that layer takes 150-250 ms, so it is kept rather than made per pan. A kept
  // layer stays drawn at the zoom it was made at, so once a zoom has settled, drop and re-add it
  // for a frame to have it redrawn sharp at the new scale.
  // That redraw and the image-size swap (settledS) are heavy, so they wait until the view has been
  // still for a moment with no button held: starting a pan right after a zoom used to land on top
  // of them and stutter. A zoom that barely changed the scale skips the redraw.
  const [settledS, setSettledS] = useState(view.s);
  const redrawTimer = useRef(0);
  const drawnAt = useRef(view.s); // the scale the layer was last drawn at
  useEffect(() => {
    const el = worldRef.current;
    if (!el) return;
    const settle = () => {
      if (gesture.current || touchG.current) {
        redrawTimer.current = setTimeout(settle, 200);
        return;
      }
      const s = S.current.view.s;
      setSettledS(s);
      if (Math.abs(s - drawnAt.current) / drawnAt.current < 0.03) return;
      drawnAt.current = s;
      el.style.willChange = 'auto';
      requestAnimationFrame(() => requestAnimationFrame(() => (el.style.willChange = '')));
    };
    clearTimeout(redrawTimer.current);
    redrawTimer.current = setTimeout(settle, 350);
    return () => clearTimeout(redrawTimer.current);
  }, [view]);
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 800 });
  useEffect(() => {
    const el = canvasRef.current;
    const ro = new ResizeObserver(() => setCanvasSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Jump to ?focus=<card> once it has been measured.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !loaded) return;
    const r = rects.current.get(id);
    if (!r) return;
    pendingFocus.current = null;
    const c = canvasRef.current.getBoundingClientRect();
    setView((v) => ({ ...v, x: c.width / 2 - (r.x + r.w / 2) * v.s, y: c.height / 2 - (r.y + r.h / 2) * v.s }));
    setSel(new Set([id]));
  }, [rectsVersion, loaded]);

  const zoomAt = useCallback((cx, cy, factor) => {
    const r = canvasRef.current.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    setView((v) => {
      const s = clamp(v.s * factor, MIN_S, MAX_S);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);
  const zoomCenter = useCallback(
    (factor) => {
      const r = canvasRef.current.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    },
    [zoomAt]
  );

  useEffect(() => {
    const el = canvasRef.current;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey && e.target.closest('[contenteditable="true"], textarea, .scrolls')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)));
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx * k, y: v.y - dy * k }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // ---------- writes ----------
  const pushUndo = useCallback((fn) => {
    undoStack.current.push(fn);
    if (undoStack.current.length > 100) undoStack.current.shift();
  }, []);

  const topZ = () => Math.max(0, ...Object.values(S.current.cards).map((c) => c.z || 0));

  const createCards = useCallback(
    async (list, { edit = false, record = true } = {}) => {
      let z = topZ() + 1;
      const full = list.map((c) => ({ id: uid(), w: DEFAULT_W[c.type], data: {}, ...c, z: c.column_id ? 0 : z++ }));
      setCards((p) => {
        const n = { ...p };
        for (const c of full) {
          n[c.id] = {
            board_id: boardId,
            x: 0,
            y: 0,
            h: null,
            color: null,
            column_id: null,
            sort: null,
            ...c,
            child: c.type === 'board' ? { id: null, title: c.title || 'New board', count: 0 } : undefined,
          };
        }
        return n;
      });
      if (edit && full[0]) {
        fresh.current.add(full[0].id);
        setSel(new Set([full[0].id]));
        setEditing(full[0].id);
      }
      const job = api('POST', `/api/boards/${encodeURIComponent(boardId)}/cards`, { cards: full });
      for (const c of full) creating.current.set(c.id, job);
      try {
        const { cards: made } = await job;
        applyCards(made);
        if (record) pushUndo(() => deleteCards(made.map((c) => c.id), { record: false }));
        return made;
      } catch (e) {
        setCards((p) => {
          const n = { ...p };
          for (const c of full) delete n[c.id];
          return n;
        });
        notify(e);
        return [];
      } finally {
        for (const c of full) creating.current.delete(c.id);
      }
    },
    [boardId, applyCards, pushUndo, notify] // deleteCards is hoisted via ref below
  );

  const deleteCards = useCallback(
    async (ids, { record = true } = {}) => {
      if (!ids.length) return;
      await Promise.allSettled(ids.map((id) => creating.current.get(id)).filter(Boolean));
      const gone = new Set(ids);
      for (const c of Object.values(S.current.cards)) if (c.column_id && gone.has(c.column_id)) gone.add(c.id);
      setCards((p) => {
        const n = { ...p };
        for (const id of gone) delete n[id];
        return n;
      });
      setArrows((p) => Object.fromEntries(Object.entries(p).filter(([, a]) => !gone.has(a.from_card) && !gone.has(a.to_card))));
      setSel((s) => (s.size ? new Set([...s].filter((id) => !gone.has(id))) : s));
      try {
        const { snapshot } = await api('POST', '/api/cards/delete', { ids });
        if (record) {
          pushUndo(async () => {
            const r = await api('POST', '/api/restore', { snapshot });
            applyCards(r.cards);
            applyArrows(r.arrows);
          });
        }
      } catch (e) {
        notify(e);
        load();
      }
    },
    [applyCards, applyArrows, pushUndo, notify, load]
  );

  const patchCards = useCallback(
    async (patches, undo) => {
      if (!patches.length) return;
      const leaving = new Set(patches.filter((p) => p.board_id && p.board_id !== boardId).map((p) => p.id));
      for (const c of Object.values(S.current.cards)) if (c.column_id && leaving.has(c.column_id)) leaving.add(c.id);
      setCards((p) => {
        const n = { ...p };
        for (const pt of patches) {
          const c = n[pt.id];
          if (!c) continue;
          n[pt.id] = { ...c, ...pt, data: pt.data ? { ...c.data, ...pt.data } : c.data };
        }
        for (const id of leaving) delete n[id];
        return n;
      });
      if (leaving.size) {
        setArrows((p) => Object.fromEntries(Object.entries(p).filter(([, a]) => !leaving.has(a.from_card) && !leaving.has(a.to_card))));
        setSel(EMPTY);
      }
      if (undo) pushUndo(undo);
      await Promise.allSettled(patches.map((p) => creating.current.get(p.id)).filter(Boolean));
      try {
        const r = await api('PATCH', '/api/cards', { cards: patches });
        applyCards(r.cards);
      } catch (e) {
        notify(e);
        load();
      }
    },
    [boardId, applyCards, pushUndo, notify, load]
  );

  const createArrow = useCallback(
    async (from, to, { record = true, id = uid(), label = null, color = null, data = {} } = {}) => {
      setArrows((p) => ({ ...p, [id]: { id, board_id: boardId, from_card: from, to_card: to, label, color, data } }));
      try {
        const r = await api('POST', `/api/boards/${encodeURIComponent(boardId)}/arrows`, { id, from_card: from, to_card: to, label, color, data });
        applyArrows([r.arrow]);
        if (record) pushUndo(() => deleteArrowRef.current(id, { record: false }));
      } catch (e) {
        applyArrows([], [id]);
        notify(e);
      }
    },
    [boardId, applyArrows, pushUndo, notify]
  );

  const deleteArrow = useCallback(
    async (id, { record = true } = {}) => {
      const a = S.current.arrows[id];
      applyArrows([], [id]);
      setSelArrow(null);
      try {
        await api('DELETE', `/api/arrows/${id}`);
        if (record && a) pushUndo(() => createArrow(a.from_card, a.to_card, { record: false, id: a.id, label: a.label, color: a.color, data: a.data }));
      } catch (e) {
        notify(e);
      }
    },
    [applyArrows, pushUndo, createArrow, notify]
  );
  const deleteArrowRef = useRef(deleteArrow);
  deleteArrowRef.current = deleteArrow;

  // Label, colour and style (data: start/end heads, dashed, weight). Undo restores all of them.
  const patchArrow = useCallback(
    function patchArrow(id, patch, { record = true } = {}) {
      const a = S.current.arrows[id];
      if (!a) return;
      const st = arrowStyle(a);
      const before = { label: a.label ?? null, color: a.color ?? null, data: { start: st.start, end: st.end, dashed: st.dashed, weight: st.weight } };
      applyArrows([{ ...a, ...patch, data: patch.data ? { ...(a.data || {}), ...patch.data } : a.data }]);
      if (record) pushUndo(() => patchArrow(id, before, { record: false }));
      api('PATCH', `/api/arrows/${id}`, patch).catch(notify);
    },
    [applyArrows, pushUndo, notify]
  );

  const undo = useCallback(async () => {
    const fn = undoStack.current.pop();
    if (!fn) return notify('Nothing to undo');
    try {
      await fn();
    } catch (e) {
      notify(e);
      load();
    }
  }, [notify, load]);

  const setLink = useCallback(
    async (id, url) => {
      setCards((p) => (p[id] ? { ...p, [id]: { ...p[id], data: { ...p[id].data, url, loading: true } } } : p));
      fresh.current.delete(id);
      let data = { url, title: url, description: null, site: null, image: null, loading: false };
      try {
        const prev = await api('GET', `/api/link-preview?url=${encodeURIComponent(url)}`);
        data = { ...data, ...prev, loading: false };
        if (prev.image) {
          const info = await api('GET', `/api/files/${prev.image}/info`).catch(() => null);
          if (info) setFiles((f) => ({ ...f, [prev.image]: info.file }));
        }
      } catch (e) {
        notify(`No preview: ${e.message}`);
      }
      await creating.current.get(id);
      // Videos get room to play.
      const wide = youtubeId(url) && (S.current.cards[id]?.w ?? DEFAULT_W.link) <= DEFAULT_W.link && !S.current.cards[id]?.column_id;
      patchCards([{ id, data, ...(wide ? { w: 400 } : {}) }]);
    },
    [patchCards, notify]
  );

  // ---------- saved items (clips) ----------
  const placeClip = useCallback(
    async (id, at) => {
      setClips((prev) => prev.filter((c) => c.id !== id));
      try {
        const { card } = await api('POST', `/api/clips/${id}/place`, { board_id: boardId, x: Math.round(at.x), y: Math.round(at.y) });
        applyCards([card]);
        setSel(new Set([card.id]));
        pushUndo(() => deleteCards([card.id], { record: false }));
      } catch (e) {
        notify(e);
        loadClips();
      }
    },
    [boardId, applyCards, pushUndo, deleteCards, notify, loadClips]
  );
  // Deleting a saved item can be undone: it leaves the list at once but is only deleted on the
  // server after the Undo message has gone (closing the page before then keeps it).
  const deleteClip = useCallback(
    (id) => {
      const clip = clips.find((c) => c.id === id);
      setClips((prev) => prev.filter((c) => c.id !== id));
      const timer = setTimeout(() => api('DELETE', `/api/clips/${id}`).catch(notify), 5000);
      notify('Saved item deleted', {
        label: 'Undo',
        run: () => {
          clearTimeout(timer);
          if (clip) setClips((prev) => [clip, ...prev.filter((c) => c.id !== id)].sort((a, b) => b.created_at - a.created_at));
        },
      });
    },
    [clips, notify]
  );

  // ---------- adding content ----------
  // A PDF's first page: drawn from the file just picked while it is small enough to hold in memory
  // (fast, nothing downloaded again); a bigger one is read from the server in pieces instead.
  const previewPdf = useCallback((f, picked) => {
    makePdfPreview(f.id, picked && picked.size <= PREVIEW_FROM_MEMORY ? picked : undefined).then((nf) => nf && setFiles((m) => ({ ...m, [nf.id]: nf })));
  }, []);

  // Pictures become image cards; any other file (a PDF, a ZIP…) a file card. Files too big for the
  // server are turned away before anything is sent. On the board, each file uploads in the background
  // as a placeholder card with its type and a progress bar (× cancels it), and turns into the real
  // card where it stood once it's stored; the board stays usable meanwhile.
  const addImages = useCallback(
    async (list, at) => {
      let all = [...list].filter(Boolean);
      if (!all.length) return;
      if (DEMO && all.some((f) => !isImageFile(f))) {
        notify("PDFs and other files can't be uploaded in the demo. Host your own ZBoard to use them.");
        all = all.filter(isImageFile);
        if (!all.length) return;
      }
      const limit = await uploadLimit();
      const tooBig = all.filter((f) => f.size > limit);
      if (tooBig.length) {
        const f = tooBig[0];
        notify(`"${f.name || 'File'}" is ${formatBytes(f.size)}; the largest upload is ${formatBytes(limit)}${tooBig.length > 1 ? ` (${tooBig.length} files are too big)` : ''}.`);
        all = all.filter((f) => f.size <= limit);
        if (!all.length) return;
      }
      const cardFor = (f, extra) => ({ type: f.width && !isPdf(f) ? 'image' : 'file', data: { fileId: f.id, caption: '' }, ...extra });

      // Into a column: one go, with a message (a column has no free spot for placeholders).
      if (at.column_id) {
        const pics = all.filter(isImageFile).length;
        notify(`Uploading ${all.length} ${pics === all.length ? 'image' : 'file'}${all.length > 1 ? 's' : ''}…`);
        try {
          const made = await uploadFiles(all);
          setFiles((f) => ({ ...f, ...byId(made) }));
          setToast(null);
          await createCards(made.map((f, i) => cardFor(f, { column_id: at.column_id, sort: (at.sort ?? 0) + i * 0.001 })));
          made.forEach((f, i) => isPdf(f) && previewPdf(f, all[i]));
        } catch (e) {
          notify(e);
        }
        return;
      }

      const spots = all.map((file, i) => ({ file, x: at.x + (i % 4) * 260, y: at.y + Math.floor(i / 4) * 260 }));
      // Bigger than one piece: resumable (uploads.js), kept going across boards, closed pages and lost
      // connections. Small ones go up in one request.
      const big = DEMO ? [] : spots.filter((s) => s.file.size > PIECE);
      for (const s of big) startUpload(s.file, { boardId, x: s.x, y: s.y }).catch((e) => notify(`${s.file.name}: ${e.message}`));
      const jobs = spots
        .filter((s) => !big.includes(s))
        .map(({ file, x, y }) => ({
          key: uid(),
          file,
          name: file.name || 'pasted.png',
          kind: isImageFile(file) ? 'image' : isPdf({ name: file.name, mime: file.type }) ? 'pdf' : 'file',
          x,
          y,
          sent: 0,
          total: file.size,
        }));
      if (!jobs.length) return;
      setUploads((u) => [...u, ...jobs.map(({ file, ...j }) => j)]);
      const patch = (key, p) => setUploads((u) => u.map((j) => (j.key === key ? { ...j, ...p } : j)));
      const drop = (key) => setUploads((u) => u.filter((j) => j.key !== key));
      const run = async (job) => {
        const req = uploadFile(job.file, (sent, total) => patch(job.key, { sent, total }));
        uploadAborts.current.set(job.key, req.abort);
        try {
          const f = await req;
          setFiles((m) => ({ ...m, [f.id]: f }));
          drop(job.key);
          await createCards([cardFor(f, { x: job.x, y: job.y })]);
          if (isPdf(f)) previewPdf(f, job.file);
        } catch (e) {
          if (e.cancelled) return drop(job.key);
          patch(job.key, { error: e.message });
          notify(`${job.name}: ${e.message}`);
          setTimeout(() => drop(job.key), 5000);
        } finally {
          uploadAborts.current.delete(job.key);
        }
      };
      // Two at a time: big files don't hold up the small ones for long, and the link isn't swamped.
      const queue = [...jobs];
      await Promise.all([0, 1].map(async () => {
        while (queue.length) await run(queue.shift());
      }));
    },
    [createCards, notify, previewPdf, boardId]
  );

  // Big uploads (uploads.js): this board's are shown as placeholders; a finished one becomes its card.
  const [bigUploads, setBigUploads] = useState(getJobs);
  useEffect(() => {
    resumeUploads();
    const offJobs = subscribe(setBigUploads);
    const offDone = onFinished(({ card, file, movedHome, picked }) => {
      setFiles((m) => ({ ...m, [file.id]: file }));
      if (card.board_id === boardId) applyCards([card]);
      if (movedHome) notify(`${file.name}: its board was deleted, so it was put on Home.`);
      if (isPdf(file)) previewPdf(file, picked);
    });
    return () => {
      offJobs();
      offDone();
    };
  }, [boardId, applyCards, notify, previewPdf]);
  const repickFor = useRef(null);
  const repickInput = useRef(null);

  const addImageUrl = useCallback(
    async (url, at, extra = {}) => {
      try {
        const { file } = await api('POST', '/api/upload-url', { url });
        setFiles((f) => ({ ...f, [file.id]: file }));
        await createCards([{ type: 'image', x: at.x, y: at.y, data: { fileId: file.id, caption: '', ...extra } }]);
      } catch (e) {
        notify(e);
      }
    },
    [createCards, notify]
  );

  const addLink = useCallback(
    async (url, at) => {
      const [c] = await createCards([{ type: 'link', x: at.x, y: at.y, data: { url, title: url, loading: true } }]);
      if (c) setLink(c.id, url);
    },
    [createCards, setLink]
  );

  const addText = useCallback((text, at) => createCards([{ type: 'note', x: at.x, y: at.y, data: { html: textToHtml(text) } }]), [createCards]);

  const addTool = useCallback(
    (kind, at) => {
      if (kind === 'image' || kind === 'file') {
        fileInput.current.dataset.at = JSON.stringify(at);
        fileInput.current.accept = kind === 'image' ? 'image/*' : '';
        fileInput.current.click();
        return;
      }
      const base = { type: kind, x: at.x, y: at.y, ...(at.column_id ? { column_id: at.column_id, sort: at.sort } : {}) };
      if (kind === 'note') createCards([base], { edit: true });
      else if (kind === 'todo') createCards([{ ...base, data: { title: '', items: [] } }], { edit: true });
      else if (kind === 'link') createCards([{ ...base, data: {} }], { edit: true });
      else if (kind === 'board') createCards([{ ...base, title: 'New board' }], { edit: true });
      else if (kind === 'color') createCards([{ ...base, data: { hex: '#ecbc1c' } }], { edit: true });
      else if (kind === 'column') {
        if (at.column_id) return notify("Columns can't go inside columns");
        createCards([{ type: 'column', x: at.x, y: at.y, data: { title: '' } }], { edit: true });
      }
    },
    [createCards, notify]
  );

  // ---------- card actions (passed to cards) ----------
  const stopEdit = useCallback((id) => setEditing((e) => (e === id ? null : e)), []);
  // Strokes (board units) become a drawing card sitting exactly where they were drawn.
  const saveDrawing = useCallback(
    async (strokes) => {
      const d = S.current.drawing;
      setDrawing(null);
      if (!d) return;
      const old = d.cardId ? S.current.cards[d.cardId] : null;
      if (d.kind === 'ink') {
        if (!old) return;
        const k = 1000 / d.frame.w;
        const ink = strokes.length ? { strokes: mapStrokes(strokes, k, -d.frame.x * k, -d.frame.y * k), vw: 1000, vh: Math.round(d.frame.h * k) } : null;
        patchCards([{ id: old.id, data: { ink } }], () => patchCards([{ id: old.id, data: { ink: old.data.ink ?? null } }]));
        setSel(new Set([old.id]));
        return;
      }
      if (!strokes.length) {
        if (old) deleteCards([old.id]);
        return;
      }
      const b = inkBounds(strokes);
      const x = Math.floor(b.x);
      const y = Math.floor(b.y);
      const w = Math.max(1, Math.ceil(b.x + b.w) - x);
      const h = Math.max(1, Math.ceil(b.y + b.h) - y);
      const data = { strokes: mapStrokes(strokes, 1, -x, -y), vw: w, vh: h };
      if (old) {
        const back = { id: old.id, x: old.x, y: old.y, w: old.w, data: old.data };
        patchCards([{ id: old.id, x, y, w, data }], () => patchCards([back]));
        setSel(new Set([old.id]));
      } else {
        const [made] = await createCards([{ type: 'drawing', x, y, w, data }]);
        if (made) setSel(new Set([made.id]));
      }
    },
    [patchCards, createCards, deleteCards]
  );

  // Add or remove a label on every selected card (one undo step).
  const toggleLabel = useCallback(
    (label, on) => {
      const cs = S.current.cards;
      const ids = [...S.current.sel].filter((id) => cs[id]);
      const patches = ids.map((id) => {
        const cur = cs[id].data.labels || [];
        return { id, data: { labels: on ? (cur.includes(label) ? cur : [...cur, label]) : cur.filter((l) => l !== label) } };
      });
      const back = ids.map((id) => ({ id, data: { labels: cs[id].data.labels || [] } }));
      patchCards(patches, () => patchCards(back));
    },
    [patchCards]
  );

  // Eyedropper on an image: the picked colour becomes a colour card beside it (Chrome / Edge).
  const pickColourFrom = useCallback(
    async (c) => {
      if (!('EyeDropper' in window)) return notify("This browser can't pick colours from the screen. Add a Color card and type the code.");
      let hex;
      try {
        hex = (await new window.EyeDropper().open()).sRGBHex;
      } catch {
        return; // cancelled
      }
      const near = Object.values(S.current.cards).filter((k) => k.type === 'color' && Math.abs(k.y - c.y) < 400 && k.x > c.x).length;
      const [made] = await createCards([{ type: 'color', x: c.x + (c.w || DEFAULT_W.image) + 24, y: c.y + near * 190, data: { hex } }]);
      if (made) setSel(new Set([made.id]));
    },
    [createCards, notify]
  );

  // Swap an image card's picture, keeping its place, caption and labels.
  const replaceImage = useCallback(
    async (fileList) => {
      const id = replaceFor.current;
      const c = S.current.cards[id];
      if (!c || !fileList?.length) return;
      try {
        const [f] = await uploadFiles([fileList[0]]);
        setFiles((m) => ({ ...m, [f.id]: f }));
        const back = { id, data: { fileId: c.data.fileId, crop: c.data.crop ?? null, rotate: c.data.rotate ?? 0 } };
        patchCards([{ id, data: { fileId: f.id, crop: null, rotate: 0 } }], () => patchCards([back]));
      } catch (e) {
        notify(e);
      }
    },
    [patchCards, notify]
  );

  // Cover of the board a board card opens. Undo puts the old one back.
  const setCover = useCallback(
    async function setCover(cardId, cover, { record = true } = {}) {
      const childId = S.current.cards[cardId]?.child?.id;
      if (!childId) return;
      const before = S.current.cards[cardId].child.cover ?? null;
      setCards((p) => {
        const n = { ...p };
        for (const c of Object.values(p)) if (c.child?.id === childId) n[c.id] = { ...c, child: { ...c.child, cover } };
        return n;
      });
      if (record) pushUndo(() => setCover(cardId, before, { record: false }));
      try {
        await api('PATCH', `/api/boards/${childId}`, { data: { cover } });
      } catch (e) {
        notify(e);
      }
    },
    [pushUndo, notify]
  );

  const actions = useMemo(
    () => ({
      saveData: (id, data) => patchCards([{ id, data }]),
      stopEdit,
      finishNote: (id, html) => {
        stopEdit(id);
        const c = S.current.cards[id];
        if (!c) return;
        const empty = !htmlText(html).trim();
        if (empty && fresh.current.has(id)) {
          fresh.current.delete(id);
          deleteCards([id], { record: false });
          return;
        }
        fresh.current.delete(id);
        if (html !== (c.data.html || '')) patchCards([{ id, data: { html } }]);
      },
      dropIfFresh: (id) => {
        if (fresh.current.has(id)) {
          fresh.current.delete(id);
          deleteCards([id], { record: false });
        }
      },
      setLink,
      renameBoard: async (cardId, title) => {
        setCards((p) => (p[cardId] ? { ...p, [cardId]: { ...p[cardId], child: { ...p[cardId].child, title } } } : p));
        const made = await creating.current.get(cardId)?.catch(() => null);
        const childId = made?.cards.find((c) => c.id === cardId)?.child?.id ?? S.current.cards[cardId]?.child?.id;
        if (!childId) return;
        setCards((p) => {
          const n = { ...p };
          for (const c of Object.values(p)) if (c.child?.id === childId) n[c.id] = { ...c, child: { ...c.child, title } };
          return n;
        });
        try {
          await api('PATCH', `/api/boards/${childId}`, { title });
        } catch (e) {
          notify(e);
        }
      },
      setCover,
      editCard: (id) => {
        setSel(new Set([id]));
        setEditing(id);
      },
      ensureFile: async (fileId) => {
        if (S.current.files[fileId]) return;
        const r = await api('GET', `/api/files/${fileId}/info`).catch(() => null);
        if (r) setFiles((f) => ({ ...f, [fileId]: r.file }));
      },
      ensurePdfPreview: async (fileId) => {
        const nf = await makePdfPreview(fileId);
        if (nf) setFiles((f) => ({ ...f, [fileId]: nf }));
      },
    }),
    [patchCards, deleteCards, setLink, stopEdit, notify, setCover]
  );

  // Drawing mode, empty or with a drawing card's strokes moved back to board units.
  const openDrawing = useCallback((c) => {
    setSel(EMPTY);
    setEditing(null);
    if (!c) return setDrawing({ cardId: null, strokes: [] });
    const k = (c.w || DEFAULT_W.drawing) / (c.data.vw || 1);
    setDrawing({ cardId: c.id, strokes: mapStrokes(c.data.strokes || [], k, c.x, c.y) });
  }, []);

  // Draw on an image: strokes are kept on the image card in 1000-unit-wide image space.
  const openInk = useCallback((c) => {
    const cardEl = worldRef.current?.querySelector(`[data-card-id="${CSS.escape(c.id)}"]`);
    const wrap = cardEl?.querySelector('.img-wrap');
    const r = rects.current.get(c.id);
    if (!wrap || !r) return;
    setSel(EMPTY);
    setEditing(null);
    const frame = { x: r.x + cardEl.clientLeft + wrap.offsetLeft, y: r.y + cardEl.clientTop + wrap.offsetTop, w: wrap.offsetWidth, h: wrap.offsetHeight };
    const ink = c.data.ink;
    setDrawing({ cardId: c.id, kind: 'ink', frame, strokes: ink ? mapStrokes(ink.strokes, frame.w / (ink.vw || 1000), frame.x, frame.y) : [] });
  }, []);

  const openCard = useCallback((c) => {
    if (!c) return;
    if (c.type === 'drawing') return openDrawing(c);
    if (c.type === 'board' && c.data.boardId) {
      // The top bar names the new board right away (from its card), not when its contents arrive.
      const board = { id: c.data.boardId, title: c.child?.title || 'Untitled' };
      if (info.current) onInfo({ board, breadcrumbs: [...info.current.breadcrumbs, board] });
      location.hash = `#/b/${c.data.boardId}`;
    } else if (c.type === 'link' && c.data.url) window.open(c.data.url, '_blank', 'noopener');
    else if (c.type === 'image' && c.data.fileId) setLightbox(c.data.fileId);
    else if (c.type === 'file' && c.data.fileId) {
      const f = S.current.files[c.data.fileId];
      // A browser that can't run pdf.js gets the PDF in its own viewer, in a new window (over the app
      // with a Done button when ZBoard runs from the home screen). The reader is never mounted then,
      // so nothing flashes first.
      if (isPdf(f) && PDF_SUPPORTED) return setReader(c.data.fileId);
      if (isPdf(f)) return void window.open(fileUrl(c.data.fileId), '_blank', 'noopener');
      const a = document.createElement('a');
      a.href = fileUrl(c.data.fileId);
      a.download = f?.name || 'file';
      a.click();
    }
  }, [openDrawing, onInfo]);

  const startEdit = useCallback((id) => {
    setSel(new Set([id]));
    setEditing(id);
  }, []);

  // These act on the selection, or on the cards a context menu was opened for.
  const pick = (only) => (Array.isArray(only) ? only : [...S.current.sel]);

  const duplicate = useCallback((only) => {
    const cs = S.current.cards;
    const picked = pick(only).map((id) => cs[id]).filter(Boolean);
    if (!picked.length) return;
    const list = [];
    for (const c of picked) {
      const copy = { type: c.type, x: c.x + 24, y: c.y + 24, w: c.w, color: c.color, data: { ...c.data } };
      if (c.column_id) Object.assign(copy, { column_id: c.column_id, sort: (c.sort ?? 0) + 0.5 });
      if (c.type === 'board') copy.copyFrom = c.data.boardId;
      copy.id = uid();
      list.push(copy);
      if (c.type === 'column') {
        for (const k of Object.values(cs).filter((k) => k.column_id === c.id)) {
          const kc = { id: uid(), type: k.type, w: k.w, color: k.color, data: { ...k.data }, column_id: copy.id, sort: k.sort };
          if (k.type === 'board') kc.copyFrom = k.data.boardId;
          list.push(kc);
        }
      }
    }
    createCards(list).then((made) => setSel(new Set(made.filter((c) => !list.find((l) => l.id === c.id)?.column_id || picked.some((p) => p.column_id)).map((c) => c.id))));
  }, [createCards]);

  const setColor = useCallback(
    (color, only) => {
      const cs = S.current.cards;
      const ids = pick(only).filter((id) => cs[id]);
      const before = ids.map((id) => ({ id, color: cs[id].color ?? null }));
      patchCards(ids.map((id) => ({ id, color })), () => patchCards(before));
      setColorOpen(false);
    },
    [patchCards]
  );

  // A coloured strip across the top of the selected cards (data.strip, a hex colour or null).
  const setStrip = useCallback(
    (strip, only) => {
      const cs = S.current.cards;
      const ids = pick(only).filter((id) => cs[id]);
      const before = ids.map((id) => ({ id, data: { strip: cs[id].data.strip ?? null } }));
      patchCards(ids.map((id) => ({ id, data: { strip } })), () => patchCards(before));
    },
    [patchCards]
  );

  const bringToFront = useCallback((only) => {
    const cs = S.current.cards;
    let z = topZ();
    const ids = pick(only).filter((id) => cs[id] && !cs[id].column_id).sort((a, b) => cs[a].z - cs[b].z);
    const before = ids.map((id) => ({ id, z: cs[id].z }));
    patchCards(ids.map((id) => ({ id, z: ++z })), () => patchCards(before));
  }, [patchCards]);

  const sendToBack = useCallback((only) => {
    const cs = S.current.cards;
    let z = Math.min(0, ...Object.values(cs).map((c) => c.z || 0));
    const ids = pick(only).filter((id) => cs[id] && !cs[id].column_id).sort((a, b) => cs[b].z - cs[a].z);
    const before = ids.map((id) => ({ id, z: cs[id].z }));
    patchCards(ids.map((id) => ({ id, z: --z })), () => patchCards(before));
  }, [patchCards]);

  // Tidy the selection into a grid from its top-left corner, in reading order (rows top to bottom,
  // left to right). Each column is as wide as its widest card, each row as tall as its tallest.
  // A selection that already sits in one row (or one column) stays that way.
  const arrangeGrid = useCallback(() => {
    const cs = S.current.cards;
    const items = [...S.current.sel]
      .filter((id) => cs[id] && !cs[id].column_id)
      .map((id) => ({ id, r: rects.current.get(id) || { x: cs[id].x, y: cs[id].y, w: cs[id].w || DEFAULT_W[cs[id].type], h: 200 } }));
    if (items.length < 2) return;
    const GAP = 24;
    items.sort((a, b) => a.r.y + a.r.h / 2 - (b.r.y + b.r.h / 2));
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      const mid = it.r.y + it.r.h / 2;
      if (row && mid - row.mid < Math.min(row.h, it.r.h) / 2) row.items.push(it);
      else rows.push({ mid, h: it.r.h, items: [it] });
    }
    const ordered = rows.flatMap((row) => row.items.sort((a, b) => a.r.x - b.r.x));
    const cols = rows.length === 1 ? ordered.length : rows.every((row) => row.items.length === 1) ? 1 : Math.ceil(Math.sqrt(ordered.length));
    const colW = [];
    const rowH = [];
    ordered.forEach((it, i) => {
      colW[i % cols] = Math.max(colW[i % cols] || 0, it.r.w);
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)] || 0, it.r.h);
    });
    const x0 = Math.min(...items.map((it) => it.r.x));
    const y0 = Math.min(...items.map((it) => it.r.y));
    const colX = colW.map((_, c) => x0 + colW.slice(0, c).reduce((s, w) => s + w + GAP, 0));
    const rowY = rowH.map((_, r) => y0 + rowH.slice(0, r).reduce((s, h) => s + h + GAP, 0));
    const patches = ordered.map((it, i) => ({ id: it.id, x: Math.round(colX[i % cols]), y: Math.round(rowY[Math.floor(i / cols)]) }));
    const moved = patches.filter((p) => p.x !== cs[p.id].x || p.y !== cs[p.id].y);
    const before = moved.map((p) => ({ id: p.id, x: cs[p.id].x, y: cs[p.id].y }));
    patchCards(moved, () => patchCards(before));
  }, [patchCards]);

  const selectAll = useCallback(() => {
    const cs = S.current.cards;
    setSel(new Set(Object.values(cs).filter((c) => !c.column_id || !cs[c.column_id]).map((c) => c.id)));
  }, []);

  const fitAll = useCallback(() => {
    const cs = S.current.cards;
    const rs = Object.values(cs)
      .filter((c) => !c.column_id || !cs[c.column_id])
      .map(rectOf);
    if (!rs.length) return;
    const x1 = Math.min(...rs.map((r) => r.x));
    const y1 = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w));
    const y2 = Math.max(...rs.map((r) => r.y + r.h));
    const el = canvasRef.current;
    const pad = 60;
    const s = clamp(Math.min((el.clientWidth - pad * 2) / (x2 - x1 || 1), (el.clientHeight - pad * 2) / (y2 - y1 || 1)), MIN_S, 1);
    setView({ s, x: (el.clientWidth - (x2 - x1) * s) / 2 - x1 * s, y: (el.clientHeight - (y2 - y1) * s) / 2 - y1 * s });
  }, []);

  const moveToBoard = useCallback(
    (ids, target) => {
      const cs = S.current.cards;
      const top = ids.filter((id) => cs[id] && !(cs[id].column_id && ids.includes(cs[id].column_id)));
      const back = top.map((id) => ({ id, board_id: boardId, x: cs[id].x, y: cs[id].y, column_id: cs[id].column_id ?? null, sort: cs[id].sort }));
      patchCards(top.map((id, i) => ({ id, board_id: target, column_id: null, x: 40 + i * 24, y: 40 + i * 24 })), () => patchCards(back));
      notify(`Moved ${top.length} card${top.length > 1 ? 's' : ''}`);
    },
    [boardId, patchCards, notify]
  );

  // ---------- clipboard ----------
  const copySelection = useCallback(
    (cut = false, only = null) => {
      const cs = S.current.cards;
      const ids = new Set([...(only || S.current.sel)].filter((id) => cs[id]));
      if (!ids.size) return null;
      for (const c of Object.values(cs)) if (c.column_id && ids.has(c.column_id)) ids.add(c.id);
      const cards = [...ids].map((id) => cs[id]);
      const plain = (c) => {
        const d = c.data || {};
        if (c.type === 'note') return htmlText(d.html);
        if (c.type === 'todo') return [d.title, ...(d.items || []).map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`)].filter(Boolean).join('\n');
        if (c.type === 'link') return d.url || '';
        if (c.type === 'board') return c.child?.title || '';
        return d.caption || d.title || '';
      };
      const clip = {
        zboard: 1,
        cut,
        board: boardId,
        at: Date.now(),
        cards: cards.map(({ child, ...c }) => c),
        arrows: Object.values(S.current.arrows).filter((a) => ids.has(a.from_card) && ids.has(a.to_card)),
        text: cards.map(plain).filter(Boolean).join('\n\n'),
      };
      try {
        localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
      } catch {}
      setCutIds(cut ? ids : EMPTY);
      const top = cards.filter((c) => !c.column_id || !ids.has(c.column_id)).length;
      notify(`${cut ? 'Cut' : 'Copied'} ${top} card${top > 1 ? 's' : ''}`);
      return clip;
    },
    [boardId, notify]
  );

  // The menu has no clipboard event to write into, so use the async API (custom types need the "web " prefix).
  const toSystemClipboard = (clip) => {
    const text = clip.text || ' ';
    try {
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        ['web ' + CLIP_TYPE]: new Blob([JSON.stringify(clip)], { type: 'web ' + CLIP_TYPE }),
      });
      navigator.clipboard.write([item]).catch(() => navigator.clipboard.writeText(text).catch(() => {}));
    } catch {
      navigator.clipboard?.writeText(text).catch(() => {});
    }
  };

  // Paste copied cards with their top-left corner at `at`. A cut moves the originals instead.
  const pasteClip = useCallback(
    async (clip, at) => {
      const inClip = new Set(clip.cards.map((c) => c.id));
      const top = clip.cards.filter((c) => !c.column_id || !inClip.has(c.column_id));
      if (!top.length) return;
      const minX = Math.min(...top.map((c) => c.x));
      const minY = Math.min(...top.map((c) => c.y));
      const place = (c) => ({ x: Math.round(at.x + c.x - minX), y: Math.round(at.y + c.y - minY) });
      if (clip.cut) {
        try {
          localStorage.removeItem(CLIP_KEY);
        } catch {}
        setCutIds(EMPTY);
        const back = top.map((c) => ({ id: c.id, board_id: clip.board, x: c.x, y: c.y, column_id: c.column_id ?? null, sort: c.sort ?? null }));
        await patchCards(
          top.map((c) => ({ id: c.id, board_id: boardId, column_id: null, ...place(c) })),
          async () => {
            await patchCards(back);
            load();
          }
        );
        load(); // arrows and stacked cards that came along
        setSel(new Set(top.map((c) => c.id)));
        return;
      }
      const ids = new Map(clip.cards.map((c) => [c.id, uid()]));
      const isTop = new Set(top.map((c) => c.id));
      const list = [...top, ...clip.cards.filter((c) => !isTop.has(c.id))].map((c) => {
        const n = { id: ids.get(c.id), type: c.type, w: c.w, color: c.color, data: { ...c.data } };
        if (isTop.has(c.id)) Object.assign(n, place(c));
        else Object.assign(n, { column_id: ids.get(c.column_id), sort: c.sort });
        if (c.type === 'board') {
          n.copyFrom = c.data.boardId;
          delete n.data.boardId;
        }
        return n;
      });
      const made = await createCards(list);
      if (!made.length) return;
      for (const a of clip.arrows || []) {
        if (ids.has(a.from_card) && ids.has(a.to_card)) createArrow(ids.get(a.from_card), ids.get(a.to_card), { record: false, label: a.label, color: a.color, data: a.data });
      }
      setSel(new Set(top.map((c) => ids.get(c.id))));
    },
    [boardId, patchCards, createCards, createArrow, load]
  );

  // Menu paste: whatever the system clipboard holds if the browser lets us read it, else our own copy.
  const pasteAt = useCallback(
    async (at) => {
      try {
        for (const it of (await navigator.clipboard?.read?.()) || []) {
          if (it.types.includes('web ' + CLIP_TYPE)) return pasteClip(JSON.parse(await (await it.getType('web ' + CLIP_TYPE)).text()), at);
          const img = it.types.find((t) => t.startsWith('image/'));
          if (img) return addImages([new File([await it.getType(img)], 'pasted.' + img.split('/')[1], { type: img })], at);
          if (it.types.includes('text/plain')) {
            const text = await (await it.getType('text/plain')).text();
            const stored = readClip();
            if (stored && stored.text === text) return pasteClip(stored, at);
            if (text.trim()) return isUrl(text) ? addLink(text.trim(), at) : addText(text, at);
          }
        }
      } catch {
        // No permission (or plain http): fall back to our own copy.
      }
      const stored = readClip();
      if (stored) return pasteClip(stored, at);
      notify('Nothing to paste');
    },
    [pasteClip, addImages, addLink, addText, notify]
  );

  // A cut pasted in another tab clears the dimming here.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== CLIP_KEY) return;
      const clip = readClip();
      setCutIds(clip?.cut && clip.board === boardId ? new Set(clip.cards.map((c) => c.id)) : EMPTY);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [boardId]);

  // ---------- context menu ----------
  const openMenuRef = useRef(null);
  openMenuRef.current = (cx, cy, target) => {
    const at = toWorld(cx, cy);
    const cardEl = target?.closest?.('[data-card-id]');
    let ids = null;
    if (cardEl) {
      const id = cardEl.dataset.cardId;
      ids = S.current.sel.has(id) ? [...S.current.sel] : [id];
      if (!S.current.sel.has(id)) setSel(new Set([id]));
    }
    setColorOpen(false);
    setCtx({ x: cx, y: cy, ids, at: { x: Math.round(at.x), y: Math.round(at.y) } });
    api('GET', '/api/boards')
      .then((r) => setBoardList(r.boards))
      .catch(() => {});
  };
  const closeMenu = useCallback(() => setCtx(null), []);

  function menuItems({ ids, at }) {
    if (!ids) {
      return [
        { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', onClick: () => pasteAt(at) },
        { separator: true },
        ...TOOLS.map((t) => ({ label: t.label, icon: t.icon, onClick: () => addTool(t.kind, at) })),
        { separator: true },
        { label: 'Select all', icon: 'select', shortcut: 'Ctrl+A', onClick: selectAll },
        { label: 'Fit to screen', icon: 'fit', onClick: fitAll },
      ];
    }
    const cs = S.current.cards;
    const single = ids.length === 1 ? cs[ids[0]] : null;
    const many = ids.length > 1 ? ` ${ids.length} cards` : '';
    // A board can't go into itself or anything inside it.
    const excluded = new Set();
    const exclude = (id) => {
      excluded.add(id);
      for (const b of boardList) if (b.parent_id === id && !excluded.has(b.id)) exclude(b.id);
    };
    for (const id of ids) if (cs[id]?.type === 'board') exclude(cs[id].data.boardId);
    const tree = (parent) =>
      boardList
        .filter((b) => b.parent_id === parent && !excluded.has(b.id))
        .map((b) => {
          const sub = tree(b.id);
          return { label: b.title || 'Untitled', icon: 'board', disabled: b.id === boardId, onClick: () => moveToBoard(ids, b.id), submenu: sub.length ? sub : undefined };
        });
    const home = boardList.find((b) => b.id === 'root');
    const moveItems = boardList.length
      ? [{ label: home?.title || 'Home', icon: 'home', disabled: boardId === 'root', onClick: () => moveToBoard(ids, 'root'), submenu: tree('root') }]
      : [{ label: 'Loading…', disabled: true }];
    const opens = single && ['board', 'link', 'image', 'file'].includes(single.type);
    return [
      single && { label: opens ? 'Open' : 'Edit', icon: opens ? 'open' : 'edit', shortcut: opens ? 'Dbl-click' : 'Enter', onClick: () => (opens ? openCard(single) : startEdit(single.id)) },
      single && opens && single.type !== 'image' && single.type !== 'file' && { label: single.type === 'board' ? 'Rename' : 'Edit link', icon: 'edit', shortcut: 'Enter', onClick: () => startEdit(single.id) },
      single?.type === 'board' && { label: 'Change cover', icon: 'palette', onClick: () => setCoverFor(single.id) },
      single?.type === 'drawing' && { label: 'Edit drawing', icon: 'draw', shortcut: 'Dbl-click', onClick: () => openDrawing(single) },
      single?.type === 'image' && !single.column_id && { label: single.data.ink ? 'Edit drawing on image' : 'Draw on image', icon: 'draw', onClick: () => openInk(single) },
      single && { separator: true },
      { label: 'Copy' + many, icon: 'copy', shortcut: 'Ctrl+C', onClick: () => { const c = copySelection(false, ids); if (c) toSystemClipboard(c); } }, // prettier-ignore
      { label: 'Cut' + many, icon: 'cut', shortcut: 'Ctrl+X', onClick: () => { const c = copySelection(true, ids); if (c) toSystemClipboard(c); } }, // prettier-ignore
      { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', onClick: () => pasteAt(at) },
      { label: 'Duplicate', icon: 'duplicate', shortcut: 'Ctrl+D', onClick: () => duplicate(ids) },
      { separator: true },
      { label: 'Move to board', icon: 'board', submenu: moveItems },
      { label: 'Colour', icon: 'palette', submenu: COLORS.map((c) => ({ label: c.label, swatch: c.id, onClick: () => setColor(c.id, ids) })) },
      { label: 'Bring to front', icon: 'front', onClick: () => bringToFront(ids) },
      { label: 'Send to back', icon: 'back', onClick: () => sendToBack(ids) },
      { separator: true },
      { label: 'Delete' + many, icon: 'trash', shortcut: 'Del', danger: true, onClick: () => deleteCards(ids) },
    ].filter(Boolean);
  }

  // ---------- drop targets ----------
  const findHint = useCallback(
    (cx, cy, dragging, { columnsOk = true } = {}) => {
      for (const el of document.elementsFromPoint(cx, cy)) {
        const cardEl = el.closest('[data-card-id]');
        if (cardEl && dragging.has(cardEl.dataset.cardId)) continue;
        const col = el.closest('.card-column');
        if (col && columnsOk) {
          const colId = col.dataset.cardId;
          const w = toWorld(cx, cy);
          const kids = Object.values(S.current.cards)
            .filter((c) => c.column_id === colId && !dragging.has(c.id))
            .sort((a, b) => a.sort - b.sort);
          let index = kids.findIndex((k) => {
            const r = rects.current.get(k.id);
            return r && w.y < r.y + r.h / 2;
          });
          if (index < 0) index = kids.length;
          return { columnId: colId, index, before: kids[index - 1]?.sort, after: kids[index]?.sort };
        }
        const b = el.closest('[data-drop-board]');
        if (b && b.dataset.dropBoard !== boardId) return { boardId: b.dataset.dropBoard };
        if (cardEl) return null;
        if (el === canvasRef.current) return null;
      }
      return null;
    },
    [toWorld, boardId]
  );

  // ---------- pointer gestures ----------
  const onPointerDown = useCallback(
    (e) => {
      if (lightbox) return;
      const t = e.target;
      if (t.closest('.ctx-menu')) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      lastPointerType.current = e.pointerType;
      if (e.pointerType === 'touch' && !t.closest('[data-handle]')) {
        touchDownRef.current(e);
        return;
      }
      const v = S.current.view;
      let g = null;
      // Right button (or Ctrl+click on a Mac): pan when dragged, context menu when released in place.
      const menuButton = e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey);
      if (e.button === 1 || menuButton || (space.current && e.button === 0)) {
        e.preventDefault();
        g = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, menu: menuButton, target: t };
      } else if (e.button !== 0) {
        return;
      } else if (t.closest('[data-handle]')) {
        const id = t.closest('[data-card-id]').dataset.cardId;
        const c = S.current.cards[id];
        e.preventDefault();
        const handle = t.closest('[data-handle]').dataset.handle;
        if (handle === 'resize') g = { type: 'resize', id, sx: e.clientX, w0: c.w || DEFAULT_W[c.type] };
        else if (handle === 'move') g = { type: 'maybe-drag', ids: S.current.sel.has(id) ? [...S.current.sel] : [id], sx: e.clientX, sy: e.clientY };
        else g = { type: 'arrow', from: id };
      } else if (t.closest('input, textarea, select, button, a, [contenteditable="true"], .float-bar, .format-bar')) {
        return;
      } else if (t.closest('.tag-chip')) {
        e.preventDefault(); // keep focus in the search box that is about to open
        window.dispatchEvent(new CustomEvent('zb:search', { detail: { tag: t.closest('.tag-chip').dataset.tag } }));
        return;
      } else if (t.closest('[data-arrow-id]')) {
        setSelArrow(t.closest('[data-arrow-id]').dataset.arrowId);
        setSel(EMPTY);
        return;
      } else if (t.closest('[data-card-id]')) {
        const id = t.closest('[data-card-id]').dataset.cardId;
        if (S.current.editing === id) return;
        let next = S.current.sel;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          next = new Set(next);
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else if (!next.has(id)) next = new Set([id]);
        setSel(next);
        setSelArrow(null);
        if (S.current.editing) document.activeElement?.blur?.();
        if (!next.has(id)) return;
        g = { type: 'maybe-drag', ids: [...next], sx: e.clientX, sy: e.clientY };
      } else {
        if (S.current.editing) document.activeElement?.blur?.();
        setSelArrow(null);
        setColorOpen(false);
        const base = e.shiftKey ? new Set(S.current.sel) : EMPTY;
        if (!e.shiftKey) setSel(EMPTY);
        g = { type: 'box', sx: e.clientX, sy: e.clientY, base };
      }
      beginRef.current(g);
    },
    [lightbox]
  );

  // Track one pointer gesture until release (window listeners, so drops anywhere count).
  const beginRef = useRef(null);
  beginRef.current = (g0) => {
    gesture.current = g0;
    canvasRef.current?.classList.add('gesturing'); // lets drags pass over playing videos
      const move = (ev) => {
        pointer.current = { x: ev.clientX, y: ev.clientY };
        const g = gesture.current;
        if (!g) return;
        const s = S.current.view.s;
        if (g.type === 'pan') {
          setView((v) => ({ ...v, x: g.vx + ev.clientX - g.sx, y: g.vy + ev.clientY - g.sy }));
        } else if (g.type === 'resize') {
          const w = Math.max(120, Math.round(g.w0 + (ev.clientX - g.sx) / s));
          setCards((p) => ({ ...p, [g.id]: { ...p[g.id], w } }));
          g.w = w;
        } else if (g.type === 'arrow') {
          setTempArrow({ from: g.from, ...toWorld(ev.clientX, ev.clientY) });
        } else if (g.type === 'box') {
          const b = { x1: Math.min(g.sx, ev.clientX), y1: Math.min(g.sy, ev.clientY), x2: Math.max(g.sx, ev.clientX), y2: Math.max(g.sy, ev.clientY) };
          setBox(b);
          const a = toWorld(b.x1, b.y1);
          const z = toWorld(b.x2, b.y2);
          const next = new Set(g.base);
          for (const c of Object.values(S.current.cards)) {
            if (c.column_id && S.current.cards[c.column_id]) continue;
            const r = rectOf(c);
            if (r.x < z.x && r.x + r.w > a.x && r.y < z.y && r.y + r.h > a.y) next.add(c.id);
          }
          setSel(next);
        } else if (g.type === 'maybe-drag') {
          if (Math.hypot(ev.clientX - g.sx, ev.clientY - g.sy) < 4) return;
          const cs = S.current.cards;
          // Cards inside a selected column move with it.
          const ids = g.ids.filter((id) => cs[id] && !(cs[id].column_id && g.ids.includes(cs[id].column_id)));
          const origin = new Map();
          const lifted = {};
          // Dragged cards ride on top of everything, keeping their order among themselves.
          let z = topZ();
          const byZ = [...ids].sort((a, b) => (cs[a].z ?? 0) - (cs[b].z ?? 0));
          const allOnTop = byZ.every((id, i) => (cs[id].z ?? 0) === z - byZ.length + 1 + i);
          for (const id of byZ) {
            const c = cs[id];
            origin.set(id, { x: c.x, y: c.y, column_id: c.column_id, sort: c.sort, z: c.z });
            if (c.column_id && cs[c.column_id]) {
              const r = rects.current.get(id);
              lifted[id] = { ...c, column_id: null, x: r?.x ?? c.x, y: r?.y ?? c.y, w: r?.w ?? c.w, z: ++z };
            } else if (!allOnTop) lifted[id] = { ...c, z: ++z };
          }
          if (Object.keys(lifted).length) setCards((p) => ({ ...p, ...lifted }));
          const start = new Map(ids.map((id) => [id, lifted[id] ? { x: lifted[id].x, y: lifted[id].y } : { x: cs[id].x, y: cs[id].y }]));
          gesture.current = { type: 'drag', ids, origin, start, sx: g.sx, sy: g.sy, hasColumn: ids.some((id) => cs[id].type === 'column') };
          setDragIds(new Set(ids));
          setEditing(null);
        } else if (g.type === 'drag') {
          const dx = (ev.clientX - g.sx) / s;
          const dy = (ev.clientY - g.sy) / s;
          setCards((p) => {
            const n = { ...p };
            for (const id of g.ids) if (n[id]) n[id] = { ...n[id], x: Math.round(g.start.get(id).x + dx), y: Math.round(g.start.get(id).y + dy) };
            return n;
          });
          const h = findHint(ev.clientX, ev.clientY, new Set(g.ids), { columnsOk: !g.hasColumn });
          g.hint = h;
          setHint(h);
        } else if (g.type === 'tool') {
          if (!g.moved && Math.hypot(ev.clientX - g.sx, ev.clientY - g.sy) < 5) return;
          g.moved = true;
          setGhost({ kind: g.kind, x: ev.clientX, y: ev.clientY });
          const h = findHint(ev.clientX, ev.clientY, EMPTY, { columnsOk: g.kind !== 'column' });
          g.hint = h?.columnId ? h : null;
          setHint(g.hint);
        }
      };

      const up = (ev) => {
        canvasRef.current?.classList.remove('gesturing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const g = gesture.current;
        gesture.current = null;
        if (!g) return;
        if (ev.type === 'pointercancel' && g.type === 'tool') {
          setGhost(null);
          setHint(null);
          return;
        }
        if (g.type === 'pan' && g.menu && Math.hypot(ev.clientX - g.sx, ev.clientY - g.sy) < 4) {
          openMenuRef.current(ev.clientX, ev.clientY, g.target);
        } else if (g.type === 'resize' && g.w && g.w !== g.w0) {
          patchCards([{ id: g.id, w: g.w }], () => patchCards([{ id: g.id, w: g.w0 }]));
        } else if (g.type === 'arrow') {
          setTempArrow(null);
          const target = document.elementsFromPoint(ev.clientX, ev.clientY).map((el) => el.closest('[data-card-id]')).find(Boolean);
          const to = target?.dataset.cardId;
          if (to && to !== g.from) createArrow(g.from, to);
        } else if (g.type === 'box') {
          setBox(null);
        } else if (g.type === 'drag') {
          setDragIds(EMPTY);
          setHint(null);
          const cs = S.current.cards;
          const h = g.hint;
          const back = g.ids.map((id) => ({ id, board_id: boardId, ...g.origin.get(id) }));
          if (h?.columnId) {
            let lo = h.before;
            const patches = g.ids.map((id, i) => {
              const sort = sortBetween(lo, h.after);
              lo = sort;
              return { id, column_id: h.columnId, sort };
            });
            patchCards(patches, () => patchCards(back));
          } else if (h?.boardId) {
            patchCards(
              g.ids.map((id, i) => ({ id, board_id: h.boardId, column_id: null, x: 40 + i * 24, y: 40 + i * 24 })),
              () => patchCards(back)
            );
            notify(`Moved ${g.ids.length} card${g.ids.length > 1 ? 's' : ''}`);
          } else {
            patchCards(
              g.ids.map((id) => ({ id, x: cs[id].x, y: cs[id].y, z: cs[id].z, column_id: null })),
              () => patchCards(back.map(({ board_id, ...rest }) => rest))
            );
          }
        } else if (g.type === 'tool') {
          setGhost(null);
          setHint(null);
          const over = document.elementsFromPoint(ev.clientX, ev.clientY).some((el) => el === canvasRef.current);
          if (!g.moved) {
            const c = centerWorld();
            addTool(g.kind, { x: Math.round(c.x - DEFAULT_W[g.kind] / 2), y: Math.round(c.y - 60) });
          } else if (over) {
            const w = toWorld(ev.clientX, ev.clientY);
            const at = { x: Math.round(w.x - 20), y: Math.round(w.y - 20) };
            if (g.hint?.columnId) Object.assign(at, { column_id: g.hint.columnId, sort: sortBetween(g.hint.before, g.hint.after) });
            addTool(g.kind, at);
          }
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
  };

  // ---------- touch: one finger pans, two pinch, hold picks up a card ----------
  const touches = useRef(new Map());
  const touchG = useRef(null);
  const lastTap = useRef(null);
  const lastPointerType = useRef('mouse');
  const touchDownRef = useRef(null);
  touchDownRef.current = (e) => {
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = touchG.current;
    if (touches.current.size >= 2) {
      if (cur?.handedOff || touches.current.size > 2) return;
      clearTimeout(cur?.timer);
      if (cur?.el) delete cur.el.dataset.lift;
      const [a, b] = [...touches.current.values()];
      touchG.current = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: S.current.view };
      return;
    }
    const t = e.target;
    if (t.closest('input, textarea, select, button, a, [contenteditable="true"], .float-bar, .format-bar, .ctx-menu')) {
      touchG.current = null;
      return;
    }
    if (t.closest('.tag-chip')) {
      touchG.current = null;
      window.dispatchEvent(new CustomEvent('zb:search', { detail: { tag: t.closest('.tag-chip').dataset.tag } }));
      return;
    }
    const base = { id: e.pointerId, sx: e.clientX, sy: e.clientY };
    const arrowEl = t.closest('[data-arrow-id]');
    const cardEl = t.closest('[data-card-id]');
    if (arrowEl) {
      setSelArrow(arrowEl.dataset.arrowId);
      setSel(EMPTY);
      touchG.current = null;
    } else if (cardEl) {
      const id = cardEl.dataset.cardId;
      if (S.current.editing === id) return (touchG.current = null);
      // Holding: the card swells a little with a growing wobble; when it comes free, a big cartoon
      // shake (styles.css, [data-lift]). Cleared when the finger lifts or the touch turns into a pan.
      const g = { ...base, type: 'hold-card', card: id, el: cardEl };
      cardEl.dataset.lift = 'hold';
      g.timer = setTimeout(() => {
        if (touchG.current !== g) return;
        g.handedOff = true;
        cardEl.dataset.lift = 'pop';
        navigator.vibrate?.(15);
        setSel(new Set([id]));
        if (S.current.editing) document.activeElement?.blur?.();
        const p = touches.current.get(e.pointerId) || { x: base.sx, y: base.sy };
        beginRef.current({ type: 'maybe-drag', ids: [id], sx: p.x, sy: p.y });
      }, 280);
      touchG.current = g;
    } else {
      const g = { ...base, type: 'hold-empty' };
      g.timer = setTimeout(() => {
        if (touchG.current !== g) return;
        g.fired = true;
        navigator.vibrate?.(15);
        openMenuRef.current(e.clientX, e.clientY, null);
      }, 550);
      touchG.current = g;
    }
  };

  useEffect(() => {
    const move = (e) => {
      if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = touchG.current;
      if (!g || g.handedOff) return;
      if (g.type === 'pinch') {
        if (touches.current.size < 2) return;
        const [a, b] = [...touches.current.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const r = canvasRef.current.getBoundingClientRect();
        const v0 = g.v0;
        const s = clamp((v0.s * d) / g.d0, MIN_S, MAX_S);
        const wx = (g.m0.x - r.left - v0.x) / v0.s;
        const wy = (g.m0.y - r.top - v0.y) / v0.s;
        setView({ s, x: m.x - r.left - wx * s, y: m.y - r.top - wy * s });
        return;
      }
      if (e.pointerId !== g.id) return;
      if (g.type === 'hold-card' || g.type === 'hold-empty') {
        // A quick swipe pans, even when it starts on a card.
        if (!g.fired && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) {
          clearTimeout(g.timer);
          if (g.el) delete g.el.dataset.lift;
          const v = S.current.view;
          touchG.current = { type: 'pan', id: g.id, sx: g.sx, sy: g.sy, vx: v.x, vy: v.y };
          setView((vv) => ({ ...vv, x: v.x + e.clientX - g.sx, y: v.y + e.clientY - g.sy }));
        }
        return;
      }
      if (g.type === 'pan') setView((v) => ({ ...v, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy }));
    };
    const up = (e) => {
      if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return;
      touches.current.delete(e.pointerId);
      const g = touchG.current;
      if (!g) return;
      if (g.type === 'pinch') {
        const rest = [...touches.current.entries()];
        if (rest.length === 1) {
          const [id, p] = rest[0];
          const v = S.current.view;
          touchG.current = { type: 'pan', id, sx: p.x, sy: p.y, vx: v.x, vy: v.y };
        } else if (!rest.length) touchG.current = null;
        return;
      }
      if (e.pointerId !== g.id) return;
      clearTimeout(g.timer);
      if (g.el) delete g.el.dataset.lift;
      touchG.current = null;
      if (g.handedOff || g.fired || g.type === 'pan' || e.type === 'pointercancel') return;
      if (g.type === 'hold-card') {
        const now = Date.now();
        const lt = lastTap.current;
        if (lt && lt.id === g.card && now - lt.t < 350) {
          lastTap.current = null;
          const c = S.current.cards[g.card];
          if (c && (c.type === 'board' || c.type === 'image' || c.type === 'file' || c.type === 'drawing' || (c.type === 'link' && c.data.url))) openCard(c);
          else if (c) startEdit(c.id);
        } else {
          lastTap.current = { id: g.card, t: now };
          // Hold the action bar back for the double-tap window: a second tap that opens the card
          // then doesn't flip the bottom bar to the card's actions and straight back again.
          setPanelHold(true);
          clearTimeout(panelHoldTimer.current);
          panelHoldTimer.current = setTimeout(() => setPanelHold(false), 350);
          setSel(new Set([g.card]));
          setSelArrow(null);
          if (S.current.editing && S.current.editing !== g.card) document.activeElement?.blur?.();
        }
      } else if (g.type === 'hold-empty') {
        if (S.current.editing) document.activeElement?.blur?.();
        setSel(EMPTY);
        setSelArrow(null);
        setColorOpen(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [openCard, startEdit]);

  const onToolDown = (kind, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    beginRef.current({ type: 'tool', kind, sx: e.clientX, sy: e.clientY, moved: false });
  };

  const onDoubleClick = useCallback(
    (e) => {
      if (lastPointerType.current === 'touch') return; // double-tap is handled by the touch code
      const el = e.target.closest('[data-card-id]');
      if (el) {
        const c = S.current.cards[el.dataset.cardId];
        if (!c || S.current.editing === c.id) return;
        if (e.target.closest('input, textarea, button, a')) return;
        if (c.type === 'board' && e.target.closest('.board-title')) startEdit(c.id); // double-click the name to rename
        else if (c.type === 'board' || c.type === 'image' || c.type === 'file' || c.type === 'drawing') openCard(c);
        else if (c.type === 'link' && c.data.url) openCard(c);
        else startEdit(c.id);
        return;
      }
      const ar = e.target.closest('[data-arrow-id]');
      if (ar) {
        setSelArrow(ar.dataset.arrowId);
        setArrowLabel(true);
        setTimeout(() => document.querySelector('.item-actions [aria-label="Label"]')?.click(), 0);
      }
    },
    [openCard, startEdit, applyArrows, notify]
  );

  // ---------- keyboard, paste, drop ----------
  const clipEventAt = useRef(0);
  // Where pasted things go: under the pointer if it is over the board, else the middle of the screen.
  const pointerWorld = useCallback(() => {
    const p = pointer.current;
    const r = canvasRef.current.getBoundingClientRect();
    const inside = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    return inside ? toWorld(p.x, p.y) : centerWorld();
  }, [toWorld, centerWorld]);

  useEffect(() => {
    const down = (e) => {
      if (S.current.drawing) return; // the drawing layer has its own keys
      const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
      if (reader) return; // the reader has its own keys
      if (e.key === 'Escape') {
        if (lightbox) return setLightbox(null);
        if (typing) {
          e.target.blur();
          setEditing(null);
        } else {
          setSel(EMPTY);
          setSelArrow(null);
          setColorOpen(false);
        }
        return;
      }
      if (typing || lightbox) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { sel, selArrow, cards } = S.current;
      if (e.key === ' ') {
        space.current = true;
        canvasRef.current?.classList.add('panning');
        e.preventDefault();
      } else if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        selectAll();
      } else if (mod && (key === 'c' || key === 'x' || key === 'v')) {
        // The copy/cut/paste events below do the work; this is the fallback if the browser sends none.
        const t = Date.now();
        setTimeout(() => {
          if (clipEventAt.current >= t) return;
          if (key === 'v') {
            const clip = readClip();
            if (clip) pasteClip(clip, pointerWorld());
          } else if (sel.size) copySelection(key === 'x');
        }, 80);
      } else if (mod && key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selArrow) deleteArrow(selArrow);
        else if (sel.size) deleteCards([...sel]);
      } else if (e.key === 'Enter' && sel.size === 1) {
        e.preventDefault();
        startEdit([...sel][0]);
      } else if (!mod && (e.key === '+' || e.key === '=')) zoomCenter(1.25);
      else if (!mod && (e.key === '-' || e.key === '_')) zoomCenter(0.8);
      else if (!mod && e.key === '0') zoomCenter(1 / S.current.view.s);
      else if (!mod && e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        fitAll();
      }
    };
    const upKey = (e) => {
      if (e.key === ' ') {
        space.current = false;
        canvasRef.current?.classList.remove('panning');
      }
    };
    const copyOrCut = (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable="true"]') || !S.current.sel.size) return;
      clipEventAt.current = Date.now();
      const clip = copySelection(e.type === 'cut');
      if (!clip) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', clip.text || ' ');
      e.clipboardData.setData(CLIP_TYPE, JSON.stringify(clip));
    };
    const paste = (e) => {
      if (S.current.drawing || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      const dt = e.clipboardData;
      if (!dt) return;
      clipEventAt.current = Date.now();
      const at = pointerWorld();
      // Cards copied in ZBoard (this tab or another): our own format, or our plain text echo.
      let clip = null;
      try {
        clip = JSON.parse(dt.getData(CLIP_TYPE) || 'null');
      } catch {}
      const stored = readClip();
      const plainText = dt.getData('text/plain');
      if (!clip?.zboard && stored && (plainText === stored.text || (!plainText && !dt.files.length))) clip = stored;
      if (clip?.zboard) {
        e.preventDefault();
        pasteClip(clip, at);
        return;
      }
      const files = [...dt.files];
      if (files.length) {
        e.preventDefault();
        addImages(files, at);
        return;
      }
      const text = dt.getData('text/plain');
      if (!text?.trim()) return;
      e.preventDefault();
      if (isUrl(text)) addLink(text.trim(), at);
      else addText(text, at);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', upKey);
    window.addEventListener('paste', paste);
    window.addEventListener('copy', copyOrCut);
    window.addEventListener('cut', copyOrCut);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', upKey);
      window.removeEventListener('paste', paste);
      window.removeEventListener('copy', copyOrCut);
      window.removeEventListener('cut', copyOrCut);
    };
  }, [lightbox, reader, undo, duplicate, deleteArrow, deleteCards, startEdit, zoomCenter, fitAll, selectAll, copySelection, pasteClip, pointerWorld, addImages, addLink, addText]);

  const onDragOver = (e) => {
    const types = [...e.dataTransfer.types];
    if (types.includes(CLIP_DRAG_TYPE) || types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html') || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e) => {
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const dt = e.dataTransfer;
    const clipId = dt.getData(CLIP_DRAG_TYPE);
    if (clipId) return placeClip(clipId, { x: at.x - 40, y: at.y - 30 });
    if (dt.files.length) return addImages(dt.files, at);
    const html = dt.getData('text/html');
    const imgEl = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img');
    const img = imgEl?.getAttribute('src');
    if (img && /^https?:/i.test(img)) {
      // Keep the alt text, and the page link when the image was inside one.
      const href = imgEl.closest('a')?.getAttribute('href');
      return addImageUrl(img, at, { alt: imgEl.getAttribute('alt') || null, source_url: href && /^https?:/i.test(href) ? href : null });
    }
    const uri = (dt.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
    const text = uri || dt.getData('text/plain');
    if (!text) return;
    if (isUrl(text) && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(text)) addImageUrl(text.trim(), at);
    else if (isUrl(text)) addLink(text.trim(), at);
    else addText(text, at);
  };

  // ---------- rendering ----------
  const { topCards, kidsOf } = useMemo(() => {
    const all = Object.values(cards);
    const kidsOf = new Map();
    const topCards = [];
    for (const c of all) {
      if (c.column_id && cards[c.column_id]) {
        if (!kidsOf.has(c.column_id)) kidsOf.set(c.column_id, []);
        kidsOf.get(c.column_id).push(c);
      } else topCards.push(c);
    }
    for (const list of kidsOf.values()) list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    topCards.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    return { topCards, kidsOf };
  }, [cards]);

  // Big boards render only cards near the screen. The window snaps to 600-screen-px tiles,
  // so panning re-renders the card layer only when it crosses a tile edge.
  const CULL_AFTER = 150;
  const TILE = 600;
  let cullKey = 'all';
  if (topCards.length > CULL_AFTER) {
    // Tiles are sized for the zoom rounded down to a power of two, so zooming only changes the set
    // of rendered cards when an edge crosses a tile or the zoom passes a doubling, not every step.
    const tile = TILE / 2 ** Math.floor(Math.log2(view.s));
    const i0 = Math.floor(-view.x / view.s / tile) - 1;
    const j0 = Math.floor(-view.y / view.s / tile) - 1;
    const i1 = Math.ceil((canvasSize.w - view.x) / view.s / tile) + 1;
    const j1 = Math.ceil((canvasSize.h - view.y) / view.s / tile) + 1;
    cullKey = `${tile.toFixed(4)}:${i0}:${j0}:${i1}:${j1}`;
  }
  const shown = useMemo(() => {
    if (cullKey === 'all') return topCards;
    const [tile, i0, j0, i1, j1] = cullKey.split(':').map(Number);
    const x0 = i0 * tile;
    const y0 = j0 * tile;
    const x1 = i1 * tile;
    const y1 = j1 * tile;
    return topCards.filter((c) => {
      if (sel.has(c.id) || editing === c.id || dragIds.has(c.id)) return true;
      const r = rects.current.get(c.id) || { x: c.x, y: c.y, w: c.w || DEFAULT_W[c.type], h: 320 };
      return r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0;
    });
  }, [topCards, cullKey, sel, editing, dragIds]);

  // Far out, images load the 256 px mini instead of the 800 px thumbnail.
  // Swapping every image between thumbnail and mini mid-zoom reloads hundreds at once (measured:
  // switching on the way out doubled the worst zoom frame), so the switch waits for the zoom to settle.
  // Image size by zoom: 800 px thumbnail, 256 px mini below 45%, 96 px micro below 20%.
  const sizeFor = (s) => (s < 0.2 ? 'micro' : s < 0.45 ? 'mini' : 'thumb');
  const lowRes = sizeFor(settledS);
  const lowResNow = sizeFor(view.s); // for cards that appear mid-zoom: right size straight away
  // Very far out on a big board, the board is shown as one picture (see FarSnapshot.jsx).
  const snap = settledS < 0.2 && topCards.length > CULL_AFTER && !drawing;
  const snapSkip = useMemo(() => new Set([...sel, ...dragIds, editing].filter(Boolean)), [sel, dragIds, editing]);

  // Watch card sizes. Keyed on which cards are rendered, not their positions, so a drag
  // does not re-subscribe every card on every mouse move.
  const shownKey = useMemo(() => shown.map((c) => c.id).join(',') + '|' + [...kidsOf.values()].flat().map((c) => c.id).join(','), [shown, kidsOf]);
  useEffect(() => {
    const ro = new ResizeObserver(scheduleMeasure);
    for (const el of worldRef.current.querySelectorAll('[data-card-id]')) ro.observe(el);
    return () => ro.disconnect();
  }, [shownKey, scheduleMeasure]);

  const cardLayer = useMemo(
    () =>
      shown.map((c) =>
        c.type === 'column' ? (
          <CardView
            key={c.id}
            card={c}
            selected={sel.has(c.id)}
            editing={editing === c.id}
            dragging={dragIds.has(c.id)}
            actions={actions}
            kids={kidsOf.get(c.id) || []}
            sel={sel}
            editingId={editing}
            files={files}
            dragIds={dragIds}
            dropIndex={hint?.columnId === c.id ? hint.index : null}
            cut={cutIds.has(c.id)}
            cutIds={cutIds}
            lowRes={lowRes}
            lowResNow={lowResNow}
            settledS={settledS}
          />
        ) : (
          <CardView
            key={c.id}
            card={c}
            selected={sel.has(c.id)}
            editing={editing === c.id}
            dragging={dragIds.has(c.id)}
            cut={cutIds.has(c.id)}
            actions={actions}
            file={files[c.data.fileId]}
            lowRes={lowRes}
            lowResNow={lowResNow}
            settledS={settledS}
            hidden={drawing?.cardId === c.id}
          />
        )
      ),
    [shown, kidsOf, sel, editing, dragIds, cutIds, actions, files, hint, lowRes, lowResNow, settledS, drawing?.cardId]
  );

  const arrowLayer = useMemo(() => {
    const items = [];
    for (const a of Object.values(arrows)) {
      const r1 = rects.current.get(a.from_card);
      const r2 = rects.current.get(a.to_card);
      if (!r1 || !r2) continue;
      const p1 = edgePoint(r1, r2.x + r2.w / 2, r2.y + r2.h / 2);
      const p2 = edgePoint(r2, r1.x + r1.w / 2, r1.y + r1.h / 2);
      items.push({ a, p1, p2, st: arrowStyle(a) });
    }
    let temp = null;
    if (tempArrow) {
      const r = rects.current.get(tempArrow.from);
      if (r) temp = { p1: edgePoint(r, tempArrow.x, tempArrow.y), p2: tempArrow };
    }
    return (
      <svg className="arrows" width="1" height="1">
        <defs>
          <marker id="zb-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="context-stroke" />
          </marker>
        </defs>
        {items.map(({ a, p1, p2, st }) => (
          <g key={a.id} data-arrow-id={a.id} className={selArrow === a.id ? 'arrow selected' : 'arrow'}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="arrow-hit" />
            {selArrow === a.id && <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="arrow-glow" style={{ strokeWidth: st.width + 8 }} />}
            <line
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              className="arrow-line"
              style={{ stroke: a.color || undefined, strokeWidth: st.width }}
              strokeDasharray={st.dashed ? `${st.width * 4} ${st.width * 3}` : undefined}
              markerEnd={st.end ? 'url(#zb-head)' : undefined}
              markerStart={st.start ? 'url(#zb-head)' : undefined}
            />
            {a.label && (
              <text x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 6} className="arrow-label" textAnchor="middle">
                {a.label}
              </text>
            )}
          </g>
        ))}
        {temp && <line x1={temp.p1.x} y1={temp.p1.y} x2={temp.p2.x} y2={temp.p2.y} className="arrow-line temp" markerEnd="url(#zb-head)" />}
      </svg>
    );
  }, [arrows, rectsVersion, tempArrow, selArrow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow bar floats above the selected arrow's middle.
  const selA = selArrow ? arrows[selArrow] : null;
  let arrowBar = null;
  if (selA && rects.current.get(selA.from_card) && rects.current.get(selA.to_card)) {
    const r1 = rects.current.get(selA.from_card);
    const r2 = rects.current.get(selA.to_card);
    const p1 = edgePoint(r1, r2.x + r2.w / 2, r2.y + r2.h / 2);
    const p2 = edgePoint(r2, r1.x + r1.w / 2, r1.y + r1.h / 2);
    arrowBar = {
      a: selA,
      st: arrowStyle(selA),
      x: clamp(((p1.x + p2.x) / 2) * view.s + view.x, 160, Math.max(160, canvasSize.w - 160)),
      y: Math.max(56, ((p1.y + p2.y) / 2) * view.s + view.y - 14),
    };
  }

  // Cover picker sits under its board card, kept on screen.
  const coverCard = coverFor && cards[coverFor]?.child?.id ? cards[coverFor] : null;
  let coverAt = null;
  if (coverCard) {
    const r = rectOf(coverCard);
    coverAt = {
      x: clamp(r.x * view.s + view.x, 8, Math.max(8, canvasSize.w - 300)),
      y: clamp((r.y + r.h) * view.s + view.y + 8, 8, Math.max(8, canvasSize.h - 420)),
    };
  }

  // Screen box around the selection, for the floating toolbar and the format bar.
  let selBox = null;
  if (sel.size && !dragIds.size && !box) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    for (const id of sel) {
      const r = rects.current.get(id);
      if (!r) continue;
      x1 = Math.min(x1, r.x);
      y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w);
    }
    if (x1 !== Infinity) {
      // Keep the floating bars on screen (they are up to ~240 px wide).
      const cw = canvasRef.current?.clientWidth || 1000;
      selBox = { x: clamp(((x1 + x2) / 2) * view.s + view.x, 124, Math.max(124, cw - 124)), y: Math.max(56, y1 * view.s + view.y) };
    }
  }
  const single = sel.size === 1 ? cards[[...sel][0]] : null;
  const editingNote = editing && cards[editing]?.type === 'note';

  const fmt = (cmd, arg) => (e) => {
    e.preventDefault();
    if (cmd === 'heading') {
      const cur = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, cur === 'h3' ? 'div' : 'h3');
    } else document.execCommand(cmd, false, arg);
  };

  // ---------- action panel (left toolbar flips to the selection's actions) ----------
  const actionsOn = !drawing && !panelHold && (sel.size > 0 || !!arrowBar);
  const openPop = (kind) => (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = wrapRef.current.getBoundingClientRect();
    setPop((p) => (p?.kind === kind ? null : { kind, top: Math.max(8, r.top - w.top), left: r.right - w.left + 8, bottom: w.bottom - r.top + 8 }));
  };
  const act = (label, icon, onClick, extra = {}) => (
    <button key={label} className={'tool act' + (extra.on ? ' on' : '') + (extra.pop && pop?.kind === extra.pop ? ' open' : '')} onClick={onClick} data-tip={extra.tip || label} aria-label={extra.aria || label} aria-pressed={extra.pressed}>
      {typeof icon === 'string' ? <Icon name={icon} size={22} /> : icon}
      <span>{label}</span>
    </button>
  );
  const selCards = [...sel].map((id) => cards[id]).filter(Boolean);
  const labelState = {};
  for (const c of selCards) for (const l of c.data.labels || []) labelState[l] = (labelState[l] || 0) + 1;
  for (const l of Object.keys(labelState)) labelState[l] = labelState[l] === selCards.length ? 'all' : 'some';

  function panelButtons() {
    const back = act('Done', 'chevronLeft', () => {
      setSel(EMPTY);
      setSelArrow(null);
    }, { tip: 'Done (Esc)' });
    if (arrowBar) {
      const { a, st } = arrowBar;
      return [
        back,
        act('Color', <span className="arrow-color-dot" style={{ background: a.color || '#8a867c' }} />, openPop('arrowColor'), { aria: 'Arrow colour', pop: 'arrowColor' }),
        act('Start', 'arrowStart', () => patchArrow(a.id, { data: { start: !st.start } }), { on: st.start, pressed: st.start, aria: 'Start arrowhead', tip: 'Arrowhead at start' }),
        act('End', 'arrowEnd', () => patchArrow(a.id, { data: { end: !st.end } }), { on: st.end, pressed: st.end, aria: 'End arrowhead', tip: 'Arrowhead at end' }),
        act('Label', 'label', openPop('arrowLabel'), { aria: 'Label', pop: 'arrowLabel', tip: 'Label (or double-click the arrow)' }),
        act('Dashed', 'dashed', () => patchArrow(a.id, { data: { dashed: !st.dashed } }), { on: st.dashed, pressed: st.dashed }),
        act(
          'Weight',
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <line x1="3" y1="11" x2="19" y2="11" stroke="currentColor" strokeWidth={st.width + 0.5} strokeLinecap="round" />
          </svg>,
          () => patchArrow(a.id, { data: { weight: (st.weight % 3) + 1 } }),
          { tip: `Weight: ${['thin', 'normal', 'thick'][st.weight - 1]} (click to change)` }
        ),
        act('Delete', 'trash', () => deleteArrow(a.id), { aria: 'Delete arrow', tip: 'Delete (Del)' }),
      ];
    }
    const out = [back];
    const t = single?.type;
    if (single) {
      if (t === 'board') out.push(act('Open', 'open', () => openCard(single)), act('Cover', 'image', () => setCoverFor((f) => (f ? null : single.id)), { tip: 'Cover: icon, text and colour' }));
      else if (t === 'link') out.push(act('Open', 'open', () => openCard(single)), act('Edit', 'edit', () => startEdit(single.id), { aria: 'Edit link', tip: 'Edit link (Enter)' }));
      else if (t === 'image') {
        if (!single.column_id) out.push(act('Draw on', 'draw', () => openInk(single), { aria: 'Draw on image', tip: 'Draw on image' }));
        out.push(act('Edit', 'crop', () => setImgEdit(single.id), { aria: 'Edit image', tip: 'Crop and rotate' }), act('Caption', 'caption', () => actions.editCard(single.id), { tip: 'Caption (searchable)' }));
      } else if (t === 'file') {
        const pdf = isPdf(files[single.data.fileId]);
        out.push(act(pdf ? 'Read' : 'Download', pdf ? 'open' : 'download', () => openCard(single), { tip: pdf ? 'Read (double-click)' : 'Download' }), act('Caption', 'caption', () => actions.editCard(single.id), { tip: 'Caption (searchable)' }));
      } else if (t === 'drawing') out.push(act('Edit', 'draw', () => openDrawing(single), { aria: 'Edit drawing', tip: 'Edit drawing (double-click)' }));
      else out.push(act('Edit', 'edit', () => startEdit(single.id), { tip: 'Edit (Enter)' }));
    }
    if (!selCards.every((c) => c.type === 'drawing' || c.type === 'color')) out.push(act('Color', 'palette', openPop('color'), { aria: 'Colour', pop: 'color', tip: 'Colour' }));
    out.push(act('Labels', 'tag', openPop('labels'), { pop: 'labels', tip: 'Labels (searchable)' }));
    if (selCards.filter((c) => !c.column_id).length > 1) out.push(act('Arrange', 'grid', arrangeGrid, { aria: 'Arrange in a grid', tip: 'Arrange in a tidy grid' }));
    out.push(act('More', 'dots', openPop('more'), { pop: 'more', aria: 'More actions', tip: 'More' }));
    return out;
  }

  function popContent() {
    const close = () => setPop(null);
    const row = (label, icon, onClick, extra = {}) =>
      extra.href ? (
        <a key={label} className="pop-row" href={extra.href} download={extra.download} onClick={close}>
          <Icon name={icon} size={16} />
          {label}
        </a>
      ) : (
        <button
          key={label}
          className={'pop-row' + (extra.danger ? ' danger' : '')}
          onClick={() => {
            close();
            onClick();
          }}
        >
          <Icon name={icon} size={16} />
          {label}
          {extra.keys && <kbd>{extra.keys}</kbd>}
        </button>
      );
    if (pop.kind === 'addMore')
      return (
        <div className="pop-menu">
          {TOOLS.filter((t) => t.extra).map((t) =>
            row(t.label, t.icon, () => {
              const c = centerWorld();
              addTool(t.kind, { x: Math.round(c.x - DEFAULT_W[t.kind] / 2), y: Math.round(c.y - 60) });
            })
          )}
        </div>
      );
    if (pop.kind === 'color')
      return (
        <ColorPicker
          bg={single?.color ?? null}
          strip={single?.data.strip ?? null}
          showStrip={!selCards.every((c) => c.type === 'board')}
          onBg={(c) => setColor(c)}
          onStrip={(c) => setStrip(c)}
        />
      );
    if (pop.kind === 'labels') return <LabelPicker current={labelState} onToggle={toggleLabel} onClose={close} />;
    if (pop.kind === 'arrowColor' && arrowBar)
      return (
        <div className="pop-swatches">
          {ARROW_COLORS.map((c) => (
            <button
              key={c || 'default'}
              className={'swatch' + ((arrowBar.a.color || null) === c ? ' on' : '')}
              style={{ background: c || '#8a867c' }}
              onClick={() => {
                patchArrow(arrowBar.a.id, { color: c });
                close();
              }}
              data-tip={c ? c : 'Default grey'}
              aria-label={'Arrow colour ' + (c || 'default')}
            />
          ))}
        </div>
      );
    if (pop.kind === 'arrowLabel' && arrowBar) return arrowLabelInput(close);
    if (pop.kind === 'more') {
      const ids = [...sel];
      const rows = [];
      if (single?.type === 'image') {
        const f = files[single.data.fileId];
        rows.push(
          row('Open full size', 'open', () => openCard(single)),
          row('Download original', 'download', null, { href: `/files/${single.data.fileId}?original=1`, download: f?.name || 'image' }),
          row('Pick a colour…', 'eyedropper', () => pickColourFrom(single)),
          row('Replace image…', 'replace', () => {
            replaceFor.current = single.id;
            replaceInput.current.click();
          })
        );
      }
      if (single?.type === 'file') {
        const f = files[single.data.fileId];
        if (isPdf(f)) rows.push(row('Read', 'open', () => openCard(single)));
        rows.push(row('Download', 'download', null, { href: fileUrl(single.data.fileId), download: f?.name || 'file' }));
      }
      rows.push(
        row('Duplicate', 'duplicate', () => duplicate(ids), { keys: 'Ctrl+D' }),
        row('Copy', 'copy', () => {
          const c = copySelection(false, ids);
          if (c) toSystemClipboard(c);
        }, { keys: 'Ctrl+C' }),
        row('Bring to front', 'front', () => bringToFront(ids)),
        row('Send to back', 'back', () => sendToBack(ids)),
        row('Delete', 'trash', () => deleteCards(ids), { danger: true, keys: 'Del' })
      );
      return <div className="pop-menu">{rows}</div>;
    }
    return null;
  }

  function arrowLabelInput(close) {
    const a = arrowBar.a;
    return (
      <input
        className="arrow-label-input"
        autoFocus
        placeholder="Label"
        defaultValue={a.label || ''}
        aria-label="Arrow label"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') {
            e.target.value = a.label || '';
            e.target.blur();
          }
        }}
        onBlur={(e) => {
          const label = e.target.value.trim() || null;
          if (label !== (a.label || null)) patchArrow(a.id, { label });
          setArrowLabel(false);
          close();
        }}
      />
    );
  }

  const gridSize = GRID * view.s;
  return (
    <div className="board-wrap" ref={wrapRef}>
      <aside className={actionsOn ? 'toolbar show-actions' : 'toolbar'}>
        <div className="tb-panel tb-tools" aria-hidden={actionsOn || undefined}>
          {TOOLS.map((t) => (
            <button key={t.kind} className={t.extra ? 'tool tool-extra' : 'tool'} onPointerDown={(e) => onToolDown(t.kind, e)} data-tip={`${t.label} — click or drag`} aria-label={t.label} tabIndex={actionsOn ? -1 : undefined}>
              <Icon name={t.icon} size={22} />
              <span>{t.label}</span>
            </button>
          ))}
          <button className="tool" onClick={() => openDrawing(null)} data-tip="Draw (pen, mouse or finger)" aria-label="Draw" tabIndex={actionsOn ? -1 : undefined}>
            <Icon name="draw" size={22} />
            <span>Draw</span>
          </button>
          <button className="tool tool-camera" onClick={() => cameraInput.current.click()} data-tip="Take a photo" aria-label="Camera" tabIndex={actionsOn ? -1 : undefined}>
            <Icon name="camera" size={22} />
            <span>Camera</span>
          </button>
          <div className="tool-sep" />
          <button className="tool" onClick={undo} data-tip="Undo (Ctrl+Z)" aria-label="Undo" tabIndex={actionsOn ? -1 : undefined}>
            <Icon name="undo" size={22} />
            <span>Undo</span>
          </button>
          <button className={'tool tool-more' + (pop?.kind === 'addMore' ? ' open' : '')} onClick={openPop('addMore')} aria-label="More things to add" tabIndex={actionsOn ? -1 : undefined}>
            <Icon name="dots" size={22} />
            <span>More</span>
          </button>
        </div>
        <div className="tb-panel tb-actions item-actions" aria-label="Selected item actions">
          {actionsOn && panelButtons()}
        </div>
      </aside>
      <input
        ref={replaceInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          replaceImage(e.target.files);
          e.target.value = '';
        }}
      />
      {pop && (
        <div className="action-pop" style={{ '--pop-top': pop.top + 'px', '--pop-left': pop.left + 'px', '--pop-bottom': pop.bottom + 'px' }} onPointerDown={(e) => e.stopPropagation()}>
          {popContent()}
        </div>
      )}
      {imgEdit && cards[imgEdit] && (
        <ImageEditor
          fileId={cards[imgEdit].data.fileId}
          file={files[cards[imgEdit].data.fileId]}
          crop={cards[imgEdit].data.crop}
          rotate={cards[imgEdit].data.rotate}
          onClose={() => setImgEdit(null)}
          onSave={({ crop, rotate }) => {
            const c = cards[imgEdit];
            patchCards([{ id: c.id, data: { crop, rotate } }], () => patchCards([{ id: c.id, data: { crop: c.data.crop ?? null, rotate: c.data.rotate ?? 0 } }]));
            setImgEdit(null);
          }}
        />
      )}

      <div
        className={dragIds.size ? 'canvas moving' : 'canvas'}
        ref={canvasRef}
        style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className={snap ? 'world snap' : 'world'} ref={worldRef} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <FarSnapshot active={snap} scale={settledS} worldRef={worldRef} rects={rects} cards={cards} files={files} skip={snapSkip} version={rectsVersion} />
          {arrowLayer}
          {cardLayer}
          {uploads.map((u) => (
            <UploadCard
              key={u.key}
              u={{ ...u, id: u.key, status: u.error ? 'failed' : 'uploading', message: u.error }}
              onCancel={() => uploadAborts.current.get(u.key)?.()}
            />
          ))}
          {bigUploads
            .filter((u) => u.board_id === boardId)
            .map((u) => (
              <UploadCard
                key={u.id}
                u={u}
                onCancel={() => cancelUpload(u.id)}
                onRemove={() => cancelUpload(u.id)}
                onFailedTap={() => {
                  if (u.reason === 'space' && retryUpload(u.id)) return;
                  repickFor.current = u.id;
                  repickInput.current.click();
                }}
              />
            ))}
        </div>

        {loaded && !topCards.length && !uploads.length && !bigUploads.some((u) => u.board_id === boardId) && (
          <div className="empty-hint">
            Add a card from the left toolbar, drop images here, or paste a link.
          </div>
        )}

        {box && <div className="box-select" style={{ left: box.x1 - canvasRef.current.getBoundingClientRect().left, top: box.y1 - canvasRef.current.getBoundingClientRect().top, width: box.x2 - box.x1, height: box.y2 - box.y1 }} />}

        {editingNote && selBox && (
          <div className="format-bar" style={{ left: selBox.x, top: selBox.y }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
            <button onMouseDown={fmt('bold')} data-tip="Bold (Ctrl+B)" aria-label="Bold">
              <Icon name="bold" size={16} />
            </button>
            <button onMouseDown={fmt('italic')} data-tip="Italic (Ctrl+I)" aria-label="Italic">
              <Icon name="italic" size={16} />
            </button>
            <button onMouseDown={fmt('underline')} data-tip="Underline (Ctrl+U)" aria-label="Underline">
              <Icon name="underline" size={16} />
            </button>
            <button onMouseDown={fmt('strikeThrough')} data-tip="Strikethrough" aria-label="Strikethrough">
              <Icon name="strike" size={16} />
            </button>
            <button onMouseDown={fmt('heading')} data-tip="Heading" aria-label="Heading">
              <Icon name="heading" size={16} />
            </button>
            <button onMouseDown={fmt('insertUnorderedList')} data-tip="Bullets" aria-label="Bullets">
              <Icon name="list" size={16} />
            </button>
          </div>
        )}

        {coverCard && (
          <div className="cover-anchor" style={{ left: coverAt.x, top: coverAt.y }}>
            <CoverPicker key={coverCard.id} cover={coverCard.child?.cover} title={coverCard.child?.title} onChange={(cv) => setCover(coverCard.id, cv)} onClose={() => setCoverFor(null)} />
          </div>
        )}

        {drawing && <DrawLayer key={drawing.cardId || 'new'} view={view} canvasRef={canvasRef} initial={drawing.strokes} frame={drawing.frame} onSave={saveDrawing} onCancel={() => setDrawing(null)} />}

        {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx)} onClose={closeMenu} />}

        <div className="zoom-ctl">
          <button className="icon-btn" onClick={() => zoomCenter(0.8)} data-tip="Zoom out (−)" aria-label="Zoom out">
            <Icon name="minus" size={16} />
          </button>
          <button className="zoom-pct" onClick={() => zoomCenter(1 / view.s)} data-tip="Reset to 100% (0)">
            {Math.round(view.s * 100)}%
          </button>
          <button className="icon-btn" onClick={() => zoomCenter(1.25)} data-tip="Zoom in (+)" aria-label="Zoom in">
            <Icon name="plus" size={16} />
          </button>
          <span className="zoom-sep" />
          <button className="icon-btn" onClick={fitAll} data-tip="Fit to screen (Shift+1)" aria-label="Fit to screen">
            <Icon name="fit" size={16} />
          </button>
        </div>
      </div>

      {ghost && (
        <div className="tool-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <Icon name={TOOLS.find((t) => t.kind === ghost.kind)?.icon} size={22} />
        </div>
      )}

      {savedOpen && (
        <SavedPanel
          clips={clips}
          boardId={boardId}
          boardTitles={Object.fromEntries(boardList.map((b) => [b.id, b.title]))}
          onPlace={(id) => {
            const c = centerWorld();
            placeClip(id, { x: c.x - 120, y: c.y - 80 });
          }}
          onDropAt={(id, cx, cy) => {
            const el = document.elementFromPoint(cx, cy);
            if (!el || !canvasRef.current?.contains(el)) return false;
            const at = toWorld(cx, cy);
            placeClip(id, { x: at.x - 40, y: at.y - 30 });
            return true;
          }}
          onDelete={deleteClip}
          onClose={onCloseSaved}
        />
      )}

      {reader && files[reader] && (
        <Suspense fallback={<div className="pdf-reader pdf-loading">Opening…</div>}>
          <PdfReader file={files[reader]} onClose={() => setReader(null)} />
        </Suspense>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <SafeImg src={`/files/${lightbox}`} alt="" />
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const c = centerWorld();
          addImages(e.target.files, { x: Math.round(c.x - 120), y: Math.round(c.y - 120) });
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const at = JSON.parse(e.target.dataset.at || 'null') || centerWorld();
          addImages(e.target.files, at);
          e.target.value = '';
        }}
      />
      {/* A file chosen for a failed upload card: the same file finishes it, another starts over there. */}
      <input
        ref={repickInput}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files[0];
          if (f && repickFor.current) repickUpload(repickFor.current, f).catch(notify);
          e.target.value = '';
        }}
      />
    </div>
  );
}
