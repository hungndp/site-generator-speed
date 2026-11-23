// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the same input:
// the output tree as a JSON object of every path it writes and that file's text, byte for byte.
// This is a fresh implementation of the same rules (README.md of makefun-site 1.0.0 is the spec,
// its code the reference where the two differ), written for speed:
//
//   - one single-pass Markdown renderer (no token objects, range-based inline rendering,
//     plain runs escaped in bulk, word counts fused into the line scan)
//   - templates compiled once per case into plain JS functions (flat scope object with
//     save/restore around loops, includes as direct calls)
//   - slug and long-date results memoised per case (titles, tags and headings repeat a lot)
//
// Nothing is cached from one case to the next: every run() starts with fresh memo tables.

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' (README.md). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Memo tables, fresh for every run() (never carried from one case to the next). */
let slugCache = new Map();
let dateCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left.
 */
export function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = s.length > 0;
      continue;
    }
    if (gap) s += '-';
    gap = false;
    s += keep;
  }
  s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  let out = dateCache.get(date);
  if (out !== undefined) return out;
  const [y, m, d] = date.split('-');
  out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, out);
  return out;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. Only the front matter itself is split into lines; the body is sliced out whole.
 */
export function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let cs = text.indexOf('\n---\n', 3);
  let ce;
  if (cs !== -1) {
    cs += 1;
    ce = cs + 3;
  } else if (text.endsWith('\n---')) {
    cs = text.length - 3;
    ce = cs + 3;
  } else return { error: 'the front matter is not closed' };
  const fmLines = text.slice(4, cs).split('\n');
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: ce === text.length ? '' : text.slice(ce + 1) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TARGET_WS = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line[0];
  if (c === undefined) return true;
  if (c === ' ' || c === '\t') return BLANK.test(line);
  if (c === '`') return FENCE_OPEN.test(line);
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether a UTF-16 code unit is whitespace, by JavaScript's \s (all of them live in the BMP). */
function isWS(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
}

/** The words of one line: its runs of characters other than whitespace. */
function wordsInLine(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const w = !isWS(line.charCodeAt(i));
    if (w && !inWord) n++;
    inWord = w;
  }
  return n;
}

/** The first index from `from` (below `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (below `end`; one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[i0..i1)` rendered inline into `out`; `link(target)` is a link's href. Specials are found with one shared
 * /g regex (lastIndex is set explicitly before every exec, so the nested calls cannot disturb the outer scan);
 * only the marked stretches are handled one by one, plain runs are escaped in bulk.
 */
const SPECIAL_RE = /[\\`*[]/g;

function inlineRange(s, i0, i1, link, out) {
  let i = i0;
  SPECIAL_RE.lastIndex = i;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null && m.index < i1) {
    const j = m.index;
    if (j > i) out.push(escapeHtml(s.slice(i, j)));
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < i1 && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === '`') {
      const close = s.indexOf('`', i + 1);
      if (close !== -1 && close < i1 && close > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, close)), '</code>');
        i = close + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const close = findUnescaped(s, '**', i + 2, i1);
        if (close > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, close, link, out);
          out.push('</strong>');
          i = close + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const close = findSingleStar(s, i + 1, i1);
        if (close > i + 1) {
          out.push('<em>');
          inlineRange(s, i + 1, close, link, out);
          out.push('</em>');
          i = close + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else {
      // c === '['
      const closeBracket = findUnescaped(s, ']', i + 1, i1);
      let mm = -1;
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        mm = s.indexOf(')', closeBracket + 2);
        if (mm >= i1) mm = -1;
      }
      if (mm !== -1) {
        const target = s.slice(closeBracket + 2, mm);
        if (target !== '' && !TARGET_WS.test(target)) {
          out.push('<a href="', escapeHtml(link(target)), '">');
          inlineRange(s, i + 1, closeBracket, link, out);
          out.push('</a>');
          i = mm + 1;
        } else {
          out.push('[');
          i++;
        }
      } else {
        out.push('[');
        i++;
      }
    }
    SPECIAL_RE.lastIndex = i;
  }
  if (i < i1) out.push(escapeHtml(s.slice(i, i1)));
}

