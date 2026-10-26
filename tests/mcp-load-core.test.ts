/**
 * Every MCP path that touches the lexicon core awaits loadCore() first.
 * This reads the source. It does not time anything.
 *
 * Tool handlers are `guarded(...)`, and guarded awaits loadCore() before the
 * body. Resources and prompts that read a lexicon go through `load`, which
 * awaits loadCore() before loadLexicon. coreFn bindings and the helpers that
 * call core() are only invoked from those bodies.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'src/mcp');

interface Call {
  start: number;
  open: number;
  end: number;
  args: string;
}

function identChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

function wordBefore(src: string, j: number): string {
  let k = j;
  while (k >= 0 && identChar(src[k])) k -= 1;
  return src.slice(k + 1, j + 1);
}

/** `/` begins a regex when the previous token cannot end an expression. */
function startsRegex(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t')) j -= 1;
  if (j < 0) return true;
  const prev = src[j] ?? '';
  if ('(,=?:!&|{;[~^+->'.includes(prev)) return true;
  if (identChar(prev)) {
    const word = wordBefore(src, j);
    return word === 'return' || word === 'throw' || word === 'case' || word === 'typeof' || word === 'void' || word === 'delete' || word === 'await' || word === 'in' || word === 'of' || word === 'yield' || word === 'else';
  }
  return false;
}

function skipRegex(src: string, i: number): number {
  i += 1;
  let inClass = false;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) {
      i += 1;
      while (identChar(src[i])) i += 1;
      return i;
    } else if (src[i] === '\n') return i;
    i += 1;
  }
  return i;
}

/** Index after a comment, string, template or regex that starts at `i`, or `i` when it does not. */
function skipAtom(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl + 1;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === '/' && startsRegex(src, i)) return skipRegex(src, i);
  if (c === "'" || c === '"') return skipString(src, i);
  if (c === '`') return skipTemplate(src, i);
  return i;
}

function skipString(src: string, i: number): number {
  const q = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === q) return i + 1;
    i += 1;
  }
  return i;
}

