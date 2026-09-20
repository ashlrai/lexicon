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
 * out and evaluated rather than compiled. That keeps this script dependency-free
 * and means it runs from a bare checkout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const out = resolve(repoRoot, 'docs/FAQ.md');

const src = readFileSync(resolve(webRoot, 'lib/site.ts'), 'utf8');

function sliceArray(name) {
  const marker = `export const ${name}`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`lib/site.ts no longer exports ${name}`);
  // Skip the type annotation: in `export const FAQ: Faq[] = [`, the first `[`
  // belongs to `Faq[]`, so the array starts after the assignment.
  const open = src.indexOf('[', src.indexOf('=', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${name} array in lib/site.ts`);
}

const constant = (name) => {
  const m = new RegExp(`export const ${name} = '([^']*)'`).exec(src);
  if (!m) throw new Error(`lib/site.ts no longer exports ${name}`);
  return m[1];
};

const FAQ = eval(sliceArray('FAQ'));
const SITE_URL = constant('SITE_URL');
const REPO = constant('REPO');

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
- [MCP server reference](MCP.md): the nineteen tools, two resources and two prompts.
- [For agents](AGENTS.md): how an agent installs and verifies Lexicon for its user.
- [Security](../SECURITY.md): the threat model and the trust gate.
- [Benchmark](BENCHMARK.md): the measurements, the method and what still fails.
- Issues and questions: ${REPO}/issues
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
