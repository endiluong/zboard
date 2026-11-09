// Full-screen PDF reader. Loaded only when a PDF is opened (React.lazy in Board.jsx), together with
// pdf.js. pdf.js reads the file in pieces (HTTP range requests), so the first page shows before a big
// file has finished downloading. Only the pages near the screen are drawn; pages far away are dropped
// again, which keeps a long PDF light on a phone (iOS allows little memory for canvases).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Document, Page } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { Icon } from './icons.jsx';
import { PDF_OPTIONS, fileUrl, loadPdf, openPdfSource } from './pdf.js';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const GAP = 12;
// Canvas sharpness, capped: phones (touch screens) at 1.5×, where canvas memory runs out first (iOS
// can kill the tab); computers at 2×.
const DPR = Math.min(typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 ? 1.5 : 2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

export default function PdfReader({ file, onClose }) {
  const [ready, setReady] = useState(false);
  const [doc, setDoc] = useState(null); // { numPages, ratios: [h/w per page] }
  const [libError, setLibError] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [fitW, setFitW] = useState(0);
  const [near, setNear] = useState(() => new Set([1]));
  const [current, setCurrent] = useState(1);
  const scroller = useRef(null);
  const pageEls = useRef(new Map());

  // The file, read in parts by pdf.js through openPdfSource (see pdf.js for why not by pdf.js itself).
  const [source, setSource] = useState(null);
  useEffect(() => {
    let live = true;
    let tr = null;
    loadPdf().then(
      () =>
        openPdfSource(file.id, {
          keep: true,
          onBytes: (n) => live && setGot((g) => g + n),
          onError: (e) => live && setError(e),
        }).then(
          (t) => {
            tr = t;
            if (!live) return t.abort();
            setSource(t);
            setReady(true);
          },
          (e) => live && setError(e)
        ),
      (e) => live && setLibError(e)
    );
    return () => {
      live = false;
      tr?.abort();
    };
  }, [file.id]);

  // Still nothing after a while (a very slow connection, or a browser pdf.js can't run in): say so
  // and offer the file itself, which the phone's own viewer can open. It keeps trying meanwhile.
  const [slow, setSlow] = useState(false);
  const [got, setGot] = useState(0); // bytes of the file read so far
  useEffect(() => {
    if (doc || error || libError) return;
    const t = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(t);
  }, [doc, error, libError]);

  // Page width that fits the screen (up to a comfortable reading width on a computer).
  useLayoutEffect(() => {
    const el = scroller.current;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight);
      setFitW(Math.max(0, Math.min(el.clientWidth - pad, 900)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.round(fitW * zoom);

  const onLoad = useCallback(async (pdf) => {
    // Page shapes, for the scroll height: page 1's for every page to start with; a page with another
    // shape corrects its own when it is drawn (onPageLoad). Asking for every page up front would make
    // pdf.js download parts of all of them, which a big file read in pieces shouldn't do.
    try {
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      setDoc({ numPages: pdf.numPages, ratios: Array.from({ length: pdf.numPages }, () => first.height / first.width) });
    } catch {} // closed meanwhile
  }, []);
  const onPageLoad = useCallback((page) => {
    const v = page.getViewport({ scale: 1 });
    const r = v.height / v.width;
    setDoc((d) => {
      if (!d || Math.abs(d.ratios[page.pageNumber - 1] - r) < 0.001) return d;
      const ratios = [...d.ratios];
      ratios[page.pageNumber - 1] = r;
      return { ...d, ratios };
    });
  }, []);

  // Which pages are within a screen of the view (drawn), and which one fills most of it (the counter).
  useEffect(() => {
    if (!doc) return;
    const root = scroller.current;
    const shown = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) e.isIntersecting ? next.add(+e.target.dataset.page) : next.delete(+e.target.dataset.page);
          return next.size === prev.size && [...next].every((n) => prev.has(n)) ? prev : next;
        });
      },
      { root, rootMargin: '100% 0px' }
    );
    const io2 = new IntersectionObserver(
      (entries) => {
        for (const e of entries) shown.set(+e.target.dataset.page, e.intersectionRatio);
        let best = 1;
        let most = -1;
        for (const [n, r] of shown) if (r > most || (r === most && n < best)) [best, most] = [n, r];
        setCurrent(best);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    for (const el of pageEls.current.values()) {
      io.observe(el);
      io2.observe(el);
    }
    return () => {
      io.disconnect();
      io2.disconnect();
    };
  }, [doc?.numPages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the same spot in the document when zooming.
  const zoomTo = useCallback(
    (z) => {
      const el = scroller.current;
      const frac = el.scrollHeight ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0;
      setZoom(z);
      requestAnimationFrame(() => (el.scrollTop = frac * el.scrollHeight - el.clientHeight / 2));
    },
    []
  );
  const step = (dir) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
    if (next !== zoom) zoomTo(next);
  };

  const goTo = (n) => {
    const el = pageEls.current.get(Math.max(1, Math.min(doc?.numPages || 1, n)));
    el?.scrollIntoView({ block: 'start' });
  };

  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Escape') onClose();
      else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) step(1);
      else if ((e.ctrlKey || e.metaKey) && e.key === '-') step(-1);
      else if ((e.ctrlKey || e.metaKey) && e.key === '0') zoomTo(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  });

  // Ctrl + wheel (and a trackpad pinch) zooms the pages, not the whole app.
  useEffect(() => {
    const el = scroller.current;
    let acc = 0;
    const wheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) > 40) {
        step(acc > 0 ? -1 : 1);
        acc = 0;
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const opening = (
    <div className="pdf-msg" role="status">
      <span className="pdf-spin" aria-hidden="true" />
      Opening…
      {got > 0 && (
        <div className="pdf-slow">
          {(got / 1048576).toFixed(1)}
          {file.size ? ` / ${(file.size / 1048576).toFixed(1)}` : ''} MB loaded
        </div>
      )}
      {slow && (
        <div className="pdf-slow">
          This is taking long.{' '}
          {/* A new window: in the home-screen app this opens over it with a Done button, instead of
              replacing the app with no way back. */}
          <a href={fileUrl(file.id)} target="_blank" rel="noopener noreferrer">
            Open it in the phone&apos;s viewer
          </a>
        </div>
      )}
    </div>
  );

  const name = file.name || 'Document.pdf';

  const pages = [];
  if (doc) {
    for (let n = 1; n <= doc.numPages; n++) {
      const h = Math.round(width * doc.ratios[n - 1]);
      pages.push(
        <div
          key={n}
          className="pdf-page"
          data-page={n}
          ref={(el) => (el ? pageEls.current.set(n, el) : pageEls.current.delete(n))}
          style={{ width, height: h, marginBottom: GAP }}
        >
          {/* Under the page: shows until the page's picture is drawn over it. */}
          <span className="pdf-spin pdf-page-spin" aria-hidden="true" />
          {near.has(n) && width > 0 && (
            <Page pageNumber={n} width={width} devicePixelRatio={DPR} loading="" renderTextLayer renderAnnotationLayer onLoadSuccess={onPageLoad} onRenderError={() => {}} />
          )}
        </div>
      );
    }
  }

  return createPortal(
    <div
      className="pdf-reader"
      role="dialog"
      aria-label={name}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <header className="pdf-bar">
        <button className="pdf-btn" onClick={onClose} aria-label="Close" data-tip="Close (Esc)">
          <Icon name="x" size={20} />
        </button>
        <div className="pdf-title" title={name}>
          {name}
        </div>
        {doc && (
          <div className="pdf-count" aria-live="polite">
            <input
              key={current}
              className="pdf-goto"
              inputMode="numeric"
              defaultValue={current}
              aria-label="Page"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  goTo(parseInt(e.target.value, 10) || 1);
                  e.target.blur();
                }
              }}
              onFocus={(e) => e.target.select()}
            />
            <span>/ {doc.numPages}</span>
          </div>
        )}
        <div className="pdf-zoom">
          <button className="pdf-btn" onClick={() => step(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out">
            <Icon name="minus" size={18} />
          </button>
          <button className="pdf-pct" onClick={() => zoomTo(1)} aria-label="Fit width">
            {Math.round(zoom * 100)}%
          </button>
          <button className="pdf-btn" onClick={() => step(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">
            <Icon name="plus" size={18} />
          </button>
        </div>
        {/* target=_blank: on an iPhone home-screen app this opens over the app (with Done) instead of
            replacing it; computers still download it. */}
        <a className="pdf-btn" href={fileUrl(file.id)} download={name} target="_blank" rel="noopener noreferrer" aria-label="Download" data-tip="Download">
          <Icon name="download" size={19} />
        </a>
      </header>
      <div className="pdf-scroll" ref={scroller}>
        {libError ? (
          <div className="pdf-msg">Couldn&apos;t load the PDF reader. Check the connection and open the file again.</div>
        ) : error && !doc ? (
          <div className="pdf-msg">
            This PDF can&apos;t be shown{error?.message ? `: ${error.message}` : ''}.{' '}
            <a href={fileUrl(file.id)} target="_blank" rel="noopener noreferrer" className="pdf-slow-link">
              Open it in the phone&apos;s viewer
            </a>
          </div>
        ) : ready ? (
          <Document
            file={source}
            options={PDF_OPTIONS}
            onLoadSuccess={onLoad}
            onLoadError={setError}
            loading={opening}
            error={<div className="pdf-msg">This PDF can&apos;t be shown{error?.message ? `: ${error.message}` : ''}.</div>}
            externalLinkTarget="_blank"
            className="pdf-doc"
          >
            {pages}
          </Document>
        ) : (
          opening
        )}
      </div>
    </div>,
    document.body
  );
}
