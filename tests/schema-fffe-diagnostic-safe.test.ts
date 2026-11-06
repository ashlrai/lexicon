import { describe, expect, it } from 'vitest';
import { LexiconSchema, parseLexicon } from '../src/core/schema.js';

const FFFE = '\uFFFE';

// The diagnostic for U+FFFE must name the code unit as text ("U+FFFE" and
// "\uFFFE"), never echo the raw noncharacter back into a terminal, log or
// file, whichever field carried it.
describe('U+FFFE diagnostic is safe to print', () => {
  const raw = {
    terms: [{
      canonical: `Ash${FFFE}lr`,
      aliases: [`a${FFFE}`],
      never: [`n${FFFE}`],
      phonetic: `p${FFFE}`,
      notes: `n${FFFE}`,
      createdAt: `c${FFFE}`,
    }],
    settings: { protectedWords: [`w${FFFE}`], packs: [`p${FFFE}`] },
  };

  it('names U+FFFE in every field and echoes no raw code unit in any issue', () => {
    const result = LexiconSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues).toHaveLength(8);
    for (const { message } of result.error.issues) {
      expect(message).toContain('U+FFFE');
      expect(message).not.toContain(FFFE);
    }
  });

  it('keeps the thrown parseLexicon error free of the raw code unit', () => {
    let message = '';
    try {
      parseLexicon(raw);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toContain('terms[0].canonical: must not contain U+FFFE');
    expect(message).toContain('in term "Ash\\uFFFElr"');
    expect(message).not.toContain(FFFE);
  });

  it('escapes the unit even when it is the only character or sits at the truncation cut', () => {
    const only = LexiconSchema.safeParse({ terms: [{ canonical: FFFE }] });
    const cut = LexiconSchema.safeParse({ terms: [{ canonical: `${'A'.repeat(38)}${FFFE}tail`, notes: FFFE }] });
    for (const result of [only, cut]) {
      if (result.success) throw new Error('Expected U+FFFE to be rejected');
      for (const { message } of result.error.issues) expect(message).not.toContain(FFFE);
    }
    const first = only.success ? '' : only.error.issues[0]?.message;
    expect(first).toContain('in term "\\uFFFE"');
  });
});
