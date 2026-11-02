import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('alias word length boundary', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`word` (\d+) \(canonical, alias\)/);

  it('takes the limit from the contract: 80 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(80);
    expect(LIMITS.word).toBe(80);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['aliases', 0]],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'aliases', 0]],
  ] as const)('accepts 80 characters and rejects 81 through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    expect(schema.safeParse(wrap({ canonical: 'X', aliases: ['a'.repeat(limit - 1)] })).success).toBe(true);
    expect(schema.safeParse(wrap({ canonical: 'X', aliases: ['a'.repeat(limit)] })).success).toBe(true);

    const result = schema.safeParse(wrap({ canonical: 'X', aliases: ['a'.repeat(limit + 1)] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(path);
      expect(result.error.issues[0].message).toContain(`must be at most ${limit} characters`);
    }
  });
});

describe('alias word length boundary: normalization and sibling lists', () => {
  const at = 'a'.repeat(LIMITS.word);

  it('measures the length after trimming and stripping invisible characters', () => {
    const parsed = TermSchema.parse({ canonical: 'X', aliases: [`  ​${at}﻿  `] });
    expect(parsed.aliases).toEqual([at]);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [` ${at}a `] }).success).toBe(false);
  });

  it('accepts an 80 character alias next to short ones and rejects the one that is too long', () => {
    expect(TermSchema.parse({ canonical: 'X', aliases: ['a', at, 'b'] }).aliases).toEqual(['a', at, 'b']);
    const bad = TermSchema.safeParse({ canonical: 'X', aliases: ['a', at, `${at}a`] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].path).toEqual(['aliases', 2]);
  });

  it('applies the same boundary to never words', () => {
    expect(TermSchema.parse({ canonical: 'X', never: [at] }).never).toEqual([at]);
    expect(TermSchema.safeParse({ canonical: 'X', never: [`${at}a`] }).success).toBe(false);
  });
});
