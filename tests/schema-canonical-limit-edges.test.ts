/**
 * Edges of the canonical word limit docs/CONTRACT.md documents
 * ("`word` 80 (canonical, alias)") that the sibling boundary tests do not
 * pin:
 *
 * - The limit counts the code points as written. The store folds canonicals
 *   (trimmed, lowercased, NFC) only to compare them; the schema never
 *   normalizes, so an NFD canonical of exactly the limit is accepted and
 *   kept byte for byte, and one a code point over is refused even though
 *   its NFC form would fit.
 * - Leading and trailing control whitespace (a newline, a tab, a carriage
 *   return) is trimmed before the count, so it never reaches the
 *   control-character check. The same character in the interior is refused
 *   on its own at the limit, and reports both issues once it also tips the
 *   length over.
 * - Every free-text field is capped independently: a term and settings
 *   maxed in each field at once still parse, and a canonical one over
 *   inside that maximal lexicon names only `canonical`.
 * - A canonical at the limit is usable, not only storable: a parsed lexicon
 *   holding it rewrites its alias in a transcript.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';
import { normalize } from '../src/core/normalize.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The canonical word cap the contract publishes, read back out of the doc so
 * a change to either side fails here. CONTRACT.md states it inside the
 * src/core/schema.ts section as "`word` 80 (canonical, alias)".
 */
