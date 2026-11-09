import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './icons.jsx';

const TYPE_ICON = { note: 'note', todo: 'todo', image: 'image', file: 'file', link: 'link', board: 'board', column: 'column' };

// Server snippets mark matches with \u0001 … \u0002.
function Snippet({ text }) {
  const parts = String(text || '').split(/\u0001([^\u0002]*)\u0002/);
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

export default function Search({ initial, onClose }) {
  const [q, setQ] = useState(initial?.tag ? '#' + initial.tag : initial?.q || '');
  const [results, setResults] = useState([]);
  const [tags, setTags] = useState([]);
  const [active, setActive] = useState(0);
  const [answered, setAnswered] = useState(''); // the query the current results belong to
  const listRef = useRef(null);

  useEffect(() => {
    api('GET', '/api/tags')
      .then((r) => setTags(r.tags))
      .catch(() => {});
  }, []);

  const tagOnly = /^#[\p{L}\p{N}_-]+$/u.test(q.trim()) ? q.trim().slice(1) : null;
  useEffect(() => {
    let alive = true;
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const url = tagOnly ? `/api/search?tag=${encodeURIComponent(tagOnly)}` : `/api/search?q=${encodeURIComponent(query)}`;
        const r = await api('GET', url);
        if (alive) {
          setResults(r.results);
          setActive(0);
        }
      } catch {
        if (alive) setResults([]);
      } finally {
        if (alive) setAnswered(query);
      }
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, tagOnly]);

  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Esc closes even when focus has left the input.
  useEffect(() => {
    const onEsc = (e) => e.key === 'Escape' && !e.target.closest?.('.search-panel') && onClose();
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  function open(r) {
    location.hash = r.kind === 'board' ? `#/b/${r.id}` : `#/b/${r.board_id}?focus=${r.id}`;
    onClose();
  }

  function onKey(e) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && results[active]) open(results[active]);
  }

  return (
    <div className="overlay search-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-panel" role="dialog" aria-label="Search">
        <div className="search-input-row">
          <Icon name="search" size={18} />
          <input autoFocus placeholder="Search cards and boards, or #tag" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search" />
          <kbd>Esc</kbd>
          <button className="search-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
        {q.trim() ? (
          <ul className="search-results scrolls" ref={listRef}>
            {results.map((r, i) => (
              <li key={r.kind + r.id} className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
                <Icon name={TYPE_ICON[r.type] || 'note'} size={18} />
                <div className="sr-main">
                  <div className="sr-snippet">
                    <Snippet text={r.snippet || (r.type === 'image' ? 'Image' : r.type === 'file' ? 'File' : r.type)} />
                  </div>
                  <div className="sr-where">{r.kind === 'board' ? (r.board_title ? `Board in ${r.board_title}` : 'Board') : r.board_title}</div>
                </div>
              </li>
            ))}
            {!results.length && answered === q.trim() && <li className="sr-empty">No matches</li>}
          </ul>
        ) : (
          <div className="tag-cloud scrolls">
            {tags.length ? (
              tags.map((t) => (
                <button key={t.tag} className="tag-chip" onClick={() => setQ('#' + t.tag)}>
                  #{t.tag} <span>{t.count}</span>
                </button>
              ))
            ) : (
              <div className="sr-empty">Write #tags in notes, to-dos or captions to see them here.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
