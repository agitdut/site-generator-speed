// solve.js — a faster drop-in replacement for makefun-site 1.0.0.
//
// Written from the bounty README spec (site-generator-speed-01): a static
// site generator whose run(input) must return, byte for byte, the same output
// tree the reference produces. Speed comes from three places:
//   1. the inline Markdown renderer scans plain text in chunks instead of
//      escaping one character at a time;
//   2. the Markdown lexer dispatches on the first character instead of
//      running six regular expressions per line;
//   3. the front-matter parser scans line boundaries with indexOf instead of
//      splitting the whole file (bodies can be large).
// Everything else is written to match the reference's semantics exactly:
// error strings, refusal reasons, sort orders, slug rules, link resolution.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longDate(date) {
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The same slug rule as the reference: NFKD, strip combining marks, keep
 *  a-z0-9, collapse runs of anything else into one '-', cap at 64 chars. */
function slugify(text) {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= "A" && ch <= "Z") keep = ch.toLowerCase();
    else if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += "-";
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, "");
  return out === "" ? "untitled" : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  const out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------------------
// Front matter. A strict subset of YAML block mappings: seven known keys,
// each with its own value grammar. Returns { data, body } or { error } with
// the first reason the file is refused. Only the front-matter region is
// split into lines; the body is sliced, never split.
// ---------------------------------------------------------------------------

const FRONT_MATTER_KEYS = ["title", "date", "tags", "draft", "layout", "slug", "summary"];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: "a quoted string is not closed" };
    let out = "";
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === "\\") {
        const n = raw[i + 1];
        if ((n !== '"' && n !== "\\") || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: "a quoted string holds a stray quote" };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith("[")) return { error: "a bare string opens on [" };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case "title":
    case "summary": {
      const s = stringOf(raw);
      return "error" in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case "date": {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case "tags": {
      if (!raw.startsWith("[") || !raw.endsWith("]")) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === "") return { value: [] };
      const tags = inner.split(",").map((t) => t.trim());
      if (tags.some((t) => t === "" || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case "draft":
      return raw === "true" ? { value: true } : raw === "false" ? { value: false } : { error: 'key "draft": true or false' };
    case "layout":
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case "slug":
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const firstNl = text.indexOf("\n");
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== "---") return { error: "no front matter" };
  // Find the closing "---" line by walking line boundaries.
  let closeLineStart = -1;
  let closeLineEnd = -1;
  let scan = firstNl === -1 ? text.length : firstNl + 1;
  while (scan <= text.length) {
    const nl = text.indexOf("\n", scan);
    const line = nl === -1 ? text.slice(scan) : text.slice(scan, nl);
    if (line === "---") {
      closeLineStart = scan;
      closeLineEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    scan = nl + 1;
  }
  if (closeLineStart === -1) return { error: "the front matter is not closed" };
  const region = text.slice(firstNl + 1, closeLineStart);
  const dataLines = region === "" ? [] : region.slice(0, -1).split("\n");
  const data = {};
  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith("#")) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? "").replace(/[ \t]+$/, "");
    if (!FRONT_MATTER_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === "") return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ("error" in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, "title")) return { error: "no title" };
  return { data, body: text.slice(closeLineEnd) };
}

// ---------------------------------------------------------------------------
// Markdown. The lexer dispatches on the first character of each line; the
// inline renderer escapes plain text in whole chunks between markers.
// ---------------------------------------------------------------------------

const ESCAPABLE = new Set("\\`*_[]()#+-.!>");

