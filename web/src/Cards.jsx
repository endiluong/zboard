import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_W, hostOf, sanitize, uid } from './util.js';
import { Icon } from './icons.jsx';
import { CoverTile } from './Cover.jsx';
import { strokePath } from './ink.js';
import { LabelChips } from './Labels.jsx';
import { rotatedImgStyle } from './ImageEditor.jsx';
import { inkFor } from './Cover.jsx';
import { colorName } from './colorNames.js';
import { isPdf } from './pdf.js';
import { formatDuration, isVideo } from './video.js';
import { formatBytes } from './Menu.jsx';

const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Card colour: the old named pastels ('yellow', …) are classes; a picked colour is a hex value.
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

// lowRes is 'thumb' | 'mini' | 'micro' (older code passed true/false).
const sizeName = (v) => (v === true ? 'mini' : v === false || !v ? 'thumb' : v);

// A picture that never shows the browser's broken-image icon. Until it has loaded it is invisible, so the
// card's own colour (and a soft shimmer, see styles.css) shows instead. A request that drops (a weak
// mobile signal) is tried again after 1, 3 and 10 s, then whenever the connection comes back or the app
// is opened again. Switching src (zooming swaps thumb ↔ mini) keeps the loaded picture visible.
const RETRY_MS = [1000, 3000, 10000];
export function SafeImg({ src, ...rest }) {
  const [st, setSt] = useState({ src, tries: 0, status: 'loading' });
  if (st.src !== src) setSt((p) => ({ src, tries: 0, status: p.status === 'loaded' ? 'loaded' : 'loading' }));
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el?.complete && el.naturalWidth > 0) setSt((p) => (p.status === 'loaded' ? p : { ...p, status: 'loaded' }));
  }, []);
  useEffect(() => {
    if (st.status !== 'failed') return;
    const again = () => setSt((p) => (p.status === 'failed' ? { ...p, tries: p.tries + 1, status: 'retry' } : p));
    if (st.tries < RETRY_MS.length) {
      const t = setTimeout(again, RETRY_MS[st.tries]);
      return () => clearTimeout(t);
    }
    const onVisible = () => document.visibilityState === 'visible' && again();
    addEventListener('online', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      removeEventListener('online', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [st.status, st.tries]);
  const url = st.tries ? `${src}${src.includes('?') ? '&' : '?'}r=${st.tries}` : src;
  return (
    <img
      ref={ref}
      src={url}
      data-img={st.status === 'loaded' ? 'loaded' : 'loading'}
      onLoad={() => setSt((p) => (p.status === 'loaded' ? p : { ...p, status: 'loaded' }))}
      onError={() => setSt((p) => ({ ...p, status: 'failed' }))}
      {...rest}
    />
  );
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

// Wrap #tags in text nodes (outside links) with clickable chips. Display only, never saved.
const TAG_RE = /(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_-]{1,50})/gu;
function decorateTags(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('#') && !walker.currentNode.parentElement.closest('a')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    TAG_RE.lastIndex = 0;
    if (!TAG_RE.test(text)) continue;
    TAG_RE.lastIndex = 0; // matchAll starts from lastIndex
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start));
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.tag = m[2].toLowerCase();
      chip.textContent = '#' + m[2];
      frag.append(chip);
      last = start + 1 + m[2].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function NoteBody({ card, editing, actions }) {
  const ref = useRef(null);
  const html = card.data.html || '';
  useLayoutEffect(() => {
    const el = ref.current;
    el.innerHTML = sanitize(html);
    if (editing) {
      el.focus();
      placeCaretAtEnd(el);
    } else {
      decorateTags(el);
    }
  }, [html, editing]);
  return (
    <div
      ref={ref}
      className="note-body rich"
      contentEditable={editing ? 'true' : 'false'}
      suppressContentEditableWarning
      data-placeholder="Write something…"
      onBlur={() => editing && actions.finishNote(card.id, sanitize(ref.current.innerHTML))}
    />
  );
}

function TodoBody({ card, editing, actions }) {
  const items = card.data.items || [];
  const focusNext = useRef(null);
  const titleRef = useRef(null);
  const save = (patch) => actions.saveData(card.id, patch);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);
  useLayoutEffect(() => {
    if (focusNext.current) {
      const el = document.querySelector(`[data-item-id="${focusNext.current}"]`);
      focusNext.current = null;
      el?.focus();
    }
  });

  function addAfter(index) {
    const item = { id: uid(), text: '', done: false };
    const next = [...items];
    next.splice(index + 1, 0, item);
    focusNext.current = item.id;
    save({ items: next });
  }

  return (
    <div className="todo-body">
      <input
        ref={titleRef}
        className="todo-title"
        placeholder="To-do list"
        defaultValue={card.data.title || ''}
        key={'t' + (card.data.title || '')}
        onBlur={(e) => {
          if (e.target.value !== (card.data.title || '')) save({ title: e.target.value });
          if (editing) actions.stopEdit(card.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items.length) document.querySelector(`[data-item-id="${items[0].id}"]`)?.focus();
            else addAfter(-1);
          }
        }}
      />
      <ul className="todo-items">
        {items.map((it, i) => (
          <li key={it.id} className={it.done ? 'done' : ''}>
            <input
              type="checkbox"
              checked={!!it.done}
              onChange={() => save({ items: items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) })}
              aria-label="Done"
            />
            <input
              className="todo-text"
              data-item-id={it.id}
              defaultValue={it.text}
              key={it.id + ':' + it.text}
              placeholder="Item"
              onBlur={(e) => {
                if (e.target.value !== it.text) save({ items: items.map((x) => (x.id === it.id ? { ...x, text: e.target.value } : x)) });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const text = e.target.value;
                  const next = items.map((x) => (x.id === it.id ? { ...x, text } : x));
                  const item = { id: uid(), text: '', done: false };
                  next.splice(i + 1, 0, item);
                  focusNext.current = item.id;
                  save({ items: next });
                } else if (e.key === 'Backspace' && !e.target.value) {
                  e.preventDefault();
                  focusNext.current = items[i - 1]?.id ?? null;
                  save({ items: items.filter((x) => x.id !== it.id) });
                }
              }}
            />
          </li>
        ))}
      </ul>
      <button className="todo-add" onClick={() => addAfter(items.length - 1)}>
        <Icon name="plus" size={14} /> Add item
      </button>
    </div>
  );
}

