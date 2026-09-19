/**
 * Regression guard for the accuracy benchmark. Thresholds are the measured
 * numbers in docs/BENCHMARK.md minus a small margin; if a matcher change trips
 * one, rerun `npm run bench -- --verbose` and either fix the regression or
 * re-baseline docs/BENCHMARK.md deliberately.
 */
import { describe, expect, it } from 'vitest';
import { isHard, isNegative, loadCorpus, loadLexicon, runBench } from './lib.js';

const lexicon = loadLexicon();
const corpus = loadCorpus();

describe('bench corpus', () => {
  it('parses and is large enough', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(250);
    const ids = new Set(corpus.map((c) => c.id));
    expect(ids.size).toBe(corpus.length);
  });

  it('has a realistic lexicon', () => {
    expect(lexicon.terms.length).toBeGreaterThanOrEqual(60);
    expect(lexicon.terms.length).toBeLessThanOrEqual(80);
    const aliasless = lexicon.terms.filter((t) => t.aliases.length === 0).length;
    expect(aliasless / lexicon.terms.length).toBeGreaterThanOrEqual(0.2);
  });

  it("every positive case's terms exist in bench/lexicon.yaml", () => {
    const canonicals = new Set(lexicon.terms.map((t) => t.canonical));
    for (const c of corpus) {
      for (const t of c.terms) expect(canonicals.has(t), `${c.id}: ${t}`).toBe(true);
    }
  });

  it('has the expected mix of positives, negatives and hard cases', () => {
    const negatives = corpus.filter(isNegative);
    const hard = corpus.filter(isHard);
    expect(corpus.length - negatives.length).toBeGreaterThanOrEqual(220);
    expect(negatives.length).toBeGreaterThanOrEqual(100);
    expect(hard.length).toBeGreaterThanOrEqual(20);
  });
});

describe('bench accuracy (default config)', () => {
  const report = runBench(corpus, lexicon, { timing: false });

  // Measured 2026-09-19 after the matcher precision fixes (docs/BENCHMARK.md):
  // positives 94.2%, term recall 96.5%, prose FP 0.0% excl. expected-hard /
  // 15.0% incl. Thresholds are those numbers minus a small margin so a matcher
  // regression trips them.
  it('recovers misheard terms (target >= 0.88 / 0.94)', () => {
    expect(report.sentence.positives.rate).toBeGreaterThanOrEqual(0.92);
    expect(report.terms.recall.rate).toBeGreaterThanOrEqual(0.95);
  });

  // The suite's target is <= 0.02 excl. expected-hard; the matcher measures
  // 0.0% (0/95) today. The expected-hard negatives are corpus ambiguities
  // (canonicals that are English words, user aliases that are phrases) and
  // sit at 18/25; they are bounded separately so they cannot creep up.
  it('leaves clean prose alone (<= 0.02 excl. expected-hard, <= 0.17 incl.)', () => {
    expect(report.falsePositiveRateExcludingHard.rate).toBeLessThanOrEqual(0.02);
    expect(report.falsePositiveRate.rate).toBeLessThanOrEqual(0.17);
  });

  it('never touches code spans, fences, URLs, emails or paths', () => {
    const guarded = report.results.filter((r) => /neg-(097|098|099|100|101|102|103)/.test(r.id));
    expect(guarded.length).toBe(7);
    for (const r of guarded) expect(r.pass, r.id).toBe(true);
  });
});
