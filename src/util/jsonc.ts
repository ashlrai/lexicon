/**
 * Read and edit JSON config files the way a person wrote them: JSON with
 * comments and trailing commas (JSONC, what VS Code's mcp.json and many hand
 * edited configs hold) parses, and an edit rewrites only the values that
 * changed, so every byte outside the keys this tool owns (other servers,
 * comments, indentation, a one-line array) is kept as it was. Rewriting the
 * whole file through JSON.stringify reformatted a user's 4-space config and
 * expanded every inline array, and JSON.parse refused a file with a comment.
 */

/** A parsed value with the span of text it came from. */
type Node =
  | { kind: 'object'; start: number; end: number; members: Member[] }
  | { kind: 'array'; start: number; end: number; items: Node[] }
  | { kind: 'scalar'; start: number; end: number; value: unknown };

interface Member {
  key: string;
  keyStart: number;
  value: Node;
}

class Scanner {
  i = 0;
  constructor(readonly text: string) {}

  fail(what: string): never {
    const before = this.text.slice(0, this.i);
    const line = before.split('\n').length;
    const column = this.i - before.lastIndexOf('\n');
    throw new Error(`${what} at line ${line} column ${column}`);
  }

  /** Skip whitespace and comments. */
  skip(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '/' && t[this.i + 1] === '/') {
        while (this.i < t.length && t[this.i] !== '\n') this.i++;
      } else if (c === '/' && t[this.i + 1] === '*') {
        const close = t.indexOf('*/', this.i + 2);
        if (close < 0) this.fail('unterminated comment');
        this.i = close + 2;
      } else return;
    }
  }

  value(): Node {
    this.skip();
    const start = this.i;
    const c = this.text[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return { kind: 'scalar', start, end: this.stringEnd(), value: JSON.parse(this.text.slice(start, this.i)) as unknown };
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.i, this.i + 400));
    if (!m) this.fail(this.i >= this.text.length ? 'unexpected end of input' : `unexpected ${JSON.stringify(c)}`);
    this.i += m[0].length;
    return { kind: 'scalar', start, end: this.i, value: JSON.parse(m[0]) as unknown };
  }

  /** Advance past a string literal starting at `i`; returns its end. */
  stringEnd(): number {
    const t = this.text;
    this.i++;
    while (this.i < t.length) {
      const c = t[this.i];
      if (c === '\\') this.i += 2;
      else if (c === '"') return ++this.i;
      else if (c === '\n') break;
      else this.i++;
    }
    return this.fail('unterminated string');
  }

  object(): Node {
    const start = this.i++;
    const members: Member[] = [];
    for (;;) {
      this.skip();
      if (this.text[this.i] === '}') return { kind: 'object', start, end: ++this.i, members };
      if (this.text[this.i] !== '"') this.fail('expected a property name or "}"');
      const keyStart = this.i;
      this.stringEnd();
      const key = JSON.parse(this.text.slice(keyStart, this.i)) as string;
      this.skip();
      if (this.text[this.i] !== ':') this.fail('expected ":"');
      this.i++;
      const value = this.value();
      // A repeated key: the last one wins, as JSON.parse has it.
      const at = members.findIndex((m) => m.key === key);
      if (at >= 0) members.splice(at, 1);
      members.push({ key, keyStart, value });
      this.skip();
      if (this.text[this.i] === ',') this.i++;
      else if (this.text[this.i] !== '}') this.fail('expected "," or "}"');
    }
  }

  array(): Node {
    const start = this.i++;
    const items: Node[] = [];
    for (;;) {
      this.skip();
      if (this.text[this.i] === ']') return { kind: 'array', start, end: ++this.i, items };
      items.push(this.value());
      this.skip();
      if (this.text[this.i] === ',') this.i++;
      else if (this.text[this.i] !== ']') this.fail('expected "," or "]"');
    }
  }
}

function parseTree(text: string): Node {
  const s = new Scanner(text);
  const root = s.value();
  s.skip();
  if (s.i < text.length) s.fail('unexpected text after the end');
  return root;
}

