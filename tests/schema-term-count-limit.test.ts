import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The file-wide terms cap as docs/CONTRACT.md states it ("`terms` 5000" in the
 * LIMITS summary), read back out of the doc so this test fails if doc and code
 * ever disagree about what a file one term over the cap does. The boundary is
 * checked against the doc, not against LIMITS, so a contract change is a
 * deliberate edit here too.
 */
const documentedLimit = (() => {
  const match = contract.match(/`terms` (\d+)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the terms count limit');
  return Number(match[1]);
})();

/**
 * A term with every field populated, each inside its own schema limit, so the
 * count cap is the only rule a list of these can break.
 */
const richTerm = (i: number) => ({
  canonical: `Term${i}`,
  aliases: [`alias${i}`, `also${i}`],
  phonetic: `TERM-${i}`,
  category: 'product',
  caseSensitive: true,
  scope: 'project',
  source: 'user',
  notes: `note ${i}`,
  createdAt: '2026-11-05T00:00:00.000Z',
  hits: i,
  never: [`never${i}`],
  context: [`context${i}`],
});

/** `documentedLimit` fully populated valid terms: the exact boundary the schema accepts. */
const TERMS = Array.from({ length: documentedLimit }, (_, i) => richTerm(i));
/** One term over the documented limit: 5001 entries when the doc says 5000. */
const OVER = [...TERMS, richTerm(documentedLimit)];

const yamlFor = (terms: ReadonlyArray<{ canonical: string }>) =>
  ['version: 1', 'terms:', ...terms.map((t) => `  - canonical: ${t.canonical}`), ''].join('\n');

describe('term count limit', () => {
  it('documents the same cap the schema enforces', () => {
    expect(documentedLimit).toBe(5000);
    expect(documentedLimit).toBe(LIMITS.terms);
    expect(OVER).toHaveLength(5001);
  });

  it('accepts a file with exactly the documented number of terms through every entry point', () => {
    const atLimit = LexiconSchema.safeParse({ version: 1, terms: TERMS });
    expect(atLimit.success).toBe(true);
    if (!atLimit.success) throw atLimit.error;
    expect(atLimit.data.terms).toHaveLength(documentedLimit);
    expect(atLimit.data.terms[0]).toEqual(TERMS[0]);
    expect(atLimit.data.terms[documentedLimit - 1]).toEqual(TERMS[documentedLimit - 1]);

    const parsed = parseLexicon({ version: 1, terms: TERMS });
    expect(parsed.terms).toHaveLength(documentedLimit);
    expect(parsed.terms[0]).toEqual(TERMS[0]);

    // The real file path: YAML text into a document before the schema sees it.
    expect(parseLexicon(parseYaml(yamlFor(TERMS))).terms).toHaveLength(documentedLimit);
  });

  it('shows every term over the cap is otherwise valid', () => {
    // Each of the 5001 terms passes the term schema on its own, so the count is
    // the only thing the file can be refused for.
    expect(OVER.every((term) => TermSchema.safeParse(term).success)).toBe(true);
    // The 5001st term alone is a legal one-term file.
    expect(parseLexicon({ terms: [OVER[documentedLimit]] }).terms[0]).toEqual(OVER[documentedLimit]);
  });

  it('rejects 5001 otherwise valid terms, blaming the list and nothing else', () => {
    const result = LexiconSchema.safeParse({ version: 1, terms: OVER });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected 5001 terms to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms'], maximum: 5000, message: 'at most 5000 terms' },
    ]);
    // The one issue is the count; no terms[i] entry is blamed.
    expect(result.error.issues).toHaveLength(1);

    expect(() => parseLexicon({ version: 1, terms: OVER })).toThrow(
      'Invalid lexicon:\n  - terms: at most 5000 terms',
    );
  });

  it('throws the same count diagnostic for an over-cap YAML file', () => {
    expect(() => parseLexicon(parseYaml(yamlFor(OVER)))).toThrow(
      'Invalid lexicon:\n  - terms: at most 5000 terms',
    );
  });

  it('reports only the count line however far over the cap the file is', () => {
    // The diagnostic states the limit once; it does not flood one line per extra term.
    const wayOver = [...OVER, richTerm(documentedLimit + 1), richTerm(documentedLimit + 2)];
    let message = '';
    try {
      parseLexicon({ version: 1, terms: wayOver });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('Invalid lexicon:\n  - terms: at most 5000 terms');
    expect(message).not.toContain('terms[');
  });

  it('reports only the count even when a term inside the over-cap file is invalid', () => {
    // The length check answers before any entry is examined, so a file over
    // the cap is refused on size alone and cannot produce a diagnostic per
    // term however malformed term 2500 is.
    const terms = [...TERMS.slice(0, 2500), { canonical: 'bad\tterm' }, ...TERMS.slice(2501), richTerm(documentedLimit)];
    expect(terms).toHaveLength(5001);
    const result = LexiconSchema.safeParse({ terms });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the file to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms'], maximum: 5000, message: 'at most 5000 terms' },
    ]);
    expect(result.error.issues).toHaveLength(1);

    let message = '';
    try {
      parseLexicon({ terms });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('Invalid lexicon:\n  - terms: at most 5000 terms');
  });
});
