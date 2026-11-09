#!/usr/bin/env node
// ZBoard terminal client. Node 18+, no dependencies.
//
//   zboard                       interactive shell (Tab completion, history)
//   zboard "cd Minis; cat 2"     one-shot: commands separated by ;
//   zboard < script.txt          piped script, one command per line
//
// Connection, first match wins: ZBOARD_URL + ZBOARD_TOKEN, ~/.config/zboard/config.json
// (written by "zboard login"), $DATA_DIR/cli-token, <repo>/data/cli-token, /data/cli-token.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const safeRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const safeJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zboard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
const REPO = path.resolve(path.dirname(fs.realpathSync(__filename)), '..');
const IS_WIN = process.platform === 'win32';
const IS_WSL = !IS_WIN && /microsoft/i.test(safeRead('/proc/version'));
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint('2');
const bold = paint('1');
const blue = paint('34');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

class ZError extends Error {}
const say = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---------- connection ----------
function loadConfig() {
  const url = (process.env.ZBOARD_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  if (process.env.ZBOARD_URL && process.env.ZBOARD_TOKEN) return { url, token: process.env.ZBOARD_TOKEN, source: 'ZBOARD_URL + ZBOARD_TOKEN' };
  const cfg = safeJson(CONFIG_FILE);
  if (cfg?.url && cfg?.token) return { url: cfg.url.replace(/\/+$/, ''), token: cfg.token, source: CONFIG_FILE };
  const files = [process.env.DATA_DIR && path.join(path.resolve(REPO, process.env.DATA_DIR), 'cli-token'), path.join(REPO, 'data', 'cli-token'), '/data/cli-token'];
  for (const f of files.filter(Boolean)) {
    const token = safeRead(f).trim();
    if (token) return { url, token, source: f };
  }
  return { url, token: null, source: null };
}
let CFG = loadConfig();

async function request(method, p, body, { raw = false, token = CFG.token, url = CFG.url, headers = {} } = {}) {
  if (!token && !headers.cookie) throw new ZError('Not connected. Run "zboard login", or start the server once on this machine (it writes data/cli-token).');
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(url + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headers },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ZError(`Can't reach ZBoard at ${url} (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401 && token) throw new ZError(`ZBoard rejected the token from ${CFG.source}. Run "zboard login".`);
  if (raw) {
    if (!res.ok) throw new ZError(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ZError(data.error || `${res.status} ${res.statusText}`);
  return data;
}
const api = (method, p, body, opts) => request(method, p, body, opts);

// ---------- text helpers ----------
const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Note HTML → markdown-ish text (bold **, italic *, strike ~~, underline _, # heading, - bullets, [text](url)).
// Block edges become one line break; only an empty line (<div><br></div>) stays blank, so
// mdToHtml(htmlToMd(html)) gives the same HTML back.
const EDGE = '\u0001';
const BLANK = '\u0002';
function htmlToMd(html) {
  let s = String(html || '').replace(/\r?\n/g, '');
  s = s.replace(/<(div|p)[^>]*>\s*<br\s*\/?>\s*<\/\1>/gi, EDGE + BLANK + EDGE);
  s = s
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, '~~$2~~')
    .replace(/<u>(.*?)<\/u>/gi, '_$1_');
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (m, href, text) => (decode(text) === decode(href) ? href : `[${text}](${href})`));
  s = s.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, `${EDGE}# $1${EDGE}`);
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gi, `${EDGE}- $1${EDGE}`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(div|p|ul|ol|blockquote|pre)[^>]*>/gi, EDGE);
  s = decode(s.replace(/<[^>]+>/g, ''));
  return s
    .replace(new RegExp(`${EDGE}+`, 'g'), '\n')
    .replace(new RegExp(BLANK, 'g'), '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

// Plain text of a note, for listings.
const htmlText = (html) => decode(String(html || '').replace(/<(br|\/div|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));

function inlineMd(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<u>$2</u>');
}

// Markdown-ish text → note HTML (the editor's own markup: div lines, h3, ul/li, b/i/u/s/a).
function mdToHtml(md) {
  const out = [];
  let list = null;
  for (const line of String(md).replace(/\r/g, '').split('\n')) {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      (list ||= []).push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`);
      list = null;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    out.push(h ? `<h3>${inlineMd(h[1])}</h3>` : `<div>${line.trim() ? inlineMd(line) : '<br>'}</div>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  while (out.length && out[out.length - 1] === '<div><br></div>') out.pop();
  return out.join('');
}

const firstLine = (s) => (String(s).split('\n').find((l) => l.trim()) || '').trim();
const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uid = () => require('crypto').randomBytes(9).toString('base64url');

// Split a command line into words, honouring "quotes", 'quotes' and backslashes.
function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

// Split on ; outside quotes.
function splitCommands(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// File names safe on Windows too: no : ? * " < > | (or slashes), no CON, NUL, COM1….
function safeName(name) {
  let n = String(name || '')
    .replace(/[:?*"<>|]/g, '')
    .replace(/[\\/\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n) n = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 180);
}

// ---------- board state ----------
const state = { board: 'root', prev: null, boards: null, rl: null, interactive: false };

async function boards(refresh = false) {
  if (!state.boards || refresh) state.boards = (await api('GET', '/api/boards')).boards;
  return state.boards;
}
const boardById = async (id) => (await boards()).find((b) => b.id === id);
async function pathOf(id) {
  const all = await boards();
  const parts = [];
  let b = all.find((x) => x.id === id);
  const seen = new Set();
  while (b && !seen.has(b.id)) {
    seen.add(b.id);
    parts.unshift(b.title || 'Untitled');
    b = all.find((x) => x.id === b.parent_id);
  }
  return '/' + parts.join('/');
}

function titleOf(card, files = {}) {
  const d = card.data || {};
  switch (card.type) {
    case 'board':
      return card.child?.title || 'Untitled';
    case 'note':
      return firstLine(htmlText(d.html)) || '(empty note)';
    case 'todo':
      return d.title || 'To-do';
    case 'link':
      return d.title || d.url || 'Link';
    case 'image':
      return d.caption || files[d.fileId]?.name || 'Image';
    case 'file':
      return d.caption || files[d.fileId]?.name || 'File';
    case 'column':
      return d.title || 'Column';
    case 'drawing':
      return `Drawing (${(d.strokes || []).length} strokes)`;
    case 'color':
      return `${(d.hex || '').toUpperCase()}${d.name ? ' ' + d.name : ''}`;
    default:
      return card.type;
  }
}

// Cards in reading order: top to bottom, left to right, column contents right after their column.
function ordered(cards) {
  const ids = new Set(cards.map((c) => c.id));
  const top = cards.filter((c) => !c.column_id || !ids.has(c.column_id)).sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const c of top) {
    out.push({ card: c, depth: 0 });
    if (c.type === 'column') {
      for (const k of cards.filter((k) => k.column_id === c.id).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) out.push({ card: k, depth: 1 });
    }
  }
  return out;
}

async function listing(id = state.board) {
  const d = await api('GET', `/api/boards/${encodeURIComponent(id)}?files=1`);
  return { ...d, items: ordered(d.cards) };
}

function matchByName(items, name, label = (x) => x.title) {
  const n = name.toLowerCase();
  return items.find((x) => label(x).toLowerCase() === n) || items.find((x) => label(x).toLowerCase().startsWith(n)) || items.find((x) => label(x).toLowerCase().includes(n));
}

// A card by its number in the listing, or by (the start of) its title.
async function resolveCard(ref, list) {
  list ||= await listing();
  if (/^\d+$/.test(ref)) {
    const it = list.items[Number(ref) - 1];
    if (!it) throw new ZError(`No card #${ref} here (${list.items.length} cards).`);
    return { card: it.card, list };
  }
  const named = list.items.map((it) => ({ ...it, title: titleOf(it.card, list.files) }));
  const it = matchByName(named, ref);
  if (!it) throw new ZError(`No card called "${ref}" here.`);
  return { card: it.card, list };
}

// Board paths: name, number, .., /, -, a/b, /Home/a/b.
async function resolveBoard(spec) {
  const all = await boards(true);
  spec = (spec ?? '').trim();
  if (!spec || spec === '/' || spec === '~') return 'root';
  if (spec === '-') {
    if (!state.prev) throw new ZError('No previous board.');
    return state.prev;
  }
  let cur = spec.startsWith('/') ? 'root' : state.board;
  const parts = spec.split('/').filter(Boolean);
  if (spec.startsWith('/') && parts.length && (all.find((b) => b.id === 'root')?.title || 'Home').toLowerCase() === parts[0].toLowerCase()) parts.shift();
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      cur = all.find((b) => b.id === cur)?.parent_id || 'root';
      continue;
    }
    const kids = all.filter((b) => b.parent_id === cur);
    let next = null;
    if (/^\d+$/.test(part)) {
      const list = await listing(cur);
      const c = list.items[Number(part) - 1]?.card;
      if (c?.type === 'board') next = c.data.boardId;
    }
    next ||= matchByName(kids, part, (b) => b.title || '')?.id;
    if (!next) throw new ZError(`No board "${part}" in ${await pathOf(cur)}.`);
    cur = next;
  }
  return cur;
}

// "mv Some note Other board": try each split until the left is a card and the right a board.
async function splitCardAndBoard(args) {
  if (args.length < 2) throw new ZError('Usage: mv|cp <card> <board>');
  const list = await listing();
  for (let i = args.length - 1; i >= 1; i--) {
    try {
      const { card } = await resolveCard(args.slice(0, i).join(' '), list);
      const board = await resolveBoard(args.slice(i).join(' '));
      return { card, board, list };
    } catch {}
  }
  throw new ZError(`Couldn't tell which card and which board: "${args.join(' ')}". Quote them: mv "card" "board".`);
}

// ---------- terminal, editor, viewer ----------
function withPausedPrompt(fn) {
  const rl = state.rl;
  if (rl) rl.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  try {
    return fn();
  } finally {
    if (rl) rl.resume();
  }
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = state.rl || readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdout.isTTY) {
      const write = rl._writeToOutput;
      rl._writeToOutput = (s) => (s.includes(question) ? write.call(rl, s) : write.call(rl, '*'.repeat(Math.min(1, s.length))));
      rl.question(question, (a) => {
        rl._writeToOutput = write;
        process.stdout.write('\n');
        if (!state.rl) rl.close();
        resolve(a);
      });
    } else
      rl.question(question, (a) => {
        if (!state.rl) rl.close();
        resolve(a);
      });
  });
}

// $VISUAL / $EDITOR, else nano → vi (Linux, WSL) or notepad → code --wait (Windows).
function editText(initial, ext = '.md') {
  const tmp = path.join(os.tmpdir(), `zboard-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, initial);
  const chosen = process.env.VISUAL || process.env.EDITOR;
  const editors = chosen ? [chosen] : IS_WIN ? ['notepad', 'code --wait'] : ['nano', 'vi'];
  let ran = false;
  withPausedPrompt(() => {
    for (const ed of editors) {
      const r = spawnSync(`${ed} "${tmp}"`, { stdio: 'inherit', shell: true });
      if (r.status === 127 || r.status === 9009 || r.error) continue;
      ran = true;
      break;
    }
  });
  const text = safeRead(tmp);
  fs.rmSync(tmp, { force: true });
  if (!ran) throw new ZError(`No editor found. Set $EDITOR (tried ${editors.join(', ')}).`);
  return text;
}

const which = (cmd) => spawnSync(IS_WIN ? 'where' : 'sh', IS_WIN ? [cmd] : ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// Open a file or URL in the desktop's viewer. False when there is no GUI to use.
function openGui(target) {
  const run = (cmd, args) => {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  };
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (IS_WIN) return run('cmd', ['/c', 'start', '""', target]);
  if (process.platform === 'darwin') return run('open', [target]);
  if (IS_WSL) {
    if (which('wslview')) return run('wslview', [target]);
    const win = /^https?:/.test(target) ? target : spawnSync('wslpath', ['-w', target], { encoding: 'utf8' }).stdout.trim();
    return run('explorer.exe', [win]);
  }
  if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && which('xdg-open')) return run('xdg-open', [target]);
  return false;
}

// iTerm2/WezTerm and kitty/Ghostty draw real images; tmux, Windows Terminal and the rest get half-blocks.
function inlineProtocol(env = process.env) {
  if (env.ZBOARD_IMAGES) return env.ZBOARD_IMAGES;
  if (env.TMUX || env.WT_SESSION) return 'blocks';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty' || env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty') return 'kitty';
  return 'blocks';
}

async function drawInline(fileId, base = `/api/files/${fileId}/render`) {
  const cols = Math.max(10, Math.min((process.stdout.columns || 80) - 2, 100));
  const proto = inlineProtocol();
  if (proto === 'iterm' || proto === 'kitty') {
    const png = Buffer.from(await (await api('GET', `${base}?mode=png&w=${cols * 10}`, null, { raw: true })).arrayBuffer());
    const b64 = png.toString('base64');
    if (proto === 'iterm') process.stdout.write(`\x1b]1337;File=inline=1;size=${png.length};width=${cols};preserveAspectRatio=1:${b64}\x07\n`);
    else {
      for (let i = 0; i < b64.length; i += 4096) {
        const more = i + 4096 < b64.length ? 1 : 0;
        process.stdout.write(i === 0 ? `\x1b_Ga=T,f=100,c=${cols},m=${more};${b64.slice(i, i + 4096)}\x1b\\` : `\x1b_Gm=${more};${b64.slice(i, i + 4096)}\x1b\\`);
      }
      process.stdout.write('\n');
    }
    return;
  }
  process.stdout.write(await (await api('GET', `${base}?mode=ansi&cols=${cols}`, null, { raw: true })).text());
}

async function download(fileId, dest) {
  const res = await api('GET', `/files/${fileId}?original=1`, null, { raw: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// Locally: the desktop viewer. Over SSH (or with no GUI): drawn in the terminal.
async function showImage(fileId, file) {
  if (!process.env.SSH_CONNECTION && !process.env.SSH_TTY && process.env.ZBOARD_IMAGES !== 'inline' && !process.env.ZBOARD_IMAGES) {
    const tmp = path.join(os.tmpdir(), `zboard-${fileId}${file?.display_ext || file?.ext || '.jpg'}`);
    await download(fileId, tmp);
    if (openGui(tmp)) return say(dim(`(opened ${path.basename(tmp)} in the image viewer)`));
  }
  await drawInline(fileId);
}

// ---------- formatting ----------
const TYPE_TAG = { board: blue('board '), note: 'note  ', todo: green('todo  '), link: yellow('link  '), image: paint('35')('image '), column: dim('column'), drawing: paint('36')('draw  '), color: paint('33')('color ') };

function rowFor(card, files, n, depth, long) {
  const d = card.data || {};
  let extra = '';
  if (card.type === 'board') extra = `${card.child?.count ?? 0} cards`;
  else if (card.type === 'todo') extra = `${(d.items || []).filter((i) => i.done).length}/${(d.items || []).length} done`;
  else if (card.type === 'link') extra = d.site || (d.url ? new URL(d.url).hostname : '');
  else if (card.type === 'image') extra = files[d.fileId] ? `${files[d.fileId].width}×${files[d.fileId].height}` : '';
  const title = titleOf(card, files) + (card.type === 'board' ? '/' : '');
  const num = String(n).padStart(3);
  const indent = depth ? '    ' : '';
  let line = `${indent}${dim(num)}  ${TYPE_TAG[card.type] || card.type}  ${card.type === 'board' ? bold(short(title, 50)) : short(title, 50)}`;
  if (extra) line += '  ' + dim(extra);
  if (long) line += '  ' + dim(`${card.id}  ${new Date(card.updated_at).toLocaleString()}`);
  return line;
}

function todoText(d) {
  return [`# ${d.title || ''}`, ...(d.items || []).map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`)].join('\n');
}
function parseTodo(text, old) {
  const lines = text.replace(/\r/g, '').split('\n');
  const title = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s+/, '').trim();
  const pool = [...(old.items || [])];
  const items = [];
  for (const l of lines) {
    const m = l.match(/^\s*[-*]\s+\[([ xX])\]\s?(.*)$/) || l.match(/^\s*[-*]\s+()(.*)$/);
    if (!m) continue;
    const i = pool.findIndex((p) => p.text === m[2]);
    const id = i >= 0 ? pool.splice(i, 1)[0].id : uid();
    items.push({ id, text: m[2], done: m[1].toLowerCase() === 'x' });
  }
  return { title, items };
}

// ---------- commands ----------
const COMMANDS = {};
const command = (names, usage, fn) => {
  for (const n of names.split(' ')) COMMANDS[n] = { usage, fn, name: names.split(' ')[0] };
};

command('help ?', 'help                 this list', () => {
  const seen = new Set();
  for (const c of Object.values(COMMANDS)) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    say('  ' + c.usage);
  }
  say(dim('  Cards are referred to by number (from ls) or by the start of their title. Typing a board name enters it.'));
});

