import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-alias-count-boundary.md', import.meta.url), 'utf8');

/** 64 distinct valid aliases: the exact boundary the schema accepts. */
const ALIASES = Array.from({ length: LIMITS.aliases }, (_, i) => `alias${i}`);

describe('alias count boundary', () => {
  it('states the caps and messages the schema enforces', () => {
    expect(doc).toContain(`\`LIMITS.aliases\` is ${LIMITS.aliases}`);
    expect(doc).toContain(`\`LIMITS.protectedWords\` (${LIMITS.protectedWords})`);
    for (const message of [
      `at most ${LIMITS.aliases} aliases per term`,
      `at most ${LIMITS.aliases} never words per term`,
      `at most ${LIMITS.aliases} packs`,
      `at most ${LIMITS.protectedWords} protected words`,
    ]) {
      expect(doc).toContain(message);
    }
  });

  it('accepts a term with 64 valid aliases through every entry point', () => {
    expect(LIMITS.aliases).toBe(64);

    expect(TermSchema.parse({ canonical: 'Ashlr.AI', aliases: ALIASES }).aliases).toEqual(ALIASES);
    expect(LexiconSchema.parse({ terms: [{ canonical: 'Ashlr.AI', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);
    expect(parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);

    // The real file path: YAML text into a document before the schema sees it.
    const yaml = ['version: 1', 'terms:', '  - canonical: Ashlr.AI', '    aliases:', ...ALIASES.map((a) => `      - ${a}`), ''].join('\n');
    expect(parseLexicon(parseYaml(yaml)).terms[0].aliases).toEqual(ALIASES);
  });

  it('rejects a 65th alias with the count error at the list path', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: [...ALIASES, 'alias64'] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65th alias to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'aliases'], maximum: 64, message: 'at most 64 aliases per term' },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [...ALIASES, 'alias64'] }] })).toThrow(
      'Invalid lexicon:\n  - terms[0].aliases: at most 64 aliases per term',
    );
  });

  it('counts the list after cleaning: raw entries that strip to nothing never count', () => {
    const padded = [...ALIASES.map((a) => `  ${a}\u200b `), '', ' ', '\t', '\u200b'];
    expect(padded).toHaveLength(LIMITS.aliases + 4);
    expect(TermSchema.parse({ canonical: 'X', aliases: padded }).aliases).toEqual(ALIASES);
  });

  it.each([
    ['over the word limit', 'x'.repeat(LIMITS.word + 1)],
    ['a control character', 'a\tb'],
    ['an unencodable character', 'a\uFFFFb'],
  ])('reports only the count error when the 65th alias is itself invalid: %s', (_label, extra) => {
    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES, extra] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65th alias to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: LIMITS.aliases, message: `at most ${LIMITS.aliases} aliases per term` },
    ]);
    expect(result.error.issues).toHaveLength(1);

    // The user-facing message hides the invalid entry the same way.
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: 'X', aliases: [...ALIASES, extra] }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(`Invalid lexicon:\n  - terms[0].aliases: at most ${LIMITS.aliases} aliases per term`);
    expect(message).not.toContain('aliases[64]');
  });

  it('reports a non-string 65th entry at its index, before the count is checked', () => {
    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES, 5] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a non-string entry to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'invalid_type', path: ['aliases', 64], message: 'Invalid input: expected string, received number' },
    ]);
    expect(result.error.issues).toHaveLength(1);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [...ALIASES, null] }] })).toThrow(
      /terms\[0\]\.aliases\[64\]/,
    );
  });

  it('reports an invalid entry inside a 64-list at its index, not as a count error', () => {
    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES.slice(0, 63), 'a\tb'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the invalid entry to be rejected');
    expect(result.error.issues).toMatchObject([
      { path: ['aliases', 63], message: 'must not contain control characters or newlines' },
    ]);
    expect(result.error.issues).toHaveLength(1);
  });

  it('reports every over-cap list in the file, each at its own path', () => {
    const over = [...ALIASES, 'extra'];
    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'X', aliases: over, never: over }],
      settings: { packs: over },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the over-cap lists to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'aliases'], maximum: 64, message: 'at most 64 aliases per term' },
      { code: 'too_big', path: ['terms', 0, 'never'], maximum: 64, message: 'at most 64 never words per term' },
      { code: 'too_big', path: ['settings', 'packs'], maximum: 64, message: 'at most 64 packs' },
    ]);
    expect(result.error.issues).toHaveLength(3);
  });

  it('enforces the settings.packs cap with its own path and message', () => {
    expect(LexiconSchema.safeParse({ settings: { packs: ALIASES } }).success).toBe(true);
    const result = LexiconSchema.safeParse({ settings: { packs: [...ALIASES, 'pack64'] } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65th pack entry to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['settings', 'packs'], maximum: 64, message: 'at most 64 packs' },
    ]);
    expect(() => parseLexicon({ settings: { packs: [...ALIASES, 'pack64'] } })).toThrow(
      'settings.packs: at most 64 packs',
    );
  });

  it('enforces the separate settings.protectedWords cap at 1000', () => {
    const words = Array.from({ length: LIMITS.protectedWords }, (_, i) => `word${i}`);
    expect(words).toHaveLength(1000);
    expect(LexiconSchema.safeParse({ settings: { protectedWords: words } }).success).toBe(true);
    expect(() => parseLexicon({ settings: { protectedWords: [...words, 'word1000'] } })).toThrow(
      'settings.protectedWords: at most 1000 protected words',
    );
  });

  it('accepts a term with every per-term limit at its maximum at once', () => {
    const term = {
      canonical: 'c'.repeat(LIMITS.word),
      aliases: ALIASES.map((a) => a.padEnd(LIMITS.word, 'x')),
      never: ALIASES.map((a) => a.padEnd(LIMITS.word, 'y')),
      phonetic: 'p'.repeat(LIMITS.text),
      notes: 'n'.repeat(LIMITS.text),
    };
    expect(term.aliases.every((a) => a.length === LIMITS.word)).toBe(true);

    expect(TermSchema.parse(term)).toStrictEqual(term);
    expect(parseLexicon({ terms: [term] }).terms[0]).toStrictEqual(term);
  });

  it('tells a count overflow apart from a length overflow at the same boundary', () => {
    // A 65th alias reports the list; an over-long alias inside a 64-list reports its index.
    const overCount = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES, 'one more'] });
    const overLength = TermSchema.safeParse({ canonical: 'X', aliases: ['x'.repeat(LIMITS.word + 1), ...ALIASES.slice(1)] });
    if (overCount.success || overLength.success) throw new Error('Expected both to be rejected');
    expect(overCount.error.issues[0].path).toEqual(['aliases']);
    expect(overLength.error.issues).toMatchObject([{ path: ['aliases', 0], message: `must be at most ${LIMITS.word} characters` }]);
  });
});
