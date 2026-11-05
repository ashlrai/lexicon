import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, TermSchema } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/** The aliases cap as docs/CONTRACT.md states it, so drift on either side fails here. */
const documented = (() => {
  const m = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
  if (!m) throw new Error('docs/CONTRACT.md no longer documents the aliases limit');
  return Number(m[1]);
})();

const aliases = (n: number): string[] => Array.from({ length: n }, (_, i) => `alias${i}`);

describe('aliases limit documented in CONTRACT.md', () => {
  it('matches LIMITS.aliases', () => {
    expect(documented).toBe(LIMITS.aliases);
  });

  it('accepts a term with exactly the limit', () => {
    const r = TermSchema.safeParse({ canonical: 'X', aliases: aliases(documented) });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aliases).toHaveLength(documented);
  });

  it('rejects a term one over the limit with a clear message', () => {
    const r = TermSchema.safeParse({ canonical: 'X', aliases: aliases(documented + 1) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]).toMatchObject({ path: ['aliases'], message: `at most ${documented} aliases per term` });
    }
  });
});
