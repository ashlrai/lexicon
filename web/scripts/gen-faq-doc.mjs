#!/usr/bin/env node
/**
 * Writes ../docs/FAQ.md from the FAQ array in web/lib/site.ts.
 *
 * The landing page, /llms-full.txt and docs/FAQ.md all have to carry the same
 * answers, and an FAQ that disagrees with itself in three places is worse than
 * no FAQ: the copy people quote is whichever one the crawler happened to read.
 * So there is one array, and this turns it into the markdown mirror.
 *
 *   node web/scripts/gen-faq-doc.mjs           # write docs/FAQ.md
 *   node web/scripts/gen-faq-doc.mjs --check   # exit 1 if it is out of date
 *
 * lib/site.ts is TypeScript, but the FAQ block is plain data, so it is sliced
 * out and read rather than compiled or executed. That keeps this script
 * dependency-free and means it runs from a bare checkout; nothing in site.ts
 * ever runs, and an entry the readers below do not understand fails the build
 * loudly instead of silently writing a wrong FAQ.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const out = resolve(repoRoot, 'docs/FAQ.md');

const src = readFileSync(resolve(webRoot, 'lib/site.ts'), 'utf8');

/* ----------------------------------------------------------- literal scan */

/** Index just past the string literal opening at i ('...', "..." or `...`). */
function skipString(text, i) {
  const quote = text[i];
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('unterminated string literal in lib/site.ts');
}

/** Index just past whitespace and // and block comments starting at i. */
function skipSpace(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated comment in lib/site.ts');
      i = end + 2;
      continue;
    }
    return i;
  }
}

/** The `[ ... ]` literal of `export const <name> ... = [` in src. */
function sliceArray(name) {
  const marker = `export const ${name}`;
  const start = src.search(new RegExp(`${marker}(?![\\w$])`));
  if (start === -1) throw new Error(`lib/site.ts no longer exports ${name}`);
  // Skip the type annotation: in `export const FAQ: Faq[] = [`, the first `[`
  // belongs to `Faq[]`, so the array starts after the assignment.
  const open = src.indexOf('[', src.indexOf('=', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    // Brackets inside a string or a comment do not count: an answer with a
    // markdown [link](url) is still one element.
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i) - 1;
    } else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipSpace(src, i) - 1;
    } else if (c === '[') {
      depth += 1;
    } else if (c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${name} array in lib/site.ts`);
}

/* ------------------------------------------------------------ the parser */

/** One reader's state over a sliced array literal. */
function reader(text, what) {
  let i = 0;
  const fail = (msg) => {
    throw new Error(`${what} in lib/site.ts: ${msg}`);
  };
  const space = () => {
    i = skipSpace(text, i);
  };
  const peek = () => {
    space();
    return i < text.length ? text[i] : undefined;
  };
  const expect = (ch) => {
    const found = peek();
    if (found !== ch) fail(`expected '${ch}', found ${JSON.stringify(found ?? 'end of input')}`);
    i += 1;
  };
  const at = () => i;
  const seek = (n) => {
    i = n;
  };
  return { text, fail, space, peek, expect, at, seek };
}

/** The character a backslash escape stands for; r is positioned on the '\'. */
function readEscape(r) {
  const { text } = r;
  let i = r.at() + 1;
  const c = text[i];
  i += 1;
  switch (c) {
    case 'n': r.seek(i); return '\n';
    case 'r': r.seek(i); return '\r';
    case 't': r.seek(i); return '\t';
    case 'b': r.seek(i); return '\b';
    case 'f': r.seek(i); return '\f';
    case 'v': r.seek(i); return '\v';
    case '0': r.seek(i); return '\0';
    case '\n': r.seek(i); return ''; // line continuation
    case '\r':
      if (text[i] === '\n') i += 1;
      r.seek(i);
      return '';
    case 'x': {
      const h = text.slice(i, i + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) r.fail(`bad \\x escape '${h}'`);
      r.seek(i + 2);
      return String.fromCharCode(parseInt(h, 16));
    }
    case 'u': {
      if (text[i] === '{') {
        const end = text.indexOf('}', i + 1);
        if (end === -1) r.fail('unterminated \\u{...} escape');
        const h = text.slice(i + 1, end);
        if (!/^[0-9a-fA-F]{1,6}$/.test(h)) r.fail(`bad \\u escape '\\u{${h}}'`);
        const cp = parseInt(h, 16);
        if (cp > 0x10ffff) r.fail(`\\u{${h}} is past the Unicode range`);
        r.seek(end + 1);
        return String.fromCodePoint(cp);
      }
      const h = text.slice(i, i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) r.fail(`bad \\u escape '${h}'`);
      r.seek(i + 4);
      return String.fromCharCode(parseInt(h, 16));
    }
    default:
      r.seek(i);
      return c ?? '';
  }
}

/** One string literal ('...', "..." or `...`), plus any '+'-joined continuations. */
function readLiteral(r) {
  let out = '';
  for (;;) {
    const quote = r.peek();
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      r.fail(`expected a string literal, found ${JSON.stringify(quote ?? 'end of input')}`);
    }
    let i = r.at() + 1;
    while (i < r.text.length) {
      const c = r.text[i];
      if (c === quote) break;
      if (quote !== '`' && (c === '\n' || c === '\r')) r.fail('unterminated string literal');
      if (quote === '`' && c === '$' && r.text[i + 1] === '{') {
        r.fail('a template ${...} is an expression, not data; use plain string literals');
      }
      if (c === '\\') {
        r.seek(i);
        out += readEscape(r);
        i = r.at();
        continue;
      }
      out += c;
      i += 1;
    }
    if (i >= r.text.length) r.fail('unterminated string literal');
    r.seek(i + 1);
    if (r.peek() !== '+') return out;
    r.expect('+');
  }
}

