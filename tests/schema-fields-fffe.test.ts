import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  LexiconSchema,
  LexiconSettingsSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  findUnencodableChar,
  parseLexicon,
  stripInvisible,
} from '../src/core/schema.js';

const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

// U+FFFE is a Unicode noncharacter: no file format a lexicon is written to
// can carry it, so the schema refuses it in every free-text field and the
// message names the code point. One row per field `refuseUnencodable`
// walks (TERM_TEXT_FIELDS): the field value, the zod path the issue is
// attached to, the path as parseLexicon prints it, and the term label the
// message carries (the canonical word, escaped when it holds the bad
// unit). List entries sit at index 1 behind a valid word.
const FIELDS: ReadonlyArray<readonly [string, Record<string, unknown>, readonly (string | number)[], string, string, string]> = [
  ['canonical', { canonical: 'Ash￾lr' }, ['canonical'], 'terms[0].canonical', 'Ash\\uFFFElr', 'Ash￾lr'],
  ['aliases', { canonical: 'Ashlr.AI', aliases: ['ok', 'Ash￾ler'] }, ['aliases', 1], 'terms[0].aliases[1]', 'Ashlr.AI', 'Ash￾ler'],
  ['never', { canonical: 'Ashlr.AI', never: ['ok', 'n￾o'] }, ['never', 1], 'terms[0].never[1]', 'Ashlr.AI', 'n￾o'],
  ['phonetic', { canonical: 'Ashlr.AI', phonetic: 'ash￾ler' }, ['phonetic'], 'terms[0].phonetic', 'Ashlr.AI', 'ash￾ler'],
  ['notes', { canonical: 'Ashlr.AI', notes: 'note ￾' }, ['notes'], 'terms[0].notes', 'Ashlr.AI', 'note ￾'],
  ['createdAt', { canonical: 'Ashlr.AI', createdAt: '2026￾' }, ['createdAt'], 'terms[0].createdAt', 'Ashlr.AI', '2026￾'],
];

