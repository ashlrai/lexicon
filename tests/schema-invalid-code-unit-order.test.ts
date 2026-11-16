import { describe, expect, it } from 'vitest';
import { findUnencodableChar, LexiconSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

const invalid = [
  ['U+FFFE', '\uFFFE'],
  ['U+FFFF', '\uFFFF'],
  ['U+D800', '\uD800'],
  ['U+DC00', '\uDC00'],
] as const;

describe('multiple unencodable code units', () => {
  it('reports the first invalid unit in input order across term and settings fields', () => {
    for (const [firstName, first] of invalid) {
      for (const [secondName, second] of invalid) {
        // Separators prevent adjacent high and low surrogates from forming a valid pair.
        // A valid pair before the errors must not be mistaken for an invalid unit.
        const value = `start 🚀 ${first} middle ${second} end`;
        const label = `${firstName} before ${secondName}`;
        expect(findUnencodableChar(value), label).toBe(firstName);
        const input = { terms: [{ canonical: 'Example', aliases: [value] }], settings: { protectedWords: [value] } };
        const result = LexiconSchema.safeParse(input);
        expect(result.success, label).toBe(false);
        if (result.success) throw new Error(`Expected rejection: ${label}`);
        expect(result.error.issues, label).toMatchObject([
          { path: ['terms', 0, 'aliases', 0], message: `must not contain ${firstName} (${UNENCODABLE_NOTE}) in term "Example"` },
          { path: ['settings', 'protectedWords', 0], message: `must not contain ${firstName} (${UNENCODABLE_NOTE})` },
        ]);
        expect(() => parseLexicon(input), label).toThrow(`must not contain ${firstName} (${UNENCODABLE_NOTE})`);
      }
    }
  });
});
