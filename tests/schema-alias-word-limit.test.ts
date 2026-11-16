import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('alias length regression: hard-coded boundary against documented limit', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const contractMatch = schemaSection?.match(/`word` (\d+) \(canonical, alias\)/);
  const documentedLimit = Number(contractMatch![1]);

  it('contract documents 80 characters for alias length', () => {
    expect(documentedLimit).toBe(80);
    expect(LIMITS.word).toBe(80);
  });

  it('accepts an 80-character alias', () => {
    const alias80 = 'a'.repeat(80);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [alias80] }).success).toBe(true);
  });

  it('rejects an 81-character alias as exceeding the documented limit', () => {
    const alias81 = 'a'.repeat(81);
    const result = TermSchema.safeParse({ canonical: 'X', aliases: [alias81] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(`must be at most ${documentedLimit} characters`);
    }
  });
});

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

  it('reports the limit through parseLexicon with the field path', () => {
    const limit = Number(match![1]);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: ['a'.repeat(limit)] }] }).terms[0].aliases).toEqual([
      'a'.repeat(limit),
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: ['a'.repeat(limit + 1)] }] })).toThrow(
      `terms[0].aliases[0]: must be at most ${limit} characters`,
    );
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

describe('alias word length boundary: edge cases', () => {
  const parse = (alias: string) => TermSchema.safeParse({ canonical: 'X', aliases: [alias] });

  it('measures the limit after trimming and stripping invisible characters', () => {
    expect(parse(`  ${'a'.repeat(LIMITS.word)}  `).success).toBe(true);
    expect(parse(`${'a'.repeat(LIMITS.word)}​`).success).toBe(true);
    expect(parse(`  ${'a'.repeat(LIMITS.word + 1)}  `).success).toBe(false);
  });

  it('rejects one oversized alias among valid ones and points at its index', () => {
    const result = TermSchema.safeParse({ canonical: 'X', aliases: ['ok', 'a'.repeat(LIMITS.word + 1)] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual(['aliases', 1]);
  });

  it('rejects a boundary-plus-one multi-byte alias', () => {
    expect(parse('é'.repeat(LIMITS.word)).success).toBe(true);
    expect(parse('é'.repeat(LIMITS.word + 1)).success).toBe(false);
  });
});

describe('mixed Unicode word length boundary', () => {
  it.each(['canonical', 'aliases', 'never'] as const)(
    'counts code points across mixed-width characters in %s',
    (field) => {
      const word = 'a'.repeat(40) + '🙂'.repeat(40);
      const term = (value: string) => field === 'canonical'
        ? { canonical: value }
        : { canonical: 'X', [field]: [value] };

      expect(Array.from(word)).toHaveLength(80);
      expect(TermSchema.safeParse(term(word)).success).toBe(true);
      const result = TermSchema.safeParse(term(`${word}é`));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an 81-character word to be rejected');
      expect(result.error.issues).toMatchObject([{
        code: 'too_big',
        path: field === 'canonical' ? [field] : [field, 0],
        maximum: 80,
      }]);
    },
  );
});