/** `s` rendered inline, whole. */
function inlineStr(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML), its excerpt (the first paragraph's inline HTML, or "") and its word
 * count (the body's words, counted once here and reused for reading_minutes).
 */
export function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  for (const line of lines) words += wordsInLine(line);
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined) {
      i++;
      continue;
    }
    if ((c0 === ' ' || c0 === '\t') && BLANK.test(line)) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${body.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>\n`);
        continue;
      }
    }
    if (line[0] === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineStr(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if (line[0] === '-' || line[0] === '*') {
      if (HR.test(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') ? BULLET.exec(line) : null;
    const ordered = bullet === null && line[0] >= '0' && line[0] <= '9' ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${html}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The compiled expression for a path: its first name from the flat scope, the rest by optional chaining. */
function pathExpr(path) {
  let e = `env.${path[0]}`;
  for (let k = 1; k < path.length; k++) e += `?.${path[k]}`;
  return e;
}

/**
 * A template's node tree compiled into a render function (out, env, ctx, depth, textOf, truthy, esc, inc).
 * The scope is one flat null-prototype object: loop bodies save and restore the names they bind, includes share it,
 * so a name always reads as the nearest binding, exactly as the scope chain reads it. An include of a template in
 * `cacheable` goes through `inc` (rendered once per entry depth, then cached for the case); any other include is a
 * direct call.
 */
export function compileTemplate(name, nodes, cacheable = new Set()) {
  const code = [];
  let uid = 0;
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') code.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') code.push(`out.push(esc(textOf(${pathExpr(n.path)})));`);
      else if (n.kind === 'raw') code.push(`out.push(textOf(${pathExpr(n.path)}));`);
      else if (n.kind === 'if') {
        code.push(`if(truthy(${pathExpr(n.path)})!==${n.not ? 'true' : 'false'}){`);
        gen(n.then);
        if (n.else !== null) {
          code.push('}else{');
          gen(n.else);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const u = uid++;
        const key = JSON.stringify(n.name);
        code.push(`{const _x${u}=${pathExpr(n.path)};if(Array.isArray(_x${u})){const _l${u}={index:0,first:false,last:false,length:_x${u}.length};const _s${u}=env[${key}];const _t${u}=env.loop;for(let _i${u}=0;_i${u}<_x${u}.length;_i${u}++){_l${u}.index=_i${u}+1;_l${u}.first=_i${u}===0;_l${u}.last=_i${u}===_x${u}.length-1;env[${key}]=_x${u}[_i${u}];env.loop=_l${u};`);
        gen(n.body);
        code.push(`}env[${key}]=_s${u};env.loop=_t${u};}}`);
      } else if (n.kind === 'include') {
        if (cacheable.has(n.name)) {
          code.push(`inc(out,env,ctx,depth,${JSON.stringify(n.name)},textOf,truthy,esc);`);
        } else {
          const u = uid++;
          code.push(`{const _g${u}=ctx.templates.get(${JSON.stringify(n.name)});if(_g${u}!==undefined&&depth<${INCLUDE_DEPTH})_g${u}(out,env,ctx,depth+1,textOf,truthy,esc,inc);}`);
        }
      }
    }
  };
  gen(nodes);
  return new Function('out', 'env', 'ctx', 'depth', 'textOf', 'truthy', 'esc', 'inc', code.join(''));
}

/**
 * An include of a template whose render depends only on the case's constants: rendered once per entry depth and
 * cached for the case, then the cached string is pushed. (A template that is missing, or included past the depth
 * cap, renders nothing, exactly as a plain include does.)
 */
function incCached(out, env, ctx, depth, name, textOf, truthy, esc) {
  if (depth >= INCLUDE_DEPTH) return;
  const fn = ctx.templates.get(name);
  if (fn === undefined) return;
  const key = `${name}|${depth + 1}`;
  let s = ctx.cache.get(key);
  if (s === undefined) {
    const o2 = [];
    fn(o2, env, ctx, depth + 1, textOf, truthy, esc, incCached);
    s = o2.join('');
    ctx.cache.set(key, s);
  }
  out.push(s);
}

/** The top-level names that never change within one case's build. */
const CONST_NAMES = new Set(['site', 'tags', 'recent']);

/**
 * The templates whose render depends only on the case's constants (site, tags, recent) and on nothing a loop binds
 * at any place they are included: those renders are the same string every time at the same include depth, so they
 * may be cached per case. A template is cacheable when its free names (what it reads from its caller's scope,
 * through its own includes) are all constants, and no include site binds one of those names in an enclosing loop.
 * Any include cycle disables caching outright (the analysis cannot prove it sound then).
 */
export function analyzeCacheable(parsed) {
  const freeOf = new Map();
  const edges = [];
  let cyclic = false;
  const stack = [];
  const analyzeNodes = (nodes, bound) => {
    const free = new Set();
    for (const n of nodes) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        for (const v of analyzeNodes(n.then, bound)) free.add(v);
        if (n.else !== null) for (const v of analyzeNodes(n.else, bound)) free.add(v);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        for (const v of analyzeNodes(n.body, b2)) free.add(v);
      } else if (n.kind === 'include') {
        edges.push([n.name, bound]);
        if (stack.includes(n.name)) {
          cyclic = true;
          continue;
        }
        const sub = parsed.get(n.name);
        if (sub === undefined) continue;
        stack.push(n.name);
        for (const v of analyzeNodes(sub, bound)) free.add(v);
        stack.pop();
      }
    }
    return free;
  };
  for (const [name, nodes] of parsed) {
    stack.push(name);
    freeOf.set(name, analyzeNodes(nodes, new Set()));
    stack.pop();
  }
  if (cyclic) return new Set();
  const shadowed = new Set();
  for (const [target, bound] of edges) {
    const tf = freeOf.get(target);
    if (tf === undefined) continue;
    for (const v of tf) if (bound.has(v)) shadowed.add(target);
  }
  const out = new Set();
  for (const [name, free] of freeOf) {
    if (shadowed.has(name)) continue;
    let ok = true;
    for (const v of free) if (!CONST_NAMES.has(v)) { ok = false; break; }
    if (ok) out.add(name);
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(t, cards) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
}

/** The flat scope for one render: the page's values over the shared ones, loop names present but unbound. */
function makeEnv(site, allTags, recent) {
  const env = Object.create(null);
  env.site = site;
  env.tags = allTags;
  env.recent = recent;
  env.page = undefined;
  env.posts = undefined;
  env.pager = undefined;
  env.tag = undefined;
  env.p = undefined;
  env.t = undefined;
  env.h = undefined;
  env.loop = undefined;
  return env;
}

/** One site's output tree: path -> text. */
export function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. Every template parsed, in code-unit order of its name. One that does not parse is reported and left out,
  // as if it were not there. Then the constant templates are found (their renders are cached per case) and every
  // template is compiled.
  const parsed = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const cacheable = analyzeCacheable(parsed);
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(name, nodes, cacheable));

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 3. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, t);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), t);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${spath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 6. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, cache: new Map() };
  const output = {};
  // One scope object for the case: loops save and restore the names they bind, so it returns to its top-level
  // state after every render; only the four varying keys are reset here per render.
  const env = makeEnv(site, allTags, recent);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    env.page = vars.page;
    env.posts = vars.posts;
    env.pager = vars.pager;
    env.tag = vars.tag;
    const out = [];
    fn(out, env, ctx, 0, textOf, truthy, escapeHtml, incCached);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t, cards) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