function toValue(node: Node): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'array') return node.items.map(toValue);
  const out: Record<string, unknown> = {};
  for (const m of node.members) {
    // A key such as "__proto__" stays an own property, as JSON.parse makes it.
    Object.defineProperty(out, m.key, { value: toValue(m.value), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Parse JSON that may hold `//` and `/* *\/` comments and trailing commas.
 * Throws an Error naming the line and column of the first problem.
 */
export function parseJsonc(text: string): unknown {
  return toValue(parseTree(text));
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The whitespace a member line of the file is indented by, one level: tabs or the smallest run of spaces. */
function indentUnit(text: string): string {
  let unit: string | undefined;
  for (const m of text.matchAll(/\n([ \t]+)\S/g)) {
    const ws = m[1] as string;
    if (ws.startsWith('\t')) return '\t';
    if (unit === undefined || ws.length < unit.length) unit = ws;
  }
  return unit ?? '  ';
}

/** The leading whitespace of the line `at` sits on. */
function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** `value` as JSON at an indentation of `indent`, its first line not indented. */
function render(value: unknown, unit: string, indent: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

/** True when `node` spans more than one line. */
function multiline(text: string, node: Node): boolean {
  return text.slice(node.start, node.end).includes('\n');
}

/** Past the spaces and comments that end the line `at` is on (a comment there belongs to what precedes it). */
function endOfLineComments(text: string, at: number): number {
  let i = at;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      return nl < 0 ? text.length : nl;
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || text.slice(i, close).includes('\n')) return at;
      i = close + 2;
      continue;
    }
    return text[i] === '\n' || text[i] === '\r' || i >= text.length ? i : at;
  }
}

/**
 * Edits that add `entries` (rendered element texts) at the end of the
 * container `node` (an object's members or an array's items), whose last
 * child ends at `lastEnd` (undefined when it is empty).
 */
function appendTo(text: string, node: Node, entries: string[], lastEnd: number | undefined, unit: string, firstChildStart: number | undefined): Edit[] {
  const close = node.end - 1;
  const outer = lineIndent(text, node.start);
  if (lastEnd === undefined) {
    if (!multiline(text, node) && entries.length === 1 && !entries[0]?.includes('\n')) {
      return [{ start: node.start + 1, end: close, text: ` ${entries[0]} ` }];
    }
    const inner = outer + unit;
    return [{ start: node.start + 1, end: close, text: `\n${entries.map((e) => inner + e).join(',\n')}\n${outer}` }];
  }
  // After the last child, and after a trailing comma when the file has one.
  const scan = new Scanner(text);
  scan.i = lastEnd;
  scan.skip();
  const trailing = text[scan.i] === ',';
  const after = trailing ? scan.i + 1 : lastEnd;
  if (!multiline(text, node)) {
    const body = entries.join(', ');
    return [trailing ? { start: after, end: after, text: ` ${body},` } : { start: after, end: after, text: `, ${body}` }];
  }
  const inner = firstChildStart !== undefined ? lineIndent(text, firstChildStart) : outer + unit;
  const lines = entries.map((e) => `\n${inner}${e}`).join(',');
  // A comment closing the last child's line stays on that line.
  const at = endOfLineComments(text, after);
  if (trailing) return [{ start: at, end: at, text: `${lines},` }];
  return at === after ? [{ start: at, end: at, text: `,${lines}` }] : [{ start: at, end: at, text: lines }, { start: after, end: after, text: ',' }];
}

/** A child of an object or array: its text span and whether it stays. */
interface Child {
  start: number;
  end: number;
  keep: boolean;
}

/** The index of the `,` after `at` (past whitespace and comments), or -1. */
function commaAfter(text: string, at: number): number {
  const scan = new Scanner(text);
  scan.i = at;
  scan.skip();
  return text[scan.i] === ',' ? scan.i : -1;
}

/** True when only spaces or tabs sit between the start of `at`'s line and `at`. */
function startsLine(text: string, at: number): boolean {
  return /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));
}

/** Past the end of the line `at` is on and its line break, or undefined when more than comments follow on it. */
function pastLineBreak(text: string, at: number): number | undefined {
  const end = endOfLineComments(text, at);
  if (end >= text.length) return end;
  if (text[end] === '\r' && text[end + 1] === '\n') return end + 2;
  if (text[end] === '\n') return end + 1;
  return undefined;
}

/**
 * Edits that delete the children of `node` marked `keep: false`, leaving every
 * kept child, its comments and the separators around it as they are: a child
 * on its own line goes with its line (and a comment ending that line), one on
 * a shared line with its comma. Null when the result would not read back as
 * the kept children (the caller then writes the container whole).
 */
function removalEdits(text: string, node: Node, children: Child[], expected: unknown): Edit[] | null {
  const edits: Edit[] = [];
  if (children.every((c) => !c.keep)) {
    edits.push({ start: node.start, end: node.end, text: node.kind === 'array' ? '[]' : '{}' });
  } else {
    for (let a = 0; a < children.length; a++) {
      if (children[a]?.keep) continue;
      let b = a;
      while (b + 1 < children.length && !children[b + 1]?.keep) b++;
      const first = children[a] as Child;
      const last = children[b] as Child;
      if (b + 1 < children.length) {
        // A kept child follows: delete the run and the comma after it.
        const comma = commaAfter(text, last.end);
        if (comma < 0) return null;
        const lineEnd = startsLine(text, first.start) ? pastLineBreak(text, comma + 1) : undefined;
        if (lineEnd !== undefined) {
          edits.push({ start: first.start - lineIndent(text, first.start).length, end: lineEnd, text: '' });
        } else {
          let end = comma + 1;
          while (text[end] === ' ' || text[end] === '\t') end++;
          edits.push({ start: first.start, end, text: '' });
        }
      } else {
        // The run ends the container: delete it and the comma before it,
        // unless the file ends its lists with a trailing comma.
        const prev = children[a - 1] as Child;
        const before = commaAfter(text, prev.end);
        if (before < 0) return null;
        const trailing = commaAfter(text, last.end);
        const tail = trailing >= 0 ? trailing + 1 : last.end;
        const lineEnd = startsLine(text, first.start) ? pastLineBreak(text, tail) : undefined;
        if (lineEnd !== undefined) {
          edits.push({ start: first.start - lineIndent(text, first.start).length, end: lineEnd, text: '' });
          if (trailing < 0) edits.push({ start: before, end: before + 1, text: '' });
        } else if (trailing < 0) {
          edits.push({ start: before, end: last.end, text: '' });
        } else {
          let end = tail;
          while (text[end] === ' ' || text[end] === '\t') end++;
          edits.push({ start: first.start, end, text: '' });
        }
      }
      a = b;
    }
  }
  let slice = text.slice(node.start, node.end);
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    slice = slice.slice(0, e.start - node.start) + e.text + slice.slice(e.end - node.start);
  }
  try {
    return same(parseJsonc(slice), expected) ? edits : null;
  } catch {
    return null;
  }
}

