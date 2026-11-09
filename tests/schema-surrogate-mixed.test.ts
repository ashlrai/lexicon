import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, findUnencodableChar } from '../src/core/schema.js';

const pair = '\uD83D\uDE80';

describe('surrogate validation in mixed text', () => {
  it.each([
    [`${pair}\uD800`, 'U+D800'],
    [`\uDC00${pair}`, 'U+DC00'],
    [`\uD800${pair}`, 'U+D800'],
    [`${pair}\uDC00`, 'U+DC00'],
    ['\uDC00\uD800', 'U+DC00'],
  ])('finds the first isolated unit in %j', (value, expected) => {
    expect(findUnencodableChar(value)).toBe(expected);
  });

  it.each(['canonical', 'aliases', 'never', 'context', 'phonetic', 'notes', 'createdAt'] as const)(
    'accepts pairs and rejects adjacent isolated units in %s',
    (field) => {
      const list = field === 'aliases' || field === 'never' || field === 'context';
      const term = (value: string) => ({ canonical: 'Rocket', [field]: list ? [value] : value });
      expect(TermSchema.safeParse(term(`before${pair}${pair}after`)).success).toBe(true);
      for (const [value, unit] of [[`${pair}\uD800`, 'U+D800'], [`${pair}\uDC00`, 'U+DC00']] as const) {
        const result = TermSchema.safeParse(term(value));
        expect(result.success).toBe(false);
        if (result.success) throw new Error('Expected an isolated surrogate to be rejected');
        expect(result.error.issues[0].path).toEqual(list ? [field, 0] : [field]);
        expect(result.error.issues[0].message).toContain(`must not contain ${unit}`);
      }
    },
  );

  it.each(['protectedWords', 'packs'] as const)('validates pairs and isolated units in settings.%s', (field) => {
    const lexicon = (value: string) => ({ settings: { [field]: [value] } });
    expect(LexiconSchema.safeParse(lexicon(pair)).success).toBe(true);
    for (const [value, unit] of [[`${pair}\uD800`, 'U+D800'], [`\uDC00${pair}`, 'U+DC00']] as const) {
      const result = LexiconSchema.safeParse(lexicon(value));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an isolated surrogate to be rejected');
      expect(result.error.issues[0].path).toEqual(['settings', field, 0]);
      expect(result.error.issues[0].message).toContain(`must not contain ${unit}`);
    }
  });
});
