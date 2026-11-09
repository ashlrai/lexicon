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
  escapeUnencodable,
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

  it('accepts and preserves an 80-character alias on a valid term', () => {
    const alias = 'a'.repeat(80);
    const term = { canonical: 'Example', aliases: [alias], notes: 'A valid term' };

    expect(TermSchema.parse(term)).toStrictEqual(term);
  });

  it('accepts 80-character canonical names and aliases after trimming and stripping invisibles', () => {
    const word = 'a'.repeat(80);
    const lex = parseLexicon({ terms: [{ canonical: ` \u200B${word} `, aliases: [` ${word}\u200B `] }] });

    expect(lex.terms[0]).toEqual({ canonical: word, aliases: [word] });
  });

  it('rejects 81-character canonical names and aliases with their field paths', () => {
    const word = 'a'.repeat(81);

    expect(() => parseLexicon({ terms: [{ canonical: word }] })).toThrow(
      'terms[0].canonical: must be at most 80 characters',
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'Valid', aliases: [word] }] })).toThrow(
      'terms[0].aliases[0]: must be at most 80 characters',
    );
  });

  it('enforces the alias word limit on hand-edited YAML after cleanup', () => {
    const yaml = (alias: string) => parseYaml(
      `terms:\n  - canonical: Example\n    aliases: [valid, " ${alias}\\u200B "]\n`,
    );
    const atLimit = 'a'.repeat(80);

    expect(parseLexicon(yaml(atLimit)).terms[0].aliases).toEqual(['valid', atLimit]);
    expect(() => parseLexicon(yaml(`${atLimit}a`))).toThrow(
      'terms[0].aliases[1]: must be at most 80 characters',
    );
  });

  it('identifies an overlong canonical among valid terms', () => {
    const result = LexiconSchema.safeParse({ terms: [
      { canonical: 'a'.repeat(80) },
      { canonical: 'b'.repeat(81) },
      { canonical: 'Valid' },
    ] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected an invalid canonical');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 1, 'canonical'], maximum: 80, message: 'must be at most 80 characters' },
    ]);
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

  it('accepts and preserves a paired surrogate in a term', () => {
    const canonical = 'Rocket \uD83D\uDE80';
    const alias = 'Launch \uD83D\uDE80';
    const result = TermSchema.safeParse({ canonical, aliases: [alias] });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected the paired surrogate to be accepted');
    expect(result.data.canonical).toBe(canonical);
    expect(result.data.aliases).toEqual([alias]);
  });

  it('reports a lone high surrogate in a term name without throwing', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: '\uD800' }] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired surrogate to be rejected');
    expect(result.error.issues).toMatchObject([{
      code: 'custom',
      path: ['terms', 0, 'canonical'],
      message: 'must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "\\uD800"',
    }]);
  });

  it('reports a lone low surrogate as U+DC00 in a term name without throwing', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: '\uDC00' }] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired low surrogate to be rejected');
    expect(result.error.issues).toMatchObject([{
      code: 'custom',
      path: ['terms', 0, 'canonical'],
      message: 'must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "\\uDC00"',
    }]);
  });

  it('identifies an unpaired low surrogate as U+DC00 anywhere in the text, but not a valid pair', () => {
    expect(findUnencodableChar('\uDC00')).toBe('U+DC00');
    expect(findUnencodableChar('Ash\uDC00lr')).toBe('U+DC00');
    // A low surrogate that follows another low surrogate has no high half before it.
    expect(findUnencodableChar('\uDC00\uDC00')).toBe('U+DC00');
    // A reversed pair is two unpaired halves; the first one found is the low surrogate.
    expect(findUnencodableChar('\uDC00\uD800')).toBe('U+DC00');
    // A well-formed pair (U+1F680) is fine.
    expect(findUnencodableChar('🚀')).toBeUndefined();
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

  it.each([
    ['inside', 'Ash\uFFFElr', 'Ash\\uFFFElr'],
    ['leading', '\uFFFEAshlr', '\\uFFFEAshlr'],
    ['trailing', 'Ashlr\uFFFE', 'Ashlr\\uFFFE'],
    ['alone', '\uFFFE', '\\uFFFE'],
  ])('rejects U+FFFE %s a canonical word and identifies it', (_where, canonical, shown) => {
    expect(findUnencodableChar(canonical)).toBe('U+FFFE');
    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      `terms[0].canonical: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${shown}"`,
    );
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
  });

  it('rejects U+FFFF in phonetic text and names the code point, field and term', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    phonetic: "ash\\uFFFFler"\n');
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF in phonetic to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'phonetic'],
        message: 'must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
      },
    ]);
    expect(() => parseLexicon(input)).toThrow('terms[0].phonetic: must not contain U+FFFF');
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
    ['context', { canonical: 'Ashlr.AI', context: ['valid', 'Ash\uFFFFler'] }, ['context', 1], 'Ashlr.AI'],
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

  // Catches: `context` is in TERM_TEXT_FIELDS and, like `never`, is refused
  // only by the term-level pass (its field schema leaves the per-entry
  // unencodable check off). Dropping it from the list passed the suite.
  it('rejects U+FFFF in a term context word and names the code point, index and term', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    context: ["deploy\\uFFFFnow"]\n');
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF in context to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'context', 0],
        message: 'must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
      },
    ]);
    expect(() => parseLexicon(input)).toThrow('terms[0].context[0]: must not contain U+FFFF');
    expect(findUnencodableChar('deploy\uFFFFnow')).toBe('U+FFFF');
  });

  // Catches: the term name in a diagnostic is documented as at most 40
  // characters. A canonical can be 80, so an unbounded name would let one bad
  // alias flood the message; the cut keeps 39 characters plus an ellipsis.
  it.each([
    ['39 characters', 'a'.repeat(39), 'a'.repeat(39)],
    ['exactly 40 characters', 'b'.repeat(40), 'b'.repeat(40)],
    ['41 characters', 'c'.repeat(41), `${'c'.repeat(39)}…`],
    ['the 80 character maximum', 'd'.repeat(LIMITS.word), `${'d'.repeat(39)}…`],
  ])('bounds the term name in an unencodable-character diagnostic: %s', (_label, canonical, shown) => {
    const result = TermSchema.safeParse({ canonical, aliases: ['bad￿'] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    const [issue] = result.error.issues;
    expect(issue.message).toBe(
      `must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${shown}"`,
    );
    expect(shown.length).toBeLessThanOrEqual(40);
  });

  it('measures the 40-character bound after unencodable characters are written as escapes', () => {
    // Six characters per escape: 7 escapes are 42 characters, so the name is cut.
    const canonical = '￿'.repeat(7);
    const result = TermSchema.safeParse({ canonical });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    const name = /in term "(.*)"$/.exec(result.error.issues[0].message)?.[1] ?? '';
    expect(name).toHaveLength(40);
    expect(name.endsWith('…')).toBe(true);
    expect(name.slice(0, 36)).toBe('\\uFFFF'.repeat(6));
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

  it('accepts a paired surrogate in a term and preserves it unchanged', () => {
    const rocket = '\uD83D\uDE80';
    const term = { canonical: `Rocket ${rocket}`, aliases: [`Launch ${rocket}`], notes: `Ready ${rocket}` };

    expect(findUnencodableChar(rocket)).toBeUndefined();
    expect(TermSchema.parse(term)).toStrictEqual(term);
    expect(parseLexicon({ terms: [term] }).terms).toStrictEqual([term]);
  });

  it.each([
    ['a canonical that is only a pair', '🚀'],
    ['a pair at the start', '🚀Rocket'],
    ['a pair at the end', 'Rocket🚀'],
    ['adjacent pairs', '🚀🚀'],
    ['the lowest and highest supplementary code points', '\u{10000}\u{10FFFF}'],
  ])('accepts a valid supplementary character in a canonical word: %s', (_label, canonical) => {
    expect(findUnencodableChar(canonical)).toBeUndefined();
    expect(TermSchema.parse({ canonical })).toMatchObject({ canonical });
    expect(parseLexicon({ terms: [{ canonical }] }).terms[0]?.canonical).toBe(canonical);
  });

  it('accepts a surrogate pair written as a YAML escape in a canonical word', () => {
    const input = parseYaml('terms:\n  - canonical: "Rocket\\uD83D\\uDE80"\n');

    expect(parseLexicon(input).terms[0]?.canonical).toBe('Rocket\u{1F680}');
  });

  it.each([
    ['a lone low surrogate', 'x\uDE80y', 'U+DE80'],
    ['the first low surrogate', '\uDC00', 'U+DC00'],
    ['a low surrogate before a high one (reversed pair)', '\uDE80\uD83D', 'U+DE80'],
    ['a low surrogate after a complete pair', '🚀\uDE80', 'U+DE80'],
  ])('rejects an alias with %s and names the invalid code unit', (_label, alias, codeUnit) => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Ashlr.AI', aliases: ['ok', alias] }] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error(`Expected ${codeUnit} to be rejected`);
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'aliases', 1],
        message: expect.stringContaining(`must not contain ${codeUnit} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`),
      },
    ]);
    expect(findUnencodableChar(alias)).toBe(codeUnit);
    expect(() => TermSchema.parse({ canonical: 'Ashlr.AI', aliases: [alias] })).toThrow(codeUnit);
  });

  it('rejects an unpaired low surrogate in a YAML alias and names the code unit and term', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: ["Ash\\uDE80ler"]\n');

    expect(() => parseLexicon(input)).toThrow(
      'terms[0].aliases[0]: must not contain U+DE80 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
    );
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

  it('rejects U+FFFE in a note loaded from YAML and names the code point, field and term', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    notes: "my \\uFFFEcompany"\n');
    const result = LexiconSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE in notes to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'notes'],
        message: 'must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Ashlr.AI"',
      },
    ]);
    expect(() => parseLexicon(input)).toThrow('terms[0].notes: must not contain U+FFFE');
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
    [{ canonical: 'Ashlr.AI', context: ['valid', 'Ash\uFFFEler'] }, ['context', 1], 'Ashlr.AI'],
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
    expect(() => parseLexicon({ terms: [{ canonical: 'X', context: ['w\uFFFFd'] }] })).toThrow(/terms\[0\]\.context\[0\]: must not contain U\+FFFF/);
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

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('rejects a canonical that is only %s, with the escaped unit as the term label', (codePoint, character) => {
    // One code point, not empty: the noncharacter itself is the whole field
    // and the whole term name, shown in the error in its escaped form.
    const result = TermSchema.safeParse({ canonical: character });

    expect(result.success).toBe(false);
    if (result.success) throw new Error(`Expected ${codePoint} to be rejected`);
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['canonical'],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "\\u${codePoint.slice(2)}"`,
      },
    ]);
  });

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('rejects a lone %s entry in each settings list at its own index', (codePoint, character) => {
    const result = LexiconSchema.safeParse({
      terms: [],
      settings: { protectedWords: ['valid', character], packs: [character] },
    });

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

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('rejects %s through the standalone LexiconSettingsSchema in both word lists', (codePoint, character) => {
    // Paths sit on the settings object itself and carry no term name: these
    // entries are file-level, not tied to one canonical.
    const result = LexiconSettingsSchema.safeParse({
      protectedWords: ['valid', `word${character}`],
      packs: [`pack${character}`],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error(`Expected ${codePoint} to be rejected`);
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['protectedWords', 1],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`,
      },
      {
        path: ['packs', 0],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`,
      },
    ]);
  });

  it('identifies U+FFFE and U+FFFF at their own indexes in the same alias list', () => {
    const result = TermSchema.safeParse({ canonical: 'Rocket', aliases: ['ok', 'a\uFFFEb', 'c\uFFFFd'] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the noncharacters to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['aliases', 1],
        message: 'must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"',
      },
      {
        path: ['aliases', 2],
        message: 'must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"',
      },
    ]);
  });

  it('identifies each noncharacter at its own field path when one term carries both', () => {
    // The check walks TERM_TEXT_FIELDS in order, so the U+FFFF issue on
    // `never` is listed ahead of the U+FFFE issue on `notes`.
    const result = TermSchema.safeParse({ canonical: 'Rocket', never: ['n\uFFFFo'], notes: 't\uFFFEt' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected both noncharacters to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['never', 0],
        message: 'must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"',
      },
      {
        path: ['notes'],
        message: 'must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"',
      },
    ]);
  });

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('still rejects %s when cleaning leaves it as the whole list entry', (codePoint, character) => {
    // Stripping invisibles and trimming leaves the single noncharacter: it
    // is not dropped as empty, so the term-level check still finds it.
    const result = TermSchema.safeParse({ canonical: 'Rocket', never: [` ${ZW}${character}${ZW} `] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error(`Expected ${codePoint} to be rejected`);
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['never', 0],
        message: `must not contain ${codePoint} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
      },
    ]);
  });

  it('identifies U+FFFE and U+FFFF in one thrown error across term and settings', () => {
    expect(() =>
      parseLexicon({
        terms: [{ canonical: 'Rocket', aliases: ['a\uFFFEb'] }],
        settings: { packs: ['p\uFFFFk'] },
      }),
    ).toThrow(
      'Invalid lexicon:\n' +
        '  - terms[0].aliases[0]: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"\n' +
        '  - settings.packs[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format)',
    );
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

  it('escapes every mixed unencodable code unit in diagnostic term labels', () => {
    const input = { terms: [{ canonical: 'A\uFFFE\uD800x\uDC00\uFFFF🚀', aliases: ['\uFFFF'] }] };
    const reason = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';
    const label = 'A\\uFFFE\\uD800x\\uDC00\\uFFFF🚀';

    expect(() => parseLexicon(input)).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: must not contain U+FFFE (${reason}) in term "${label}"\n` +
      `  - terms[0].aliases[0]: must not contain U+FFFF (${reason}) in term "${label}"`,
    );
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

  it('reports a lone low surrogate as a term name without throwing', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: '\uDC00' }] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the lone low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['terms', 0, 'canonical'],
        message: 'must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "\\uDC00"',
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

  it.each([
    ['high', 0xd800, 0xdbff],
    ['low', 0xdc00, 0xdfff],
  ])('reports every isolated %s surrogate at its alias path', (_kind, first, last) => {
    for (let unit = first; unit <= last; unit++) {
      const code = `U+${unit.toString(16).toUpperCase()}`;
      const alias = `before${String.fromCharCode(unit)}after`;
      const result = TermSchema.safeParse({ canonical: 'Rocket', aliases: [alias] });

      expect(findUnencodableChar(alias)).toBe(code);
      expect(result.success, code).toBe(false);
      if (result.success) throw new Error(`Expected ${code} to be rejected`);
      expect(result.error.issues.map(({ path, message }) => ({ path, message })), code).toEqual([
        {
          path: ['aliases', 0],
          message: `must not contain ${code} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"`,
        },
      ]);
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

  it('preserves a valid supplementary character when escaping an adjacent unpaired surrogate', () => {
    const pair = '\uD83D\uDE80';
    const canonical = `Launch ${pair}`;
    const result = LexiconSchema.safeParse({ terms: [{ canonical }] });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected the supplementary character to be accepted');
    expect(result.data.terms[0].canonical).toBe(canonical);
    expect(findUnencodableChar(canonical)).toBeUndefined();
    expect(escapeUnencodable(`${pair}\uD800`)).toBe(`${pair}\\uD800`);
    expect(escapeUnencodable(`\uDC00${pair}`)).toBe(`\\uDC00${pair}`);
  });

  it('keeps a valid surrogate pair in the term label when another field is invalid', () => {
    const canonical = 'Launch \uD83D\uDE80';
    const result = LexiconSchema.safeParse({ terms: [{ canonical, aliases: ['bad\uD800'] }] });

    expect(findUnencodableChar(canonical)).toBeUndefined();
    expect(TermSchema.parse({ canonical }).canonical).toBe(canonical);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired alias surrogate to be rejected');
    expect(result.error.issues).toEqual([expect.objectContaining({
      path: ['terms', 0, 'aliases', 0],
      message: `must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${canonical}"`,
    })]);
  });

  it.each([
    ['adjacent', '\uD83D\uDE80\uD842\uDFB7'],
    ['separated by text', '\uD83D\uDE80 and \uD842\uDFB7'],
  ])('accepts and preserves two distinct surrogate pairs in a canonical term when %s', (_description, canonical) => {
    expect(TermSchema.parse({ canonical }).canonical).toBe(canonical);
    expect(parseLexicon({ terms: [{ canonical }] }).terms[0].canonical).toBe(canonical);
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

  it('accepts a valid surrogate pair in every free-text field, up to the documented limits', () => {
    // A well-formed pair is one supplementary character, not an unpaired
    // surrogate: the unencodable-character check must let it through.
    const pair = '\u{1F680}';
    expect(pair).toHaveLength(2);
    const text = pair.repeat(LIMITS.text);
    const word = pair.repeat(LIMITS.word);
    const parsed = parseLexicon({
      terms: [{ canonical: word, aliases: [word], never: [word], phonetic: word, notes: text }],
    }).terms[0];
    expect(parsed.canonical).toBe(word);
    expect(parsed.aliases).toEqual([word]);
    expect(parsed.never).toEqual([word]);
    expect(parsed.phonetic).toBe(word);
    expect(parsed.notes).toBe(text);

    // One past each limit is still rejected.
    expect(() => parseLexicon({ terms: [{ canonical: `${word}${pair}` }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${text}${pair}` }] })).toThrow(/terms\[0\]\.notes/);
    // A pair is fine, but a pair followed by a lone high surrogate is not.
    expect(LexiconSchema.safeParse({ terms: [{ canonical: `${pair}\uD800` }] }).success).toBe(false);
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

  it('accepts a notes value of exactly 200 characters and rejects 201', () => {
    const exact = 'n'.repeat(200);
    expect(TermSchema.parse({ canonical: 'X', notes: exact }).notes).toBe(exact);
    expect(TermSchema.safeParse({ canonical: 'X', notes: exact + 'n' }).success).toBe(false);
    // Surrounding whitespace is trimmed before the cap applies.
    expect(TermSchema.parse({ canonical: 'X', notes: `  ${exact}  ` }).notes).toBe(exact);
    // Invisible characters are stripped first, so they do not count toward the 200.
    expect(TermSchema.parse({ canonical: 'X', notes: `${exact}​` }).notes).toBe(exact);
    // The same cap holds for phonetic.
    expect(TermSchema.parse({ canonical: 'X', phonetic: exact }).phonetic).toBe(exact);
    expect(TermSchema.safeParse({ canonical: 'X', phonetic: exact + 'n' }).success).toBe(false);
  });

  it('rejects a 201-character note with the notes path and the 200 limit from docs/CONTRACT.md', () => {
    const result = TermSchema.safeParse({ canonical: 'X', notes: 'n'.repeat(201) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(LIMITS.text).toBe(200);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].path).toEqual(['notes']);
    expect(result.error.issues[0].message).toMatch(/must be at most 200 characters/);
  });

  it('rejects an over-limit note read from YAML, pointing at the term index and keeping the valid terms out of the error', () => {
    const long = 'n'.repeat(LIMITS.text + 1);
    const ok = 'n'.repeat(LIMITS.text);
    const input = parseYaml(
      `terms:\n  - canonical: Fine\n    notes: ${ok}\n  - canonical: Rocket\n    notes: ${long}\n`,
    );
    let message = '';
    try {
      parseLexicon(input);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('Invalid lexicon:\n  - terms[1].notes: must be at most 200 characters');
  });

  it('counts a 200-character note in characters, not UTF-16 units', () => {
    const rocket = '\u{1F680}'.repeat(200);
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: rocket }] }).terms[0].notes).toBe(rocket);
  });

  it('rejects a 201-character note whatever its code points, measured after trimming and stripping invisibles', () => {
    const rocket = '\u{1F680}';
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: rocket.repeat(201) }] })).toThrow(
      /terms\[0\]\.notes: must be at most 200 characters/,
    );
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${'n'.repeat(200)}x` }] })).toThrow(/terms\[0\]\.notes/);
    // Padding and zero-width characters do not count toward the 200.
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: `  ${'n'.repeat(100)}${ZW}${'n'.repeat(100)}  ` }] }).terms[0].notes).toHaveLength(200);
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

  it('accepts a 200-character phonetic from YAML and rejects the 201st character', () => {
    const phonetic = `${'a'.repeat(199)}🚀`;
    const yaml = (value: string) => `terms:\n  - canonical: Example\n    phonetic: "${value}"\n`;

    expect(parseLexicon(parseYaml(yaml(phonetic))).terms[0].phonetic).toBe(phonetic);
    expect(() => parseLexicon(parseYaml(yaml(`${phonetic}x`)))).toThrow(
      'terms[0].phonetic: must be at most 200 characters',
    );
  });

  it('rejects a 201-character phonetic in a later term after cleaning', () => {
    const phonetic = 'p'.repeat(201);
    const input = { terms: [
      { canonical: 'First', phonetic: 'valid' },
      { canonical: 'Second', phonetic: ` ${ZW}${phonetic} ` },
    ] };

    const result = LexiconSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the phonetic limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 1, 'phonetic'], maximum: 200, message: 'must be at most 200 characters' },
    ]);
    expect(() => parseLexicon(input)).toThrow(
      'Invalid lexicon:\n  - terms[1].phonetic: must be at most 200 characters',
    );
  });

  it('applies the 80-character alias contract independently across terms and aliases', () => {
    const below = 'a'.repeat(79);
    const atLimit = 'b'.repeat(80);
    const overLimit = 'c'.repeat(81);
    const valid = {
      terms: [
        { canonical: 'First', aliases: [below, ` ${atLimit} `] },
        { canonical: 'Second', aliases: [atLimit, 'short'] },
      ],
    };
    expect(parseLexicon(valid).terms.map((term) => term.aliases)).toEqual([
      [below, atLimit],
      [atLimit, 'short'],
    ]);

    const invalid = {
      terms: [
        { canonical: 'First', aliases: [below, atLimit, overLimit] },
        { canonical: 'Second', aliases: [overLimit, atLimit] },
      ],
    };
    const result = LexiconSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected overlong aliases to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'aliases', 2], maximum: 80 },
      { code: 'too_big', path: ['terms', 1, 'aliases', 0], maximum: 80 },
    ]);
    expect(() => parseLexicon(invalid)).toThrow(
      'Invalid lexicon:\n  - terms[0].aliases[2]: must be at most 80 characters\n  - terms[1].aliases[0]: must be at most 80 characters',
    );
  });

  it('enforces the alias word boundary in a YAML lexicon', () => {
    const alias = 'a'.repeat(80);
    const yaml = (value: string) => `terms:\n  - canonical: Example\n    aliases:\n      - ${value}\n`;

    expect(parseLexicon(parseYaml(yaml(alias))).terms[0].aliases).toEqual([alias]);
    expect(() => parseLexicon(parseYaml(yaml(`${alias}a`)))).toThrow(
      'Invalid lexicon:\n  - terms[0].aliases[0]: must be at most 80 characters',
    );
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

  it.each(['notes', 'phonetic'] as const)('counts astral characters at the 200-character text boundary for %s', (field) => {
    const text = '\u{1F680}'.repeat(200);
    expect(text).toHaveLength(400); // 200 code points, each two UTF-16 code units.
    expect(parseLexicon({ terms: [{ canonical: 'X', [field]: text }] }).terms[0][field]).toBe(text);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', [field]: `${text}\u{1F680}` }] })).toThrow(
      `terms[0].${field}: must be at most 200 characters`,
    );
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

  it('rejects 65 distinct aliases in a YAML lexicon with a validation error', () => {
    const aliases = Array.from({ length: 65 }, (_, i) => `alias${i}`);
    const yaml = (words: string[]) => `terms:\n  - canonical: Example\n    aliases:\n${words.map((word) => `      - ${word}`).join('\n')}\n`;

    expect(parseLexicon(parseYaml(yaml(aliases.slice(0, 64)))).terms[0].aliases).toEqual(aliases.slice(0, 64));
    expect(() => parseLexicon(parseYaml(yaml(aliases)))).toThrow(
      'Invalid lexicon:\n  - terms[0].aliases: at most 64 aliases per term',
    );
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

  it('accepts exactly 64 never spellings per term and rejects a 65th', () => {
    const never = Array.from({ length: LIMITS.aliases }, (_, i) => `never${i}`);
    expect(never).toHaveLength(64);

    const atLimit = LexiconSchema.safeParse({ terms: [{ canonical: 'X', never }] });
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data.terms[0].never).toEqual(never);

    // Empties and invisible-only entries are cleaned away first, so they do not count.
    expect(TermSchema.parse({ canonical: 'X', never: [...never.map((w) => ` ${ZW}${w} `), '', ' ', ZW] }).never).toEqual(never);

    const overLimit = LexiconSchema.safeParse({ terms: [{ canonical: 'X', never: [...never, 'never64'] }] });
    expect(overLimit.success).toBe(false);
    if (overLimit.success) throw new Error('Expected the never limit to be enforced');
    expect(overLimit.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'never'], maximum: 64, message: 'at most 64 never words per term' },
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

  it('counts never entries separately from aliases after cleaning, including duplicates', () => {
    const aliases = Array.from({ length: 64 }, (_, i) => `alias${i}`);
    const never = Array(64).fill(' excluded ');
    const term = parseLexicon({ terms: [{ canonical: 'X', aliases, never: [...never, '', ' ', ZW] }] }).terms[0];
    expect(term.aliases).toEqual(aliases);
    expect(term.never).toEqual(Array(64).fill('excluded'));

    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases, never: [...never, 'another'] }] })).toThrow(
      /terms\[0\]\.never: at most 64 never words per term/,
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

  it('counts repeated terms toward the documented 5000-term limit', () => {
    // docs/CONTRACT.md specifies a collection limit, not a unique-name limit.
    const terms = Array.from({ length: 5000 }, () => ({ canonical: 'Repeated' }));
    const parsed = parseLexicon({ terms });
    expect(parsed.terms).toHaveLength(5000);
    expect(parsed.terms.every((term) => term.canonical === 'Repeated')).toBe(true);

    expect(() => parseLexicon({ terms: [...terms, { canonical: 'Repeated' }] })).toThrow(
      'Invalid lexicon:\n  - terms: at most 5000 terms',
    );
  });

  it('accepts exactly LIMITS.aliases never words and rejects one more, naming the path and the limit', () => {
    const fixture = (n: number) => Array.from({ length: n }, (_, i) => `nope${i}`);
    expect(LIMITS.aliases).toBe(64);
    expect(parseLexicon({ terms: [{ canonical: 'Ashlr.AI', never: fixture(LIMITS.aliases) }] }).terms[0].never).toHaveLength(64);
    expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr.AI', never: fixture(LIMITS.aliases + 1) }] })).toThrow(
      'Invalid lexicon:\n  - terms[0].never: at most 64 never words per term',
    );
    const result = TermSchema.safeParse({ canonical: 'X', never: fixture(LIMITS.aliases + 1) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].path).toEqual(['never']);
  });

  it('rejects an over-limit never list read from YAML at the right term index', () => {
    const items = Array.from({ length: LIMITS.aliases + 1 }, (_, i) => `    - w${i}`).join('\n');
    const input = parseYaml(`terms:\n  - canonical: Fine\n  - canonical: Rocket\n    never:\n${items}\n`);
    expect(() => parseLexicon(input)).toThrow('Invalid lexicon:\n  - terms[1].never: at most 64 never words per term');
  });

  it('accepts 64 never entries per term from YAML, including repeated entries', () => {
    // The contract caps entries per term, not unique spellings or the whole file.
    const items = Array.from({ length: 64 }, () => '    - repeated').join('\n');
    const input = parseYaml(`terms:\n  - canonical: First\n    never:\n${items}\n  - canonical: Second\n    never:\n${items}\n`);
    const parsed = parseLexicon(input);
    expect(parsed.terms.map((term) => term.never)).toEqual([Array(64).fill('repeated'), Array(64).fill('repeated')]);

    const overLimit = parseYaml(`terms:\n  - canonical: First\n    never:\n${items}\n    - repeated\n`);
    expect(() => parseLexicon(overLimit)).toThrow('Invalid lexicon:\n  - terms[0].never: at most 64 never words per term');
  });
});
