import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LexiconSchema, LIMITS, parseLexicon, TermSchema } from '../src/core/schema.js';

// docs/schema-limit-reference.md also carries what used to be
// contract-limits-reference.md, contract-term-limits.md and
// contract-limit-examples.md; their tests are merged here.
const reference = readFileSync(new URL('../docs/schema-limit-reference.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('schema limit reference', () => {
  it('records each public limit and the contract values', () => {
    for (const [name, value] of Object.entries(LIMITS)) {
      expect(reference).toContain(`| \`${name}\` | ${value} |`);
      expect(contract).toContain(`\`${name}\` ${value}`);
    }
    expect(reference).toContain('| `createdAt` | 64 |');
    expect(reference).toContain('omissions in the');
  });

  it('agrees with the contract LIMITS line and names every field and unit', () => {
    const contractLimits = contract.split('\n').find((line) => line.startsWith('- `LIMITS`:'));
    expect(contractLimits).toBeDefined();
    expect(reference).toContain('[schema contract](CONTRACT.md#srccoreschemats)');

    const rows = [
      ['word', 'Unicode code points per `canonical`, each `aliases`, `never` or `context` entry, and each `settings.protectedWords` or `settings.packs` entry'],
      ['text', 'Unicode code points per `phonetic` or `notes` field'],
      ['aliases', 'Entries per term\'s `aliases`, `never` or `context` list, and per `settings.packs` list; each list has its own cap'],
      ['terms', 'Terms per lexicon file'],
      ['protectedWords', 'Entries in `settings.protectedWords` per lexicon file'],
    ] as const;

    expect(rows.map(([name]) => name).sort()).toEqual(Object.keys(LIMITS).sort());
    for (const [name, fields] of rows) {
      expect(contractLimits).toContain(`\`${name}\` ${LIMITS[name]}`);
      expect(reference).toContain(`| \`${name}\` | ${LIMITS[name]} | ${fields} |`);
    }
  });

  it('is linked from the documentation index', () => {
    expect(index).toContain('[schema-limit-reference.md](schema-limit-reference.md)');
  });

  it.each([
    ['canonical', (s: string) => ({ terms: [{ canonical: s }] })],
    ['alias', (s: string) => ({ terms: [{ canonical: 'X', aliases: [s] }] })],
    ['never', (s: string) => ({ terms: [{ canonical: 'X', never: [s] }] })],
    ['context', (s: string) => ({ terms: [{ canonical: 'X', context: [s] }] })],
    ['protectedWords', (s: string) => ({ settings: { protectedWords: [s] } })],
    ['packs', (s: string) => ({ settings: { packs: [s] } })],
  ])('documents the word limit applied to %s', (_field, input) => {
    const word = '𠮷'.repeat(LIMITS.word);
    expect(LexiconSchema.safeParse(input(` ​${word} `)).success).toBe(true);
    expect(LexiconSchema.safeParse(input(`${word}𠮷`)).success).toBe(false);
  });

  it.each([
    ['aliases', (entries: string[]) => ({ terms: [{ canonical: 'X', aliases: entries }] }), LIMITS.aliases],
    ['never', (entries: string[]) => ({ terms: [{ canonical: 'X', never: entries }] }), LIMITS.aliases],
    ['context', (entries: string[]) => ({ terms: [{ canonical: 'X', context: entries }] }), LIMITS.aliases],
    ['packs', (entries: string[]) => ({ settings: { packs: entries } }), LIMITS.aliases],
    ['protectedWords', (entries: string[]) => ({ settings: { protectedWords: entries } }), LIMITS.protectedWords],
  ])('counts cleaned %s entries without deduplicating', (_field, input, max) => {
    const entries = Array<string>(max).fill('same');
    expect(LexiconSchema.safeParse(input([...entries, ' ', '​'])).success).toBe(true);
    expect(LexiconSchema.safeParse(input([...entries, 'same'])).success).toBe(false);
  });

  it.each([
    ['phonetic', LIMITS.text],
    ['notes', LIMITS.text],
    ['createdAt', 64],
  ])('enforces the documented %s length', (field, max) => {
    const input = (length: number) => ({ terms: [{ canonical: 'X', [field]: '𠮷'.repeat(length) }] });
    expect(LexiconSchema.safeParse(input(max)).success).toBe(true);
    expect(LexiconSchema.safeParse(input(max + 1)).success).toBe(false);
  });

  it('runs the documented examples against the schema', () => {
    const blocks = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(1);
    const imports = "import assert from 'node:assert/strict';\nimport { parseLexicon } from '@ashlr/lexicon';\n";
    expect(blocks[0][1].startsWith(imports)).toBe(true);
    // Execute the actual example against source, without requiring a built dist/.
    const run = new Function('assert', 'parseLexicon', blocks[0][1].slice(imports.length));
    run(assert, parseLexicon);
  });
});

