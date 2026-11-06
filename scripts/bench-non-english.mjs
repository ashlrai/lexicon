// From the repository root: node --import tsx scripts/bench-non-english.mjs
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadCorpus, loadLexicon, runBench } from '../bench/lib.ts';

if (process.argv.slice(2).some((arg) => arg !== '--json')) {
  throw new Error('Usage: node --import tsx scripts/bench-non-english.mjs [--json]');
}
const names = z.array(z.object({
  lang: z.enum(['arabic', 'german', 'japanese', 'polish', 'spanish']),
  canonical: z.string().min(1),
  heard: z.array(z.string().min(1)).min(1),
})).min(30).parse(parse(readFileSync(new URL('../bench/non-english.yaml', import.meta.url), 'utf8')));
if (new Set(names.map((n) => n.canonical)).size !== names.length || new Set(names.map((n) => n.lang)).size < 5) {
  throw new Error('Fixture requires unique names across at least five languages');
}
const lexicon = loadLexicon();
for (const name of names) {
  if (!lexicon.terms.some((t) => t.canonical === name.canonical && t.category === 'person')) {
    throw new Error(`Unknown person in benchmark lexicon: ${name.canonical}`);
  }
}
const cases = names.flatMap((name, i) => name.heard.map((heard, j) => ({
  id: `name-${i}-${j}`, category: 'person', lang: name.lang,
  heard: `ask ${heard} about the plan`, expected: `ask ${name.canonical} about the plan`, terms: [name.canonical],
})));
const baseline = runBench(loadCorpus().filter((c) => c.lang === undefined), lexicon, { timing: false });
const report = runBench(cases, lexicon, { timing: false });
const aliases = runBench(cases, lexicon, { timing: false, phonetic: false, fuzzy: false });
const rate = (r) => `${(100 * r.rate).toFixed(2)}% (${r.hit}/${r.total})`;
const rows = Object.entries(report.lang.byLang).map(([lang, group]) => {
  const count = names.filter((n) => n.lang === lang).length;
  const gap = (100 * (baseline.terms.recall.rate - group.recall.rate)).toFixed(2);
  return `| ${lang} | ${count} | ${rate(group.rawRecall)} | ${rate(aliases.lang.byLang[lang].recall)} | ${rate(group.recall)} | ${rate(baseline.terms.recall)} | ${gap} |`;
});
const markdown = [
  '# Non-English name benchmark', '',
  'Reproduce from the repository root after `npm install`:', '',
  '```sh', 'node --import tsx scripts/bench-non-english.mjs > docs/BENCH-NON-ENGLISH.md', '```', '',
  'Add `--json` for every scored case, including misses. This report is generated; tests check drift.', '',
  `${names.length} distinct names across five languages, with ${cases.length} synthetic spelling variants curated from`,
  '[the existing generator](../bench/gen-corpus.ts) into [non-english.yaml](../bench/non-english.yaml).',
  'All variants, including difficult misses, are scored against the unchanged [benchmark lexicon](../bench/lexicon.yaml).',
  `Defaults: minConfidence ${report.config.minConfidence}, phonetic and fuzzy enabled. No matcher changes or user configuration.`, '',
  'A hit means the exact, case-sensitive canonical occurs in the output as often as expected (term recall).',
  'Raw scores the input; aliases-only disables phonetic and fuzzy matching. Gap is English minus language in percentage points.', '',
  '| Language | Names | Raw hits | Aliases-only hits | Default hits | Existing English hits | Gap (pp) |',
  '|---|---:|---:|---:|---:|---:|---:|', ...rows, '',
  `Overall default hits: ${rate(report.terms.recall)}; aliases-only: ${rate(aliases.terms.recall)}.`, '',
  `The English-sentence baseline is the existing ${baseline.counts.cases} untagged cases (${baseline.counts.positives} positives);`,
  'its proper nouns have mixed origins, so this is not a controlled English-origin-name comparison.',
  'These are hand-written errors in English sentences, not real speech or native-language dictation.',
  'Japanese and Arabic names use romanization. Configured aliases contribute to the score.',
  'This focused fixture measures positive recovery only; [the full benchmark](BENCHMARK.md#non-english-names)',
  'also measures sentence accuracy, precision and damage to clean prose.', '',
].join('\n');
process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify({ baseline, report, aliases }, null, 2)}\n` : markdown);
