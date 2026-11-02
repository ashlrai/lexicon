import { describe, expect, it } from 'vitest';
import { findUnencodableChar, LexiconSchema, parseLexicon } from '../src/core/schema.js';

describe('a valid surrogate pair', () => {
  // U+1F680 ROCKET, the first and last supplementary code points, and a CJK extension character.
  const pairs = ['🚀', '𐀀', '􏿿', '𠀋'];

  it.each(pairs)('is not reported as unencodable: %j', (pair) => {
    expect(findUnencodableChar(pair)).toBeUndefined();
    expect(findUnencodableChar(`before ${pair} after`)).toBeUndefined();
    expect(findUnencodableChar(`${pair}${pair}`)).toBeUndefined();
  });

  it.each(pairs)('is accepted in every free-text field: %j', (pair) => {
    const result = LexiconSchema.safeParse({
      terms: [
        {
          canonical: `Rocket${pair}`,
          aliases: [`rock${pair}et`],
          never: [pair],
          phonetic: `rok${pair}`,
          notes: `launch ${pair}`,
        },
      ],
      settings: { protectedWords: [pair], packs: [`pack${pair}`] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.terms[0].canonical).toBe(`Rocket${pair}`);
    expect(result.data.terms[0].aliases).toEqual([`rock${pair}et`]);
    expect(result.data.terms[0].phonetic).toBe(`rok${pair}`);
    expect(result.data.terms[0].notes).toBe(`launch ${pair}`);
    expect(result.data.settings?.protectedWords).toEqual([pair]);
  });

  it('survives parseLexicon without an unpaired-surrogate error', () => {
    const lexicon = parseLexicon({ terms: [{ canonical: 'Rocket 🚀', aliases: ['🚀 ship'] }] });
    expect(lexicon.terms[0].canonical).toBe('Rocket 🚀');
    expect(lexicon.terms[0].aliases).toEqual(['🚀 ship']);
  });

  it('still rejects a lone half next to a valid pair', () => {
    expect(findUnencodableChar('🚀\uD83D')).toBe('U+D83D');
    expect(findUnencodableChar('\uDE80🚀')).toBe('U+DE80');
  });
});