function ImageBody({ card, editing, selected, inColumn, file, actions, lowRes }) {
  const d = card.data;
  const fileId = d.fileId;
  useEffect(() => {
    if (fileId && !file) actions.ensureFile(fileId);
  }, [fileId, file, actions]);
  const site = d.source_url ? hostOf(d.source_url) : '';
  // Crop and rotation are drawn, never baked into the file: a stage the size of the whole
  // (rotated) picture, shifted so the crop box fills the frame.
  const rot = d.rotate || 0;
  const known = file?.width && file?.height;
  const rw = known ? (rot % 180 ? file.height : file.width) : 1;
  const rh = known ? (rot % 180 ? file.width : file.height) : 1;
  const c = known && d.crop ? d.crop : { x: 0, y: 0, w: 1, h: 1 };
  const edited = known && (rot || d.crop);
  const ratio = known ? `${c.w * rw} / ${c.h * rh}` : undefined;
  const src = fileId && `/files/${fileId}/${sizeName(lowRes)}`;
  const img = src && (
    <SafeImg
      src={src}
      alt={d.caption || d.alt || file?.name || ''}
      title={d.alt || undefined}
      draggable={false}
      loading="lazy"
      decoding="async"
      style={edited ? rotatedImgStyle(rot, rw, rh) : undefined}
    />
  );
  return (
    <>
      <div className="img-wrap" style={{ aspectRatio: ratio, backgroundColor: !file?.alpha && file?.color ? file.color : undefined }}>
        {edited ? (
          <div className="img-stage" style={{ width: `${100 / c.w}%`, height: `${100 / c.h}%`, left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%` }}>
            {img}
          </div>
        ) : (
          img
        )}
        <LabelChips labels={d.labels} />
        {d.ink?.strokes?.length > 0 && (
          <svg className="img-ink" viewBox={`0 0 ${d.ink.vw || 1000} ${d.ink.vh || 1000}`} preserveAspectRatio="none">
            {d.ink.strokes.map((st, i) => (
              <path key={i} d={strokePath(st)} fill={st.c} />
            ))}
          </svg>
        )}
      </div>
      <Caption card={card} editing={editing} selected={selected} inColumn={inColumn} actions={actions} />
      {site && (
        <div className="img-source">
          From{' '}
          <a href={d.source_url} target="_blank" rel="noopener noreferrer" title={d.source_title || d.source_url} draggable={false}>
            {site}
          </a>
        </div>
      )}
    </>
  );
}

// The searchable line under a picture or a file.
function Caption({ card, editing, selected, inColumn, actions }) {
  const d = card.data;
  if (editing) {
    return (
      <input
        className="caption-input"
        autoFocus
        placeholder={d.alt ? `Caption (page said: ${d.alt.slice(0, 60)})` : 'Add a caption (searchable)'}
        defaultValue={d.caption || ''}
        onBlur={(e) => {
          if (e.target.value !== (d.caption || '')) actions.saveData(card.id, { caption: e.target.value });
          actions.stopEdit(card.id);
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
    );
  }
  if (d.caption) return <div className="caption">{d.caption}</div>;
  if (!selected || inColumn) return null;
  return (
    <button className="caption-add" onClick={() => actions.editCard(card.id)}>
      Add a caption
    </button>
  );
}

// Any file that isn't a picture. A PDF shows its first page (drawn once by the browser, see pdf.js)
// and opens in the reader; other files show their type and download when opened.
// The tallest a PDF or video card's picture gets, as height ÷ width. A4 (1.41) and US Letter (1.29)
// pages and portrait phone videos (1.78) show whole; a page taller than that (a one-page infographic,
// a long scroll) shows its top, so one file can't stretch down the whole board.
const MAX_TALL = { pdf: 1.5, video: 1.8 };

function FileBody({ card, editing, selected, inColumn, file, actions, lowRes }) {
  const d = card.data;
  const fileId = d.fileId;
  const pdf = isPdf(file);
  const video = !pdf && isVideo(file);
  useEffect(() => {
    if (fileId && !file) actions.ensureFile(fileId);
  }, [fileId, file, actions]);
  useEffect(() => {
    if ((pdf || video) && !file.width) actions.ensurePreview(fileId, video);
  }, [pdf, video, file?.width, fileId, actions]);
  const ext = (file?.ext || '').replace('.', '').toUpperCase().slice(0, 5) || 'FILE';
  const kind = pdf ? ' is-pdf' : video ? ' is-video' : '';
  const facts = [pdf ? (file.pages ? `${file.pages} page${file.pages === 1 ? '' : 's'}` : 'PDF') : video ? formatDuration(file.duration) || 'Video' : ext, file?.size ? formatBytes(file.size) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      {(pdf || video) && file.width ? (
        <div className="img-wrap file-page" style={{ aspectRatio: `${file.width} / ${Math.min(file.height, file.width * (pdf ? MAX_TALL.pdf : MAX_TALL.video))}`, backgroundColor: file.color || '#ffffff' }}>
          {/* ?v: a redrawn preview gets a new address, so no cache shows the old one. */}
          <SafeImg src={`/files/${fileId}/${sizeName(lowRes)}?v=${file.width}x${file.height}`} alt={file.name || ''} draggable={false} loading="lazy" decoding="async" />
          {video && (
            <>
              <span className="file-play" aria-hidden="true">
                <Icon name="play" size={22} />
              </span>
              {file.duration > 0 && <span className="file-duration">{formatDuration(file.duration)}</span>}
            </>
          )}
          <LabelChips labels={d.labels} />
        </div>
      ) : (
        <div className={'file-tile' + kind}>
          <span className="file-ext">{ext}</span>
          <LabelChips labels={d.labels} />
        </div>
      )}
      <div className="file-meta">
        <span className={'file-badge' + kind}>{ext}</span>
        <span className="file-text">
          <span className="file-name">{file?.name || 'File'}</span>
          <span className="file-facts">{facts}</span>
        </span>
      </div>
      <Caption card={card} editing={editing} selected={selected} inColumn={inColumn} actions={actions} />
    </>
  );
}

function LinkBody({ card, editing, actions, lowRes }) {
  const d = card.data;
  if (!d.url || editing) {
    return (
      <div className="link-empty">
        <Icon name="link" size={16} />
        <input
          className="link-input"
          autoFocus
          placeholder="Paste a link and press Enter"
          defaultValue={d.url || ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const v = e.target.value.trim();
              if (v) actions.setLink(card.id, /^https?:\/\//i.test(v) ? v : 'https://' + v);
              actions.stopEdit(card.id);
            }
          }}
          onBlur={(e) => {
            actions.stopEdit(card.id);
            if (!e.target.value.trim() && !d.url) actions.dropIfFresh(card.id);
          }}
        />
      </div>
    );
  }
  const video = youtubeId(d.url);
  if (video) return <VideoBody card={card} video={video} lowRes={lowRes} />;
  return (
    <div className="link-body">
      {d.image && <SafeImg className="link-img" src={`/files/${d.image}/${sizeName(lowRes)}`} alt="" draggable={false} loading="lazy" decoding="async" />}
      <div className="link-meta">
        <div className="link-title">{d.loading ? 'Fetching preview…' : d.title || d.url}</div>
        {d.description && <div className="link-desc">{d.description}</div>}
        <div className="link-site">{d.site || hostOf(d.url)}</div>
      </div>
    </div>
  );
}

// YouTube links: watch, youtu.be, shorts, live and embed URLs. Returns { id, start } or null.
export function youtubeId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
  const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const start = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  return { id, start };
}

// Plays inside the card. Drag the card by its title strip while the video is showing.
function VideoBody({ card, video, lowRes }) {
  const d = card.data;
  const [playing, setPlaying] = useState(false);
  const thumb = d.image ? `/files/${d.image}/${sizeName(lowRes)}` : `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  return (
    <div className="link-body video-body">
      <div className="video-frame">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0${video.start ? '&start=' + video.start : ''}`}
            title={d.title || 'YouTube video'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <>
            <SafeImg src={thumb} alt="" draggable={false} loading="lazy" decoding="async" />
            <button className="video-play" onClick={() => setPlaying(true)} aria-label="Play video" data-tip="Play here">
              <Icon name="play" size={22} />
            </button>
          </>
        )}
      </div>
      <div className="link-meta">
        <div className="link-title">{d.loading ? 'Fetching preview…' : d.title || d.url}</div>
        <div className="link-site video-site">
          <span>YouTube</span>
          {playing && (
            <button className="video-stop" onClick={() => setPlaying(false)}>
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BoardBody({ card, editing, actions }) {
  const child = card.child;
  return (
    <div className="board-body">
      <CoverTile cover={child?.cover?.bg || !isHex(card.color) ? child?.cover : { ...(child?.cover || {}), bg: card.color }} fallback={<Icon name="board" size={28} />} />
      {editing ? (
        <input
          className="board-title-input"
          autoFocus
          defaultValue={child?.title || ''}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            if (child && e.target.value !== child.title) actions.renameBoard(card.id, e.target.value);
            actions.stopEdit(card.id);
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />
      ) : (
        <div className="board-title">{child?.title || 'Untitled'}</div>
      )}
      <div className="board-count">{child ? `${child.count} card${child.count === 1 ? '' : 's'}` : ''}</div>
    </div>
  );
}

function ColumnBody({ card, editing, kids, sel, editingId, files, actions, dropIndex, dragIds, cutIds, lowRes, lowResNow, settledS }) {
  return (
    <>
      <div className="col-head">
        {editing ? (
          <input
            className="col-title-input"
            autoFocus
            defaultValue={card.data.title || ''}
            placeholder="Column"
            onBlur={(e) => {
              if (e.target.value !== (card.data.title || '')) actions.saveData(card.id, { title: e.target.value });
              actions.stopEdit(card.id);
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          />
        ) : (
          <div className="col-title">{card.data.title || 'Column'}</div>
        )}
        <div className="col-count">{kids.length}</div>
      </div>
      <div className="col-body" data-drop-column={card.id}>
        {kids.map((k, i) => (
          <Fragment key={k.id}>
            {dropIndex === i && <div className="drop-line" />}
            <CardView
              card={k}
              inColumn
              selected={sel.has(k.id)}
              editing={editingId === k.id}
              file={files[k.data.fileId]}
              actions={actions}
              dragging={dragIds.has(k.id)}
              cut={cutIds?.has(k.id)}
              lowRes={lowRes}
              lowResNow={lowResNow}
              settledS={settledS}
            />
          </Fragment>
        ))}
        {dropIndex === kids.length && <div className="drop-line" />}
        {!kids.length && dropIndex == null && <div className="col-empty">Drop cards here</div>}
      </div>
    </>
  );
}

// Strokes drawn as SVG, scaled to the card's width. Double-click to draw on it again.
function DrawingBody({ card }) {
  const d = card.data;
  return (
    <svg className="drawing-svg" viewBox={`0 0 ${d.vw || 1} ${d.vh || 1}`} style={{ aspectRatio: `${d.vw || 1} / ${d.vh || 1}` }}>
      {(d.strokes || []).map((st, i) => (
        <path key={i} d={strokePath(st)} fill={st.c} />
      ))}
    </svg>
  );
}

// A colour swatch: the colour, its hex code and a name (the nearest web colour name unless typed).
// Editing: hex code, the system colour picker, and an eyedropper where the browser has one.
function ColorBody({ card, editing, actions }) {
  const d = card.data;
  const hex = isHex(d.hex) ? d.hex.toLowerCase() : '#ecbc1c';
  const timer = useRef(0);
  const setHex = (h) => isHex(h) && h.toLowerCase() !== hex && actions.saveData(card.id, { hex: h.toLowerCase() });
  const fromScreen = async () => {
    try {
      const r = await new window.EyeDropper().open();
      setHex(r.sRGBHex);
    } catch {}
  };
  const commitOnEnter = (e) => e.key === 'Enter' && e.target.blur();
  return (
    <>
      <div className="color-swatch" style={{ background: hex, color: inkFor(hex) }}>
        <span className="color-hex">{hex.toUpperCase()}</span>
      </div>
      {editing ? (
        <div className="color-edit" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && actions.stopEdit(card.id)}>
          <div className="color-edit-row">
            <label className="color-well" style={{ background: hex }} data-tip="Choose a colour">
              <input
                type="color"
                defaultValue={hex}
                aria-label="Choose a colour"
                // The system picker reports every drag step; save once it rests.
                onChange={(e) => {
                  const v = e.target.value;
                  clearTimeout(timer.current);
                  timer.current = setTimeout(() => setHex(v), 250);
                }}
              />
            </label>
            <input
              className="color-hex-input"
              key={hex}
              autoFocus
              defaultValue={hex.toUpperCase()}
              aria-label="Hex code"
              onKeyDown={commitOnEnter}
              onBlur={(e) => {
                const v = '#' + e.target.value.trim().replace(/^#/, '');
                if (isHex(v)) setHex(v);
                else e.target.value = hex.toUpperCase(); // not a colour: show the current one again
              }}
            />
            {'EyeDropper' in window && (
              <button className="color-dropper" onMouseDown={(e) => e.preventDefault()} onClick={fromScreen} data-tip="Pick a colour from the screen" aria-label="Pick a colour from the screen">
                <Icon name="eyedropper" size={16} />
              </button>
            )}
          </div>
          <input
            className="color-name-input"
            defaultValue={d.name || ''}
            placeholder={colorName(hex)}
            aria-label="Colour name"
            onKeyDown={commitOnEnter}
            onBlur={(e) => e.target.value.trim() !== (d.name || '') && actions.saveData(card.id, { name: e.target.value.trim() })}
          />
        </div>
      ) : (
        <div className="color-name">{d.name || colorName(hex)}</div>
      )}
    </>
  );
}

const BODIES = { note: NoteBody, todo: TodoBody, image: ImageBody, file: FileBody, link: LinkBody, board: BoardBody, drawing: DrawingBody, color: ColorBody };

export const CardView = memo(function CardView(props) {
  const { card, inColumn, selected, editing, dragging, cut, hidden } = props;
  // Image size: a card that mounts mid-zoom takes the size for the current zoom; after that it only
  // follows the settled zoom, so a zoom never makes every visible image reload at once.
  const [lowRes, setLowRes] = useState(props.lowResNow ?? props.lowRes);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) setLowRes(props.lowRes);
    mounted.current = true;
  }, [props.lowRes, props.settledS]);
  const bg = isHex(card.color) && card.type !== 'board' ? { background: card.color, color: inkFor(card.color) === '#ffffff' ? '#f5f5f4' : undefined } : null;
  // A card showing its handles comes to the front while selected: the handles live inside the card,
  // so they could never be drawn above a neighbour that sits higher in the stack.
  const withHandles = selected && !inColumn && !editing;
  const style = inColumn ? bg || undefined : { left: card.x, top: card.y, width: card.w || DEFAULT_W[card.type], zIndex: withHandles ? 1e6 + (card.z || 0) : card.z, ...bg };
  const cutout = card.type === 'image' && props.file?.alpha === 1; // see-through PNG: no card frame
  const cls = ['card', `card-${card.type}`, cutout && 'cutout', selected && 'selected', editing && 'editing', dragging && 'dragging', cut && 'cut', hidden && (card.type === 'image' ? 'ink-hide' : 'ink-editing'), card.color && !isHex(card.color) && `c-${card.color}`, isHex(card.color) && 'has-bg', inColumn && 'in-column']
    .filter(Boolean)
    .join(' ');
  const Body = card.type === 'column' ? ColumnBody : BODIES[card.type];
  return (
    <div className={cls} style={style} data-card-id={card.id} data-drop-board={card.type === 'board' ? card.data.boardId : undefined}>
      {card.data?.strip && card.type !== 'board' && <div className="card-strip" style={{ background: card.data.strip }} />}
      {Body ? (
        <Body {...props} lowRes={lowRes} />
      ) : (
        // A kind of card made by a newer ZBoard than this one (a phone still running an old copy).
        <div className="card-unknown">
          <Icon name="refresh" size={22} />
          <span>Reload ZBoard to see this card</span>
        </div>
      )}
      {card.type !== 'image' && card.type !== 'file' && card.type !== 'column' && <LabelChips labels={card.data.labels} />}
      {withHandles && (
        <>
          {/* Touch screens: an Arrow button above the card (finger-sized, keeps the corners clear) and a
              circle on the bottom-right corner to resize by pulling it. Moving is hold-and-drag on the
              card itself. Same size on screen at any zoom. */}
          {TOUCH ? (
            <>
              <div className="handle-pill" style={{ '--hs': 1 / (props.settledS || 1) }}>
                <div className="handle pill-btn pill-arrow" data-handle="arrow" aria-label="Connect with an arrow">
                  <Icon name="arrowEnd" size={20} />
                </div>
              </div>
              <div className="handle handle-move handle-resize-touch" data-handle="resize" aria-label="Resize" style={{ '--hs': 1 / (props.settledS || 1) }}>
                <Icon name="resize" size={18} />
              </div>
            </>
          ) : (
            <>
              <div className="handle handle-resize" data-handle="resize" data-tip="Resize" />
              <div className="handle handle-arrow" data-handle="arrow" data-tip="Drag to a card to connect" />
            </>
          )}
        </>
      )}
    </div>
  );
});
