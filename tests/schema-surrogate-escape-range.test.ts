import { describe, expect, it } from 'vitest';
import { TermSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

// The diagnostic for an unpaired surrogate writes the rejected code unit as a
// literal \uXXXX escape in the quoted term name (and as U+XXXX in the reason),
// never the raw unit: a lone surrogate cannot be encoded in UTF-8, so printing
// one would come back as U+FFFD or mojibake and the user could not tell which
// code unit was rejected. The other schema tests pin fixed examples; this one
// sweeps the whole surrogate range and the pair boundaries on either side of
// it, so a narrowing of the range, a lowercase or short hex escape, or a raw
// unit leaking into the message fails here no matter which unit regressed.

const hex = (cp: number): string => cp.toString(16).toUpperCase().padStart(4, '0');

describe('unpaired surrogate escape over the whole range', () => {
  it('writes every code unit U+D800..U+DFFF as a \\uXXXX escape in the term name', () => {
    for (let cp = 0xd800; cp <= 0xdfff; cp++) {
      const unit = String.fromCharCode(cp);
      const label = `U+${hex(cp)}`;
      const canonical = `a${unit}b`;

      expect(findUnencodableChar(canonical), label).toBe(label);

      const result = TermSchema.safeParse({ canonical });
      expect(result.success, label).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.map(({ path, message }) => ({ path, message })), label).toEqual([
        { path: ['canonical'], message: `must not contain ${label} (${UNENCODABLE_NOTE}) in term "a\\u${hex(cp)}b"` },
      ]);
      // The diagnostic itself is encodable: no raw unit survives in it.
      expect(findUnencodableChar(result.error.issues[0].message), label).toBeUndefined();
      expect(result.error.issues[0].message).not.toContain(unit);
    }
  });

  it('escapes nothing that is half of a valid pair, at every range boundary', () => {
    // Every high surrogate against both low-surrogate ends, and every low
    // surrogate against both high-surrogate ends: the pair lookarounds must
    // hold at the edges of the ranges, not only for mid-range emoji.
    for (let cp = 0xd800; cp <= 0xdbff; cp++) {
      const high = String.fromCharCode(cp);
      for (const low of ['\uDC00', '\uDFFF']) {
        expect(findUnencodableChar(`a${high}${low}b`), `U+${hex(cp)} + ${hex(low.charCodeAt(0))}`).toBeUndefined();
      }
    }
    for (let cp = 0xdc00; cp <= 0xdfff; cp++) {
      const low = String.fromCharCode(cp);
      for (const high of ['\uD800', '\uDBFF']) {
        expect(findUnencodableChar(`a${high}${low}b`), `${hex(high.charCodeAt(0))} + U+${hex(cp)}`).toBeUndefined();
      }
    }
    expect(TermSchema.parse({ canonical: 'x', aliases: ['\uD800\uDC00', '\uDBFF\uDFFF'] }).aliases)
      .toEqual(['\u{10000}', '\u{10FFFF}']);
  });

  it.each([0xd800, 0xd83d, 0xdbff, 0xdc00, 0xdead, 0xdfff])(
    'throws the same escaped diagnostic through parseLexicon for U+%s',
    (cp) => {
      const unit = String.fromCharCode(cp);
      let message = '';
      try {
        parseLexicon({ terms: [{ canonical: `a${unit}b` }] });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        message = error.message;
      }
      expect(message).toBe(
        `Invalid lexicon:\n  - terms[0].canonical: must not contain U+${hex(cp)} (${UNENCODABLE_NOTE}) in term "a\\u${hex(cp)}b"`,
      );
      expect(message).not.toContain(unit);
      // The thrown text is encodable end to end: a UTF-8 round-trip is lossless.
      expect(findUnencodableChar(message)).toBeUndefined();
      expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message);
    },
  );

  it.each([
    [34, `${'A'.repeat(34)}\\uD800`], // the escaped name fits exactly
    [35, `${'A'.repeat(35)}\\uD8…`], // the 40-character cut lands inside the escape
    [38, `${'A'.repeat(38)}\\…`], // only the backslash remains
    [39, `${'A'.repeat(39)}…`], // the escape is cut entirely
  ])('keeps the escape, never the raw unit, at the name boundary with %i leading characters', (count, shown) => {
    const result = TermSchema.safeParse({ canonical: `${'A'.repeat(count)}\uD800` });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired surrogate to be rejected');
    const message = result.error.issues[0].message;
    expect(message).toContain(`in term "${shown}"`);
    expect(message).not.toContain('\uD800');
    expect(findUnencodableChar(message)).toBeUndefined();
  });

  it.each([
    ['aliases', ['ok', 'a\uD83Db'], ['aliases', 1]],
    ['never', ['ok', 'a\uD83Db'], ['never', 1]],
    ['phonetic', 'p\uD83D', ['phonetic']],
    ['notes', 'n\uD83D', ['notes']],
    ['createdAt', 'c\uD83D', ['createdAt']],
  ] as const)('names U+D83D for %s without a name escape, and no raw unit', (field, value, path) => {
    const result = TermSchema.safeParse({ canonical: 'Rocket', [field]: value });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired surrogate to be rejected');
    expect(result.error.issues.map(({ path: p, message }) => ({ path: p, message }))).toEqual([
      { path, message: `must not contain U+D83D (${UNENCODABLE_NOTE}) in term "Rocket"` },
    ]);
    expect(findUnencodableChar(result.error.issues[0].message)).toBeUndefined();
  });
});
