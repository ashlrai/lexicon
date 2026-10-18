// Wall-clock bounds on normalizing pathological input. They live in their own
// file so vitest.config.ts runs them in the `perf` project, after every other
// file and in one forked worker. Inside tests/matcher.test.ts the many-blocks
// case read 2925 and 3236 ms against its 2500 ms bound on a busy ubuntu node 20
// runner (main, d0a1e95 and 946f82b) while it takes about 750 ms alone, with
// no change to the matcher. The bounds are unchanged.
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/matcher.js';
import { normalizeWithIndex } from '../src/core/normalize.js';

// The time budget (shouldStop) is polled between tokens only, so the work
// before the first token (protected ranges, token trimming) and after the
// scan (overlaps, collapsed mentions, the splice) has to be linear on its own,
// or the 1 MB the local API accepts and the 100 000 characters MCP checks
// hold the one thread for seconds past any budget. Each case here took
// several seconds before; the bound is loose so a slow CI runner still passes.
describe('pathological input stays linear outside the shouldStop scan', () => {
  const index = buildIndex({ version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] });
  const cases: Array<[string, string]> = [
    ['a long run with no space or @ (the email pattern)', 'a'.repeat(200_000)],
    ['a dotted run with no @', 'ab.'.repeat(70_000)],
    ['a token of dashes that does not end in one (the trailing-punctuation trim)', `a${'-'.repeat(200_000)}b`],
    ['a token of apostrophes', `a${"'".repeat(200_000)}b`],
    ['tens of thousands of alias hits (overlaps and the splice)', 'Ashler '.repeat(28_000)],
    ['hits beside the canonical in one block (collapsed mentions)', 'Ashler Ashlr.AI '.repeat(25_000)],
    ['hits in many blocks with the canonical everywhere', 'Ashler Ashlr.AI\n\n'.repeat(23_000)],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      // No budget: the whole scan has to fit too, and none of these is long in tokens.
      const started = Date.now();
      normalizeWithIndex(text, index);
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  }

  it('still corrects every hit and skips the address', () => {
    const text = `${'Ashler '.repeat(3)}mail ashler@example.com`;
    const out = normalizeWithIndex(text, index);
    expect(out.output).toBe(`${'Ashlr.AI '.repeat(3)}mail ashler@example.com`);
  });
});