function findUnescaped(s, what, from) {
  for (let j = from; j + what.length <= s.length; j++) {
    if (s[j] === "\\" && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\" && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s[j] === "*") {
      if (s[j + 1] === "*") {
        j++;
        continue;
      }
      return j;
    }
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[]/g;

function inline(s, env) {
  const parts = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const next = m ? m.index : n;
    if (next > i) parts.push(escapeHtml(s.slice(i, next)));
    if (next === n) break;
    i = next;
    const c = s[i];
    if (c === "\\" && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      parts.push(escapeHtml(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        parts.push("<code>", escapeHtml(s.slice(i + 1, j)), "</code>");
        i = j + 1;
      } else {
        parts.push("`");
        i++;
      }
      continue;
    }
    if (c === "*") {
      if (s[i + 1] === "*") {
        const j = findUnescaped(s, "**", i + 2);
        if (j > i + 2) {
          parts.push("<strong>", inline(s.slice(i + 2, j), env), "</strong>");
          i = j + 2;
        } else {
          parts.push("**");
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        parts.push("<em>", inline(s.slice(i + 1, j), env), "</em>");
        i = j + 1;
      } else {
        parts.push("*");
        i++;
      }
      continue;
    }
    if (c === "[") {
      const k = findUnescaped(s, "]", i + 1);
      const closeParen = k !== -1 && s[k + 1] === "(" ? s.indexOf(")", k + 2) : -1;
      const target = closeParen === -1 ? "" : s.slice(k + 2, closeParen);
      if (target !== "" && !/\s/.test(target)) {
        parts.push('<a href="', escapeHtml(env.link(target)), '">');
        parts.push(inline(s.slice(i + 1, k), env), "</a>");
        i = closeParen + 1;
        continue;
      }
      parts.push("[");
      i++;
      continue;
    }
    parts.push(escapeHtml(c));
    i++;
  }
  return parts.join("");
}

const trimLine = (line) => line.replace(/^[ \t]+|[ \t]+$/g, "");

function isBlank(line) {
  if (line === "") return true;
  const c = line[0];
  return (c === " " || c === "\t") && /^[ \t]*$/.test(line);
}

function fenceOpen(line) {
  if (line[0] !== "`") return null;
  return /^```([A-Za-z0-9_+-]*)[ \t]*$/.exec(line);
}

function headingOf(line) {
  if (line[0] !== "#") return null;
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") hashes++;
  if (hashes === 0 || hashes > 6) return null;
  if (hashes >= line.length || (line[hashes] !== " " && line[hashes] !== "\t")) return null;
  let start = hashes;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  let end = line.length;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  if (end === start) return null;
  return { level: hashes, text: line.slice(start, end) };
}

function isHr(line) {
  const c = line[0];
  if (c !== "-" && c !== "*") return false;
  return /^(?:---|\*\*\*)[ \t]*$/.test(line);
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

function lex(src) {
  const lines = src.split("\n");
  const tokens = [];
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const body = [];
      i++;
      while (i < L && !/^```[ \t]*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < L) i++;
      tokens.push({ kind: "code", lang: fence[1], lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      tokens.push({ kind: "heading", ...heading });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ kind: "hr" });
      i++;
      continue;
    }
    if (line[0] === ">") {
      const body = [];
      while (i < L && lines[i][0] === ">") {
        const l = lines[i];
        body.push(l.slice(1).startsWith(" ") ? l.slice(2) : l.slice(1));
        i++;
      }
      const text = body.map(trimLine).filter((x) => x !== "").join("\n");
      tokens.push({ kind: "quote", text });
      continue;
    }
    const first = line[0];
    const bullet = first === "-" || first === "*" ? /^[-*] (.*)$/.exec(line) : null;
    const ordered = bullet === null && first >= "0" && first <= "9" ? /^(\d{1,9})\. (.*)$/.exec(line) : null;
    if (bullet || ordered) {
      const marker = ordered ? /^(\d{1,9})\. (.*)$/ : /^[-*] (.*)$/;
      const start = ordered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < L) {
        const m = marker.exec(lines[i]);
        if (m) {
          items.push([trimLine(m[ordered ? 2 : 1])]);
          i++;
          continue;
        }
        if (items.length > 0 && /^ {2,}\S/.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
          continue;
        }
        break;
      }
      tokens.push({ kind: "list", ordered: !!ordered, start, items: items.map((parts) => parts.join("\n")) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    tokens.push({ kind: "paragraph", text: body.join("\n") });
  }
  return tokens;
}

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = "";
  for (const t of lex(src)) {
    if (t.kind === "paragraph") {
      const html = inline(t.text, env);
      if (excerpt === "") excerpt = html;
      out.push(`<p>${html}</p>`);
    } else if (t.kind === "heading") {
      const id = uniqueSlug(slugify(t.text), ids);
      const html = inline(t.text, env);
      if (t.level === 2 || t.level === 3) toc.push({ level: t.level, id, html });
      out.push(`<h${t.level} id="${id}">${html}</h${t.level}>`);
    } else if (t.kind === "hr") {
      out.push("<hr>");
    } else if (t.kind === "code") {
      const lang = t.lang === "" ? "" : ` class="language-${escapeHtml(t.lang)}"`;
      out.push(`<pre><code${lang}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join("")}</code></pre>`);
    } else if (t.kind === "quote") {
      out.push(
        t.text === ""
          ? "<blockquote>\n</blockquote>"
          : `<blockquote>\n<p>${inline(t.text, env)}</p>\n</blockquote>`,
      );
    } else if (t.kind === "list") {
      const tag = t.ordered ? "ol" : "ul";
      const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      out.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join("")}</${tag}>`);
    }
  }
  return { html: out.map((b) => `${b}\n`).join(""), toc, excerpt };
}

// ---------------------------------------------------------------------------
// Templates. Tokenizer and parser keep the reference's exact error strings;
// the renderer pushes fragments into an array instead of concatenating
// strings node by node.
// ---------------------------------------------------------------------------

class TemplateError extends Error {
  constructor(name, reason) {
    super(`template "${name}": ${reason}`);
    this.name = "TemplateError";
  }
}

function pathOf(name, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) {
    throw new TemplateError(name, `${JSON.stringify(text)} is not a path`);
  }
  return text.split(".");
}

function tokenize(name, src) {
  const tokens = [];
  let text = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== "{" && next !== "%") {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === "{") {
      const raw = src[open + 2] === "{";
      const close = src.indexOf(raw ? "}}}" : "}}", open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(name, `a ${raw ? "{{{" : "{{"} is not closed`);
      }
      if (text !== "") tokens.push({ kind: "text", text });
      text = "";
      tokens.push({
        kind: raw ? "raw" : "var",
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf("%}", open + 2);
    if (close === -1) throw new TemplateError(name, "a {% is not closed");
    const end = close + 2;
    const lineStart = src.lastIndexOf("\n", open - 1) + 1;
    const nl = src.indexOf("\n", end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
    tokens.push({ kind: "tag", tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== "") tokens.push({ kind: "text", text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: "root", body: [] };
  const stack = [root];
  let body = root.body;
  for (const token of tokenize(name, src)) {
    if (token.kind === "text") {
      if (token.text !== "") body.push({ kind: "text", text: token.text });
    } else if (token.kind === "var" || token.kind === "raw") {
      body.push({ kind: token.kind, path: token.path });
    } else {
      const tag = token.tag;
      const top = stack[stack.length - 1];
      if (tag.startsWith("for ")) {
        const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag);
        if (!m) throw new TemplateError(name, `{% ${tag} %} is not a tag`);
        const node = { kind: "for", name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if (tag.startsWith("if ")) {
        const m = /^if (not )?(\S+)$/.exec(tag);
        if (!m) throw new TemplateError(name, `{% ${tag} %} is not a tag`);
        const node = {
          kind: "if",
          path: pathOf(name, m[2]),
          not: m[1] === "not ",
          then: [],
          else: null,
        };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === "else") {
        if (top.kind !== "if" || top.else !== null) {
          throw new TemplateError(name, "an else outside an if");
        }
        top.else = [];
        body = top.else;
      } else if (tag === "endfor" || tag === "endif") {
        const kind = tag.slice(3);
        if (top.kind !== kind) {
          throw new TemplateError(name, `an ${tag} with no open ${kind}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === "root" ? parent.body : parent.kind === "for" ? parent.body : parent.else ?? parent.then;
      } else if (tag.startsWith("include ")) {
        const m = /^include "([a-z0-9-]+)"$/.exec(tag);
        if (!m) throw new TemplateError(name, `{% ${tag} %} is not a tag`);
        body.push({ kind: "include", name: m[1] });
      } else {
        throw new TemplateError(name, `{% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(name, `a ${top.kind} is not closed`);
  }
  return root.body;
}

function lookup(scope, path) {
  let current = scope;
  while (current !== null) {
    if (Object.hasOwn(current.vars, path[0])) {
      let value = current.vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, path[k])) {
          return undefined;
        }
        value = value[path[k]];
      }
      return value;
    }
    current = current.parent;
  }
  return undefined;
}

function textOf(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textOf).join(", ");
  return "";
}

function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return true;
  return !!v;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    if (n.kind === "text") {
      out.push(n.text);
    } else if (n.kind === "var") {
      out.push(ctx.escape(textOf(lookup(scope, n.path))));
    } else if (n.kind === "raw") {
      out.push(textOf(lookup(scope, n.path)));
    } else if (n.kind === "if") {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === "for") {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          renderNodes(
            n.body,
            {
              vars: {
                [n.name]: xs[k],
                loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
              },
              parent: scope,
            },
            ctx,
            depth,
            out,
          );
        }
      }
    } else if (n.kind === "include") {
      const template = ctx.templates.get(n.name);
      if (template !== undefined && depth < 8) {
        renderNodes(template, scope, ctx, depth + 1, out);
      }
    }
  }
}

function renderTemplate(nodes, scope, ctx) {
  const out = [];
  renderNodes(nodes, scope, ctx, 0, out);
  return out.join("");
}

// ---------------------------------------------------------------------------
// The build pipeline. Same phases as the reference, in the same order:
// readSources -> frontMatter -> permalinks -> markdown -> collections ->
// tags -> layouts. Every refusal, report line and sort order matches.
// ---------------------------------------------------------------------------

const RESERVED = ["posts", "tags", "page"];
const REPORT_FILE = "build-report.txt";

function dirOf(path) {
  const k = path.lastIndexOf("/");
  return k === -1 ? "" : path.slice(0, k);
}

function resolvePath(dir, rel) {
  const parts = dir === "" ? [] : dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function ownTags(source) {
  const seen = new Set();
  const out = [];
  for (const name of source.data.tags ?? []) {
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

function linkOf(source) {
  if (source === null) return null;
  return {
    title: source.data.title,
    url: source.url,
    date: source.data.date ?? "",
    date_long: source.data.date === undefined ? "" : longDate(source.data.date),
  };
}

function cardOf(source) {
  return {
    title: source.data.title,
    url: source.url,
    date: source.data.date ?? "",
    date_long: source.data.date === undefined ? "" : longDate(source.data.date),
    summary: source.data.summary ?? "",
    excerpt: source.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(source.body) / 200)),
    tags: source.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function build(input) {
  const report = [];
  const files = [...(input.files ?? [])].sort((a, b) => byCodeUnits(a.path, b.path));
  const bySource = new Map();
  const staticPaths = new Set();
  const sources = [];
  const statics = [];

  for (const f of files) {
    if (f.path.endsWith(".md")) {
      const s = { path: f.path, raw: f.content.replace(/\r\n?/g, "\n"), data: null, body: "" };
      sources.push(s);
    } else {
      staticPaths.add(f.path);
      statics.push(f);
    }
  }

  // Templates: parse once, in code-unit order of name. A template that does
  // not parse is absent, so a source naming it is refused below.
  const templates = new Map();
  const templateNames = Object.keys(input.templates ?? {}).sort(byCodeUnits);
  for (const name of templateNames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) {
        report.push(e.message);
        continue;
      }
      throw e;
    }
  }

  // Front matter: parse, refuse, drop drafts.
  const live = [];
  for (const s of sources) {
    const parsed = parseFrontMatter(s.raw);
    if ("error" in parsed) {
      report.push(`refused ${s.path}: ${parsed.error}`);
      continue;
    }
    s.data = parsed.data;
    s.body = parsed.body;
    s.post = s.path.startsWith("posts/");
    const own = RESERVED.find((d) => d !== "posts" && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, "date")) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? "post" : "page");
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    live.push(s);
  }

  // Permalinks.
  const takenIn = new Map();
  const takeFrom = (dir) => {
    if (!takenIn.has(dir)) takenIn.set(dir, new Set(dir === "" ? RESERVED : []));
    return takenIn.get(dir);
  };
  for (const s of live) {
    const dir = s.post ? "posts" : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takeFrom(dir));
    s.slug = slug;
    s.outDir = dir === "" ? slug : `${dir}/${slug}`;
    s.url = `${input.site.base_url.replace(/\/+$/, "")}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const base = input.site.base_url.replace(/\/+$/, "");

  // Markdown: render each source, resolving links against the site.
  const broken = new Set();
  for (const s of live) {
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("/") || target.startsWith("#")) {
          return target;
        }
        const hash = target.indexOf("#");
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? "" : target.slice(hash);
        const path = rel === "" ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdown(s.body, env);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  // Collections: posts newest first, then slug.
  const posts = live
    .filter((s) => s.post)
    .sort((a, b) => byCodeUnits(b.data.date, a.data.date) || byCodeUnits(a.slug, b.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: first spelling kept, counted in collection order, sorted by count
  // then slug. Every source (post or page) gets tagRefs.
  const bySlug = new Map();
  const tags = [];
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
        tags.push(tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of live) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(
        (name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: "", posts: [] },
      );
    }
  }
  tags.sort((a, b) => b.posts.length - a.posts.length || byCodeUnits(a.slug, b.slug));

  // Layouts.
  const output = {};
  const ctx = { templates, escape: escapeHtml };
  const site = { title: input.site.title ?? "", base_url: base };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderTemplate(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx);
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  for (const s of live) {
    const layout = s.data.layout ?? (s.post ? "post" : "page");
    output[`${s.outDir}/index.html`] = render(layout, { page: pageOf(s) });
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const pager = {
      number: k,
      total: pages,
      url: indexUrl(k),
      newer_url: k === 1 ? "" : indexUrl(k - 1),
      older_url: k === pages ? "" : indexUrl(k + 1),
    };
    const html = render("index", {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager,
    });
    if (html !== null) output[k === 1 ? "index.html" : `page/${k}/index.html`] = html;
  }

  for (const t of tags) {
    const html = render("tag", {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render("tags", {});
  if (tagsHtml !== null) output["tags/index.html"] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
      continue;
    }
    output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(
    `built ${live.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`,
  );
  output[REPORT_FILE] = `${lines.join("\n")}\n`;
  return output;
}

export function run(input) {
  return build(input);
}
