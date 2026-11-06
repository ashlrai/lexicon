import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LIMITS, TermSchema, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

// A valid surrogate pair in a term name (the canonical) is encodable, so it is accepted.
describe('a supplementary-plane character in a term name', () => {
  const rocket = '\u{1F680}';
  const names = [`Rocket${rocket}`, `${rocket}Rocket`, `Roc${rocket}ket`, '\u{20000}', '\u{10FFFF}', rocket];

  it.each(names)('is not flagged as unencodable: %j', (name) => {
    expect(findUnencodableChar(name)).toBeUndefined();
  });

  it.each(names)('is accepted as a canonical and kept as one character: %j', (name) => {
    const term = TermSchema.parse({ canonical: name });
    expect(term.canonical).toBe(name);
  });

  it('writes the pair as its two surrogate code units', () => {
    expect(rocket).toHaveLength(2);
    expect(rocket.charCodeAt(0)).toBe(0xd83d);
    expect(rocket.charCodeAt(1)).toBe(0xde80);
    expect(TermSchema.parse({ canonical: '🚀' }).canonical).toBe(rocket);
  });

  it('survives parseLexicon and a YAML write and read', () => {
    const first = parseLexicon({ terms: [{ canonical: `Rocket${rocket}` }] });
    const second = parseLexicon(parse(stringify(first)));
    expect(second.terms[0].canonical).toBe(`Rocket${rocket}`);
  });

  it('keeps a pair that ends exactly at the word limit and rejects one past it', () => {
    const atLimit = 'a'.repeat(LIMITS.word - 1) + rocket;
    expect(TermSchema.parse({ canonical: atLimit }).canonical).toBe(atLimit);
    expect(TermSchema.safeParse({ canonical: `${atLimit}a` }).success).toBe(false);
  });

  it('still rejects a lone surrogate half beside a valid pair', () => {
    expect(TermSchema.safeParse({ canonical: `${rocket}\uD83D` }).success).toBe(false);
    expect(TermSchema.safeParse({ canonical: `\uDE80${rocket}` }).success).toBe(false);
  });
});
