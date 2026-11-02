import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('notes text length boundary', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`text` (\d+) \(notes, phonetic\)/);

  it('takes the limit from the contract: 200 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(200);
    expect(LIMITS.text).toBe(200);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['notes']],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'notes']],
  ] as const)('accepts notes at the limit and rejects one character over through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    for (const character of ['n', '🙂']) {
      const atLimit = character.repeat(limit);
      expect(schema.safeParse(wrap({ canonical: 'X', notes: atLimit })).success).toBe(true);

      const result = schema.safeParse(wrap({ canonical: 'X', notes: `${atLimit}${character}` }));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an overlong notes field to be rejected');
      expect(result.error.issues).toMatchObject([
        { code: 'too_big', path, maximum: limit, message: `must be at most ${limit} characters` },
      ]);
    }
  });

  it('measures the boundary after trimming and stripping invisible characters', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);

    expect(parseLexicon({ terms: [{ canonical: 'X', notes: `  ${atLimit}\u200b  ` }] }).terms[0].notes).toBe(atLimit);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${atLimit}n` }] })).toThrow(
      `terms[0].notes: must be at most ${limit} characters`,
    );
  });

  it('keeps a term whose notes is at the limit while a later term over it is refused', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);
    const raw = {
      terms: [
        { canonical: 'Within', notes: atLimit },
        { canonical: 'Over', notes: `${atLimit}n` },
      ],
    };

    expect(() => parseLexicon(raw)).toThrow(`terms[1].notes: must be at most ${limit} characters`);
  });
});
