import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, LIMITS } from '../src/core/schema.js';

const reference = readFileSync(new URL('../docs/schema-limit-reference.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('schema limit reference', () => {
  it('records each public limit and the contract values', () => {
    for (const [name, value] of Object.entries(LIMITS)) {
      expect(reference).toContain(`| \`${name}\` | ${value} |`);
      expect(contract).toContain(`\`${name}\` ${value}`);
    }
    expect(reference).toContain('| `createdAt` | 64 |');
    expect(reference).toContain('omissions in the');
  });

  it.each([
    ['canonical', (s: string) => ({ terms: [{ canonical: s }] })],
    ['alias', (s: string) => ({ terms: [{ canonical: 'X', aliases: [s] }] })],
    ['never', (s: string) => ({ terms: [{ canonical: 'X', never: [s] }] })],
    ['protectedWords', (s: string) => ({ settings: { protectedWords: [s] } })],
    ['packs', (s: string) => ({ settings: { packs: [s] } })],
  ])('documents the word limit applied to %s', (_field, input) => {
    const word = '𠮷'.repeat(LIMITS.word);
    expect(LexiconSchema.safeParse(input(` \u200b${word} `)).success).toBe(true);
    expect(LexiconSchema.safeParse(input(`${word}𠮷`)).success).toBe(false);
  });

  it.each([
    ['aliases', (entries: string[]) => ({ terms: [{ canonical: 'X', aliases: entries }] }), LIMITS.aliases],
    ['never', (entries: string[]) => ({ terms: [{ canonical: 'X', never: entries }] }), LIMITS.aliases],
    ['packs', (entries: string[]) => ({ settings: { packs: entries } }), LIMITS.aliases],
    ['protectedWords', (entries: string[]) => ({ settings: { protectedWords: entries } }), LIMITS.protectedWords],
  ])('counts cleaned %s entries without deduplicating', (_field, input, max) => {
    const entries = Array<string>(max).fill('same');
    expect(LexiconSchema.safeParse(input([...entries, ' ', '\u200b'])).success).toBe(true);
    expect(LexiconSchema.safeParse(input([...entries, 'same'])).success).toBe(false);
  });

  it.each([
    ['phonetic', LIMITS.text],
    ['notes', LIMITS.text],
    ['createdAt', 64],
  ])('enforces the documented %s length', (field, max) => {
    const input = (length: number) => ({ terms: [{ canonical: 'X', [field]: '𠮷'.repeat(length) }] });
    expect(LexiconSchema.safeParse(input(max)).success).toBe(true);
    expect(LexiconSchema.safeParse(input(max + 1)).success).toBe(false);
  });
});
