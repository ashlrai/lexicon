import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  DISPLAY_MAX_CHARS,
  LIMITS,
  MAX_LISTED_ISSUES,
  LexiconSchema,
  LexiconSettingsSchema,
  TermSchema,
  emptyLexicon,
  findUnencodableChar,
  parseLexicon,
  sanitizeForDisplay,
  stripControlChars,
  stripInvisible,
} from '../src/core/schema.js';

describe('parseLexicon', () => {
  it('accepts a minimal valid lexicon', () => {
    const lex = parseLexicon({ version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] });
    expect(lex.version).toBe(1);
    expect(lex.terms).toHaveLength(1);
    expect(lex.terms[0].aliases).toEqual(['Ashler']);
  });

  it('fills defaults: version, terms, aliases', () => {
    const lex = parseLexicon({ terms: [{ canonical: 'Kubernetes' }] });
    expect(lex.version).toBe(1);
    expect(lex.terms[0].aliases).toEqual([]);
    expect(parseLexicon({}).terms).toEqual([]);
  });

  it('leaves the optional word lists out when the input has none (never, protectedWords, packs)', () => {
    const lex = parseLexicon({ terms: [{ canonical: 'Kubernetes' }], settings: { fuzzy: true } });
    expect(lex.terms[0]).toStrictEqual({ canonical: 'Kubernetes', aliases: [] });
    expect(lex.settings).toStrictEqual({ fuzzy: true });
    // An explicit empty list is the file's own and is kept.
    expect(parseLexicon({ terms: [{ canonical: 'K', never: [] }] }).terms[0].never).toEqual([]);
    expect(parseLexicon({ terms: [{ canonical: 'K', never: [' ', 'k8s'] }] }).terms[0].never).toEqual(['k8s']);
  });

  it('reads a key left empty in hand-edited YAML (null) as a key left out', () => {
    // `terms:` with nothing under it, and a term whose `aliases:` line was emptied.
    expect(parseLexicon(parseYaml('version: 1\nterms:\n'))).toStrictEqual(emptyLexicon());
    const lex = parseLexicon(
      parseYaml(
        [
          'version: 1',
          'settings:',
          'terms:',
          '  - canonical: Ashlr.AI',
          '    aliases:',
          '    never:',
          '    notes:',
          '  - canonical: Vercel',
          '    aliases: [Versel]',
          '',
        ].join('\n'),
      ),
    );
    // Same shapes as a missing key: aliases [] (always present), never and settings absent.
    expect(lex).toStrictEqual({
      version: 1,
      terms: [
        { canonical: 'Ashlr.AI', aliases: [] },
        { canonical: 'Vercel', aliases: ['Versel'] },
      ],
    });
    const settings = parseLexicon({ terms: [], settings: { protectedWords: null, packs: null, fuzzy: true } });
    expect(settings.settings).toStrictEqual({ fuzzy: true });
    // A null entry inside a list, and a null canonical, are still errors.
    expect(() => parseLexicon({ terms: [{ canonical: null }] })).toThrow(/terms\[0\]\.canonical/);
    expect(() => parseLexicon({ terms: [null] })).toThrow(/terms\[0\]/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [null] }] })).toThrow(/terms\[0\]\.aliases\[0\]/);
  });

  it('passes non-record preprocess inputs through to the schemas, which reject them with the path', () => {
    // A term that is a number or a string, settings that is a string or an
    // array: nullKeysAsAbsent only rewrites plain objects, so these still
    // fail on shape, not on the null-key rule.
    expect(() => parseLexicon({ terms: [42] })).toThrow(/terms\[0\]/);
    expect(() => parseLexicon({ terms: ['x'] })).toThrow(/terms\[0\]/);
    expect(() => parseLexicon({ settings: 'yes' })).toThrow(/settings/);
    expect(() => parseLexicon({ settings: [] })).toThrow(/settings/);
  });

  it('treats null/undefined (empty YAML file) as an empty lexicon', () => {
    expect(parseLexicon(null)).toEqual(emptyLexicon());
    expect(parseLexicon(undefined)).toEqual(emptyLexicon());
  });

  it('trims aliases and drops empty ones', () => {
    const lex = parseLexicon({ terms: [{ canonical: '  Ashlr.AI ', aliases: [' Ashler ', '', '   '] }] });
    expect(lex.terms[0].canonical).toBe('Ashlr.AI');
    expect(lex.terms[0].aliases).toEqual(['Ashler']);
  });

  it('strips unknown keys instead of failing', () => {
    const lex = parseLexicon({ terms: [{ canonical: 'X', aliases: [], bogus: 1 }], extra: true });
    expect(lex.terms[0]).not.toHaveProperty('bogus');
    expect(lex).not.toHaveProperty('extra');
  });

  it('rejects a non-object with a readable message', () => {
    expect(() => parseLexicon('nope')).toThrow(/expected an object, received string/);
    expect(() => parseLexicon(42)).toThrow(/expected an object/);
  });

  it('rejects bad fields with the path in the message', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 5 }] })).toThrow(/terms\[0\]\.canonical/);
    expect(() => parseLexicon({ terms: [{ canonical: '' }] })).toThrow(/terms\[0\]\.canonical: must not be empty/);
    expect(() => parseLexicon({ version: 2, terms: [] })).toThrow(/version/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', category: 'thing' }] })).toThrow(/terms\[0\]\.category/);
    expect(() => parseLexicon({ terms: [], settings: { minConfidence: 1.5 } })).toThrow(/settings\.minConfidence/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', hits: -1 }] })).toThrow(/terms\[0\]\.hits/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: 'Ashler' }] })).toThrow(/terms\[0\]\.aliases/);
  });

  it('lists every problem at once', () => {
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: '' }, { canonical: 'Y', scope: 'nowhere' }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Invalid lexicon:/);
    expect(message).toMatch(/terms\[0\]\.canonical/);
    expect(message).toMatch(/terms\[1\]\.scope/);
  });

  // Catches: a file with thousands of bad entries made a 359 KB message, and
  // every MCP tool, resource and prompt returned it whole to the agent (the
  // doctor twice), as did every CLI command.
  it('lists at most MAX_LISTED_ISSUES problems, with a count of the rest', () => {
    const terms = Array.from({ length: 5000 }, (_, i) => ({ canonical: `T${i}`, aliases: 'nope' }));
    let message = '';
    try {
      parseLexicon({ terms });
    } catch (err) {
      message = (err as Error).message;
    }
    const lines = message.split('\n');
    expect(lines[0]).toBe('Invalid lexicon:');
    expect(lines.slice(1, -1)).toHaveLength(MAX_LISTED_ISSUES);
    expect(lines[1]).toBe('  - terms[0].aliases: Invalid input: expected array, received string');
    expect(lines.at(-1)).toBe(`  - ... and ${5000 - MAX_LISTED_ISSUES} more problems like these`);
    expect(message.length).toBeLessThan(2000);
  });
});

