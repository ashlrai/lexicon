import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { isNegative, loadCorpus, loadLexicon, runBench, type BenchReport } from './lib.js';

it('writes the documented non-English baseline with comparable subset metrics', () => {
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
    const markdown = execFileSync(process.execPath, [
      '--import', 'tsx', 'bench/run.ts',
      '--corpus', input, '--lexicon', 'bench/lexicon.yaml', '--out', output,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const saved = JSON.parse(readFileSync(output, 'utf8')) as BenchReport & {
      corpus: string;
      lexicon: string;
      failures: Array<{ id: string }>;
    };
    const expected = runBench(loadCorpus(input), loadLexicon(), { timing: false });

    expect(saved.corpus).toBe(relative(process.cwd(), input));
    expect(saved.lexicon).toBe('bench/lexicon.yaml');
    expect(saved.config).toEqual(expected.config);
    expect(saved.lang).toEqual(expected.lang);
    expect(saved.failures.map((failure) => failure.id)).toEqual(
      expected.results.filter((result) => !result.pass).map((result) => result.id),
    );
    expect(saved.lang?.nonEnglish.cases).toBeGreaterThan(0);
    expect(saved.lang?.baseline.cases).toBeGreaterThan(0);
    expect(markdown).toContain('## Non-English subset (lang-tagged cases)');
    expect(markdown).toContain('baseline (untagged)');
    expect(markdown).toContain('non-English (all)');
    for (const lang of Object.keys(saved.lang?.byLang ?? {})) expect(markdown).toContain(`| ${lang} |`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