describe('U+FFFE in a free-text field', () => {
  it('is refused, not stripped: only bidi and zero-width marks are removed', () => {
    // stripInvisible leaves U+FFFE in place so the term-level check still
    // sees it; a zero-width space or a bidi override comes out instead.
    expect(stripInvisible('Ash￾lr')).toBe('Ash￾lr');
    expect(stripInvisible('\u200BAshlr\u202E')).toBe('Ashlr');
  });

  it.each(FIELDS)('findUnencodableChar reports U+FFFE in %s', (_field, _term, _path, _printed, _name, value) => {
    expect(findUnencodableChar(value)).toBe('U+FFFE');
    expect(findUnencodableChar(`ok￾${value}`)).toBe('U+FFFE');
  });

  it.each(FIELDS)('TermSchema rejects U+FFFE in %s at its own path, naming the term', (_field, term, path, _printed, name) => {
    const result = TermSchema.safeParse(term);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues.map(({ path: issuePath, message }) => ({ path: issuePath, message }))).toEqual([
      { path, message: `${reason} in term "${name}"` },
    ]);
  });

  it.each(FIELDS)('LexiconSchema reports U+FFFE in %s under terms[0]', (_field, term, path, _printed, name) => {
    const result = LexiconSchema.safeParse({ terms: [term] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues.map(({ path: issuePath, message }) => ({ path: issuePath, message }))).toEqual([
      { path: ['terms', 0, ...path], message: `${reason} in term "${name}"` },
    ]);
  });

  it.each(FIELDS)('parseLexicon throws for U+FFFE in %s, naming the code point and the term', (_field, term, _path, printed, name) => {
    expect(() => parseLexicon({ terms: [term] })).toThrow(`Invalid lexicon:\n  - ${printed}: ${reason} in term "${name}"`);
  });

  it('rejects U+FFFE in every field of one term at its own path, in field order', () => {
    const result = LexiconSchema.safeParse({
      terms: [
        {
          canonical: 'Ash￾lr',
          aliases: ['a￾b'],
          never: ['n￾o'],
          phonetic: 'p￾',
          notes: 'no￾te',
          createdAt: '2026￾',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    // The term label in every message is the canonical word with the bad
    // unit escaped, so the printed error stays encodable.
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      [
        ['terms', 0, 'canonical'],
        ['terms', 0, 'aliases', 0],
        ['terms', 0, 'never', 0],
        ['terms', 0, 'phonetic'],
        ['terms', 0, 'notes'],
        ['terms', 0, 'createdAt'],
      ].map((path) => ({ path, message: `${reason} in term "Ash\\uFFFElr"` })),
    );
  });

  it('rejects U+FFFE in both settings word lists without a term name', () => {
    for (const [schema, wrap, paths] of [
      [
        LexiconSettingsSchema,
        (s: string) => ({ protectedWords: ['ok', `w${s}d`], packs: [`p${s}`] }),
        [['protectedWords', 1], ['packs', 0]],
      ],
      [
        LexiconSchema,
        (s: string) => ({ terms: [], settings: { protectedWords: ['ok', `w${s}d`], packs: [`p${s}`] } }),
        [['settings', 'protectedWords', 1], ['settings', 'packs', 0]],
      ],
    ] as const) {
      const result = schema.safeParse(wrap('￾'));

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected U+FFFE to be rejected');
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
        paths.map((path) => ({ path, message: reason })),
      );
    }
    expect(() => parseLexicon({ terms: [], settings: { packs: ['pack￾'] } })).toThrow(`settings.packs[0]: ${reason}`);
  });

  it('rejects U+FFFE spelled as a YAML escape in never and createdAt, the way a hand-edited file carries it', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    never: ["n\\uFFFEo"]\n    createdAt: "2026\\uFFFE"\n');
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'never', 0], message: `${reason} in term "Ashlr.AI"` },
      { path: ['terms', 0, 'createdAt'], message: `${reason} in term "Ashlr.AI"` },
    ]);
    expect(() => parseLexicon(input)).toThrow('terms[0].createdAt: must not contain U+FFFE');
  });
  // Catches: the term name in a diagnostic is bounded at 40 characters.
  // Mirrors the same tests in schema.test.ts but with U+FFFE instead of U+FFFF,
  // ensuring the escape-then-truncate path in showTermName is tested for both
  // noncharacters that refuseUnencodable detects.

  it('truncates a long canonical name in a U+FFFE diagnostic from TermSchema', () => {
    // A canonical well over 40 characters, with U+FFFE in another field to
    // trigger refuseUnencodable. The canonical is clean (no unencodable chars)
    // so showTermName does the plain 40-character cut.
    const canonical = 'a'.repeat(45);
    const result = TermSchema.safeParse({ canonical, notes: 'bad\uFFFE' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    const nameIssue = result.error.issues.find((i) => i.path[0] === 'notes');
    expect(nameIssue).toBeDefined();
    const shown = /in term "(.*)"$/.exec(nameIssue!.message)?.[1] ?? '';
    expect(shown).toBe(`${'a'.repeat(39)}\u2026`);
    expect(shown.length).toBe(40);
  });

  it('truncates a long canonical name in a U+FFFE diagnostic from parseLexicon', () => {
    const canonical = 'x'.repeat(50);
    const msg = () => parseLexicon({ terms: [{ canonical, notes: 'bad\uFFFE' }] });

    expect(msg).toThrow(`terms[0].notes: must not contain U+FFFE (${UNENCODABLE_NOTE}) in term "${'x'.repeat(39)}\u2026"`);
  });

  it('measures the 40-character truncation boundary after escaping U+FFFE', () => {
    // U+FFFE is one char that escapes to \\uFFFE (6 chars). 35 printable chars
    // plus one U+FFFE gives 36 total, which escapes to 41 characters (35 + 6).
    // That is over the 40-character limit, so showTermName truncates.
    const canonical = 'A'.repeat(35) + '\uFFFE';
    const result = TermSchema.safeParse({ canonical });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    const name = /in term "(.*)"$/.exec(result.error.issues[0].message)?.[1] ?? '';
    expect(name).toHaveLength(40);
    expect(name.endsWith('\u2026')).toBe(true);
    // 34 A's (39 slots for 39 printable) plus the ellipsis, with the escape
    // consuming the extra 6 chars that pushed over the limit.
    expect(name.slice(0, 34)).toBe('A'.repeat(34));
  });

  it('does not truncate a canonical that stays at 40 characters after escaping U+FFFE', () => {
    // 34 printable chars plus one U+FFFE = 35 total. Escaped: 34 + 6 = 40 exactly.
    // At the boundary, no truncation occurs.
    const canonical = 'B'.repeat(34) + '\uFFFE';
    const result = TermSchema.safeParse({ canonical });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    const name = /in term "(.*)"$/.exec(result.error.issues[0].message)?.[1] ?? '';
    expect(name).toHaveLength(40);
    expect(name.endsWith('\u2026')).toBe(false);
    expect(name).toBe('B'.repeat(34) + '\\uFFFE');
  });
});
