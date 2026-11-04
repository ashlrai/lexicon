import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, LIMITS, TermSchema } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/contract-term-limits.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('contract term limits reference', () => {
  it.each(['a', '𠮷'])('enforces the documented alias word limit for %s', (character) => {
    const match = contract.match(/`word` (\d+) \(canonical, alias\)/);
    expect(match).not.toBeNull();
    const documentedLimit = Number(match![1]);
    expect(documentedLimit).toBe(80);

    const alias = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical: 'Name', aliases: [alias] }).aliases).toEqual([alias]);

    const result = TermSchema.safeParse({ canonical: 'Name', aliases: [alias + character] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias to exceed the documented word limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases', 0], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it.each(['a', '𠮷'])('enforces the documented canonical word limit for %s', (character) => {
    const match = contract.match(/`word` (\d+) \(canonical, alias\)/);
    expect(match).not.toBeNull();
    const documentedLimit = Number(match![1]);
    expect(documentedLimit).toBe(80);

    const canonical = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical }).canonical).toBe(canonical);

    const result = TermSchema.safeParse({ canonical: canonical + character });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the canonical to exceed the documented word limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it.each(['a', '𠮷'])('enforces the documented phonetic text limit for %s', (character) => {
    const match = contract.match(/`text` (\d+) \(notes, phonetic\)/);
    expect(match).not.toBeNull();
    const documentedLimit = Number(match![1]);
    expect(documentedLimit).toBe(200);

    const phonetic = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical: 'Name', phonetic }).phonetic).toBe(phonetic);

    const result = TermSchema.safeParse({ canonical: 'Name', phonetic: phonetic + character });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected phonetic to exceed the documented text limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['phonetic'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it.each([
    ['word', 'Unicode code points in each term\'s `canonical` and each `aliases` entry'],
    ['text', 'Unicode code points in each term\'s `notes` and `phonetic` field'],
    ['aliases', 'Entries in each term\'s `aliases` list and `never` list, counted separately'],
    ['terms', 'Entries in the file\'s `terms` list'],
    ['protectedWords', 'Entries in `settings.protectedWords`'],
  ] as const)('keeps the %s value and fields in step with the contract', (name, fields) => {
    expect(doc).toContain(`| \`${name}\` | ${LIMITS[name]} | ${fields} |`);
    expect(contract).toContain(`\`${name}\` ${LIMITS[name]}`);
  });

  it('accepts the term limit and rejects one additional term', () => {
    const terms = Array.from({ length: LIMITS.terms }, (_, i) => ({ canonical: `Term${i}` }));
    expect(LexiconSchema.safeParse({ terms }).success).toBe(true);
    expect(LexiconSchema.safeParse({ terms: [...terms, { canonical: 'Overflow' }] }).success).toBe(false);
  });

  it('accepts 64 aliases per term and rejects 65', () => {
    const match = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(64);

    const aliases = Array.from({ length: 64 }, (_, i) => `alias ${i}`);
    expect(TermSchema.parse({ canonical: 'Name', aliases }).aliases).toEqual(aliases);

    const result = TermSchema.safeParse({ canonical: 'Name', aliases: [...aliases, 'overflow'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias count to exceed the documented limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: 64, message: 'at most 64 aliases per term' },
    ]);
  });

  it('counts aliases and never lists separately', () => {
    const entries = Array<string>(LIMITS.aliases).fill('word');
    const input = (aliases: string[], never: string[]) => ({ terms: [{ canonical: 'X', aliases, never }] });
    expect(LexiconSchema.safeParse(input(entries, entries)).success).toBe(true);
    expect(LexiconSchema.safeParse(input([...entries, 'extra'], entries)).success).toBe(false);
    expect(LexiconSchema.safeParse(input(entries, [...entries, 'extra'])).success).toBe(false);
  });
});
