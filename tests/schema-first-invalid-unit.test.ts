import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { findUnencodableChar, LexiconSchema, parseLexicon } from '../src/core/schema.js';

describe('first invalid code unit documentation', () => {
  const doc = readFileSync(new URL('../docs/schema-first-invalid-unit.md', import.meta.url), 'utf8');
  const examples = [...doc.matchAll(/<!-- first-unit-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)];

  it('matches the documented YAML and complete error', () => {
    expect(examples).toHaveLength(1);
    let message: string | undefined;
    try {
      parseLexicon(parseYaml(examples[0][1]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(examples[0][2]);
  });

  it.each([
    ['\uFFFF\uFFFE', 'U+FFFF'],
    ['\uFFFE\uFFFF', 'U+FFFE'],
    ['\uD800x\uDC00', 'U+D800'],
    ['\uDC00x\uD800', 'U+DC00'],
    ['\uD800\uD83D\uDE80\uFFFF', 'U+D800'],
    ['\uD83D\uDE80\uDC00\uFFFF', 'U+DC00'],
    ['\uD83D\uDE80', undefined],
  ])('finds the first invalid unit in %j', (input, expected) => {
    expect(findUnencodableChar(input)).toBe(expected);
  });

  it.each([
    ['ASCII before noncharacters', 'Hello\uFFFF then \uFFFE', 'U+FFFF'],
    ['BMP text before a high surrogate', 'Café 東京\uDBFFx\uFFFE', 'U+DBFF'],
    ['a valid pair before a low surrogate', 'Rocket 🚀\uDFFF then \uD800', 'U+DFFF'],
    ['a valid pair before a noncharacter', 'Rocket 🚀\uFFFE then \uFFFF', 'U+FFFE'],
    ['a high surrogate before a valid pair', 'Rocket \uD800🚀 then \uFFFF', 'U+D800'],
  ])('reports the first invalid unit after %s', (_description, input, expected) => {
    expect(findUnencodableChar(input)).toBe(expected);

    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Rocket', aliases: [input] }],
      settings: { protectedWords: [input] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid text to be rejected');
    const reason = `must not contain ${expected} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`;
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'aliases', 0], message: `${reason} in term "Rocket"` },
      { path: ['settings', 'protectedWords', 0], message: reason },
    ]);
  });

  it('reports the first invalid unit in notes and packs on repeated calls', () => {
    const inputs = [
      ['Rocket 🚀\uFFFF then \uD800', 'U+FFFF'],
      ['Rocket 🚀\uD800 then \uFFFF', 'U+D800'],
      ['Rocket 🚀\uFFFF then \uD800', 'U+FFFF'],
    ];

    for (const [input, first] of inputs) {
      const reason = `must not contain ${first} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`;
      expect(() => parseLexicon({
        terms: [{ canonical: 'Rocket', notes: input }],
        settings: { packs: [input] },
      })).toThrow(
        `Invalid lexicon:\n  - terms[0].notes: ${reason} in term "Rocket"\n` +
        `  - settings.packs[0]: ${reason}`,
      );
    }
  });

  it.each([
    ['two high surrogates', '\uD800\uDBFF', 'U+D800', '\\uD800\\uDBFF'],
    ['two low surrogates', '\uDC00\uDFFF', 'U+DC00', '\\uDC00\\uDFFF'],
    ['low then high surrogate', '\uDFFF\uD800', 'U+DFFF', '\\uDFFF\\uD800'],
    ['noncharacter then surrogate', '\uFFFE\uD800', 'U+FFFE', '\\uFFFE\\uD800'],
    ['surrogate then noncharacter', '\uDC00\uFFFF', 'U+DC00', '\\uDC00\\uFFFF'],
    ['high surrogate followed by a valid pair', '\uD800\uD83D\uDE80', 'U+D800', '\\uD800🚀'],
    ['valid pair followed by two low surrogates', '\uD83D\uDE80\uDC00\uDFFF', 'U+DC00', '🚀\\uDC00\\uDFFF'],
    ['low surrogate followed by a valid pair', '\uDC00\uD83D\uDE80', 'U+DC00', '\\uDC00🚀'],
  ])('reports consecutive units: %s', (_description, input, expected, preview) => {
    const raw = {
      terms: [{ canonical: input, aliases: [input] }],
      settings: { protectedWords: [input] },
    };
    const reason = `must not contain ${expected} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`;

    expect(findUnencodableChar(input)).toBe(expected);
    const result = LexiconSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid text to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'canonical'], message: `${reason} in term "${preview}"` },
      { path: ['terms', 0, 'aliases', 0], message: `${reason} in term "${preview}"` },
      { path: ['settings', 'protectedWords', 0], message: reason },
    ]);
    expect(() => parseLexicon(raw)).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${reason} in term "${preview}"\n` +
      `  - terms[0].aliases[0]: ${reason} in term "${preview}"\n` +
      `  - settings.protectedWords[0]: ${reason}`,
    );
  });

  it('reports each field\'s own first unit when one term carries a different pair in every text field', () => {
    // Every free-text field the term-level check walks gets two distinct
    // invalid code units in a different order, so each issue must name the
    // unit that is first in that field, not the first the file happens to
    // contain. Issues list in TERM_TEXT_FIELDS order, then the two settings
    // lists, each at its own path.
    const inputs = {
      canonical: 'A\uFFFEz\uFFFF',
      aliases: 'a\uFFFFb\uD800',
      never: 'n\uD800n\uDC00',
      phonetic: 'p\uDC00p\uFFFE',
      notes: 'n\uDBFFn\uFFFF',
      createdAt: 'c\uFFFFc\uDFFF',
      protectedWords: 'w\uDFFFw\uFFFE',
      packs: 'p\uFFFEp\uDC00',
    };
    const first = {
      canonical: 'U+FFFE',
      aliases: 'U+FFFF',
      never: 'U+D800',
      phonetic: 'U+DC00',
      notes: 'U+DBFF',
      createdAt: 'U+FFFF',
      protectedWords: 'U+DFFF',
      packs: 'U+FFFE',
    };
    for (const [field, input] of Object.entries(inputs)) {
      expect(findUnencodableChar(input), field).toBe(first[field as keyof typeof first]);
    }

    const name = 'A\\uFFFEz\\uFFFF';
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';
    const inTerm = (found: string) => `must not contain ${found} (${reason}) in term "${name}"`;
    const result = LexiconSchema.safeParse({
      terms: [{
        canonical: inputs.canonical,
        aliases: [inputs.aliases],
        never: [inputs.never],
        phonetic: inputs.phonetic,
        notes: inputs.notes,
        createdAt: inputs.createdAt,
      }],
      settings: { protectedWords: [inputs.protectedWords], packs: [inputs.packs] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid code units to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'canonical'], message: inTerm(first.canonical) },
      { path: ['terms', 0, 'aliases', 0], message: inTerm(first.aliases) },
      { path: ['terms', 0, 'never', 0], message: inTerm(first.never) },
      { path: ['terms', 0, 'phonetic'], message: inTerm(first.phonetic) },
      { path: ['terms', 0, 'notes'], message: inTerm(first.notes) },
      { path: ['terms', 0, 'createdAt'], message: inTerm(first.createdAt) },
      { path: ['settings', 'protectedWords', 0], message: `must not contain ${first.protectedWords} (${reason})` },
      { path: ['settings', 'packs', 0], message: `must not contain ${first.packs} (${reason})` },
    ]);
  });

  it('reports the next invalid unit in the same entry after the first is removed', () => {
    // The fix loop the doc example ends with: a field holds two distinct
    // invalid code units, the error names the first, and once that unit is
    // removed the next parse names the second. Removing it too leaves the
    // entry clean.
    const lexicon = (alias: string) => ({ terms: [{ canonical: 'Rocket', aliases: [alias] }] });
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';

    expect(() => parseLexicon(lexicon('a\uFFFFb\uD800'))).toThrow(
      `terms[0].aliases[0]: must not contain U+FFFF (${reason}) in term "Rocket"`,
    );
    expect(() => parseLexicon(lexicon('ab\uD800'))).toThrow(
      `terms[0].aliases[0]: must not contain U+D800 (${reason}) in term "Rocket"`,
    );
    expect(parseLexicon(lexicon('ab')).terms[0].aliases).toEqual(['ab']);
  });

  it('holds a term\'s invalid-unit report until that term\'s fields type-check', () => {
    // The term-level check runs on the parsed term, so a field of the wrong
    // type fails the term itself and its other fields' invalid units are not
    // listed yet: the type error is what the hand editor sees first, and the
    // hidden unit is named on the next pass once the shape is right. A
    // malformed sibling term does not hide a clean term's report.
    const result = LexiconSchema.safeParse({
      terms: [
        { canonical: 5, notes: 'x\uFFFEy\uFFFF' },
        { canonical: 'Y', notes: 'n\uD800' },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid input to be rejected');
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'canonical'], message: 'Invalid input: expected string, received number' },
      { path: ['terms', 1, 'notes'], message: `must not contain U+D800 (${reason}) in term "Y"` },
    ]);

    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: 'x\uFFFEy\uFFFF' }] })).toThrow(
      `terms[0].notes: must not contain U+FFFE (${reason}) in term "X"`,
    );
  });

  it('accepts mixed valid ASCII, BMP text and supplementary characters', () => {
    const input = 'Hello Café 東京 🚀 𠀀';
    expect(findUnencodableChar(input)).toBeUndefined();
    expect(parseLexicon({ terms: [{ canonical: 'Rocket', aliases: [input] }] }).terms[0].aliases).toEqual([input]);
  });
});
