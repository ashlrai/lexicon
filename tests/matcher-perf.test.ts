// Wall-clock bound on the matcher. It lives in its own file so vitest.config.ts
// can run it in the `perf` project: one forked worker, after every other file
// has finished, so no other suite competes for the CPU while it is timed.
// Inside tests/matcher.test.ts it ran alongside every other file and missed the
// 20 ms bound under load (21.96 ms on ubuntu node 20) without any regression.
import { describe, expect, it } from 'vitest';
import { buildIndex, findReplacements, phoneticCandidates } from '../src/core/matcher.js';
import { PHONETIC_BASE, PHONETIC_LENGTH_WEIGHT } from '../src/core/matcher/tuning.js';
import type { Lexicon, Term } from '../src/core/types.js';

function lex(terms: Term[]): Lexicon {
  return { version: 1, terms };
}

const ASHLR: Term = { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashler AI'] };
const K8S: Term = { canonical: 'Kubernetes', aliases: [] };

describe('robustness and performance', () => {
  it('finds replacements in a 2KB text with 200 terms in under 20ms', () => {
    const terms: Term[] = Array.from({ length: 200 }, (_, i) => ({
      canonical: `Widgetron${i}X`,
      aliases: [`widget tron ${i}`, `wigetron${i}`],
    }));
    terms.push(ASHLR, K8S);
    const index = buildIndex(lex(terms));
    const text = "The quick brown fox jumps over the lazy dog while Ashler ships Cooper Nettie's clusters to widget tron 7. ".repeat(20);
    expect(text.length).toBeGreaterThan(2000);
    findReplacements(text, index); // warm-up
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const reps = findReplacements(text, index);
      best = Math.min(best, performance.now() - t0);
      expect(reps.length).toBe(60);
    }
    expect(best).toBeLessThan(20);
  });
});

describe('lexicon-fast-index', () => {
  it('matches the linear phonetic scan and is at least twice as fast on a growing pack', () => {
    const index = buildIndex(lex(Array.from({ length: 5000 }, (_, i) => ({
      canonical: `Str${'a'.repeat(i % 70 + 1)}${i}`, aliases: [],
    }))));
    const entries = [...index.phoneticKeys.values()].sort((a, b) => b.length - a.length)[0];
    expect(entries.length).toBe(5000);
    const scan = (items: typeof entries, length: number, bar: number) => items.filter((e) =>
      PHONETIC_BASE * (1 - Math.abs(length - e.length) / Math.max(length, e.length) * PHONETIC_LENGTH_WEIGHT) >= bar,
    ).map((e) => e.termIndex).sort((a, b) => a - b);
    for (const length of [3, 4, 15, 40, 73, 80]) {
      for (const bar of [0, 0.675, 0.82, 0.89, 0.9, 1]) {
        expect(scan(phoneticCandidates(entries, length, bar), length, bar)).toEqual(scan(entries, length, bar));
      }
    }
    // Full matching retains the first term on equal-confidence ties, including
    // when a fresh pack index replaces the previous one.
    for (const current of [index, buildIndex(index.lexicon)]) {
      expect(findReplacements('Straa', current, { fuzzy: false, minConfidence: 0.9 }))
        .toMatchObject([{ replacement: 'Straa1', reason: 'phonetic', confidence: 0.9 }]);
    }
    const measure = (indexed: boolean) => {
      let best = Infinity;
      for (let round = 0; round < 5; round++) {
        const start = performance.now();
        for (let i = 0; i < 200; i++) {
          const items = indexed ? phoneticCandidates(entries, 5, 0.9) : entries;
          expect(scan(items, 5, 0.9).length).toBe(72);
        }
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    measure(true); measure(false);
    const linear = measure(false), indexed = measure(true);
    console.info(`Phonetic length index: ${(linear / indexed).toFixed(1)}x faster than linear scan`);
    expect(indexed).toBeLessThan(linear / 2);
  });
});
