import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function testSources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return testSources(file);
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) ? [file] : [];
  });
}

/**
 * Check runtime imports, including helpers, without executing test modules.
 * Strings (including child-process scripts) and comments are data here, but
 * template interpolations are executable. Computed specifiers must originate
 * as URLs; guessing from a variable's name would let a path escape the guard.
 */
function portabilityViolations(source: string): string[] {
  const tokens: Array<{ text: string; index: number; value?: string }> = [];
  const scanner = createScanner(true, undefined, source);
  const templates: number[] = [];
  const parens: string[] = [];
  let depth = 0;
  let previous = '';
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken && /^(?:|[([{=,:;!?&|+*%~^<>-]|return|throw|case|yield|else|=>)$/.test(previous)) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.CloseBraceToken) depth--;
    else if (kind === SyntaxKind.OpenBraceToken) depth++;
    else if (kind === SyntaxKind.TemplateHead) templates.push(depth);
    const token = scanner.getTokenText();
    tokens.push({ text: token, index: scanner.getTokenStart(),
      value: kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral ? scanner.getTokenValue() : undefined });
    if (kind === SyntaxKind.OpenParenToken) parens.push(previous);
    // A regex may begin a statement immediately after a control condition.
    previous = kind === SyntaxKind.CloseParenToken && ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(parens.pop() ?? '') ? 'else' : token;
  }
  const text = (start: number, end: number): string => tokens.slice(start, end).map((token) => token.text).join('');
  const close = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (['(', '[', '{'].includes(token)) stack.push(i);
    else if ([')', ']', '}'].includes(token)) {
      const open = stack.pop();
      if (open !== undefined) close.set(open, i);
    }
  }

  const initializers = new Map<string, Array<[number, number]>>();
  const parameters = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const last = close.get(i);
    if (tokens[i].text === '(' && last !== undefined &&
      (tokens[last + 1]?.text === '=>' || tokens[last + 1]?.text === '{' &&
        !['if', 'while', 'for', 'switch', 'with'].includes(tokens[i - 1]?.text))) {
      for (let j = i + 1; j < last; j++) parameters.add(tokens[j].text);
    }
    if (tokens[i].text === '=>' && tokens[i - 1]?.text !== ')') parameters.add(tokens[i - 1]?.text);
    if (['let', 'var'].includes(tokens[i].text)) parameters.add(tokens[i + 1]?.text);
    if (tokens[i].text !== 'const' || tokens[i + 2]?.text !== '=') continue;
    let end = i + 3;
    while (end < tokens.length && ![';', ','].includes(tokens[end].text)) end = (close.get(end) ?? end) + 1;
    const name = tokens[i + 1].text;
    const ranges = initializers.get(name) ?? [];
    ranges.push([i + 3, end]);
    initializers.set(name, ranges);
  }

  const safe = (start: number, end: number, seen = new Set<string>()): boolean => {
    if (tokens[start]?.text === '(' && close.get(start) === end - 1) return safe(start + 1, end - 1, seen);
    if (end === start + 1 && tokens[start].value !== undefined) {
      const specifier = tokens[start].value;
      // Raw absolute paths work on POSIX but Windows treats C: as a URL scheme.
      return !specifier.includes('${') && !/^(?:[\\/]|[a-z]:)/i.test(specifier);
    }
    const call = tokens[start]?.text === 'pathToFileURL' ? start + 1
      : tokens[start]?.text === 'new' && tokens[start + 1]?.text === 'URL' ? start + 2 : -1;
    const last = close.get(call);
    if (last !== undefined && ['', '.href', '.toString()'].includes(text(last + 1, end))) return true;
    const name = tokens[start]?.text;
    if (name === undefined || seen.has(name) || parameters.has(name) || !['', '.href', '.toString()'].includes(text(start + 1, end))) return false;
    const ranges = initializers.get(name);
    // A duplicate binding is ambiguous without scope analysis. Require an
    // explicit URL conversion at the import rather than trusting one of them.
    return ranges?.length === 1 && safe(...ranges[0], new Set([...seen, name]));
  };

  const hits: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== 'import' || tokens[i + 1]?.text !== '(') continue;
    const end = close.get(i + 1);
    let argEnd = i + 2;
    while (end !== undefined && argEnd < end && tokens[argEnd].text !== ',') argEnd = (close.get(argEnd) ?? argEnd) + 1;
    if (end !== undefined && !safe(i + 2, argEnd)) {
      const line = source.slice(0, tokens[i].index).split('\n').length;
      hits.push(`${line}: ${text(i, end + 1)}: use pathToFileURL(path).href`);
    }
  }
  return hits;
}

describe('Windows dynamic import portability', () => {
  it('scans both test trees, including nested helpers and Node test files', () => {
    const files = [...testSources('tests'), ...testSources('test')];
    expect(files).toContain('tests/helpers/help-sweep.ts');
    expect(files).toContain('test/hook-main-sonar.test.mjs');
    const hits = files.flatMap((file) => portabilityViolations(readFileSync(path.join(ROOT, file), 'utf8')).map((hit) => `${file}:${hit}`));
    expect(hits).toEqual([]);
  });

  it.each([
    'await import(fixture);',
    'await import(resolve(root, "fixture.mjs"));',
    'await import(path.join(root, "fixture.mjs"));',
    'await import(fileURLToPath(new URL("./fixture.mjs", import.meta.url)));',
    'const moduleUrl = resolve("fixture.mjs"); await import(moduleUrl);',
    'const file = join(root, "fixture.mjs"); const alias = file; await import(alias);',
    'await import("/tmp/fixture.mjs");',
    String.raw`await import('C:\\fixtures\\module.mjs');`,
    String.raw`await import('\\\\server\\share\\module.mjs');`,
    'await import(`${root}/fixture.mjs`);',
    'const note = `${await import(fixture)}`;',
    "const r = /'/; await import(fixture); const s = /'/;",
    'const url = pathToFileURL(fixture).href; function load(url) { return import(url); }',
    String.raw`await import('C\u003a/fixtures/module.mjs');`,
    'const url = pathToFileURL(fixture).href; { let url = fixture; await import(url); }',
    "if (ready) /'/.test(x); await import(fixture); /'/.test(x);",
  ])('rejects an inline bare-path sample: %s', (source) => {
    expect(portabilityViolations(source)).toHaveLength(1);
  });

  it.each([
    'await import("../src/core/index.js");',
    'await import("node:fs"); await import("yaml");',
    'await import("file:///C:/fixtures/module.mjs");',
    'await import(pathToFileURL(fixture).href);',
    'await import(new URL("./fixture.mjs", import.meta.url).href);',
    'const url = pathToFileURL(fixture).href; const alias = url; await import(alias);',
    '// import(fixture)\n/* import(resolve(root)) */ const note = "import(fixture)";',
    'type Module = typeof import("./fixture.js");',
    'await import("./fixture.json", { with: { type: "json" } });',
  ])('accepts portable imports and ignores non-runtime text: %s', (source) => {
    expect(portabilityViolations(source)).toEqual([]);
  });
});
