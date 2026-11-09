import DOMPurify from 'dompurify';

// Ids match the server's pattern; getRandomValues also works on plain-http LAN pages.
export function uid() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const byId = (list) => Object.fromEntries((list || []).map((x) => [x.id, x]));

export const DEFAULT_W = { note: 240, todo: 240, image: 240, link: 260, board: 140, column: 280, drawing: 240, color: 200, file: 220 };

export const COLORS = [
  { id: null, label: 'None' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'grey', label: 'Grey' },
];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const sanitize = (html) =>
  DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'h1', 'h2', 'h3', 'p', 'div', 'br', 'ul', 'ol', 'li', 'a', 'span', 'blockquote', 'code', 'pre'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
  });

export function htmlText(html) {
  const d = document.createElement('div');
  d.innerHTML = sanitize(html);
  return d.textContent || '';
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const textToHtml = (s) => escapeHtml(s).split(/\r?\n/).map((l) => `<div>${l || '<br>'}</div>`).join('');

export const isUrl = (s) => /^https?:\/\/[^\s]+$/i.test(String(s || '').trim());

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// A sort value between two neighbours (either may be missing).
export function sortBetween(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

export const isImageFile = (f) => f.type?.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name || '');
