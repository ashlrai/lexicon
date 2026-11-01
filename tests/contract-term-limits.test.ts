import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, LIMITS } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/contract-term-limits.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('contract term limits reference', () => {
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

  it('counts aliases and never lists separately', () => {
    const entries = Array<string>(LIMITS.aliases).fill('word');
    const input = (aliases: string[], never: string[]) => ({ terms: [{ canonical: 'X', aliases, never }] });
    expect(LexiconSchema.safeParse(input(entries, entries)).success).toBe(true);
    expect(LexiconSchema.safeParse(input([...entries, 'extra'], entries)).success).toBe(false);
    expect(LexiconSchema.safeParse(input(entries, [...entries, 'extra'])).success).toBe(false);
  });
});
