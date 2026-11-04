import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TermSchema } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('contract alias-count limit', () => {
  it('accepts the documented number of aliases and rejects one more', () => {
    const match = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
    expect(match).not.toBeNull();
    const documentedLimit = Number(match![1]);
    expect(documentedLimit).toBe(64);

    const aliases = Array.from({ length: documentedLimit }, (_, i) => `alias${i}`);
    expect(TermSchema.parse({ canonical: 'X', aliases }).aliases).toEqual(aliases);

    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...aliases, `alias${documentedLimit}`] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias-count limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: documentedLimit, message: `at most ${documentedLimit} aliases per term` },
    ]);
  });
});