/** The `{ q, a }` entries of the FAQ literal. */
function parseFaq(text) {
  const r = reader(text, 'the FAQ array');
  const entries = [];
  r.expect('[');
  while (r.peek() !== ']') {
    const entry = {};
    r.expect('{');
    for (;;) {
      const found = r.peek();
      const name = /^[A-Za-z_$][\w$]*/.exec(r.text.slice(r.at()))?.[0];
      if (name === undefined) r.fail(`expected a property name, found ${JSON.stringify(found ?? 'end of input')}`);
      r.seek(r.at() + name.length);
      r.expect(':');
      if (name !== 'q' && name !== 'a') r.fail(`unexpected property '${name}': the generator reads q and a`);
      entry[name] = readLiteral(r);
      const next = r.peek();
      if (next === '}') break;
      r.expect(',');
      if (r.peek() === '}') break; // trailing comma
    }
    r.expect('}');
    if (typeof entry.q !== 'string' || typeof entry.a !== 'string') r.fail('an entry is missing its q or a string');
    entries.push(entry);
    if (r.peek() === ',') r.expect(',');
  }
  r.expect(']');
  if (r.peek() !== undefined) r.fail(`trailing text after the array: ${JSON.stringify(r.text.slice(r.at(), r.at() + 40))}`);
  return entries;
}

/** How many top-level elements a sliced `[ ... ]` literal holds. */
function countElements(text) {
  let i = skipSpace(text, 0);
  if (text[i] !== '[') throw new Error(`expected an array literal in lib/site.ts, found ${JSON.stringify(text[i] ?? 'end of input')}`);
  i += 1;
  let depth = 0;
  let count = 0;
  let fresh = true;
  for (;;) {
    i = skipSpace(text, i);
    const c = text[i];
    if (c === undefined) throw new Error('unterminated array literal in lib/site.ts');
    if (depth === 0) {
      if (c === ']') return count;
      if (c === ',') {
        fresh = true;
        i += 1;
        continue;
      }
      if (fresh) {
        count += 1;
        fresh = false;
      }
    }
    if (c === "'" || c === '"' || c === '`') i = skipString(text, i);
    else if (c === '{' || c === '[' || c === '(') {
      depth += 1;
      i += 1;
    } else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      i += 1;
    } else i += 1;
  }
}

/* ------------------------------------------------------------- the facts */

const constant = (name) => {
  const m = new RegExp(`export const ${name} = '([^']*)'`).exec(src);
  if (!m) throw new Error(`lib/site.ts no longer exports ${name}`);
  return m[1];
};

/** 3 -> 'three', 21 -> 'twenty-one': the docs count in words. */
const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
];
const spell = (n) => (n <= 20 ? WORDS[n] : n < 30 ? `twenty-${WORDS[n - 20]}` : String(n));

const FAQ = parseFaq(sliceArray('FAQ'));
const SITE_URL = constant('SITE_URL');
const REPO = constant('REPO');
// Counted from the same arrays the page and /mcp.json render, so the claim the
// doc makes is the claim the code makes. A hardcoded count here once read
// "two resources" for a year after the third one shipped.
const counts = {
  tools: countElements(sliceArray('MCP_TOOLS')),
  resources: countElements(sliceArray('MCP_RESOURCES')),
  prompts: countElements(sliceArray('MCP_PROMPTS')),
};
const mcpClaim =
  `the ${spell(counts.tools)} ${counts.tools === 1 ? 'tool' : 'tools'}, ` +
  `${spell(counts.resources)} ${counts.resources === 1 ? 'resource' : 'resources'} and ` +
  `${spell(counts.prompts)} ${counts.prompts === 1 ? 'prompt' : 'prompts'}`;

const body = `<!--
  Generated from web/lib/site.ts by web/scripts/gen-faq-doc.mjs.
  Edit the FAQ array there, then run: node web/scripts/gen-faq-doc.mjs
  The same answers are rendered at ${SITE_URL}#faq and served at ${SITE_URL}/llms-full.txt.
-->

# FAQ

Plain answers about Lexicon, the personal lexicon for voice-to-agents. Each one
stands on its own, so quoting a single answer somewhere else still makes sense.

${FAQ.map((f) => `## ${f.q}\n\n${f.a}`).join('\n\n')}

## Anything else

- [Quickstart](QUICKSTART.md): nothing to working, in five minutes.
- [Install into your agents](CLIENTS.md): the per-client commands.
- [MCP server reference](MCP.md): ${mcpClaim}.
- [For agents](AGENTS.md): how an agent installs and verifies Lexicon for its user.
- [Security](../SECURITY.md): the threat model and the trust gate.
- [Benchmark](BENCHMARK.md): the measurements, the method and what still fails.
- Issues and questions: ${REPO}/issues

Back to [the docs index](README.md).
`;

const existing = (() => {
  try {
    return readFileSync(out, 'utf8');
  } catch {
    return null;
  }
})();

if (process.argv.includes('--check')) {
  if (existing !== body) {
    process.stderr.write('docs/FAQ.md is out of date; run: node web/scripts/gen-faq-doc.mjs\n');
    process.exit(1);
  }
  process.stdout.write('docs/FAQ.md is up to date\n');
} else {
  writeFileSync(out, body);
  process.stdout.write(`docs/FAQ.md  ${FAQ.length} questions, ${body.length} bytes\n`);
}
