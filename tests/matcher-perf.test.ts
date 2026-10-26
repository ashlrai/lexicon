// Wall-clock bound on the matcher. It lives in its own file so vitest.config.ts
// can run it in the `perf` project: one forked worker, after every other file
// has finished, so no other suite competes for the CPU while it is timed.
// Inside tests/matcher.test.ts it ran alongside every other file and missed the
// 20 ms bound under load (21.96 ms on ubuntu node 20) without any regression.
import { describe, expect, it } from 'vitest';
import { buildIndex, findReplacements } from '../src/core/matcher.js';
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

it('builds a 5000-term vocabulary and tokenizes a large transcript within a generous budget', async () => {
  const { tokenize } = await import('../src/core/matcher/tokenize.js');
  const terms: Term[] = Array.from({ length: 5_000 }, (_, i) => ({
    canonical: `Widgetron${i}.AI`,
    aliases: [`widget tron ${i}`, `wigetron${i}`, `Wídget${i}`],
  }));
  const text = "Widget tron's Wídget42 ships to https://example.com/widget beside `wigetron7`.\n".repeat(2_000);
  const started = performance.now();
  const index = buildIndex(lex(terms));
  const tokens = tokenize(text, true);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(index.exact.get('widget tron 4999')?.[0].term).toBe(terms[4999]);
  expect(index.aliasEntries.length).toBeGreaterThan(30_000);
  expect(tokens).toHaveLength(20_000);
  expect(tokens.filter((token) => token.skipped)).toHaveLength(8_000);
});
