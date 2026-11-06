import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, LIMITS } from '../src/core/schema.js';
import { MAX_CORRECTION_LENGTH } from '../src/core/caps.js';

const doc = readFileSync(new URL('../docs/term-capacity-reference.md', import.meta.url), 'utf8');
const [counts, lengths] = doc.split('## Text-length limits (how long)');

describe('term capacity reference', () => {
  it('lists every count limit under counts and every length under lengths', () => {
    expect(counts).toContain(`| Terms per lexicon file | ${LIMITS.terms} | \`terms\``);
    expect(counts).toContain(`| Aliases per term | ${LIMITS.aliases} | \`aliases\``);
    expect(counts).toContain(`| \`never\` words per term | ${LIMITS.aliases} |`);
    expect(counts).toContain(`| \`context\` words per term | ${LIMITS.aliases} |`);
    expect(counts).toContain(`| \`settings.protectedWords\` entries | ${LIMITS.protectedWords} |`);
    expect(lengths).toContain(`| \`canonical\` | ${LIMITS.word} | \`word\``);
    expect(lengths).toContain(`| \`notes\`, \`phonetic\` | ${LIMITS.text} | \`text\``);
    expect(lengths).toContain(`(${MAX_CORRECTION_LENGTH}, in \`caps.ts\`)`);
  });

  it('matches the contract and the documented source references exist', () => {
    const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
    for (const [k, v] of Object.entries(LIMITS)) expect(contract).toContain(`\`${k}\` ${v}`);
    const schema = readFileSync(new URL('../src/core/schema.ts', import.meta.url), 'utf8');
    for (const fn of ['buildLexicon', 'buildTerm', 'buildSettings', 'NonEmptyWord', 'CleanWordList']) {
      expect(doc).toContain(fn);
      expect(schema).toContain(`function ${fn}`);
    }
  });

  it('enforces counts and lengths independently', () => {
    const alias = 'x'.repeat(LIMITS.word);
    const aliases = (n: number, a = alias) => ({ terms: [{ canonical: 'X', aliases: Array.from({ length: n }, (_, i) => `${a}${i}`.slice(-LIMITS.word)) }] });
    expect(LexiconSchema.safeParse(aliases(LIMITS.aliases)).success).toBe(true);
    expect(LexiconSchema.safeParse(aliases(LIMITS.aliases + 1, 'a')).success).toBe(false);
    expect(LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: ['y'.repeat(LIMITS.word + 1)] }] }).success).toBe(false);
    const terms = (n: number) => ({ terms: Array.from({ length: n }, (_, i) => ({ canonical: `t${i}` })) });
    expect(LexiconSchema.safeParse(terms(LIMITS.terms)).success).toBe(true);
    expect(LexiconSchema.safeParse(terms(LIMITS.terms + 1)).success).toBe(false);
  });
});
