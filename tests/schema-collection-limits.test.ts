import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const reference = readFileSync(new URL('../docs/schema-collection-limits.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('schema collection limits reference', () => {
  it('records the contract values and corresponding validation definitions', () => {
    for (const name of ['aliases', 'terms'] as const) {
      expect(reference).toContain(`| \`LIMITS.${name}\` | ${LIMITS[name]} |`);
      expect(contract).toContain(`\`${name}\` ${LIMITS[name]}`);
    }
    for (const definition of ['buildTerm', 'WordList', 'CleanWordList', 'buildLexicon', 'z.array(term).max(LIMITS.terms)']) {
      expect(reference).toContain(`\`${definition}\``);
    }
  });

  it('counts cleaned aliases per term, including duplicates, and reports the documented error', () => {
    const aliases = Array<string>(LIMITS.aliases).fill(' same ');
    const parsed = parseLexicon({ terms: [{ canonical: 'First', aliases: [...aliases, ' ', '\u200b'] }, { canonical: 'Second', aliases }] });
    expect(parsed.terms.map((term) => term.aliases)).toEqual([Array<string>(LIMITS.aliases).fill('same'), Array<string>(LIMITS.aliases).fill('same')]);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [...aliases, 'same'] }).success).toBe(false);
    const error = `terms[0].aliases: at most ${LIMITS.aliases} aliases per term`;
    expect(reference).toContain(error);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [...aliases, 'same'] }] })).toThrow(error);
  });

  it('counts terms even when repeated and reports the documented error', () => {
    const terms = Array.from({ length: LIMITS.terms }, () => ({ canonical: 'Repeated' }));
    expect(LexiconSchema.parse({ terms }).terms).toHaveLength(LIMITS.terms);
    const error = `terms: at most ${LIMITS.terms} terms`;
    expect(reference).toContain(error);
    expect(() => parseLexicon({ terms: [...terms, { canonical: 'Repeated' }] })).toThrow(error);
  });

  it('defaults missing and null collections but rejects null entries', () => {
    expect(parseLexicon({ terms: null }).terms).toEqual([]);
    expect(parseLexicon({}).terms).toEqual([]);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: null }, { canonical: 'Y' }] }).terms.map((term) => term.aliases)).toEqual([[], []]);
    expect(LexiconSchema.safeParse({ terms: [null] }).success).toBe(false);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [null] }).success).toBe(false);
  });
});