const documentedLimit = (() => {
  const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = section?.match(/`word` (\d+) \(canonical, alias\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the canonical word limit');
  return Number(match[1]);
})();

const AT_LIMIT = 'a'.repeat(documentedLimit);

describe('the limit counts the canonical as written, not its NFC fold', () => {
  // "e" + U+0301 (combining acute) is NFD "é": two code points that fold to
  // one under NFC, the form canonicals are compared under elsewhere. Written
  // as escapes so the source file cannot store it precomposed.
  const nfdAtLimit = `${'a'.repeat(documentedLimit - 2)}e\u0301`;
  const nfdOneOver = `${'a'.repeat(documentedLimit - 1)}e\u0301`;

  it('keeps the documented limit in step with the schema cap', () => {
    expect(documentedLimit).toBe(80);
    expect(documentedLimit).toBe(LIMITS.word);
    expect([...nfdAtLimit]).toHaveLength(documentedLimit);
    expect([...nfdAtLimit.normalize('NFC')]).toHaveLength(documentedLimit - 1);
    expect([...nfdOneOver]).toHaveLength(documentedLimit + 1);
    expect([...nfdOneOver.normalize('NFC')]).toHaveLength(documentedLimit);
  });

  it('accepts an NFD canonical at the documented limit and keeps it as written', () => {
    expect(TermSchema.parse({ canonical: nfdAtLimit }).canonical).toBe(nfdAtLimit);
    expect(parseLexicon({ terms: [{ canonical: nfdAtLimit }] }).terms[0].canonical).toBe(nfdAtLimit);
  });

  it('refuses one whose written form is a code point over though its NFC form fits', () => {
    const result = TermSchema.safeParse({ canonical: nfdOneOver });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an NFD canonical over the limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
    expect(result.error.issues).toHaveLength(1);
    expect(() => parseLexicon({ terms: [{ canonical: nfdOneOver }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: must be at most ${documentedLimit} characters`,
    );
  });
});

describe('control whitespace at the edges trims before the count', () => {
  it('accepts an at-limit canonical padded with newlines, tabs and carriage returns', () => {
    for (const padded of [`\n${AT_LIMIT}\n`, `\t${AT_LIMIT}\r\n `, `\r\n\t ${AT_LIMIT} \t\n`]) {
      expect(parseLexicon({ terms: [{ canonical: padded }] }).terms[0].canonical).toBe(AT_LIMIT);
    }
  });

  it('reports an interior newline at the limit as only the control-character issue', () => {
    const interior = `${'a'.repeat(39)}\n${'a'.repeat(40)}`;
    expect([...interior]).toHaveLength(documentedLimit);
    const result = TermSchema.safeParse({ canonical: interior });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an interior newline to be rejected');
    expect(result.error.issues).toMatchObject([
      { path: ['canonical'], message: 'must not contain control characters or newlines' },
    ]);
    expect(result.error.issues).toHaveLength(1);
  });

  it('reports the same newline one over the limit as both issues', () => {
    const interior = `${'a'.repeat(40)}\n${'a'.repeat(40)}`;
    expect([...interior]).toHaveLength(documentedLimit + 1);
    const result = TermSchema.safeParse({ canonical: interior });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an over-limit canonical with a newline to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
      { path: ['canonical'], message: 'must not contain control characters or newlines' },
    ]);
    expect(result.error.issues).toHaveLength(2);
    expect(() => parseLexicon({ terms: [{ canonical: interior }] })).toThrow(
      `terms[0].canonical: must be at most ${documentedLimit} characters\n  - terms[0].canonical: must not contain control characters or newlines`,
    );
  });
});

describe('every free-text field is capped independently', () => {
  // A lexicon with every list and string at its documented maximum at once.
  const maxedLexicon = (canonical: string) => ({
    terms: [
      {
        canonical,
        aliases: Array.from({ length: LIMITS.aliases }, () => 'a'.repeat(documentedLimit)),
        phonetic: 'p'.repeat(LIMITS.text),
        notes: 'n'.repeat(LIMITS.text),
        createdAt: 'c'.repeat(64),
        never: Array.from({ length: LIMITS.aliases }, () => 'v'.repeat(documentedLimit)),
        context: Array.from({ length: LIMITS.aliases }, () => 'x'.repeat(documentedLimit)),
      },
    ],
    settings: {
      protectedWords: Array.from({ length: LIMITS.protectedWords }, () => 'w'.repeat(documentedLimit)),
      packs: Array.from({ length: LIMITS.aliases }, () => 'k'.repeat(documentedLimit)),
    },
  });

  it('accepts a term and settings maxed in every field at once', () => {
    const parsed = parseLexicon(maxedLexicon(AT_LIMIT));
    const [term] = parsed.terms;
    expect(term.canonical).toBe(AT_LIMIT);
    expect(term.aliases).toHaveLength(LIMITS.aliases);
    expect(term.aliases[0]).toHaveLength(documentedLimit);
    expect(term.never).toHaveLength(LIMITS.aliases);
    expect(term.context).toHaveLength(LIMITS.aliases);
    expect(term.phonetic).toHaveLength(LIMITS.text);
    expect(term.notes).toHaveLength(LIMITS.text);
    expect(term.createdAt).toHaveLength(64);
    expect(parsed.settings?.protectedWords).toHaveLength(LIMITS.protectedWords);
    expect(parsed.settings?.packs).toHaveLength(LIMITS.aliases);
  });

  it('inside that maximal lexicon a canonical one over still names only canonical', () => {
    const result = LexiconSchema.safeParse(maxedLexicon(`${AT_LIMIT}a`));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the over-limit canonical to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
    expect(result.error.issues).toHaveLength(1);
  });
});

describe('a canonical at the documented limit still drives a correction', () => {
  it('rewrites an alias to the at-limit canonical it was parsed with', () => {
    const canonical = `${'Z'.repeat(documentedLimit - 3)}.AI`;
    expect(canonical).toHaveLength(documentedLimit);
    const lexicon = parseLexicon({ terms: [{ canonical, aliases: ['zedtop'] }] });
    const result = normalize('deploy zedtop tonight', lexicon);
    expect(result.changed).toBe(true);
    expect(result.output).toBe(`deploy ${canonical} tonight`);
    expect(result.replacements).toMatchObject([{ original: 'zedtop', replacement: canonical, reason: 'alias' }]);
  });
});
