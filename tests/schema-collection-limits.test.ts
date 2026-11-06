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

  it('enforces the contract limit of 5000 terms even when they are repeated', () => {
    // Keep the boundary independent of LIMITS so a contract change is deliberate.
    expect(contract).toContain('`terms` 5000');
    const terms = Array.from({ length: 5000 }, () => ({ canonical: 'Repeated' }));
    expect(LexiconSchema.parse({ terms }).terms).toHaveLength(5000);
    const overflow = { terms: [...terms, { canonical: 'Repeated' }] };
    const result = LexiconSchema.safeParse(overflow);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the terms limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms'], maximum: 5000 },
    ]);
    const error = 'terms: at most 5000 terms';
    expect(reference).toContain(error);
    expect(() => parseLexicon(overflow)).toThrow(error);
  });

  it('accepts 5000 distinct terms with aliases in order and refuses the 5001st', () => {
    const make = (i: number) => ({ canonical: `Term${i}`, aliases: [` alias ${i} `] });
    const terms = Array.from({ length: 5000 }, (_, i) => make(i));
    const parsed = parseLexicon({ terms });
    expect(parsed.terms).toHaveLength(5000);
    expect(parsed.terms[0]).toMatchObject({ canonical: 'Term0', aliases: ['alias 0'] });
    expect(parsed.terms[4999]).toMatchObject({ canonical: 'Term4999', aliases: ['alias 4999'] });
    expect(() => parseLexicon({ terms: [...terms, make(5000)] })).toThrow('terms: at most 5000 terms');
  });

  it('defaults missing and null collections but rejects null entries', () => {
    expect(parseLexicon({ terms: null }).terms).toEqual([]);
    expect(parseLexicon({}).terms).toEqual([]);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: null }, { canonical: 'Y' }] }).terms.map((term) => term.aliases)).toEqual([[], []]);
    expect(LexiconSchema.safeParse({ terms: [null] }).success).toBe(false);
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [null] }).success).toBe(false);
  });
});
