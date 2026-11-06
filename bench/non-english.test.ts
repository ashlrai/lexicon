import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/matcher.js';
import { normalizeWithIndex } from '../src/core/normalize.js';
import { loadCorpus, loadLexicon, type BenchReport } from './lib.js';
const root = new URL('../', import.meta.url);
const runner = fileURLToPath(new URL('scripts/bench-non-english.mjs', root));
const args = ['--import', import.meta.resolve('tsx'), runner];
const run = (...flags: string[]) => execFileSync(process.execPath, [...args, ...flags], { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 });
const names = parse(readFileSync(new URL('bench/non-english.yaml', root), 'utf8')) as {
  lang: string; canonical: string; heard: string[];
}[];
const lexicon = loadLexicon();
const index = buildIndex(lexicon);
describe('focused non-English benchmark', () => {
  it('covers unique names in five languages, aliases and aliasless terms, and several errors per name', () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
    expect(new Set(names.map((n) => n.canonical)).size).toBe(names.length);
    expect(new Set(names.map((n) => n.lang)).size).toBeGreaterThanOrEqual(5);
    const terms = names.map((n) => lexicon.terms.find((t) => t.canonical === n.canonical));
    expect(terms.every((t) => t?.category === 'person')).toBe(true);
    expect(terms.some((t) => t!.aliases.length === 0)).toBe(true);
    expect(terms.some((t) => t!.aliases.length > 0)).toBe(true);
    for (const name of names) expect(new Set(name.heard).size).toBeGreaterThanOrEqual(3);
  });

  it('scores every variant, retains misses, and recomputes the existing baseline', () => {
    const data = JSON.parse(run('--json')) as { baseline: BenchReport; report: BenchReport; aliases: BenchReport };
    const expected = loadCorpus().filter((c) => c.lang === undefined).map((c) => [c.id, normalizeWithIndex(c.heard, index).output]);
    expect(data.baseline.results.map((r) => [r.id, r.output])).toEqual(expected);
    expect(data.baseline.terms.recall).toEqual({ hit: 303, total: 313, rate: 303 / 313 });
    expect(data.baseline.counts.cases).toBe(402);
    expect(data.report.counts.cases).toBe(names.reduce((n, name) => n + name.heard.length, 0));
    for (const lang of new Set(names.map((n) => n.lang))) {
      const selected = names.filter((n) => n.lang === lang);
      const hits = selected.flatMap((n) => n.heard.map((heard) =>
        normalizeWithIndex(`ask ${heard} about the plan`, index).output.includes(n.canonical))).filter(Boolean).length;
      const total = selected.reduce((n, name) => n + name.heard.length, 0);
      expect(data.report.lang!.byLang[lang].recall).toEqual({ hit: hits, total, rate: hits / total });
    }
    expect(data.report.results.some((r) => r.missed.includes('Grzegorz Brzęczyszczykiewicz'))).toBe(true);
    expect(data.report.terms.recall.hit).toBeGreaterThan(data.aliases.terms.recall.hit);
  });
  it('reproduces the committed report from outside the checkout', () => {
    expect(run()).toBe(readFileSync(new URL('docs/BENCH-NON-ENGLISH.md', root), 'utf8'));
  });

  it('rejects unsupported flags instead of silently scoring the wrong configuration', () => {
    const result = spawnSync(process.execPath, [...args, '--min-confidence', '0.9'], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage:');
    expect(result.stdout).toBe('');
  });
});