function matchDelim(src: string, openIndex: number): number {
  const open = src[openIndex];
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  if (close === undefined || (open !== '(' && open !== '{' && open !== '[')) throw new Error(`not a delimiter at ${openIndex}`);
  let depth = 1;
  let i = openIndex + 1;
  while (i < src.length) {
    const next = skipAtom(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = src[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`unbalanced ${open} at ${openIndex}`);
}

function skipTemplate(src: string, i: number): number {
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i = matchDelim(src, i + 1) + 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Calls of `callee` outside strings and comments. `callee` may contain dots. */
function findCalls(src: string, callee: string): Call[] {
  const found: Call[] = [];
  let i = 0;
  while (i < src.length) {
    const next = skipAtom(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (src.startsWith(callee, i) && !identChar(src[i - 1]) && !identChar(src[i + callee.length])) {
      let j = i + callee.length;
      while (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t') j += 1;
      if (src[j] === '(') {
        const end = matchDelim(src, j);
        found.push({ start: i, open: j, end, args: src.slice(j + 1, end) });
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < args.length) {
    const next = skipAtom(args, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = args[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = args.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function arrowBody(handler: string): string {
  let i = 0;
  while (i < handler.length) {
    const next = skipAtom(handler, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (handler.startsWith('=>', i)) return handler.slice(i + 2).trim();
    i += 1;
  }
  throw new Error(`no arrow in handler: ${handler.slice(0, 80)}`);
}

function inside(index: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([from, to]) => index >= from && index <= to);
}

function toolFiles(): string[] {
  return readdirSync(path.join(MCP, 'tools'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(MCP, 'tools', name));
}

function mcpSources(): string[] {
  const files = [path.join(MCP, 'server.ts'), path.join(MCP, 'shared.ts')];
  return files.concat(toolFiles());
}

function coreFnNames(src: string): string[] {
  return [...src.matchAll(/const (\w+) = coreFn\(/g)].map((match) => match[1] ?? '');
}

/**
 * The `{` that opens a function body. Return types in this tree put that brace
 * at the end of a line (`: string {`, `}> {`). A `{` inside the return type
 * (`Promise<{ ... }>`) is not.
 */
function bodyOpen(src: string, afterParams: number): number {
  let i = afterParams;
  while (i < src.length) {
    if (src[i] === '{') {
      let j = i + 1;
      while (src[j] === ' ' || src[j] === '\t' || src[j] === '\r') j += 1;
      if (src[j] === '\n' || j >= src.length) return i;
    }
    i += 1;
  }
  return -1;
}

interface Fn {
  file: string;
  name: string;
  exported: boolean;
  /** Index of the `function` keyword, so the signature is not a call of `name`. */
  signature: number;
  bodyStart: number;
  bodyEnd: number;
}

/** `function name(` and `async function name(` bodies. */
function functionRanges(file: string, src: string): Fn[] {
  const out: Fn[] = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^;{]*>)?\s*\(/g;
  for (const match of src.matchAll(re)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    const paren = src.indexOf('(', match.index);
    const afterParams = matchDelim(src, paren) + 1;
    const open = bodyOpen(src, afterParams);
    if (open < 0) continue;
    out.push({
      file,
      name,
      exported: match[0].startsWith('export'),
      signature: match.index,
      bodyStart: open,
      bodyEnd: matchDelim(src, open),
    });
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Index of `=>` after a parameter list, skipping a return type. -1 when this is not an arrow. */
function arrowAfter(src: string, i: number): number {
  let angle = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  while (i < src.length) {
    const next = skipAtom(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const flat = angle + brace + paren + bracket === 0;
    if (src.startsWith('=>', i) && flat) return i;
    const c = src[i];
    if (c === '<') angle += 1;
    else if (c === '>') {
      if (angle === 0) return -1;
      angle -= 1;
    } else if (c === '{') brace += 1;
    else if (c === '}') {
      if (brace === 0) return -1;
      brace -= 1;
    } else if (c === '(') paren += 1;
    else if (c === ')') {
      if (paren === 0) return -1;
      paren -= 1;
    } else if (c === '[') bracket += 1;
    else if (c === ']') {
      if (bracket === 0) return -1;
      bracket -= 1;
    } else if ((c === ';' || c === '\n') && flat) return -1;
    i += 1;
  }
  return -1;
}

function expressionEnd(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const next = skipAtom(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return i;
    i += 1;
  }
  return src.length;
}

/** `const name = (...) =>` bodies, including ones nested in a registrar. */
function arrowRanges(file: string, src: string): Fn[] {
  const out: Fn[] = [];
  const re = /const (\w+) = (?:async\s*)?\(/g;
  for (const match of src.matchAll(re)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    const paren = match.index + match[0].length - 1;
    let afterParams: number;
    try {
      afterParams = matchDelim(src, paren) + 1;
    } catch {
      continue;
    }
    const arrow = arrowAfter(src, afterParams);
    if (arrow < 0) continue;
    let bodyStart = arrow + 2;
    while (src[bodyStart] === ' ' || src[bodyStart] === '\n' || src[bodyStart] === '\r' || src[bodyStart] === '\t') bodyStart += 1;
    let bodyEnd: number;
    try {
      bodyEnd = src[bodyStart] === '{' ? matchDelim(src, bodyStart) : expressionEnd(src, bodyStart);
    } catch {
      continue;
    }
    out.push({ file, name, exported: false, signature: match.index, bodyStart, bodyEnd });
  }
  return out;
}

describe('loadCore is awaited on every MCP path', () => {
  it('core() throws until loadCore() resolves, then returns that module', async () => {
    const { core, loadCore, shellWord } = await import('../src/mcp/shared.js');
    expect(shellWord("O'Brien")).toBe("'O'\\''Brien'");
    expect(() => core()).toThrow(/loadCore\(\) must be awaited/);
    const loaded = await loadCore();
    expect(typeof loaded.loadLexicon).toBe('function');
    expect(core()).toBe(loaded);
  });

  it('keeps MCP shell hints consistent with the shared core quoting API', async () => {
    const { loadCore, shellWord } = await import('../src/mcp/shared.js');
    const loaded = await loadCore();
    for (const value of ['/safe/repo', '/a repo', "/Mason's repo", '$(touch unwanted)', '']) {
      expect(shellWord(value), value).toBe(loaded.posixShellWord(value));
    }
    expect(shellWord('/safe/repo')).toBe('/safe/repo');
    expect(shellWord('/a repo')).toBe("'/a repo'");
    expect(shellWord('$(touch unwanted)')).toBe("'$(touch unwanted)'");
  });

  it('guarded awaits loadCore before the tool body', () => {
    const src = readFileSync(path.join(MCP, 'shared.ts'), 'utf8');
    const start = src.indexOf('export async function guarded');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('\n}', start));
    const awaited = body.indexOf('await loadCore()');
    const ran = body.indexOf('fn()');
    expect(awaited).toBeGreaterThanOrEqual(0);
    expect(ran).toBeGreaterThan(awaited);
  });

  it('the server load() awaits loadCore before loadLexicon', () => {
    const src = readFileSync(path.join(MCP, 'server.ts'), 'utf8');
    const start = src.indexOf('const load = async');
    const end = src.indexOf('const server = new McpServer');
    const body = src.slice(start, end);
    const awaited = body.indexOf('await loadCore()');
    const ran = body.indexOf('loadLexicon(');
    expect(awaited).toBeGreaterThanOrEqual(0);
    expect(ran).toBeGreaterThan(awaited);
  });

  it('the only value import of the core barrel is the awaited loadCore() import', () => {
    const dynamic: string[] = [];
    for (const file of mcpSources()) {
      const src = readFileSync(file, 'utf8');
      const valueImport = src.match(/import\s+(?!type\b)[^;]*from\s+['"][^'"]*core\/index\.js['"]/);
      expect(valueImport, file).toBeNull();
      for (const call of findCalls(src, 'import')) {
        if (!call.args.includes('core/index.js')) continue;
        // `typeof import(...)` is a type query. It is erased, and it does not load the module.
        const before = src.slice(Math.max(0, call.start - 7), call.start);
        if (before.endsWith('typeof ')) continue;
        dynamic.push(path.basename(file));
      }
    }
    expect(dynamic).toEqual(['shared.ts']);
  });

  it('every tool, resource and prompt reaches the core only after await loadCore()', () => {
    const sources = mcpSources().map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    const fns = sources.flatMap((src) => [...functionRanges(src.file, src.text), ...arrowRanges(src.file, src.text)]);
    const safe = new Map<string, Array<[number, number]>>();
    const addSafe = (file: string, from: number, to: number): void => {
      const list = safe.get(file) ?? [];
      if (list.some(([start, end]) => start === from && end === to)) return;
      list.push([from, to]);
      safe.set(file, list);
    };

    let tools = 0;
    for (const src of sources) {
      for (const call of findCalls(src.text, 'guarded')) addSafe(src.file, call.open, call.end);
      for (const call of findCalls(src.text, 'server.registerTool')) {
        const args = splitArgs(call.args);
        const body = arrowBody(args[args.length - 1] ?? '');
        expect(body.startsWith('guarded('), `${path.basename(src.file)} handler does not start with guarded(): ${body.slice(0, 60)}`).toBe(true);
        tools += 1;
      }
    }
    expect(tools).toBe(21);

    const server = sources.find((src) => src.file.endsWith(`${path.sep}server.ts`));
    expect(server).toBeDefined();
    const handlers = [...findCalls(server?.text ?? '', 'server.registerResource'), ...findCalls(server?.text ?? '', 'server.registerPrompt')];
    expect(handlers).toHaveLength(4);
    const touches = ['lexiconForModel(', 'lexiconJsonWithin(', 'emptyLexiconNote(', 'emptyLexiconSuffix(', 'skippedProjectSuffix(', 'skippedProjectFields(', 'core('];
    for (const call of handlers) {
      const args = splitArgs(call.args);
      const handler = args[args.length - 1] ?? '';
      const at = call.args.lastIndexOf(handler);
      const handlerStart = call.open + 1 + at;
      let touchAt = -1;
      for (const token of touches) {
        const found = handler.indexOf(token);
        if (found >= 0 && (touchAt < 0 || found < touchAt)) touchAt = found;
      }
      const awaited = handler.indexOf('await loadForContext()');
      if (touchAt >= 0) {
        expect(awaited, `handler uses the core before loadForContext(): ${handler.slice(0, 80)}`).toBeGreaterThanOrEqual(0);
        expect(awaited).toBeLessThan(touchAt);
      }
      if (awaited >= 0) addSafe(server?.file ?? '', handlerStart + awaited, call.end);
    }

    const writeOpts = fns.find((fn) => fn.name === 'mcpWriteOpts');
    expect(writeOpts).toBeDefined();
    const writeBody = sources.find((src) => src.file === writeOpts?.file)?.text.slice(writeOpts?.bodyStart, writeOpts?.bodyEnd) ?? '';
    const writeAwait = writeBody.indexOf('await loadCore()');
    expect(writeAwait).toBeGreaterThanOrEqual(0);
    addSafe(writeOpts?.file ?? '', (writeOpts?.bodyStart ?? 0) + writeAwait, writeOpts?.bodyEnd ?? 0);

    const callsOf = (fn: Fn): Array<{ file: string; start: number }> => {
      const hits: Array<{ file: string; start: number }> = [];
      for (const src of sources) {
        if (!fn.exported && src.file !== fn.file) continue;
        for (const call of findCalls(src.text, fn.name)) {
          if (src.file === fn.file && call.start >= fn.signature && call.start <= fn.bodyEnd) continue;
          const before = src.text.slice(Math.max(0, call.start - 20), call.start);
          if (/\bfunction\s+$/.test(before)) continue;
          hits.push({ file: src.file, start: call.start });
        }
      }
      return hits;
    };

    let grew = true;
    while (grew) {
      grew = false;
      for (const fn of fns) {
        const ranges = safe.get(fn.file) ?? [];
        if (ranges.some(([start, end]) => start <= fn.bodyStart && end >= fn.bodyEnd)) continue;
        const calls = callsOf(fn);
        if (calls.length === 0) continue;
        if (calls.every((hit) => inside(hit.start, safe.get(hit.file) ?? []))) {
          addSafe(fn.file, fn.bodyStart, fn.bodyEnd);
          grew = true;
        }
      }
    }

    const coreFnDef = fns.find((fn) => fn.name === 'coreFn');
    const where = (file: string, index: number): string => `${path.relative(ROOT, file)}:${lineOf(sources.find((src) => src.file === file)?.text ?? '', index)}`;
    for (const src of sources) {
      for (const name of coreFnNames(src.text)) {
        for (const call of findCalls(src.text, name)) {
          expect(inside(call.start, safe.get(src.file) ?? []), `${where(src.file, call.start)} calls ${name} before loadCore()`).toBe(true);
        }
      }
      for (const call of findCalls(src.text, 'core')) {
        if (coreFnDef && src.file === coreFnDef.file && call.start >= coreFnDef.bodyStart && call.start <= coreFnDef.bodyEnd) continue;
        const before = src.text.slice(Math.max(0, call.start - 20), call.start);
        if (/\bfunction\s+$/.test(before)) continue;
        expect(inside(call.start, safe.get(src.file) ?? []), `${where(src.file, call.start)} calls core() before loadCore()`).toBe(true);
      }
    }
  });
});