/** Collect the edits that turn `node` (holding `old`) into `next`. */
function diff(text: string, node: Node, next: unknown, unit: string, edits: Edit[]): void {
  const old = toValue(node);
  if (same(old, next)) return;
  const indent = lineIndent(text, node.start);
  if (node.kind === 'object' && isPlain(next)) {
    const keys = Object.keys(next);
    const kept = node.members.filter((m) => Object.prototype.hasOwnProperty.call(next, m.key));
    // Keys only removed, the rest in order: delete those members in place.
    if (kept.length < node.members.length && keys.length === kept.length && kept.every((m, i) => keys[i] === m.key)) {
      const expected = Object.fromEntries(kept.map((m) => [m.key, toValue(m.value)]));
      const children = node.members.map((m) => ({ start: m.keyStart, end: m.value.end, keep: kept.includes(m) }));
      const removal = removalEdits(text, node, children, expected);
      if (removal !== null) {
        edits.push(...removal);
        for (const m of kept) diff(text, m.value, next[m.key], unit, edits);
        return;
      }
    }
    // A removed key or a reordering is not a pure merge: write this value whole.
    if (kept.length !== node.members.length || kept.some((m, i) => keys[i] !== m.key)) {
      edits.push({ start: node.start, end: node.end, text: render(next, unit, indent) });
      return;
    }
    for (const m of node.members) diff(text, m.value, next[m.key], unit, edits);
    const added = keys.slice(node.members.length);
    if (added.length > 0) {
      const first = node.members[0];
      const memberIndent = first ? lineIndent(text, first.keyStart) : indent + unit;
      const compact = first !== undefined && !multiline(text, node);
      const entries = added.map((k) => `${JSON.stringify(k)}: ${compact ? JSON.stringify(next[k]) : render(next[k], unit, memberIndent)}`);
      const last = node.members[node.members.length - 1];
      edits.push(...appendTo(text, node, entries, last?.value.end, unit, first?.keyStart));
    }
    return;
  }
  if (node.kind === 'array' && Array.isArray(next) && next.length < node.items.length) {
    // Elements only removed, the rest unchanged and in order: delete those in place.
    let j = 0;
    const children = node.items.map((item) => {
      const keep = j < next.length && same(toValue(item), next[j]);
      if (keep) j++;
      return { start: item.start, end: item.end, keep };
    });
    const removal = j === next.length ? removalEdits(text, node, children, next) : null;
    if (removal !== null) {
      edits.push(...removal);
      return;
    }
  }
  if (node.kind === 'array' && Array.isArray(next) && next.length === node.items.length) {
    for (const [i, item] of node.items.entries()) diff(text, item, next[i], unit, edits);
    return;
  }
  if (node.kind === 'array' && Array.isArray(next) && next.length >= node.items.length && node.items.every((item, i) => same(toValue(item), next[i]))) {
    const first = node.items[0];
    const itemIndent = first ? lineIndent(text, first.start) : indent + unit;
    const compact = first !== undefined && !multiline(text, node);
    const entries = next.slice(node.items.length).map((v) => (compact ? JSON.stringify(v) : render(v, unit, itemIndent)));
    const last = node.items[node.items.length - 1];
    edits.push(...appendTo(text, node, entries, last?.end, unit, first?.start));
    return;
  }
  edits.push({ start: node.start, end: node.end, text: render(next, unit, indent) });
}

/**
 * `text` (JSON or JSONC) rewritten to hold `next`, changing only what
 * differs: a changed value is replaced in place, a new key or array element
 * is added after the last one in the file's own indentation (and trailing
 * comma style), and everything else, comments included, is kept byte for
 * byte. A removed key or array element is deleted with its line (or its
 * comma on a shared line), comments around it kept; keys reordered, or
 * removed and added at once, make that object be written whole. Falls
 * back to plain 2-space JSON when `text` is empty or the edited text would
 * not read back as `next`.
 */
export function editJsonText(text: string, next: unknown): string {
  const plain = `${JSON.stringify(next, null, 2)}\n`;
  if (text.trim() === '') return plain;
  let tree: Node;
  try {
    tree = parseTree(text);
  } catch {
    return plain;
  }
  const edits: Edit[] = [];
  diff(text, tree, next, indentUnit(text), edits);
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  try {
    if (same(parseJsonc(out), next)) return out;
  } catch {
    // fall through
  }
  return plain;
}
