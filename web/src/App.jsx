import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { DEMO, REPO_URL } from './demo.js';
import Board from './Board.jsx';
import { bootDone } from './boot.js';
import { Icon } from './icons.jsx';
import Menu from './Menu.jsx';
import Search from './Search.jsx';

// #/b/<board id>?focus=<card id>
function parseHash() {
  const m = location.hash.match(/^#\/b\/([^?]+)(?:\?(.*))?$/);
  const params = new URLSearchParams(m?.[2] || '');
  return { board: m ? decodeURIComponent(m[1]) : 'root', focus: params.get('focus') };
}

function Login({ onDone }) {
  useEffect(bootDone, []);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/login', { password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form onSubmit={submit} className="login-box">
        <div className="login-logo">ZBoard</div>
        <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState('checking');
  const [route, setRoute] = useState(parseHash);
  const [info, setInfo] = useState({ board: null, breadcrumbs: [] });
  const [search, setSearch] = useState(null);
  const [menu, setMenu] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false); // false, true (opened by hand) or 'auto'
  const [clipCount, setClipCount] = useState(0);
  // Saved items open by themselves on a board that has some, once per visit: closing the panel
  // keeps it closed there, and one that opened by itself closes again on the next board.
  const autoShown = useRef(null);
  useEffect(() => {
    autoShown.current = null;
    setSavedOpen((o) => (o === 'auto' ? false : o));
  }, [route.board]);
  const onClipCount = useCallback(
    (n) => {
      setClipCount(n);
      if (n > 0 && autoShown.current !== route.board) {
        autoShown.current = route.board;
        setSavedOpen((o) => o || 'auto');
      }
    },
    [route.board]
  );
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch((s) => (s ? null : {}));
      }
    };
    const onTag = (e) => setSearch({ tag: e.detail.tag });
    window.addEventListener('keydown', onKey);
    window.addEventListener('zb:search', onTag);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('zb:search', onTag);
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api('GET', '/api/me')
      .then(() => setAuth('in'))
      .catch(() => setAuth('out'));
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => setRenaming(false), [route.board]);

  useEffect(() => {
    document.title = info.board && info.board.id !== 'root' ? `${info.board.title} · ZBoard` : 'ZBoard';
  }, [info.board]);

  // Opened straight on a board (a reload, a link, Safari restoring the tab): the browser has nothing
  // above it in its history, so Back would leave ZBoard or land on an old page. Fill in
  // Home → … → this board once per page load, so Back walks up the tree.
  const seeded = useRef(false);
  useEffect(() => {
    const bc = info.breadcrumbs;
    if (seeded.current || !bc?.length) return;
    seeded.current = true;
    if (bc.length < 2 || history.state?.zbPath) return; // at Home, or this history was filled in before a reload
    const here = location.hash;
    history.replaceState({ zbPath: true }, '', `#/b/${bc[0].id}`);
    for (const b of bc.slice(1, -1)) history.pushState({ zbPath: true }, '', `#/b/${b.id}`);
    history.pushState({ zbPath: true }, '', here);
  }, [info.breadcrumbs]);

  if (auth === 'checking') return <div className="splash">ZBoard</div>;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;

  const crumbs = info.breadcrumbs;
  async function renameBoard(id, title) {
    setRenaming(false);
    const old = crumbs.find((b) => b.id === id)?.title;
    if (!title || title === old) return;
    setInfo((inf) => ({ board: inf.board?.id === id ? { ...inf.board, title } : inf.board, breadcrumbs: inf.breadcrumbs.map((b) => (b.id === id ? { ...b, title } : b)) }));
    await api('PATCH', `/api/boards/${id}`, { title }).catch(() => setInfo((inf) => ({ ...inf, breadcrumbs: inf.breadcrumbs.map((b) => (b.id === id ? { ...b, title: old } : b)) })));
  }
  async function logout() {
    await api('POST', '/api/logout').catch(() => {});
    setAuth('out');
  }

  return (
    <div className="app">
      <header className="topbar">
        {/* Phones and the installed app have no browser Back button: this goes up one board. */}
        {crumbs.length > 1 && (
          <a className="icon-btn back-btn" href={`#/b/${crumbs[crumbs.length - 2].id}`} aria-label={`Back to ${crumbs[crumbs.length - 2].title || 'Untitled'}`}>
            <Icon name="chevronLeft" size={22} />
          </a>
        )}
        <a className="logo" href="#/b/root" data-tip="Home" data-drop-board={route.board !== 'root' ? 'root' : undefined}>
          ZBoard
        </a>
        <nav className="crumbs">
          {crumbs.map((b, i) => (
            <span key={b.id} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">/</span>}
              {i === crumbs.length - 1 && renaming ? (
                <input
                  className="crumb-input"
                  autoFocus
                  defaultValue={b.title}
                  aria-label="Board name"
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') {
                      e.target.value = b.title;
                      e.target.blur();
                    }
                  }}
                  onBlur={(e) => renameBoard(b.id, e.target.value.trim())}
                />
              ) : (
                <a
                  href={`#/b/${b.id}`}
                  className={i === crumbs.length - 1 ? 'crumb current' : 'crumb'}
                  data-drop-board={i < crumbs.length - 1 ? b.id : undefined}
                  data-tip={i === crumbs.length - 1 ? 'Double-click to rename' : undefined}
                  onDoubleClick={i === crumbs.length - 1 ? () => setRenaming(true) : undefined}
                >
                  {b.title || 'Untitled'}
                </a>
              )}
            </span>
          ))}
        </nav>
        <div className="topbar-right">
          <button className="search-btn" onClick={() => setSearch({})} data-tip="Search (Ctrl+K)" aria-label="Search">
            <Icon name="search" size={18} />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button className={savedOpen ? 'icon-btn on' : 'icon-btn'} onClick={() => setSavedOpen((o) => !o)} data-tip="Saved items" aria-label="Saved items">
            <Icon name="inbox" />
            {clipCount > 0 && <span className="badge">{clipCount}</span>}
          </button>
          <button className="icon-btn" onClick={() => setMenu(true)} data-tip="Menu" aria-label="Menu">
            <Icon name="menu" />
          </button>
        </div>
      </header>
      {DEMO && (
        <div className="demo-banner">
          <span>
            <b>Demo</b> · everything you make stays in this browser
          </span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Host your own ↗
          </a>
        </div>
      )}
      <Board
        key={route.board}
        boardId={route.board}
        focus={route.focus}
        onInfo={setInfo}
        savedOpen={!!savedOpen}
        onCloseSaved={() => setSavedOpen(false)}
        onClipCount={onClipCount}
      />
      {search && <Search initial={search} onClose={() => setSearch(null)} />}
      {menu && <Menu boardId={route.board} boardTitle={info.board?.title} onClose={() => setMenu(false)} onLogout={logout} />}
    </div>
  );
}
