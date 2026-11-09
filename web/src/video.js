// Videos. The server has no video decoder, so, as for PDFs (pdf.js), the browser draws the card's
// picture: a frame from early in the video, drawn by a hidden <video> and sent to the server once.
// Playing streams from the server: the browser asks for the part it is about to play (range
// requests), so a 1 GB video starts at once and jumps anywhere without downloading the rest.
import { api } from './api.js';

export const isVideo = (f) => !!f && (/^video\//.test(f.mime || '') || /\.(mp4|m4v|mov|webm|ogv)$/i.test(f.name || '') || /^\.(mp4|m4v|mov|webm|ogv)$/i.test(f.ext || ''));
export const videoUrl = (id) => `/files/${id}?original=1`;

// 754 → "12:34", 4000 → "1:06:40".
export function formatDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function once(el, ok, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(reject, new Error('timed out')), ms);
    const okFn = () => done(resolve);
    const errFn = () => done(reject, new Error(el.error?.message || "this video can't be played here"));
    function done(fn, v) {
      clearTimeout(t);
      el.removeEventListener(ok, okFn);
      el.removeEventListener('error', errFn);
      fn(v);
    }
    el.addEventListener(ok, okFn);
    el.addEventListener('error', errFn);
  });
}

// A frame about 800 px wide, from 10% in (at most 3 s, past a black first frame), and the length.
async function drawFrame(src) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  try {
    await once(v, 'loadedmetadata', 30000);
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(3, duration * 0.1) || 0.1;
    await once(v, 'seeked', 30000);
    if (v.readyState < 2) await once(v, 'loadeddata', 15000);
    const scale = Math.min(1, 800 / v.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No preview'))), 'image/jpeg', 0.85));
    canvas.width = canvas.height = 0;
    return { blob, width: v.videoWidth, height: v.videoHeight, duration };
  } finally {
    v.removeAttribute('src');
    v.load(); // stop downloading
  }
}

// Draw a video's frame and give it to the server as the file's preview. file: the File just picked
// (read locally, nothing downloaded) or nothing (read from the server). One try per file per visit.
const tried = new Map();
export function makeVideoPreview(fileId, file) {
  if (!tried.has(fileId)) {
    tried.set(
      fileId,
      (async () => {
        if (!file) {
          const now = (await api('GET', `/api/files/${fileId}/info`)).file;
          if (now.width) return now;
        }
        const local = file && URL.createObjectURL(file);
        try {
          const { blob, width, height, duration } = await drawFrame(local || videoUrl(fileId));
          const r = await api('POST', `/api/files/${fileId}/preview?duration=${duration}&w=${width}&h=${height}`, await blob.arrayBuffer(), 'image/jpeg');
          return r.file;
        } finally {
          if (local) URL.revokeObjectURL(local);
        }
      })().catch((e) => {
        console.warn('Video preview failed', fileId, e);
        return null;
      })
    );
  }
  return tried.get(fileId);
}