describe('schemas', () => {
  it('TermSchema accepts every optional field', () => {
    const term = TermSchema.parse({
      canonical: 'Ashlr.AI',
      aliases: ['Ashler'],
      phonetic: 'ASH-ler',
      category: 'brand',
      caseSensitive: false,
      scope: 'project',
      source: 'harvest:repo',
      notes: 'my company',
      createdAt: '2026-01-01T00:00:00Z',
      hits: 3,
      never: ['ashes'],
    });
    expect(term.category).toBe('brand');
    expect(term.never).toEqual(['ashes']);
  });

  it('LexiconSettingsSchema bounds minConfidence', () => {
    expect(LexiconSettingsSchema.safeParse({ minConfidence: 0.5 }).success).toBe(true);
    expect(LexiconSettingsSchema.safeParse({ minConfidence: -0.1 }).success).toBe(false);
    expect(LexiconSettingsSchema.safeParse({ protectedWords: ['sauce'], skipCode: false }).success).toBe(true);
  });

  it('LexiconSchema only accepts version 1', () => {
    expect(LexiconSchema.safeParse({ version: 1, terms: [] }).success).toBe(true);
    expect(LexiconSchema.safeParse({ version: '1', terms: [] }).success).toBe(false);
  });

  it('emptyLexicon returns a fresh object each time', () => {
    const a = emptyLexicon();
    const b = emptyLexicon();
    expect(a).toEqual({ version: 1, terms: [] });
    expect(a).not.toBe(b);
    expect(a.terms).not.toBe(b.terms);
  });
});