command('ls', 'ls [-l] [board]      list cards on this board', async (args) => {
  const long = args.includes('-l');
  const rest = args.filter((a) => a !== '-l').join(' ');
  const id = rest ? await resolveBoard(rest) : state.board;
  const list = await listing(id);
  if (!list.items.length) return say(dim('(empty board)'));
  list.items.forEach((it, i) => say(rowFor(it.card, list.files, i + 1, it.depth, long)));
});

command('cd', 'cd [board]           enter a board (name, number, .., /, -, /Home/a/b)', async (args) => {
  const id = await resolveBoard(args.join(' '));
  if (id !== state.board) {
    state.prev = state.board;
    state.board = id;
  }
});

command('pwd', 'pwd                  where you are', async () => say(await pathOf(state.board)));

command('tree', 'tree [board]         boards under this one', async (args) => {
  const all = await boards(true);
  const start = args.length ? await resolveBoard(args.join(' ')) : state.board;
  say(bold((await boardById(start))?.title || 'Home'));
  const walk = (id, prefix) => {
    const kids = all.filter((b) => b.parent_id === id).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    kids.forEach((b, i) => {
      const last = i === kids.length - 1;
      say(prefix + (last ? '└── ' : '├── ') + (b.title || 'Untitled'));
      walk(b.id, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(start, '');
});

async function showCard(card, list) {
  const d = card.data || {};
  switch (card.type) {
    case 'note':
      return say(htmlToMd(d.html) || dim('(empty note)'));
    case 'todo':
      return say(todoText(d).replace(/^# /, '').replace(/- \[x\]/g, green('[x]')).replace(/- \[ \]/g, '[ ]'));
    case 'link':
      say(bold(d.title || d.url));
      say(blue(d.url || ''));
      if (d.description) say(d.description);
      return;
    case 'image':
      await showImage(d.fileId, list.files[d.fileId]);
      if (d.caption) say(d.caption);
      return;
    case 'drawing':
      return drawInline(null, `/api/cards/${card.id}/render`);
    case 'board': {
      const sub = await listing(d.boardId);
      say(bold(titleOf(card) + '/'));
      sub.items.forEach((it, i) => say(rowFor(it.card, sub.files, i + 1, it.depth)));
      return;
    }
    case 'column': {
      say(bold(d.title || 'Column'));
      const kids = list.items.filter((it) => it.card.column_id === card.id);
      kids.forEach((it) => say('  ' + rowFor(it.card, list.files, list.items.indexOf(it) + 1, 0)));
      return;
    }
  }
}

command('cat view', 'cat|view <card>...   show a card (images open in the viewer, or draw over SSH)', async (args) => {
  if (!args.length) throw new ZError('Usage: cat <card>');
  const list = await listing();
  const refs = args.every((a) => /^\d+$/.test(a)) ? args : [args.join(' ')];
  for (const ref of refs) {
    const { card } = await resolveCard(ref, list);
    await showCard(card, list);
  }
});

command('info', 'info <card>          details of a card', async (args) => {
  const { card, list } = await resolveCard(args.join(' '));
  const d = card.data || {};
  const rows = [
    ['id', card.id],
    ['type', card.type],
    ['title', titleOf(card, list.files)],
    ['position', `${Math.round(card.x)}, ${Math.round(card.y)}${card.w ? `  width ${Math.round(card.w)}` : ''}`],
    ['colour', card.color || '—'],
    ['created', new Date(card.created_at).toLocaleString()],
    ['updated', new Date(card.updated_at).toLocaleString()],
  ];
  if (card.type === 'board') rows.push(['board id', d.boardId], ['cards', String(card.child?.count ?? 0)]);
  if (card.type === 'link') rows.push(['url', d.url]);
  if (card.type === 'image') {
    const f = list.files[d.fileId] || (await api('GET', `/api/files/${d.fileId}/info`)).file;
    rows.push(['file', `${f.name} (${f.width}×${f.height}, ${Math.round(f.size / 1024)} KB)`], ['file id', f.id]);
  }
  if (card.column_id) rows.push(['in column', titleOf(list.cards.find((c) => c.id === card.column_id) || { type: 'column', data: {} })]);
  for (const [k, v] of rows) say(`${dim(k.padEnd(10))} ${v}`);
});

command('get', 'get <card> [dir]     download an image original (notes save as .md)', async (args) => {
  const list = await listing();
  let dir = '.';
  let ref = args.join(' ');
  if (args.length > 1 && fs.existsSync(args[args.length - 1]) && fs.statSync(args[args.length - 1]).isDirectory()) {
    dir = args[args.length - 1];
    ref = args.slice(0, -1).join(' ');
  }
  const { card } = await resolveCard(ref, list);
  const d = card.data || {};
  let dest;
  if (card.type === 'image') {
    const f = list.files[d.fileId] || (await api('GET', `/api/files/${d.fileId}/info`)).file;
    dest = path.join(dir, safeName(f.name || f.id + f.ext));
    await download(d.fileId, dest);
  } else if (card.type === 'note') {
    dest = path.join(dir, safeName(titleOf(card).slice(0, 60)) + '.md');
    fs.writeFileSync(dest, htmlToMd(d.html) + '\n');
  } else if (card.type === 'todo') {
    dest = path.join(dir, safeName(d.title || 'todo') + '.md');
    fs.writeFileSync(dest, todoText(d) + '\n');
  } else if (card.type === 'link') return say(d.url);
  else throw new ZError(`Nothing to download for a ${card.type}.`);
  say(`Saved ${dest}`);
});

command('open', 'open <card>          open in the browser / image viewer', async (args) => {
  const { card, list } = await resolveCard(args.join(' '));
  const d = card.data || {};
  let target;
  if (card.type === 'link') target = d.url;
  else if (card.type === 'image') {
    target = path.join(os.tmpdir(), safeName(list.files[d.fileId]?.name || `zboard-${d.fileId}.jpg`));
    await download(d.fileId, target);
  } else if (card.type === 'board') target = `${CFG.url}/#/b/${d.boardId}`;
  else target = `${CFG.url}/#/b/${card.board_id}?focus=${card.id}`;
  if (!openGui(target)) say(target);
});

command('search', 'search <words|#tag>  find cards and boards', async (args) => {
  const q = args.join(' ');
  if (!q) throw new ZError('Usage: search <words>');
  const tag = /^#[\p{L}\p{N}_-]+$/u.test(q) ? q.slice(1) : null;
  const { results } = await api('GET', tag ? `/api/search?tag=${encodeURIComponent(tag)}` : `/api/search?q=${encodeURIComponent(q)}`);
  if (!results.length) return say(dim('No matches.'));
  for (const r of results) {
    const where = r.kind === 'board' ? await pathOf(r.id) : await pathOf(r.board_id);
    const snip = String(r.snippet || '')
      .replace(/\u0001/g, COLOR ? '\x1b[1;33m' : '[')
      .replace(/\u0002/g, COLOR ? '\x1b[0m' : ']')
      .replace(/\s*\n\s*/g, ' ');
    say(`${dim(where)}  ${r.kind === 'board' ? blue('board ') : ''}${short(snip, 100)}`);
  }
});

command('tags', 'tags [tag]           list #tags, or the cards with one', async (args) => {
  if (args.length) return COMMANDS.search.fn(['#' + args[0].replace(/^#/, '')]);
  const { tags } = await api('GET', '/api/tags');
  if (!tags.length) return say(dim('No tags yet.'));
  say(tags.map((t) => `#${t.tag} ${dim('(' + t.count + ')')}`).join('  '));
});

command('saved', 'saved                items saved with the browser extension', async () => {
  const { clips } = await api('GET', '/api/clips');
  if (!clips.length) return say(dim('Nothing saved.'));
  for (const c of clips) {
    const d = c.data;
    const what = c.kind === 'image' ? 'image' : c.kind === 'link' ? d.title || d.url : short(firstLine(d.text), 60);
    say(`${dim(await pathOf(c.board_id))}  ${c.kind.padEnd(5)}  ${what}`);
  }
});

// New cards go below everything on the board (or at the end of a column with --in).
async function placeNew(list) {
  let y = 40;
  for (const c of list.cards) if (!c.column_id) y = Math.max(y, c.y + (c.type === 'image' ? 320 : 180));
  return { x: 40, y: list.cards.length ? y + 40 : 40 };
}

command('new', 'new note|todo|link|board|column [text] [--in <column>]', async (args) => {
  const type = args[0];
  if (!['note', 'todo', 'link', 'board', 'column'].includes(type)) throw new ZError('Usage: new note|todo|link|board|column [text] [--in <column>]');
  let rest = args.slice(1);
  let column = null;
  const list = await listing();
  const inAt = rest.indexOf('--in');
  if (inAt >= 0) {
    const { card } = await resolveCard(rest.slice(inAt + 1).join(' '), list);
    if (card.type !== 'column') throw new ZError(`"${titleOf(card)}" is not a column.`);
    if (type === 'column') throw new ZError("Columns can't go inside columns.");
    column = card;
    rest = rest.slice(0, inAt);
  }
  let text = rest.join(' ');
  const card = { type, ...(column ? { column_id: column.id } : await placeNew(list)) };
  if (type === 'note') {
    if (!text && state.interactive) text = editText('');
    if (!text.trim()) throw new ZError('Empty note, nothing created.');
    card.data = { html: mdToHtml(text) };
  } else if (type === 'todo') card.data = { title: text || 'To-do', items: [] };
  else if (type === 'link') {
    if (!text) throw new ZError('Usage: new link <url>');
    const url = /^https?:\/\//i.test(text) ? text : 'https://' + text;
    card.data = { url, title: url };
    try {
      const p = await api('GET', `/api/link-preview?url=${encodeURIComponent(url)}`);
      card.data = { url, title: p.title, description: p.description, site: p.site, image: p.image };
    } catch (e) {
      say(dim(`(no preview: ${e.message})`));
    }
  } else if (type === 'board') card.title = text || 'New board';
  else card.data = { title: text };
  const { card: made } = await api('POST', `/api/boards/${encodeURIComponent(state.board)}/cards`, card);
  const after = await listing();
  const n = after.items.findIndex((it) => it.card.id === made.id) + 1;
  say(`Created ${dim('#' + n)} ${titleOf(made, after.files)}`);
});

command('edit', 'edit <card>          edit a note or to-do in $EDITOR', async (args) => {
  const { card } = await resolveCard(args.join(' '));
  const d = card.data || {};
  if (card.type === 'note') {
    const text = editText(htmlToMd(d.html) + '\n');
    const html = mdToHtml(text.replace(/\n+$/, ''));
    if (html === d.html) return say(dim('No changes.'));
    await api('PATCH', '/api/cards', { cards: [{ id: card.id, data: { html } }] });
  } else if (card.type === 'todo') {
    const next = parseTodo(editText(todoText(d) + '\n'), d);
    await api('PATCH', '/api/cards', { cards: [{ id: card.id, data: next }] });
  } else throw new ZError(`Use "rename" for a ${card.type}.`);
  say('Saved.');
});

command('rename', 'rename <card> <new title>', async (args) => {
  if (args.length < 2) throw new ZError('Usage: rename <card> <new title>');
  const list = await listing();
  let card;
  let title;
  for (let i = 1; i < args.length && !card; i++) {
    try {
      card = (await resolveCard(args.slice(0, i).join(' '), list)).card;
      title = args.slice(i).join(' ');
    } catch {}
  }
  if (!card) throw new ZError(`No card "${args[0]}" here.`);
  if (card.type === 'board') await api('PATCH', `/api/boards/${card.data.boardId}`, { title });
  else if (card.type === 'image') await api('PATCH', '/api/cards', { cards: [{ id: card.id, data: { caption: title } }] });
  else if (card.type === 'link' || card.type === 'todo' || card.type === 'column') await api('PATCH', '/api/cards', { cards: [{ id: card.id, data: { title } }] });
  else throw new ZError('Notes have no title: use "edit".');
  say(`Renamed to "${title}".`);
});

async function setChecked(args, done) {
  if (args.length < 2) throw new ZError(`Usage: ${done ? 'check' : 'uncheck'} <todo> <item number or text>`);
  const list = await listing();
  for (let i = args.length - 1; i >= 1; i--) {
    let card;
    try {
      card = (await resolveCard(args.slice(0, i).join(' '), list)).card;
    } catch {
      continue;
    }
    if (card.type !== 'todo') continue;
    const items = card.data.items || [];
    const ref = args.slice(i).join(' ');
    const item = /^\d+$/.test(ref) ? items[Number(ref) - 1] : matchByName(items, ref, (x) => x.text);
    if (!item) throw new ZError(`No item "${ref}" in "${card.data.title}".`);
    await api('PATCH', '/api/cards', { cards: [{ id: card.id, data: { items: items.map((x) => (x.id === item.id ? { ...x, done } : x)) } }] });
    return say(`${done ? green('[x]') : '[ ]'} ${item.text}`);
  }
  throw new ZError('No to-do found.');
}
command('check', 'check <todo> <item>  tick an item (number or text)', (args) => setChecked(args, true));
command('uncheck', 'uncheck <todo> <item>', (args) => setChecked(args, false));

command('upload', 'upload <file>... [--in <column>]   add images', async (args) => {
  let files = args;
  let column = null;
  const list = await listing();
  const inAt = args.indexOf('--in');
  if (inAt >= 0) {
    column = (await resolveCard(args.slice(inAt + 1).join(' '), list)).card;
    files = args.slice(0, inAt);
  }
  // Unquoted paths with spaces: join words back until they name a file.
  const paths = [];
  for (let i = 0; i < files.length; ) {
    let j = files.length;
    while (j > i && !fs.existsSync(files.slice(i, j).join(' '))) j--;
    if (j === i) throw new ZError(`No such file: ${files[i]}`);
    paths.push(files.slice(i, j).join(' '));
    i = j;
  }
  if (!paths.length) throw new ZError('Usage: upload <file>...');
  const form = new FormData();
  for (const p of paths) form.append('file', new Blob([fs.readFileSync(p)]), path.basename(p));
  const { files: uploaded } = await api('POST', '/api/upload', form);
  const at = await placeNew(list);
  const cards = uploaded.map((f, i) => ({ type: 'image', ...(column ? { column_id: column.id } : { x: at.x + i * 260, y: at.y }), w: 240, data: { fileId: f.id, caption: '' } }));
  await api('POST', `/api/boards/${encodeURIComponent(state.board)}/cards`, { cards });
  say(`Uploaded ${uploaded.length} image${uploaded.length === 1 ? '' : 's'}.`);
});

command('rm', 'rm <card>...         delete cards (asks first in the shell)', async (args) => {
  const list = await listing();
  const refs = args.every((a) => /^\d+$/.test(a)) ? args : [args.join(' ')];
  if (!args.length) throw new ZError('Usage: rm <card>...');
  const cards = [];
  for (const r of refs) cards.push((await resolveCard(r, list)).card);
  if (state.interactive) {
    const names = cards.map((c) => `"${titleOf(c, list.files)}"`).join(', ');
    const a = await ask(`Delete ${names}${cards.some((c) => c.type === 'board') ? ' and everything inside' : ''}? [y/N] `);
    if (!/^y/i.test(a)) return say('Kept.');
  }
  await api('POST', '/api/cards/delete', { ids: cards.map((c) => c.id) });
  say(`Deleted ${cards.length} card${cards.length === 1 ? '' : 's'}.`);
});

command('mv', 'mv <card> <board>    move a card to another board', async (args) => {
  const { card, board } = await splitCardAndBoard(args);
  await api('PATCH', '/api/cards', { cards: [{ id: card.id, board_id: board, column_id: null, x: 40, y: 40 }] });
  say(`Moved "${titleOf(card)}" to ${await pathOf(board)}.`);
});

command('cp', 'cp <card> <board>    copy a card (boards are copied with everything inside)', async (args) => {
  const { card, board, list } = await splitCardAndBoard(args);
  const copy = { type: card.type, w: card.w, color: card.color, data: { ...card.data }, ...(await placeNew(await listing(board))) };
  if (card.type === 'board') {
    copy.copyFrom = card.data.boardId;
    delete copy.data.boardId;
  }
  await api('POST', `/api/boards/${encodeURIComponent(board)}/cards`, copy);
  say(`Copied "${titleOf(card, list.files)}" to ${await pathOf(board)}.`);
});

command('login', 'login [url]          sign in with the app password and save a token', async (args) => {
  const url = (args[0] || (await ask(`ZBoard address [${CFG.url}]: `)) || CFG.url).replace(/\/+$/, '');
  const password = await ask('Password: ', { hidden: true });
  let res;
  try {
    res = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  } catch (e) {
    throw new ZError(`Can't reach ${url} (${e.cause?.code || e.message}).`);
  }
  if (!res.ok) throw new ZError((await res.json().catch(() => ({}))).error || `Login failed (${res.status})`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const { token } = await request('GET', '/api/token', null, { url, token: null, headers: { cookie } });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
  CFG = loadConfig();
  state.boards = null;
  say(`Signed in to ${url}. Token saved in ${CONFIG_FILE}.`);
});

command('logout', 'logout               forget the saved token', async () => {
  fs.rmSync(CONFIG_FILE, { force: true });
  CFG = loadConfig();
  say(CFG.token ? `Removed ${CONFIG_FILE}. Still connected through ${CFG.source}.` : `Removed ${CONFIG_FILE}.`);
});

command('whoami', 'whoami               which server and token are in use', async () => {
  say(`${dim('server'.padEnd(8))} ${CFG.url}`);
  say(`${dim('token'.padEnd(8))} ${CFG.source || red('none')}`);
  if (CFG.token) {
    await api('GET', '/api/me');
    say(`${dim('status'.padEnd(8))} ${green('connected')}  ${dim('board')} ${await pathOf(state.board)}`);
  }
});

command('exit quit', 'exit                 leave the shell', () => {
  state.rl?.close();
});

// ---------- running ----------
async function runLine(line) {
  const words = tokenize(line.trim());
  if (!words.length) return;
  const [name, ...args] = words;
  const cmd = COMMANDS[name.toLowerCase()];
  if (cmd) return cmd.fn(args);
  // Typing a board name enters it.
  let board;
  try {
    board = await resolveBoard(words.join(' '));
  } catch {
    throw new ZError(`Unknown command "${name}". Type "help".`);
  }
  return COMMANDS.cd.fn(words);
}

async function runAll(text) {
  let failed = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const c of splitCommands(line)) {
      try {
        await runLine(c);
      } catch (e) {
        failed = true;
        process.stderr.write(red('zboard: ') + (e instanceof ZError ? e.message : e.stack) + '\n');
      }
    }
  }
  return failed ? 1 : 0;
}

// Tab completion: commands and board names first, then card titles, board paths or files.
async function complete(line) {
  const endsWithSpace = /\s$/.test(line);
  const words = tokenize(line);
  const partial = endsWithSpace ? '' : words[words.length - 1] || '';
  const filter = (list) => [...new Set(list)].filter((x) => x.toLowerCase().startsWith(partial.toLowerCase())).sort();
  const childBoards = async (id) => (await boards()).filter((b) => b.parent_id === id).map((b) => b.title || 'Untitled');
  if (words.length === 0 || (words.length === 1 && !endsWithSpace)) {
    return [filter([...Object.keys(COMMANDS), ...(await childBoards(state.board))]), partial];
  }
  const cmd = words[0].toLowerCase();
  if (cmd === 'new' && words.length <= 2) return [filter(['note', 'todo', 'link', 'board', 'column']), partial];
  if (['cd', 'ls', 'tree'].includes(cmd)) {
    const slash = partial.lastIndexOf('/');
    if (slash >= 0) {
      const base = partial.slice(0, slash + 1);
      const id = await resolveBoard(base).catch(() => null);
      if (!id) return [[], partial];
      const leaf = partial.slice(slash + 1).toLowerCase();
      return [(await childBoards(id)).filter((t) => t.toLowerCase().startsWith(leaf)).map((t) => base + t + '/'), partial];
    }
    return [filter([...(await childBoards(state.board)).map((t) => t + '/'), '../', '/']), partial];
  }
  if (cmd === 'upload') {
    const dir = path.dirname(partial || './x');
    try {
      const names = fs.readdirSync(dir === '.' && !partial.startsWith('./') ? '.' : dir);
      const prefix = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
      return [filter(names.map((n) => prefix + n)), partial];
    } catch {
      return [[], partial];
    }
  }
  if (COMMANDS[cmd]) {
    const list = await listing();
    return [filter(list.items.map((it) => titleOf(it.card, list.files))), partial];
  }
  return [[], partial];
}

async function shell() {
  state.interactive = true;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const history = safeRead(HISTORY_FILE).split('\n').filter(Boolean).reverse().slice(0, 1000);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history,
    historySize: 1000,
    removeHistoryDuplicates: true,
    completer: (line, cb) => complete(line).then((r) => cb(null, r), () => cb(null, [[], line])),
  });
  state.rl = rl;
  rl.on('history', (h) => {
    try {
      fs.writeFileSync(HISTORY_FILE, [...h].reverse().join('\n') + '\n');
    } catch {}
  });
  const setPrompt = async () => rl.setPrompt(`${blue('zboard')}:${bold(await pathOf(state.board).catch(() => '?'))}> `);
  say(dim(`ZBoard ${CFG.url}${CFG.source ? '' : ' (not connected: run "login")'} — type "help"`));
  await setPrompt();
  rl.prompt();
  rl.on('line', async (line) => {
    rl.pause();
    try {
      for (const c of splitCommands(line)) await runLine(c);
    } catch (e) {
      process.stderr.write(red('zboard: ') + (e instanceof ZError ? e.message : e.stack) + '\n');
    }
    await setPrompt();
    rl.resume();
    rl.prompt();
  });
  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h') return COMMANDS.help.fn([]);
  if (argv.length) process.exit(await runAll(argv.join(' ')));
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    process.exit(await runAll(Buffer.concat(chunks).toString('utf8')));
  }
  await shell();
}

if (require.main === module) main();
module.exports = { htmlToMd, mdToHtml, tokenize, splitCommands, safeName, inlineProtocol, complete, parseTodo };
