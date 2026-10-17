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