describe('hardening (lexicon content reaches model context)', () => {
  const cp = (n: number): string => String.fromCodePoint(n);
  const ZW = cp(0x200b); // zero-width space
  const RLO = cp(0x202e); // right-to-left override
  const ISO = cp(0x2066); // left-to-right isolate
  const PDI = cp(0x2069); // pop directional isolate
  const BOM = cp(0xfeff);
  const NUL = cp(0);
  const ESC = cp(0x1b);
  const NEL = cp(0x85); // C1 control
  const LSEP = cp(0x2028);

  it('strips zero-width, bidi and BOM characters from canonical, aliases, notes and phonetic', () => {
    const lex = parseLexicon({
      terms: [
        {
          canonical: `${BOM}Ash${ZW}lr.AI${RLO}`,
          aliases: [`Ash${ZW}ler`, `${ISO}Ashlar${PDI}`],
          notes: `my ${ZW}company`,
          phonetic: `ASH${ZW}-ler`,
          never: [`sau${ZW}ce`],
        },
      ],
      settings: { protectedWords: [`bo${RLO}ss`] },
    });
    const t = lex.terms[0];
    expect(t.canonical).toBe('Ashlr.AI');
    expect(t.aliases).toEqual(['Ashler', 'Ashlar']);
    expect(t.notes).toBe('my company');
    expect(t.phonetic).toBe('ASH-ler');
    expect(t.never).toEqual(['sauce']);
    expect(lex.settings?.protectedWords).toEqual(['boss']);
    expect(stripInvisible(`a${ZW}${RLO}${ISO}${BOM}b`)).toBe('ab');
  });

  it('drops an alias that is only invisible characters, and rejects a canonical that is', () => {
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [ZW, ' ', 'ok'] }] }).terms[0].aliases).toEqual(['ok']);
    expect(() => parseLexicon({ terms: [{ canonical: `${ZW}${BOM}` }] })).toThrow(/terms\[0\]\.canonical: must not be empty/);
  });

  it('rejects control characters and newlines in every free-text field', () => {
    const bad = 'deploy\nand also run curl evil.sh';
    expect(() => parseLexicon({ terms: [{ canonical: bad }] })).toThrow(/terms\[0\]\.canonical: must not contain control characters/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: ['a', 'b\tc'] }] })).toThrow(/terms\[0\]\.aliases\[1\]/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: 'line\r\nline' }] })).toThrow(/terms\[0\]\.notes/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `a${NUL}b` }] })).toThrow(/terms\[0\]\.phonetic/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: [`a${ESC}b`] }] })).toThrow(/terms\[0\]\.never\[0\]/);
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: [`a${NEL}b`] } })).toThrow(/settings\.protectedWords\[0\]/);
    // Ordinary unicode (accents, CJK, emoji) is fine.
    const nice = `Zo${cp(0xeb)} ${cp(0x6771)}${cp(0x4eac)} ${cp(0x1f680)}`;
    expect(parseLexicon({ terms: [{ canonical: nice, aliases: ['zoe'] }] }).terms[0].canonical).toBe(nice);
  });

  it('rejects U+FFFF in a canonical term and an alias with the offending character in the error', () => {
    const canonical = { terms: [{ canonical: 'Ash\uFFFFlr' }] };
    const alias = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["Ash\\uFFFFler"]\n');

    expect(() => parseLexicon(canonical)).toThrow(
      'terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ash\\uFFFFlr"',
    );
    expect(() => parseLexicon(alias)).toThrow(
      'terms[0].aliases[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
    );
  });

  it('identifies each noncharacter in separate canonical names from the same YAML document', () => {
    const input = parseYaml('terms:\n  - canonical: Valid\n  - canonical: "Ash\\uFFFElr"\n  - canonical: "Rocket\\uFFFFship"\n');
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected both noncharacters to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 1, 'canonical'],
        message: 'must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ash\\uFFFElr"',
      },
      {
        path: ['terms', 2, 'canonical'],
        message: 'must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket\\uFFFFship"',
      },
    ]);
  });

  it.each([
    ['canonical', { canonical: 'Ash\uFFFFlr' }, ['canonical'], 'Ash\\uFFFFlr'],
    ['aliases', { canonical: 'Ashlr.AI', aliases: ['valid', 'Ash\uFFFFler'] }, ['aliases', 1], 'Ashlr.AI'],
    ['never', { canonical: 'Ashlr.AI', never: ['valid', 'Ash\uFFFFler'] }, ['never', 1], 'Ashlr.AI'],
    ['phonetic', { canonical: 'Ashlr.AI', phonetic: 'Ash\uFFFFler' }, ['phonetic'], 'Ashlr.AI'],
    ['notes', { canonical: 'Ashlr.AI', notes: 'Ash\uFFFFler' }, ['notes'], 'Ashlr.AI'],
    ['createdAt', { canonical: 'Ashlr.AI', createdAt: '2026\uFFFF' }, ['createdAt'], 'Ashlr.AI'],
  ])('rejects U+FFFF in term %s with a specific structured error', (_field, term, path, name) => {
    const result = TermSchema.safeParse(term);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues.map(({ path: issuePath, message }) => ({ path: issuePath, message }))).toEqual([
      {
        path,
        message: `must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${name}"`,
      },
    ]);
  });

  it('reports U+FFFF as the first unencodable character in settings', () => {
    const word = 'Rocket \u{1F680}\uFFFF\uFFFE';

    expect(findUnencodableChar(word)).toBe('U+FFFF');
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: [word] } })).toThrow(
      'settings.protectedWords[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format)',
    );
  });

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('identifies %s in both settings lists after empty entries are removed', (codePoint, character) => {
    const input = {
      terms: [],
      settings: {
        protectedWords: [' ', 'valid', `before${character}after`],
        packs: ['', `before${character}after`],
      },
    };
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error(`Expected ${codePoint} to be rejected`);
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['settings', 'protectedWords', 1],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`,
      },
      {
        path: ['settings', 'packs', 0],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`,
      },
    ]);
  });

  it('preserves valid Unicode values on either side of the rejected BMP boundary', () => {
    const neighbors = ['\uFFFD', '\u{10000}'];
    const input = { terms: [{ canonical: 'Boundary', aliases: neighbors }], settings: { packs: neighbors } };

    expect(parseLexicon(input)).toMatchObject(input);
    for (const character of neighbors) expect(findUnencodableChar(character)).toBeUndefined();
  });

  it('rejects U+FFFE in a canonical term and a YAML alias with the offending character in the error', () => {
    const canonical = { terms: [{ canonical: 'Ash\uFFFElr' }] };
    const alias = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["Ash\\uFFFEler"]\n');

    expect(() => parseLexicon(canonical)).toThrow(
      'terms[0].canonical: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ash\\uFFFElr"',
    );
    expect(() => parseLexicon(alias)).toThrow(
      'terms[0].aliases[0]: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
    );
    expect(findUnencodableChar('ok\uFFFE\uFFFF')).toBe('U+FFFE');
  });

  it('reports U+FFFE after a valid surrogate pair and before a second noncharacter', () => {
    const text = '\u{1F680}\uFFFE\uFFFF';

    expect(findUnencodableChar(text)).toBe('U+FFFE');
    expect(() => parseLexicon({ terms: [{ canonical: 'Rocket', notes: text }] })).toThrow(
      'terms[0].notes: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"',
    );
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: [text] } })).toThrow(
      'settings.protectedWords[0]: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format)',
    );
  });

  it.each([
    [{ canonical: 'Ash\uFFFElr' }, ['canonical'], 'Ash\\uFFFElr'],
    [{ canonical: 'Ashlr.AI', aliases: ['valid', 'Ash\uFFFEler'] }, ['aliases', 1], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', never: ['valid', 'Ash\uFFFEler'] }, ['never', 1], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', phonetic: 'ash\uFFFEler' }, ['phonetic'], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', notes: 'note\uFFFE' }, ['notes'], 'Ashlr.AI'],
    [{ canonical: 'Ashlr.AI', createdAt: '2026\uFFFE' }, ['createdAt'], 'Ashlr.AI'],
  ])('rejects U+FFFE in standalone term field %#', (term, path, name) => {
    const result = TermSchema.safeParse(term);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues).toMatchObject([
      {
        code: 'custom',
        path,
        message: `must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${name}"`,
      },
    ]);
  });

  // Catches: U+FFFE, U+FFFF and an unpaired surrogate passed the schema
  // (they are neither control nor invisible characters), though no UTF-8 file
  // can hold a lone surrogate and XML forbids all three: one such alias made
  // the macos plist unreadable and the YAML written back unreadable as UTF-8.
  it('refuses U+FFFE, U+FFFF and an unpaired surrogate in every free-text field, naming the term', () => {
    const bad = [
      ['\uFFFE', 'U+FFFE'], ['\uFFFF', 'U+FFFF'], ['\uD800', 'U+D800'],
      ['\uDFFF', 'U+DFFF'], ['a\uDC00b', 'U+DC00'], ['a\uD83D', 'U+D83D'],
    ];
    for (const [ch, codePoint] of bad) {
      expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: ['ok', `x${ch}`] }] })).toThrow(
        `terms[0].aliases[1]: must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"`,
      );
    }
    expect(() => parseLexicon({ terms: [{ canonical: 'Ash\uFFFElr' }] })).toThrow(
      /terms\[0\]\.canonical: must not contain U\+FFFE .* in term "Ash\\uFFFElr"/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: 'n\uFFFF' }] })).toThrow(/terms\[0\]\.notes: must not contain U\+FFFF .* in term "X"/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: '\uD800' }] })).toThrow(/terms\[0\]\.phonetic: must not contain U\+D800/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: ['\uDBFF'] }] })).toThrow(/terms\[0\]\.never\[0\]: must not contain U\+DBFF/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', createdAt: '2026\uFFFE' }] })).toThrow(/terms\[0\]\.createdAt: must not contain U\+FFFE/);
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: ['a\uFFFE'] } })).toThrow(/settings\.protectedWords\[0\]: must not contain U\+FFFE/);
    expect(() => parseLexicon({ terms: [], settings: { packs: ['\uD800'] } })).toThrow(/settings\.packs\[0\]: must not contain U\+D800/);
    // Through YAML, as a hand-edited file spells them.
    expect(() => parseLexicon(parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["\\uFFFE"]\n'))).toThrow(/aliases\[0\]: must not contain U\+FFFE/);
    // A non-string entry inside a checked list is still reported at its own
    // index by the field schemas, not by the term-level unencodable check.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [5] }] })).toThrow(/terms\[0\]\.aliases\[0\]/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: [{ deep: true }] }] })).toThrow(/terms\[0\]\.never\[0\]/);
    // A surrogate pair (an emoji) and the noncharacters XML allows are fine.
    const ok = parseLexicon({ terms: [{ canonical: 'Rocket \u{1F680}', aliases: ['\uFFFD', '\uFDD0'] }] });
    expect(ok.terms[0].canonical).toBe('Rocket \u{1F680}');
    expect(ok.terms[0].aliases).toEqual(['\uFFFD', '\uFDD0']);
    expect(findUnencodableChar('a\u{1F680}b')).toBeUndefined();
    expect(findUnencodableChar('a\uD83D')).toBe('U+D83D');
    expect(findUnencodableChar('\uDE80x')).toBe('U+DE80');
  });

  it('identifies an unpaired high surrogate in a canonical term', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Rocket \uD83Dship' }] })).toThrow(
      'terms[0].canonical: must not contain U+D83D (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket \\uD83Dship"',
    );
  });

  it('safely renders an unpaired high surrogate in a term name across validation errors', () => {
    const input = { terms: [{ canonical: 'Rocket \uD83Dship', aliases: ['\uFFFF'] }] };
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';

    try {
      parseLexicon(input);
      throw new Error('Expected the invalid term to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(
        `Invalid lexicon:\n  - terms[0].canonical: must not contain U+D83D (${reason}) in term "Rocket \\uD83Dship"\n` +
        `  - terms[0].aliases[0]: must not contain U+FFFF (${reason}) in term "Rocket \\uD83Dship"`,
      );
      expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message);
    }
  });

  it.each([
    ['high first', 'D800', 'DFFF'],
    ['low first', 'DC00', 'DBFF'],
  ])('escapes every unpaired surrogate in YAML term previews (%s)', (_order, first, second) => {
    const input = parseYaml(`terms:\n  - canonical: "Name \\u${first} middle \\u${second} end"\n    aliases: ["bad\\uFFFF"]\n`);
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';
    const preview = `Name \\u${first} middle \\u${second} end`;
    const expected = `Invalid lexicon:\n  - terms[0].canonical: must not contain U+${first} (${reason}) in term "${preview}"\n  - terms[0].aliases[0]: must not contain U+FFFF (${reason}) in term "${preview}"`;

    expect(() => parseLexicon(input)).toThrow(expected);
    const result = LexiconSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unpaired surrogates to be rejected');
    for (const issue of result.error.issues) {
      expect(Buffer.from(issue.message, 'utf8').toString('utf8')).toBe(issue.message);
    }
  });

  it.each(['D800', 'DBFF'])('reports an unpaired high surrogate U+%s from YAML with a readable term label', (hex) => {
    const input = parseYaml(`terms:\n  - canonical: "Rocket \\u${hex}ship"\n`);
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired high surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'canonical'],
        message: `must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket \\u${hex}ship"`,
      },
    ]);
  });

  it('reports an unpaired high surrogate immediately before a valid pair', () => {
    const canonical = 'Rocket \uDBFF\uD83D\uDE80';

    expect(findUnencodableChar(canonical)).toBe('U+DBFF');
    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      'terms[0].canonical: must not contain U+DBFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket \\uDBFF🚀"',
    );
  });

  it.each([
    ['U+FFFF then U+FFFE', '\uFFFFa\uFFFE', 'U+FFFF'],
    ['U+FFFE then an unpaired high surrogate', '\uFFFEa\uD800', 'U+FFFE'],
    ['an unpaired high surrogate then U+FFFF', '\uD800a\uFFFF', 'U+D800'],
    ['an unpaired low surrogate after a valid pair', '\u{1F680}\uDC00a\uFFFE', 'U+DC00'],
  ])('reports the first unencodable character for %s', (_description, text, first) => {
    expect(findUnencodableChar(text)).toBe(first);

    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Rocket', aliases: [text] }],
      settings: { protectedWords: [text] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unencodable characters to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'aliases', 0],
        message: `must not contain ${first} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
      },
      {
        path: ['settings', 'protectedWords', 0],
        message: `must not contain ${first} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`,
      },
    ]);
  });

  it('identifies an unpaired low surrogate in a canonical term and settings', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Rocket \uDC00ship' }] })).toThrow(
      'terms[0].canonical: must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket \\uDC00ship"',
    );
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: ['a\uDC00b'] } })).toThrow(
      'settings.protectedWords[0]: must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format)',
    );
  });

  it.each(['DC00', 'DFFF'])('rejects an unpaired low surrogate U+%s in a YAML alias', (hex) => {
    const input = parseYaml(`terms:\n  - canonical: Rocket\n    aliases: ["valid", "ship\\u${hex}name"]\n`);
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired low surrogate in the alias to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'aliases', 1],
        message: `must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
      },
    ]);
    expect(() => parseLexicon(input)).toThrow(
      `terms[0].aliases[1]: must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
    );
  });

  it.each(['DC00', 'DFFF'])('reports an unpaired low surrogate U+%s from YAML with a readable term label', (hex) => {
    const input = parseYaml(`terms:\n  - canonical: "Rocket \\u${hex}ship"\n`);
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'canonical'],
        message: `must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket \\u${hex}ship"`,
      },
    ]);
  });

  it.each(['DC00', 'DFFF'])('safely reports an unpaired low surrogate U+%s after a valid pair in a term name', (hex) => {
    const canonical = `Rocket \u{1F680}${String.fromCharCode(parseInt(hex, 16))}ship`;
    const input = { terms: [{ canonical }] };
    const result = LexiconSchema.safeParse(input);
    const message = `must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket 🚀\\u${hex}ship"`;

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'canonical'], message },
    ]);
    expect(() => parseLexicon(input)).toThrow(`terms[0].canonical: ${message}`);
  });

  it.each([
    ['D800', '\uD800'],
    ['DBFF', '\uDBFF'],
    ['DC00', '\uDC00'],
    ['DFFF', '\uDFFF'],
  ])('reports lone surrogate U+%s at string and valid-pair boundaries', (hex, unit) => {
    const pair = '\uD83D\uDE80';
    for (const text of [unit, `${pair}${unit}`, `${unit}${pair}`, `${pair}${unit}${pair}`]) {
      expect(findUnencodableChar(text)).toBe(`U+${hex}`);
      expect(() => parseLexicon({ terms: [{ canonical: 'Rocket', aliases: [text] }] })).toThrow(
        `terms[0].aliases[0]: must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
      );
    }
  });

  it('accepts and preserves paired surrogates in term and settings text', () => {
    const rocket = '\uD83D\uDE80';
    const term = {
      canonical: `${rocket} Rocket`,
      aliases: [`Rocket ${rocket}`, `${rocket}${rocket}`],
      never: [`not ${rocket}`],
      phonetic: `rocket ${rocket} ship`,
      notes: `${rocket} launch`,
      createdAt: `date ${rocket}`,
    };
    const settings = { protectedWords: [`${rocket} protected`], packs: [`pack ${rocket}`] };

    expect(parseLexicon({ terms: [term], settings })).toMatchObject({ terms: [term], settings });
    for (const text of [rocket, `${rocket}a`, `a${rocket}`, `${rocket}${rocket}`]) {
      expect(findUnencodableChar(text)).toBeUndefined();
    }
    expect(findUnencodableChar(`${rocket}\uD800`)).toBe('U+D800');
    expect(findUnencodableChar(`\uDC00${rocket}`)).toBe('U+DC00');
  });

  it.each([
    ['U+10000', '\uD800\uDC00'],
    ['U+103FF', '\uD800\uDFFF'],
    ['U+10FC00', '\uDBFF\uDC00'],
    ['U+10FFFF', '\uDBFF\uDFFF'],
  ])('accepts the paired surrogates for %s from YAML', (_codePoint, pair) => {
    const input = parseYaml(`terms:\n  - canonical: "before ${pair} after"\n    aliases: ["${pair}${pair}"]\n`);
    const parsed = parseLexicon(input);

    expect(parsed.terms[0].canonical).toBe(`before ${pair} after`);
    expect(parsed.terms[0].aliases).toEqual([`${pair}${pair}`]);
    expect(findUnencodableChar(pair)).toBeUndefined();
  });

  it('accepts pairs across the full high and low surrogate ranges', () => {
    for (let unit = 0; unit <= 0x3ff; unit++) {
      for (const pair of [
        String.fromCharCode(0xd800 + unit, 0xdc00),
        String.fromCharCode(0xd800 + unit, 0xdfff),
        String.fromCharCode(0xd800, 0xdc00 + unit),
        String.fromCharCode(0xdbff, 0xdc00 + unit),
      ]) {
        expect(findUnencodableChar(`a${pair}${pair}z`)).toBeUndefined();
      }
    }
  });

  it('preserves supplementary characters decoded from paired YAML surrogate escapes', () => {
    const input = parseYaml(
      'terms:\n  - canonical: "Name \\uD842\\uDFB7"\n    aliases: ["\\uD83D\\uDE80\\uD842\\uDFB7"]\n' +
      'settings:\n  protectedWords: ["\\uD842\\uDFB7"]\n',
    );
    const parsed = parseLexicon(input);

    expect(parsed.terms[0].canonical).toBe('Name \u{20BB7}');
    expect(parsed.terms[0].aliases).toEqual(['\u{1F680}\u{20BB7}']);
    expect(parsed.settings?.protectedWords).toEqual(['\u{20BB7}']);
  });

  it('accepts a supplementary CJK character decoded from a YAML Unicode escape', () => {
    const character = '\u{20000}';
    const input = parseYaml('terms:\n  - canonical: "Name \\U00020000"\nsettings:\n  protectedWords: ["\\U00020000"]\n');
    const parsed = parseLexicon(input);

    expect(findUnencodableChar(character)).toBeUndefined();
    expect(parsed.terms[0].canonical).toBe(`Name ${character}`);
    expect(parsed.settings?.protectedWords).toEqual([character]);

    const canonical = parsed.terms[0].canonical;
    const protectedWord = parsed.settings?.protectedWords?.[0];
    if (protectedWord === undefined) throw new Error('Expected a protected word');
    expect(findUnencodableChar(canonical)).toBeUndefined();
    expect(findUnencodableChar(protectedWord)).toBeUndefined();
    expect(canonical.codePointAt(5)).toBe(0x20000);
    expect(protectedWord.codePointAt(0)).toBe(0x20000);
    expect(protectedWord.charCodeAt(0)).toBe(0xd840);
    expect(protectedWord.charCodeAt(1)).toBe(0xdc00);
  });

  // U+20BB7 (𠮷), a CJK Extension B ideograph from plane 2: the "Yoshiki"
  // name kanji is the sort of supplementary character a lexicon of names
  // actually carries, and its high surrogate U+D842 sits outside the range
  // the emoji pairs above exercise.
  it('accepts and preserves a supplementary character in an alias', () => {
    const yoshiki = '\u{20BB7}';
    const alias = `Tsuchi${yoshiki}ya`;
    const lex = parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: [alias, yoshiki, `${yoshiki}top`, `tail${yoshiki}`] }] });

    expect(lex.terms[0].aliases).toEqual([alias, yoshiki, `${yoshiki}top`, `tail${yoshiki}`]);
    // Preserved code unit for code unit: still one supplementary code point
    // encoded as the same pair, not normalized or dropped.
    const embedded = lex.terms[0].aliases[0];
    expect(embedded.codePointAt(6)).toBe(0x20bb7);
    expect(embedded.charCodeAt(6)).toBe(0xd842);
    expect(embedded.charCodeAt(7)).toBe(0xdfb7);
    expect(lex.terms[0].aliases[1]).toHaveLength(2);
    expect(findUnencodableChar(alias)).toBeUndefined();
  });

  it('accepts a supplementary character spelled as a YAML \\U escape in an alias', () => {
    // The 8-digit \U escape is how a hand-edited file spells an astral
    // character its editor cannot type.
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["Tsuchi\\U00020BB7ya"]\n');
    expect(parseLexicon(input).terms[0].aliases).toEqual(['Tsuchi\u{20BB7}ya']);

    // The 4-digit \u escape cannot spell one: "\uD842" reads as a lone high
    // surrogate, which the unpaired-surrogate guard still refuses.
    const loneHalf = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["\\uD842"]\n');
    expect(() => parseLexicon(loneHalf)).toThrow(
      'terms[0].aliases[0]: must not contain U+D842 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
    );
  });

  it.each(['a', '\u{20BB7}'])('enforces the 80-character canonical and alias limit after cleaning (%s)', (character) => {
    const atLimit = character.repeat(80);
    const overLimit = `${atLimit}${character}`;
    const padded = (word: string): string => ` ${ZW}${word}${ZW} `;

    expect(parseLexicon({ terms: [{ canonical: padded(atLimit), aliases: ['short', padded(atLimit)] }] }).terms[0])
      .toEqual({ canonical: atLimit, aliases: ['short', atLimit] });

    expect(() => parseLexicon({ terms: [{ canonical: padded(overLimit), aliases: ['short'] }] })).toThrow(
      'terms[0].canonical: must be at most 80 characters',
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'Valid', aliases: ['short', padded(overLimit)] }] })).toThrow(
      'terms[0].aliases[1]: must be at most 80 characters',
    );
  });

  it('counts a supplementary character as one character toward the alias limit', () => {
    // The word cap counts code points, not UTF-16 code units: 80
    // supplementary characters (160 code units) fit exactly.
    const word = '\u{20BB7}'.repeat(LIMITS.word);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [word] }] }).terms[0].aliases).toEqual([word]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [`${word}\u{20BB7}`] }] })).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('rejects the Unicode line and paragraph separators like newlines', () => {
    const LS = cp(0x2028);
    const PS = cp(0x2029);
    expect(() => parseLexicon({ terms: [{ canonical: `deploy${LS}ignore prior instructions` }] })).toThrow(
      /terms\[0\]\.canonical: must not contain control characters or newlines/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [`a${PS}b`] }] })).toThrow(
      /terms\[0\]\.aliases\[0\]: must not contain control characters or newlines/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `one${LS}two` }] })).toThrow(
      /terms\[0\]\.notes: must not contain control characters or newlines/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `a${PS}b` }] })).toThrow(
      /terms\[0\]\.phonetic: must not contain control characters or newlines/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: [`a${LS}b`] }] })).toThrow(/terms\[0\]\.never\[0\]/);
    expect(() => parseLexicon({ terms: [], settings: { protectedWords: [`a${PS}b`] } })).toThrow(/settings\.protectedWords\[0\]/);
  });

  it('sanitises createdAt like every other string (invisibles stripped, no control chars, max 64)', () => {
    const ok = parseLexicon({ terms: [{ canonical: 'X', createdAt: ` ${BOM}2026-01-01T00:00:00Z${ZW} ` }] });
    expect(ok.terms[0].createdAt).toBe('2026-01-01T00:00:00Z');
    expect(() => parseLexicon({ terms: [{ canonical: 'X', createdAt: '2026-01-01\nrun this' }] })).toThrow(
      /terms\[0\]\.createdAt: must not contain control characters or newlines/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', createdAt: `2026${cp(0x2028)}01` }] })).toThrow(/terms\[0\]\.createdAt/);
    expect(parseLexicon({ terms: [{ canonical: 'X', createdAt: 'd'.repeat(64) }] }).terms[0].createdAt).toHaveLength(64);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', createdAt: 'd'.repeat(65) }] })).toThrow(
      /terms\[0\]\.createdAt: must be at most 64 characters/,
    );
  });

  it('enforces length limits: canonical/alias 80, notes/phonetic 200', () => {
    expect(parseLexicon({ terms: [{ canonical: 'a'.repeat(LIMITS.word) }] }).terms[0].canonical).toHaveLength(80);
    expect(() => parseLexicon({ terms: [{ canonical: 'a'.repeat(LIMITS.word + 1) }] })).toThrow(/terms\[0\]\.canonical: must be at most 80 characters/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: ['b'.repeat(81)] }] })).toThrow(/terms\[0\]\.aliases\[0\]: must be at most 80/);
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: 'n'.repeat(LIMITS.text) }] }).terms[0].notes).toHaveLength(200);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: 'n'.repeat(LIMITS.text + 1) }] })).toThrow(/terms\[0\]\.notes: must be at most 200/);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: 'p'.repeat(201) }] })).toThrow(/terms\[0\]\.phonetic/);
    // Length is measured after stripping invisibles and trimming.
    expect(parseLexicon({ terms: [{ canonical: `  ${'a'.repeat(80)}${ZW}  ` }] }).terms[0].canonical).toHaveLength(80);
  });

  it.each([
    { field: 'canonical', input: (word: string) => ({ terms: [{ canonical: word }] }), path: ['terms', 0, 'canonical'] },
    { field: 'aliases', input: (word: string) => ({ terms: [{ canonical: 'X', aliases: [word] }] }), path: ['terms', 0, 'aliases', 0] },
    { field: 'never', input: (word: string) => ({ terms: [{ canonical: 'X', never: [word] }] }), path: ['terms', 0, 'never', 0] },
    { field: 'protectedWords', input: (word: string) => ({ settings: { protectedWords: [word] } }), path: ['settings', 'protectedWords', 0] },
    { field: 'packs', input: (word: string) => ({ settings: { packs: [word] } }), path: ['settings', 'packs', 0] },
  ])('enforces the 80-character word boundary for $field after sanitizing', ({ input, path }) => {
    const word = 'w'.repeat(80);
    const atLimit = LexiconSchema.safeParse(input(` ${ZW}${word} `));
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data).toMatchObject(input(word));

    const overLimit = LexiconSchema.safeParse(input(`${word}w`));
    expect(overLimit.success).toBe(false);
    if (overLimit.success) throw new Error('Expected the word limit to be enforced');
    expect(overLimit.error.issues).toMatchObject([
      { code: 'too_big', path, maximum: 80, message: 'must be at most 80 characters' },
    ]);
  });

  it.each(['notes', 'phonetic'] as const)('enforces the 200-character text boundary for %s after sanitizing', (field) => {
    const text = 'x'.repeat(200);
    const atLimit = LexiconSchema.safeParse({ terms: [{ canonical: 'X', [field]: ` ${ZW}${text} ` }] });
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data.terms[0][field]).toBe(text);

    const overLimit = LexiconSchema.safeParse({ terms: [{ canonical: 'X', [field]: `${text}x` }] });
    expect(overLimit.success).toBe(false);
    if (overLimit.success) throw new Error('Expected the text limit to be enforced');
    expect(overLimit.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, field], maximum: 200, message: 'must be at most 200 characters' },
    ]);
  });

  it.each(['notes', 'phonetic'] as const)('enforces the 200-character boundary on standalone terms for %s', (field) => {
    const text = 'x'.repeat(200);
    expect(TermSchema.parse({ canonical: 'X', [field]: text })[field]).toBe(text);

    const result = TermSchema.safeParse({ canonical: 'X', [field]: `${text}x` });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the text limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: [field], maximum: 200, message: 'must be at most 200 characters' },
    ]);
  });

  it('enforces the 80-character word boundary on the fields of a standalone term', () => {
    const word = 'w'.repeat(LIMITS.word);
    const term = TermSchema.parse({ canonical: word, aliases: [word], never: [word] });
    expect(term.canonical).toBe(word);
    expect(term.aliases).toEqual([word]);
    expect(term.never).toEqual([word]);

    for (const [input, path] of [
      [{ canonical: `${word}w` }, ['canonical']],
      [{ canonical: 'X', aliases: [`${word}w`] }, ['aliases', 0]],
      [{ canonical: 'X', never: [`${word}w`] }, ['never', 0]],
    ] as const) {
      const result = TermSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected the word limit to be enforced');
      expect(result.error.issues).toMatchObject([
        { code: 'too_big', path, maximum: LIMITS.word, message: 'must be at most 80 characters' },
      ]);
    }
  });

  // Catches: zod's .max counts code points, not UTF-16 code units, so a word
  // of 80 emoji is in and one of 81 is out even though their .length is 160
  // and 162. A refactor that measured .length (or a zod that did) would turn
  // every astral name over 40 characters away at the door.
  it('counts the word limit in code points: 80 astral characters pass, 81 fail', () => {
    const rocket = '\u{1F680}'; // one code point, two UTF-16 code units
    const atLimit = rocket.repeat(LIMITS.word);
    expect(atLimit).toHaveLength(LIMITS.word * 2);
    const lex = parseLexicon({ terms: [{ canonical: atLimit, aliases: [atLimit] }] });
    expect(lex.terms[0].canonical).toBe(atLimit);
    expect(lex.terms[0].aliases).toEqual([atLimit]);

    const overLimit = rocket.repeat(LIMITS.word + 1);
    expect(() => parseLexicon({ terms: [{ canonical: overLimit }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [overLimit] }] })).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('stripControlChars removes every control, separator and invisible character and nothing else', () => {
    const CR = cp(0x0d);
    const DEL = cp(0x7f);
    const C1 = cp(0x9b); // CSI as a single C1 byte
    const LS = cp(0x2028);
    const PS = cp(0x2029);
    const input = `a${CR}b${DEL}c${C1}d${LS}e${PS}f${NEL}g${ESC}[31mh${ESC}]0;title${cp(7)}i${ZW}j${RLO}k${NUL}`;
    const out = stripControlChars(input);
    for (const bad of [CR, DEL, C1, LS, PS, NEL, ESC, cp(7), ZW, RLO, NUL]) expect(out).not.toContain(bad);
    expect(out).toBe('abcdefg[31mh]0;titleijk');
    expect(stripControlChars('Ashlr.AI, café — naïve')).toBe('Ashlr.AI, café — naïve');
  });

  it('sanitizeForDisplay drops whole ANSI sequences, format/private-use code points, and caps the length', () => {
    expect(sanitizeForDisplay(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeForDisplay(`/repo${ESC}]0;pwned${cp(7)}/.lexicon.yaml`)).toBe('/repo/.lexicon.yaml');
    expect(sanitizeForDisplay(`${ESC}]0;pwned${ESC}\\x`)).toBe('x'); // OSC with ST terminator
    expect(sanitizeForDisplay(`${ESC}]0;unterminated`)).toBe('0;unterminated'); // ESC ] alone is a two-byte sequence; the text after it stays visible
    expect(sanitizeForDisplay(`a${ESC}Mb`)).toBe('ab'); // two-byte ESC sequence
    expect(sanitizeForDisplay(`${RLO}evil${ZW}${BOM}${cp(0x00ad)}${cp(0xe000)}${cp(0xe0041)}ok${NEL}${LSEP}`)).toBe('evilok');
    expect(sanitizeForDisplay(`${cp(0xd800)}lone surrogate`)).toBe('lone surrogate');
    expect(sanitizeForDisplay('emoji 🙂 and 日本語 survive')).toBe('emoji 🙂 and 日本語 survive');

    const long = 'x'.repeat(DISPLAY_MAX_CHARS + 50);
    const capped = sanitizeForDisplay(long);
    expect(Array.from(capped)).toHaveLength(DISPLAY_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
    expect(sanitizeForDisplay('x'.repeat(DISPLAY_MAX_CHARS))).toBe('x'.repeat(DISPLAY_MAX_CHARS));
    // Astral characters count once each and are never split.
    const astral = '🙂'.repeat(DISPLAY_MAX_CHARS + 1);
    expect(Array.from(sanitizeForDisplay(astral))).toHaveLength(DISPLAY_MAX_CHARS);
    expect(sanitizeForDisplay(astral).slice(-3)).toBe('🙂…'); // the cut lands between pairs, never inside one
  });

  it('caps aliases per term at 64 and terms per file at 5000', () => {
    const aliases = Array.from({ length: LIMITS.aliases }, (_, i) => `a${i}`);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases }] }).terms[0].aliases).toHaveLength(64);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [...aliases, 'one more'] }] })).toThrow(/terms\[0\]\.aliases: at most 64 aliases/);
    // Empties do not count toward the cap.
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [...aliases, '', ' '] }] }).terms[0].aliases).toHaveLength(64);

    const terms = Array.from({ length: LIMITS.terms }, (_, i) => ({ canonical: `T${i}` }));
    expect(parseLexicon({ terms }).terms).toHaveLength(5000);
    expect(() => parseLexicon({ terms: [...terms, { canonical: 'overflow' }] })).toThrow(/terms: at most 5000 terms/);
  });

  it('accepts 64 aliases per term and rejects a 65th', () => {
    const aliases = Array.from({ length: 64 }, (_, i) => `alias${i}`);
    const atLimit = LexiconSchema.safeParse({ terms: [{ canonical: 'First', aliases }, { canonical: 'Second', aliases }] });
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data.terms.map((term) => term.aliases)).toEqual([aliases, aliases]);

    const overLimit = LexiconSchema.safeParse({
      terms: [{ canonical: 'First', aliases }, { canonical: 'Second', aliases: [...aliases, 'alias64'] }],
    });
    expect(overLimit.success).toBe(false);
    if (overLimit.success) throw new Error('Expected the aliases limit to be enforced');
    expect(overLimit.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 1, 'aliases'], maximum: 64, message: 'at most 64 aliases per term' },
    ]);
  });

  it('enforces the standalone term alias limit after cleaning the list', () => {
    const aliases = Array.from({ length: 64 }, (_, i) => `alias${i}`);
    const input = [...aliases.map((alias) => ` ${ZW}${alias} `), '', ' ', ZW];

    expect(TermSchema.parse({ canonical: 'X', aliases: input }).aliases).toEqual(aliases);

    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...input, ' alias64 '] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the aliases limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: 64, message: 'at most 64 aliases per term' },
    ]);
  });

  it('counts repeated aliases toward the documented per-term limit', () => {
    expect(LIMITS.aliases).toBe(64);
    const aliases = Array.from({ length: 64 }, () => ' spelling ');
    const term = { canonical: 'X', aliases };

    expect(parseLexicon({ terms: [term] }).terms[0].aliases).toEqual(Array(64).fill('spelling'));
    expect(() => parseLexicon({ terms: [{ ...term, aliases: [...aliases, 'spelling'] }] })).toThrow(
      'Invalid lexicon:\n  - terms[0].aliases: at most 64 aliases per term',
    );
  });

  it('accepts exactly 5000 terms and reports the terms boundary for 5001', () => {
    const terms = Array.from({ length: 5000 }, (_, i) => ({ canonical: `Term${i}` }));
    const atLimit = LexiconSchema.safeParse({ terms });
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data.terms).toHaveLength(5000);
    expect(atLimit.data.terms[4999].canonical).toBe('Term4999');
    expect(atLimit.data.terms).toEqual(terms.map((term) => ({ ...term, aliases: [] })));

    const overLimit = LexiconSchema.safeParse({ terms: [...terms, { canonical: 'Term5000' }] });
    expect(overLimit.success).toBe(false);
    if (overLimit.success) throw new Error('Expected the terms limit to be enforced');
    expect(overLimit.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms'], maximum: 5000, message: 'at most 5000 terms' },
    ]);
    expect(() => parseLexicon({ terms: [...terms, { canonical: 'Term5000' }] })).toThrow(
      'Invalid lexicon:\n  - terms: at most 5000 terms',
    );
  });
});
