import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, win32 } from 'node:path';
import { expect, it } from 'vitest';
import { isNegative, loadCorpus, loadLexicon, runBench, type BenchReport } from './lib.js';
import { reportPath } from './report-path.js';

it.each([
  ['bench/lexicon.yaml', 'bench/lexicon.yaml'],
  [win32.relative('C:\\repo', 'C:\\repo\\bench\\lexicon.yaml'), 'bench/lexicon.yaml'],
  [win32.relative('C:\\repo', 'C:\\fixtures\\corpus.jsonl'), '../fixtures/corpus.jsonl'],
])('stores the relative path %s with portable separators', (input, expected) => {
  expect(reportPath(input)).toBe(expected);
});

it('writes the documented non-English baseline with comparable subset metrics', () => {
  const readme = readFileSync('bench/README.md', 'utf8');
  const section = readme.split('## Repeat the non-English-name benchmark')[1]?.split('\n## ')[0];
  const command = section?.match(/```bash\n([^\n]+)\n```/)?.[1];
  expect(command).toBe('npm run bench -- --out /tmp/lexicon-name-benchmark.json');
  const dir = mkdtempSync(join(tmpdir(), 'lexicon-name-bench-'));
  try {
    const output = join(dir, 'results.json');
    const input = join(dir, 'corpus.jsonl');
    const corpus = loadCorpus();
    const cases = [
      corpus.find((c) => c.lang === undefined && !isNegative(c)),
      corpus.find((c) => c.lang === 'german' && !isNegative(c)),
      corpus.find((c) => c.lang === 'polish' && !isNegative(c)),
      corpus.find((c) => c.lang !== undefined && isNegative(c)),
    ];
    if (cases.some((c) => c === undefined)) throw new Error('benchmark fixture is missing representative cases');
    writeFileSync(input, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const args = command!.split(' ').slice(1);
    args[args.length - 1] = output;
    args.push('--corpus', input);
    const markdown = execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const saved = JSON.parse(readFileSync(output, 'utf8')) as BenchReport & {
      corpus: string;
      lexicon: string;
      failures: Array<{ id: string }>;
    };
    const expected = runBench(loadCorpus(input), loadLexicon(), { timing: false });

    expect(saved.corpus).toBe(relative(process.cwd(), input).replace(/\\/g, '/'));
    expect(saved.lexicon).toBe('bench/lexicon.yaml');
    expect(saved.config).toEqual(expected.config);
    expect(saved.lang).toEqual(expected.lang);
    expect(saved.failures.map((failure) => failure.id)).toEqual(
      expected.results.filter((result) => !result.pass).map((result) => result.id),
    );
    expect(saved.lang?.nonEnglish.cases).toBeGreaterThan(0);
    expect(saved.lang?.baseline.cases).toBeGreaterThan(0);
    const repeated = runBench(loadCorpus(input), loadLexicon(), { timing: false });
    expect(repeated.config).toEqual(saved.config);
    expect(repeated.counts).toEqual(saved.counts);
    expect(repeated.lang).toEqual(saved.lang);
    expect(repeated.results.filter((result) => !result.pass)).toEqual(saved.failures);
    const subsets = saved.lang!;
    expect(subsets.baseline.cases + subsets.nonEnglish.cases).toBe(saved.counts.cases);
    expect(Object.values(subsets.byLang).reduce((sum, group) => sum + group.cases, 0))
      .toBe(subsets.nonEnglish.cases);
    expect(markdown).toContain('## Non-English subset (lang-tagged cases)');
    expect(markdown).toContain('| subset | cases | sentence acc | acc excl. hard | recall raw | recall | precision | F1 | prose FP |');
    expect(markdown).toContain('baseline (untagged)');
    expect(markdown).toContain('non-English (all)');
    for (const lang of Object.keys(saved.lang?.byLang ?? {})) expect(markdown).toContain(`| ${lang} |`);
    for (const group of [subsets.baseline, subsets.nonEnglish, ...Object.values(subsets.byLang)]) {
      expect(markdown).toContain(`${(group.recall.rate * 100).toFixed(1)}% (${group.recall.hit}/${group.recall.total})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
