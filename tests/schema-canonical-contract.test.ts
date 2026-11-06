import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('canonical word length contract', () => {
  it('enforces the documented boundary in both schemas and the parser', () => {
    const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
    const match = section?.match(/`word` (\d+) \(canonical, alias\)/);
    expect(match).toBeTruthy();
    const limit = Number(match![1]);
    expect(limit).toBe(80);

    for (const character of ['a', '🙂']) {
      const atLimit = character.repeat(limit);
      const overLimit = `${atLimit}${character}`;

      for (const [schema, wrap, path] of [
        [TermSchema, (canonical: string) => ({ canonical }), ['canonical']],
        [LexiconSchema, (canonical: string) => ({ terms: [{ canonical }] }), ['terms', 0, 'canonical']],
      ] as const) {
        expect(schema.safeParse(wrap(atLimit)).success).toBe(true);
        const result = schema.safeParse(wrap(overLimit));
        expect(result.success).toBe(false);
        if (result.success) throw new Error('Expected an overlong canonical to be rejected');
        expect(result.error.issues).toMatchObject([
          { code: 'too_big', path, maximum: limit, message: `must be at most ${limit} characters` },
        ]);
      }

      expect(parseLexicon({ terms: [{ canonical: `  ${atLimit}\u200b  ` }] }).terms[0].canonical).toBe(atLimit);
      expect(() => parseLexicon({ terms: [{ canonical: overLimit }] })).toThrow(
        `terms[0].canonical: must be at most ${limit} characters`,
      );
    }
  });
});
