import { describe, expect, it } from 'vitest';
import { parseLexicon } from './schema.js';

const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';

describe('term names in schema errors', () => {
  it.each([
    { length: 39, shown: 'n'.repeat(39) },
    { length: 40, shown: 'n'.repeat(40) },
    { length: 41, shown: `${'n'.repeat(39)}…` },
    { length: 80, shown: `${'n'.repeat(39)}…` },
  ])('shows a $length-character name as "$shown"', ({ length, shown }) => {
    expect(() => parseLexicon({ terms: [{ canonical: 'n'.repeat(length), aliases: ['\uFFFF'] }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases[0]: must not contain U+FFFF (${reason}) in term "${shown}"`,
    );
  });

  it.each([
    { canonical: `A\uFFFE\uFFFF\uD800\uDC00\uDFFFz`, shown: 'A\\uFFFE\\uFFFF𐀀\\uDFFFz', found: 'U+FFFE' },
    { canonical: `${'n'.repeat(34)}\uD800`, shown: `${'n'.repeat(34)}\\uD800`, found: 'U+D800' },
    { canonical: `${'n'.repeat(33)}\uD800xx`, shown: `${'n'.repeat(33)}\\uD800…`, found: 'U+D800' },
  ])('escapes invalid code units in the displayed name for $found', ({ canonical, shown, found }) => {
    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: must not contain ${found} (${reason}) in term "${shown}"`,
    );
  });
});
