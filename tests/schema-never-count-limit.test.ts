import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * `never` shares one count limit with `aliases`: schema.ts builds it as
 * `OptionalWordList(LIMITS.aliases, 'never words per term')` and the contract
 * documents the pair as "`aliases` 64 (aliases and `never` per term)". The
 * limit is read back out of the doc so this test fails if doc and code ever
 * disagree about what a 65-entry `never` list does.
 */
const documentedLimit = (() => {
  const match = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the shared aliases/never count limit');
  return Number(match[1]);
})();

/** `documentedLimit` distinct valid never words: the exact boundary the schema accepts. */
const NEVER = Array.from({ length: documentedLimit }, (_, i) => `never${i}`);
/** One word over the documented limit: 65 entries when the doc says 64. */
const OVER = [...NEVER, `never${documentedLimit}`];

describe('never count limit', () => {
  it('documents one shared cap for aliases and never', () => {
    expect(documentedLimit).toBe(64);
    expect(documentedLimit).toBe(LIMITS.aliases);
    expect(OVER).toHaveLength(65);
  });

  it('accepts a never list at the documented limit through every entry point', () => {
    expect(TermSchema.parse({ canonical: 'X', never: NEVER }).never).toEqual(NEVER);
    expect(LexiconSchema.parse({ terms: [{ canonical: 'X', never: NEVER }] }).terms[0].never).toEqual(NEVER);
    expect(parseLexicon({ terms: [{ canonical: 'X', never: NEVER }] }).terms[0].never).toEqual(NEVER);

    // The real file path: YAML text into a document before the schema sees it.
    const yaml = ['version: 1', 'terms:', '  - canonical: X', '    never:', ...NEVER.map((w) => `      - ${w}`), ''].join('\n');
    expect(parseLexicon(parseYaml(yaml)).terms[0].never).toEqual(NEVER);
  });

  it('rejects a 65-entry never list with the count diagnostic at the list path', () => {
    const term = TermSchema.safeParse({ canonical: 'X', never: OVER });
    expect(term.success).toBe(false);
    if (term.success) throw new Error('Expected the 65-entry never list to be rejected');
    expect(term.error.issues).toMatchObject([
      { code: 'too_big', path: ['never'], maximum: 64, message: 'at most 64 never words per term' },
    ]);
    expect(term.error.issues).toHaveLength(1);

    const lexicon = LexiconSchema.safeParse({ terms: [{ canonical: 'X', never: OVER }] });
    expect(lexicon.success).toBe(false);
    if (lexicon.success) throw new Error('Expected the 65-entry never list to be rejected');
    expect(lexicon.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'never'], maximum: 64, message: 'at most 64 never words per term' },
    ]);
    expect(lexicon.error.issues).toHaveLength(1);

    // The user-facing diagnostic names the field, the limit and the term's index.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: OVER }] })).toThrow(
      'Invalid lexicon:\n  - terms[0].never: at most 64 never words per term',
    );
  });

  it('reports the same diagnostic through the real YAML file path', () => {
    const yaml = ['version: 1', 'terms:', '  - canonical: X', '    never:', ...OVER.map((w) => `      - ${w}`), ''].join('\n');
    expect(() => parseLexicon(parseYaml(yaml))).toThrow(
      'Invalid lexicon:\n  - terms[0].never: at most 64 never words per term',
    );
  });

  it('points the diagnostic at the term whose list is over, not the first term', () => {
    const input = { terms: [{ canonical: 'A' }, { canonical: 'B' }, { canonical: 'C', never: OVER }] };
    const result = LexiconSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65-entry never list to be rejected');
    expect(result.error.issues).toMatchObject([{ path: ['terms', 2, 'never'] }]);
    expect(result.error.issues).toHaveLength(1);
    expect(() => parseLexicon(input)).toThrow('  - terms[2].never: at most 64 never words per term');
  });

  it('names the never list when it alone is over the cap', () => {
    // 64 aliases is legal; only the never list can be blamed for this file.
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: NEVER, never: OVER }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65-entry never list to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'never'], message: 'at most 64 never words per term' },
    ]);
    expect(result.error.issues).toHaveLength(1);
  });

  it('reports one count line however far over the cap the list is', () => {
    // The diagnostic states the limit once; it does not flood one line per extra entry.
    const wayOver = Array.from({ length: documentedLimit * 2 }, (_, i) => `never${i}`);
    expect(wayOver).toHaveLength(128);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: wayOver }] })).toThrow(
      'Invalid lexicon:\n  - terms[0].never: at most 64 never words per term',
    );
  });

  it.each([
    ['over the word limit', 'x'.repeat(LIMITS.word + 1)],
    ['a control character', 'a\tb'],
    ['an unencodable character', 'a\uFFFFb'],
  ])('reports only the count error when the 65th never word is itself invalid: %s', (_label, extra) => {
    const result = TermSchema.safeParse({ canonical: 'X', never: [...NEVER, extra] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the 65-entry never list to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['never'], maximum: 64, message: 'at most 64 never words per term' },
    ]);
    expect(result.error.issues).toHaveLength(1);

    // The user-facing message hides the invalid entry the same way.
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: 'X', never: [...NEVER, extra] }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('Invalid lexicon:\n  - terms[0].never: at most 64 never words per term');
    expect(message).not.toContain('never[64]');
  });

  it('reports a non-string 65th entry at its index, before the count is checked', () => {
    const result = TermSchema.safeParse({ canonical: 'X', never: [...NEVER, 5] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a non-string entry to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'invalid_type', path: ['never', 64], message: 'Invalid input: expected string, received number' },
    ]);
    expect(result.error.issues).toHaveLength(1);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', never: [...NEVER, null] }] })).toThrow(
      /terms\[0\]\.never\[64\]/,
    );
  });

  it('reports an invalid entry inside a 64-list at its index, not as a count error', () => {
    const result = TermSchema.safeParse({ canonical: 'X', never: [...NEVER.slice(0, 63), 'a\tb'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the invalid entry to be rejected');
    expect(result.error.issues).toMatchObject([
      { path: ['never', 63], message: 'must not contain control characters or newlines' },
    ]);
    expect(result.error.issues).toHaveLength(1);
  });
});
