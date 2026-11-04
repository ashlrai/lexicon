import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The alias cap the contract publishes, read back out of the doc so a change
 * to either side fails here. CONTRACT.md states it as
 * "`aliases` 64 (aliases and `never` per term)".
 */
const documentedLimit = (() => {
  const match = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the aliases count limit');
  return Number(match[1]);
})();

/** `documentedLimit` distinct valid aliases: the exact boundary the schema accepts. */
const ALIASES = Array.from({ length: documentedLimit }, (_, i) => `alias${i}`);

describe('contract alias-count limit', () => {
  it('keeps the documented count in step with the schema cap', () => {
    expect(documentedLimit).toBe(64);
    expect(documentedLimit).toBe(LIMITS.aliases);
    expect(ALIASES).toHaveLength(64);
  });

  it('accepts the documented number of aliases and rejects one more', () => {
    expect(TermSchema.parse({ canonical: 'X', aliases: ALIASES }).aliases).toEqual(ALIASES);

    const result = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES, `alias${documentedLimit}`] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias-count limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: documentedLimit, message: `at most ${documentedLimit} aliases per term` },
    ]);
  });

  it('validates a term with 64 aliases through every schema entry point', () => {
    expect(TermSchema.parse({ canonical: 'X', aliases: ALIASES }).aliases).toEqual(ALIASES);
    expect(LexiconSchema.parse({ terms: [{ canonical: 'X', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);
  });

  it('validates a term with 64 aliases read from a YAML lexicon file', () => {
    // The real file path: YAML text into a document before the schema sees it.
    const yaml = ['version: 1', 'terms:', '  - canonical: X', '    aliases:', ...ALIASES.map((a) => `      - ${a}`), ''].join('\n');
    expect(parseLexicon(parseYaml(yaml)).terms[0].aliases).toEqual(ALIASES);
  });

  it('rejects one over the documented limit at the list path', () => {
    const over = [...ALIASES, `alias${documentedLimit}`];
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: over }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected one alias over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'aliases'], maximum: documentedLimit, message: `at most ${documentedLimit} aliases per term` },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: over }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases: at most ${documentedLimit} aliases per term`,
    );
  });
});