describe('contract term limits', () => {
  const documented = (pattern: RegExp, expected: number): number => {
    const match = contract.match(pattern);
    expect(match).not.toBeNull();
    const limit = Number(match![1]);
    expect(limit).toBe(expected);
    return limit;
  };

  it.each(['a', '𠮷'])('enforces the documented alias word limit for %s', (character) => {
    const documentedLimit = documented(/`word` (\d+) \(canonical, alias\)/, 80);
    const alias = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical: 'Name', aliases: [alias] }).aliases).toEqual([alias]);

    const result = TermSchema.safeParse({ canonical: 'Name', aliases: [alias + character] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias to exceed the documented word limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases', 0], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it.each(['a', '𠮷'])('enforces the documented canonical word limit for %s', (character) => {
    const documentedLimit = documented(/`word` (\d+) \(canonical, alias\)/, 80);
    const canonical = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical }).canonical).toBe(canonical);

    const result = TermSchema.safeParse({ canonical: canonical + character });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the canonical to exceed the documented word limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it.each(['a', '𠮷'])('enforces the documented phonetic text limit for %s', (character) => {
    const documentedLimit = documented(/`text` (\d+) \(notes, phonetic\)/, 200);
    const phonetic = character.repeat(documentedLimit);
    expect(TermSchema.parse({ canonical: 'Name', phonetic }).phonetic).toBe(phonetic);

    const result = TermSchema.safeParse({ canonical: 'Name', phonetic: phonetic + character });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected phonetic to exceed the documented text limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['phonetic'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it('accepts the term limit and rejects one additional term', () => {
    const terms = Array.from({ length: LIMITS.terms }, (_, i) => ({ canonical: `Term${i}` }));
    expect(LexiconSchema.safeParse({ terms }).success).toBe(true);
    expect(LexiconSchema.safeParse({ terms: [...terms, { canonical: 'Overflow' }] }).success).toBe(false);
  });

  it('accepts 64 aliases per term and rejects 65', () => {
    documented(/`aliases` (\d+) \(aliases and `never` per term\)/, 64);
    const aliases = Array.from({ length: 64 }, (_, i) => `alias ${i}`);
    expect(TermSchema.parse({ canonical: 'Name', aliases }).aliases).toEqual(aliases);

    const result = TermSchema.safeParse({ canonical: 'Name', aliases: [...aliases, 'overflow'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias count to exceed the documented limit');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['aliases'], maximum: 64, message: 'at most 64 aliases per term' },
    ]);
  });

  it('counts aliases and never lists separately', () => {
    const entries = Array<string>(LIMITS.aliases).fill('word');
    const input = (aliases: string[], never: string[]) => ({ terms: [{ canonical: 'X', aliases, never }] });
    expect(LexiconSchema.safeParse(input(entries, entries)).success).toBe(true);
    expect(LexiconSchema.safeParse(input([...entries, 'extra'], entries)).success).toBe(false);
    expect(LexiconSchema.safeParse(input(entries, [...entries, 'extra'])).success).toBe(false);
  });
});
