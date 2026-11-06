import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

describe('a supplementary-plane character in an alias', () => {
  const rocket = '\u{1F680}';
  const aliases = [`rock${rocket}et`, '\u{20000}', '\u{10FFFF}'];

  it('is accepted and preserved exactly', () => {
    const term = TermSchema.parse({ canonical: 'Rocket', aliases });
    expect(term.aliases).toEqual(aliases);
    expect([...term.aliases[0]!]).toHaveLength(7);
  });

  it('is preserved through parseLexicon and a YAML write and read', () => {
    const first = parseLexicon({ terms: [{ canonical: 'Rocket', aliases }] });
    const second = parseLexicon(parse(stringify(first)));
    expect(second.terms[0].aliases).toEqual(aliases);
  });

  it('accepts a pair written as two surrogate escapes and keeps it as one character', () => {
    const term = TermSchema.parse({ canonical: 'Rocket', aliases: ['go 🚀'] });
    expect(term.aliases).toEqual([`go ${rocket}`]);
  });

  it('survives trimming around the pair', () => {
    const term = TermSchema.parse({ canonical: 'Rocket', aliases: [`  ${rocket}  `] });
    expect(term.aliases).toEqual([rocket]);
  });

  it('keeps a pair that ends exactly at the word limit and rejects one past it', () => {
    const atLimit = 'a'.repeat(LIMITS.word - 1) + rocket;
    expect(TermSchema.parse({ canonical: 'X', aliases: [atLimit] }).aliases).toEqual([atLimit]);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [`${atLimit}a`] }).success).toBe(false);
  });

  it('still rejects a lone surrogate half beside a valid pair', () => {
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [`${rocket}\uD83D`] }).success).toBe(false);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [`\uDE80${rocket}`] }).success).toBe(false);
  });
});
