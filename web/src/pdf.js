// PDFs, read with pdf.js (through react-pdf). Nothing of it is in the app's first download: the
// library, its worker and the reader (PdfReader.jsx) load the first time a PDF is shown or opened.
// The worker is a separate file the browser fetches on its own, so the heavy parsing and drawing
// never block the board.
// The legacy build (see pdf-assets.mjs): works on older iPhones too.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { api } from './api.js';
import { openCache } from './pdfCache.js';

const BASE = import.meta.env.BASE_URL;
// Fonts and character maps some PDFs need (copied next to the app by pdfAssets() in vite.config.js).
// disableAutoFetch + disableStream: read only the parts of the file that the pages being shown
// need (HTTP range requests), never the rest of a big file in the background.
export const PDF_OPTIONS = {
  cMapUrl: BASE + 'pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: BASE + 'pdfjs/standard_fonts/',
  disableAutoFetch: true,
  disableStream: true,
};

let lib = null;
export function loadPdf() {
  lib ??= import('react-pdf').then((m) => {
    m.pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  lib.catch(() => (lib = null)); // a dropped download can be tried again
  return lib;
}

// Reading a file from the server in parts, done here rather than by pdf.js itself: on iPhones pdf.js's
// own range requests could stop for good after a dozen parts (one answer never reached it, and it
// never asks again). Here each part skips the browser's cache, is given up on when it takes too long,
// and is asked for again. pdf.js still decides which parts it needs: those of the pages being shown.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getRange(url, begin, end, isLive) {
  for (let i = 0; ; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000 + (end - begin) / 50); // 15 s plus 20 s per MB
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
      if (r.status !== 206 && r.status !== 200) throw new Error(`the server answered ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const total = Number((r.headers.get('content-range') || '').split('/')[1]) || (r.status === 200 ? buf.length : 0);
      return { data: r.status === 200 ? buf.slice(begin, end) : buf, total };
    } catch (e) {
      if (i >= 4 || !isLive()) throw e;
      await sleep(1000 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

// A pdf.js source (PDFDataRangeTransport) for a file on the server. onBytes(n): progress; onError(e):
// a part that couldn't be read after several tries.
// keep: also use and fill this browser's 7-day copy of the parts read (pdfCache.js); the reader does,
// drawing a board preview doesn't. onBytes counts only what came from the server.
export async function openPdfSource(fileId, { onBytes = () => {}, onError = () => {}, keep = false } = {}) {
  const [{ pdfjs }, cache] = await Promise.all([loadPdf(), keep ? openCache(fileId) : null]);
  const url = new URL(fileUrl(fileId), location.href).href;
  let live = true;
  let total = cache?.size() || 0;
  const read = async (begin, end) => {
    const kept = total && (await cache?.get(begin, Math.min(end, total)));
    if (kept) return { data: kept, total };
    const r = await getRange(url, begin, end, () => live);
    onBytes(r.data.length);
    total ||= r.total;
    cache?.put(begin, r.data, r.total);
    return r;
  };
  const first = await read(0, 65536);
  if (!first.total) throw new Error("the server didn't say how big the file is");
  const t = new pdfjs.PDFDataRangeTransport(first.total, first.data);
  t.requestDataRange = (begin, end) =>
    read(begin, end).then(
      ({ data }) => {
        if (!live) return;
        t.onDataRange(begin, data);
      },
      (e) => live && onError(e)
    );
  const abort = t.abort.bind(t);
  t.abort = () => {
    live = false;
    abort();
  };
  return t;
}

// Whether this browser can run pdf.js at all, decided by feature, not by OS version: the legacy build
// fills in most of what older browsers lack, but not these two (iOS before 16.4, old Android
// WebViews). Without them pdf.js is never downloaded: PDFs open in the browser's own viewer instead
// and keep their plain tile on the board. (On iOS 16, pdf.js's worker could even crash the tab, in a
// way no code can catch, so it must not be tried.)
export const PDF_SUPPORTED = typeof OffscreenCanvas === 'function' && typeof structuredClone === 'function';

export const isPdf = (f) => !!f && (f.ext === '.pdf' || f.mime === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
export const fileUrl = (id) => `/files/${id}?original=1`;

// The first page as a JPEG about 800 px wide, plus the page count.
async function drawFirstPage(src) {
  const { pdfjs } = await loadPdf();
  const doc = await pdfjs.getDocument({ ...PDF_OPTIONS, ...(src instanceof ArrayBuffer ? { data: src } : { range: src }) }).promise;
  try {
    const page = await doc.getPage(1);
    const one = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 800 / one.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    // At most 1.5 × as tall as wide (the card shows no more, see Cards.jsx): a one-page infographic
    // many screens long is drawn from its top only, sharp, and without a huge canvas (iOS limits them).
    canvas.height = Math.ceil(Math.min(viewport.height, viewport.width * 1.5));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No preview'))), 'image/jpeg', 0.85));
    const { width, height } = canvas;
    canvas.width = canvas.height = 0; // free the memory now (iOS keeps little for canvases)
    return { blob, width, height, pages: doc.numPages };
  } finally {
    doc.destroy();
  }
}

// Draw a PDF's first page and give it to the server as the file's preview. src: the file just
// picked (a File) or, for one uploaded elsewhere, nothing (it is read from the server). One try
// per file per visit: a broken or locked PDF keeps its plain tile.
const tried = new Map();
export function makePdfPreview(fileId, file) {
  if (!PDF_SUPPORTED) return Promise.resolve(null); // another device will draw it
  if (!tried.has(fileId)) {
    tried.set(
      fileId,
      (async () => {
        if (!file) {
          // Another device may have drawn it since this one loaded the board.
          const now = (await api('GET', `/api/files/${fileId}/info`)).file;
          if (now.width) return now;
        }
        const { blob, width, height, pages } = await drawFirstPage(file ? await file.arrayBuffer() : await openPdfSource(fileId));
        const r = await api('POST', `/api/files/${fileId}/preview?pages=${pages}&w=${width}&h=${height}`, await blob.arrayBuffer(), 'image/jpeg');
        return r.file;
      })().catch((e) => {
        console.warn('PDF preview failed', fileId, e);
        return null;
      })
    );
  }
  return tried.get(fileId);
}
