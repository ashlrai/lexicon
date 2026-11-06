import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  LexiconSchema,
  LexiconSettingsSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  findUnencodableChar,
  parseLexicon,
} from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0] ?? '';

// The note the contract records (`UNENCODABLE_NOTE = '...'`), used to build the
// documented error text so the test fails when doc and code drift apart.
const documentedNote = section.match(/UNENCODABLE_NOTE = '([^']+)'/)?.[1];
const reason = (unit: string) => `must not contain ${unit} (${documentedNote})`;

// A high surrogate (U+D800 to U+DBFF) is unpaired when no low surrogate
// (U+DC00 to U+DFFF) follows it. These cover each way that happens.
const UNPAIRED_HIGH: ReadonlyArray<readonly [string, string, string]> = [
  ['a lone high surrogate', 'Ashlr\uD800', 'U+D800'],
  ['the last high surrogate', 'Ashlr\uDBFF', 'U+DBFF'],
  ['a high surrogate before a BMP letter', '\uD800x', 'U+D800'],
  ['a high surrogate before another high surrogate', '\uD800\uD83D', 'U+D800'],
  ['a high surrogate before a valid pair', 'Rocket \uD800\uD83D\uDE80', 'U+D800'],
];

describe('unpaired high surrogate contract', () => {
  it('is documented in CONTRACT.md with the exported note and error shape', () => {
    expect(section).toContain('unpaired surrogate');
    expect(section).toContain('`must not contain U+XXXX (UNENCODABLE_NOTE)`');
    expect(section).toContain('` in term "<canonical>"`');
    expect(documentedNote).toBe(UNENCODABLE_NOTE);
  });

  it.each(UNPAIRED_HIGH)('findUnencodableChar names the offending code unit in %s', (_description, input, unit) => {
    expect(findUnencodableChar(input)).toBe(unit);
    // The named unit is the input's own first offending code unit, not a
    // constant: the same shape with a different surrogate names that one.
    const other = input.replace('\uD800', '\uD801').replace('\uDBFF', '\uD801');
    expect(findUnencodableChar(other)).toBe('U+D801');
  });

  it.each([
    [{ canonical: 'Ash\uD800lr' }, ['canonical'], 'Ash\\uD800lr'],
    [{ canonical: 'Ashlr.AI', aliases: ['ok', 'Ash\uD800ler'] }, ['aliases', 1], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', never: ['ok', 'Ash\uD800ler'] }, ['never', 1], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', phonetic: 'ash\uD800ler' }, ['phonetic'], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', notes: 'note\uD800' }, ['notes'], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', createdAt: '2026\uD800' }, ['createdAt'], 'Ashlr.AI'],
  ])('rejects an unpaired high surrogate in standalone term field %#, naming the unit and the term', (term, path, name) => {
    const result = TermSchema.safeParse(term);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired high surrogate to be rejected');
    expect(result.error.issues.map(({ path: issuePath, message }) => ({ path: issuePath, message }))).toEqual([
      { path, message: `${reason('U+D800')} in term "${name}"` },
    ]);
  });

  it('rejects one in every free-text field of a term at its own path', () => {
    const result = LexiconSchema.safeParse({
      terms: [
        {
          canonical: 'Ashlr.AI',
          aliases: ['ok', 'a\uD800b'],
          never: ['n\uDBFFo'],
          phonetic: 'ph\uD800',
          notes: 'no\uD83Dte',
          createdAt: '2026\uD800',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired high surrogates to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      [
        [['terms', 0, 'aliases', 1], 'U+D800'],
        [['terms', 0, 'never', 0], 'U+DBFF'],
        [['terms', 0, 'phonetic'], 'U+D800'],
        [['terms', 0, 'notes'], 'U+D83D'],
        [['terms', 0, 'createdAt'], 'U+D800'],
      ].map(([path, unit]) => ({ path, message: `${reason(unit as string)} in term "Ashlr.AI"` })),
    );
  });

  it('rejects one through parseLexicon with the documented Invalid lexicon error', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: ['Ash\uD800ler'] }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases[0]: ${reason('U+D800')} in term "Ashlr.AI"`,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'Ash\uDBFFlr' }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${reason('U+DBFF')} in term "Ash\\uDBFFlr"`,
    );
  });

  it('rejects one in both settings lists without a term name', () => {
    for (const [schema, wrap, paths] of [
      [LexiconSettingsSchema, (s: string) => ({ protectedWords: ['ok', `w${s}d`], packs: [`p${s}`] }), [['protectedWords', 1], ['packs', 0]]],
      [LexiconSchema, (s: string) => ({ terms: [], settings: { protectedWords: ['ok', `w${s}d`], packs: [`p${s}`] } }), [['settings', 'protectedWords', 1], ['settings', 'packs', 0]]],
    ] as const) {
      const result = schema.safeParse(wrap('\uD800'));

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected the unpaired high surrogate to be rejected');
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
        paths.map((path) => ({ path, message: reason('U+D800') })),
      );
    }
    expect(() => parseLexicon({ terms: [], settings: { packs: ['pack\uD800'] } })).toThrow(
      `settings.packs[0]: ${reason('U+D800')}`,
    );
  });

  it('rejects one spelled as a YAML escape, the way a hand-edited file carries it', () => {
    // No UTF-8 file can hold a lone surrogate raw; a double-quoted YAML
    // scalar can still spell one as \uD800 and the parser hands it to the schema.
    const raw = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["Ash\\uD800ler"]\n');

    expect(() => parseLexicon(raw)).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases[0]: ${reason('U+D800')} in term "Ashlr.AI"`,
    );
  });

  it.each([
    ['the first supplementary code point', 'LINE\uD800\uDC00', 'LINE\u{10000}'],
    ['the last code point', 'END\uDBFF\uDFFF', 'END\u{10FFFF}'],
  ])('accepts %s written as a pair, which the contract keeps legal', (_description, paired, expected) => {
    expect(findUnencodableChar(paired)).toBeUndefined();
    expect(TermSchema.parse({ canonical: 'Rocket', aliases: [paired] }).aliases).toEqual([expected]);
    expect(parseLexicon({ terms: [{ canonical: 'Rocket', aliases: [paired] }] }).terms[0].aliases).toEqual([expected]);
  });
});
