/**
 * @ashlr/lexicon as a library: load, correct, extend, harvest, export.
 *
 * Run from a checkout:   node --import tsx examples/library-usage.ts
 * In your own project:   npm i @ashlr/lexicon
 *                        import { normalize, loadLexicon, ... } from '@ashlr/lexicon';
 *
 * Nothing here touches your real config: the example lexicon is copied to a
 * temp file and LEXICON_PATH points at that copy.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
// From an installed package this line is:  import { ... } from '@ashlr/lexicon';
import {
  addTerm,
  diffSummary,
  exportLexicon,
  harvestRepo,
  loadLexicon,
  normalize,
  parseLexicon,
} from '../src/core/index.js';
import type { Lexicon, NormalizeResult } from '../src/core/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// 1. Parse a lexicon file yourself (parseLexicon validates the shape and limits).
const raw: unknown = parseYaml(await fs.readFile(path.join(here, 'lexicon.example.yaml'), 'utf8'));
const lexicon: Lexicon = parseLexicon(raw);
console.log(`parsed ${lexicon.terms.length} terms from lexicon.example.yaml`);

// 2. normalize() is pure: text + lexicon in, NormalizeResult out.
const result: NormalizeResult = normalize('ask ashler to deploy pie dantic on head sner', lexicon);
console.log('\nnormalize()');
console.log('  input:   ', result.input);
console.log('  output:  ', result.output);
console.log('  changed: ', result.changed);
for (const r of result.replacements) {
  // { start, end, original, replacement, canonical, reason: 'alias' | 'phonetic' | 'fuzzy', confidence }
  console.log(`  ${r.start}-${r.end} "${r.original}" -> "${r.replacement}" (${r.reason}, ${r.confidence.toFixed(2)})`);
}
console.log('  summary:\n' + diffSummary(result).replace(/^/gm, '    '));

// 3. The store: loadLexicon() merges the global file with a trusted project
//    .lexicon.yaml found from `cwd`; addTerm() writes back. Both honour
//    LEXICON_PATH, so point it at a scratch copy for this demo.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-example-'));
process.env.LEXICON_PATH = path.join(scratch, 'lexicon.yaml');
await fs.copyFile(path.join(here, 'lexicon.example.yaml'), process.env.LEXICON_PATH);

const added = await addTerm({ canonical: 'Deepgram', aliases: ['deep gram', 'deepgram'], category: 'product' });
console.log(`\naddTerm(): ${added.created ? 'created' : 'merged'} ${added.term.canonical} in ${added.file.path}`);

const loaded = await loadLexicon({ cwd: repoRoot });
console.log(`loadLexicon(): ${loaded.merged.terms.length} merged terms (global: ${loaded.global.path})`);
console.log('  ', normalize('send the deep gram transcript to Mason Wyat', loaded.merged).output);

// 4. harvestRepo() finds names worth adding from a codebase (package names,
//    PascalCase identifiers, git authors, README proper nouns).
const candidates = await harvestRepo(path.join(repoRoot, 'tests', 'fixtures', 'fake-repo'), { limit: 3 });
console.log('\nharvestRepo():');
for (const c of candidates) {
  console.log(`  ${c.canonical} (${c.category}, x${c.count}) aliases: ${c.suggestedAliases.join(', ') || '(none)'}`);
}

// 5. exportLexicon() renders the lexicon for another tool.
console.log('\nexportLexicon(lexicon, "whisper-prompt"):');
console.log('  ' + exportLexicon(loaded.merged, 'whisper-prompt', { limit: 6 }).trim());
console.log('\nexportLexicon(lexicon, "deepgram", { categories: ["product"] }):');
console.log(exportLexicon(loaded.merged, 'deepgram', { categories: ['product'] }).replace(/^/gm, '  ').trimEnd());

await fs.rm(scratch, { recursive: true, force: true });
