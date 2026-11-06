import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';

/** Exactly LIMITS.aliases entries: the boundary list the schema must accept. */
const ALIASES = Array.from({ length: LIMITS.aliases }, (_, i) => `alias${i}`);

describe('alias list at the documented count limit', () => {
  it('documents a 64-alias cap per term', () => {
    // LIMITS.aliases is the figure docs/CONTRACT.md publishes as
    // `aliases` 64 (aliases and `never` per term); pin it so a change is deliberate.
    expect(LIMITS.aliases).toBe(64);
    expect(ALIASES).toHaveLength(64);
  });

  it('accepts a term whose alias list is exactly at the limit, through every entry point', () => {
    expect(TermSchema.parse({ canonical: 'Ashlr.AI', aliases: ALIASES }).aliases).toEqual(ALIASES);
    expect(LexiconSchema.parse({ version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);
    expect(parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: ALIASES }] }).terms[0].aliases).toEqual(ALIASES);
  });

  it('accepts the boundary list in a hand-written YAML document', () => {
    const yaml = ['version: 1', 'terms:', '  - canonical: Ashlr.AI', '    aliases:', ...ALIASES.map((a) => `      - ${a}`), ''].join('\n');
    expect(parseLexicon(parseYaml(yaml)).terms[0].aliases).toEqual(ALIASES);
  });

  it('accepts a `never` list at the same limit and keeps the key present', () => {
    // `never` shares LIMITS.aliases through OptionalWordList, which leaves a
    // missing key absent; a provided list at the cap must come back present.
    const parsed = parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: [], never: ALIASES }] });
    expect(parsed.terms[0].never).toEqual(ALIASES);
  });

  it('keeps case-variant spellings as distinct entries inside the cap', () => {
    // The schema counts cleaned entries and never deduplicates; case-insensitive
    // dedupe is addTerm's job (dedupeAliases in store.ts), not the file parser's.
    const list = [...ALIASES.slice(0, 62), 'CaseWord', 'caseword'];
    expect(list).toHaveLength(LIMITS.aliases);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: list }] }).terms[0].aliases).toEqual(list);
  });

  it('counts case variants toward the cap, so 65 with a pair of them is still too many', () => {
    const list = [...ALIASES, 'caseword', 'CaseWord'];
    const result = TermSchema.safeParse({ canonical: 'X', aliases: list });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the over-cap list to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: LIMITS.aliases, message: `at most ${LIMITS.aliases} aliases per term` },
    ]);
  });

  it('leaves the input list untouched while cleaning it', () => {
    // The transform maps and filters into a new array; a regression that
    // cleaned in place would corrupt the caller's data.
    const raw = [...ALIASES.map((a) => ` ${a} `), '   '];
    const before = [...raw];
    const parsed = parseLexicon({ terms: [{ canonical: 'X', aliases: raw }] });
    expect(parsed.terms[0].aliases).toEqual(ALIASES);
    expect(raw).toEqual(before);
  });
});
