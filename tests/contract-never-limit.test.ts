/**
 * The `never` count boundary of docs/CONTRACT.md's LIMITS paragraph: `aliases`,
 * 64, caps each term's `never` list as well as its `aliases` list ("`aliases`
 * 64 (aliases and `never` per term)"), and docs/term-capacity-reference.md
 * states the two lists are counted separately. A term with 64 never words is
 * accepted; 65 is refused as `at most 64 never words per term`. Every entry
 * point is exercised: TermSchema, LexiconSchema, parseLexicon (including from
 * YAML text), and the write path behind `lexicon add --never`, MCP add_term
 * and POST /add (addTerm/runAdd on the real store), including the merge that
 * overflows an existing term's list.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';
import { addTerm, readLexiconFile } from '../src/core/store.js';
import { runAdd } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

const ZW = '\u200b'; // a zero-width space: stripped before the entry is counted

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const capacity = readFileSync(new URL('../docs/term-capacity-reference.md', import.meta.url), 'utf8');

/**
 * The never-word cap the contract publishes, read back out of the doc so a
 * change to either side fails here. CONTRACT.md states it as
 * "`aliases` 64 (aliases and `never` per term)".
 */
const documentedLimit = (() => {
  const match = contract.match(/`aliases` (\d+) \(aliases and `never` per term\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the aliases count limit');
  return Number(match[1]);
})();

/** `documentedLimit` distinct valid never words: the exact boundary the schema accepts. */
const NEVER = Array.from({ length: documentedLimit }, (_, i) => `guard${i}`);

describe('contract never-count limit', () => {
  it('keeps the documented count in step with the schema cap', () => {
    expect(documentedLimit).toBe(64);
    expect(documentedLimit).toBe(LIMITS.aliases);
    expect(NEVER).toHaveLength(64);
    // docs/term-capacity-reference.md publishes the same row.
    expect(capacity).toContain(`| \`never\` words per term | ${documentedLimit} | \`aliases\` |`);
  });

  it('accepts the documented number of never words and rejects one more', () => {
    expect(TermSchema.parse({ canonical: 'SaaS', never: NEVER }).never).toEqual(NEVER);

    const result = TermSchema.safeParse({ canonical: 'SaaS', never: [...NEVER, `guard${documentedLimit}`] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the never-count limit to be enforced');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['never'], maximum: documentedLimit, message: `at most ${documentedLimit} never words per term` },
    ]);
  });

  it('validates a term at the limit through every schema entry point', () => {
    expect(TermSchema.parse({ canonical: 'SaaS', never: NEVER }).never).toEqual(NEVER);
    expect(LexiconSchema.parse({ terms: [{ canonical: 'SaaS', never: NEVER }] }).terms[0].never).toEqual(NEVER);
    expect(parseLexicon({ terms: [{ canonical: 'SaaS', never: NEVER }] }).terms[0].never).toEqual(NEVER);
  });

  it('rejects one over the documented limit at the list path', () => {
    const over = [...NEVER, `guard${documentedLimit}`];
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'SaaS', never: over }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected one never word over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'never'], maximum: documentedLimit, message: `at most ${documentedLimit} never words per term` },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'SaaS', never: over }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].never: at most ${documentedLimit} never words per term`,
    );
  });

  it('reads the boundary from a YAML lexicon file', () => {
    // The real file path: YAML text into a document before the schema sees it.
    const yaml = (words: readonly string[]) =>
      ['version: 1', 'terms:', '  - canonical: SaaS', '    never:', ...words.map((w) => `      - ${w}`), ''].join('\n');
    expect(parseLexicon(parseYaml(yaml(NEVER))).terms[0].never).toEqual(NEVER);
    expect(() => parseLexicon(parseYaml(yaml([...NEVER, `guard${documentedLimit}`])))).toThrow(
      `terms[0].never: at most ${documentedLimit} never words per term`,
    );
  });

  it('counts the never list separately from the aliases list', () => {
    // The contract caps each list at 64; a term may carry both at once.
    const aliases = Array.from({ length: documentedLimit }, (_, i) => `sas${i}`);
    expect(parseLexicon({ terms: [{ canonical: 'SaaS', aliases, never: NEVER }] }).terms[0].never).toEqual(NEVER);

    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'SaaS', aliases, never: [...NEVER, 'extra'] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the never list over the limit to be rejected even with aliases at the limit');
    expect(result.error.issues).toMatchObject([{ path: ['terms', 0, 'never'], maximum: documentedLimit }]);
  });

  it('drops blank entries before counting, but still counts duplicates', () => {
    // docs/term-capacity-reference.md: "Empty list entries are dropped before
    // counting; duplicates still count."
    expect(parseLexicon({ terms: [{ canonical: 'SaaS', never: [...NEVER, '  '] }] }).terms[0].never).toEqual(NEVER);
    expect(parseLexicon({ terms: [{ canonical: 'SaaS', never: [...NEVER, ZW] }] }).terms[0].never).toEqual(NEVER);

    // 65 entries where the extra duplicates an earlier one are still 65 entries.
    expect(TermSchema.safeParse({ canonical: 'SaaS', never: [...NEVER, 'guard0'] }).success).toBe(false);

    // A null entry is never silently dropped: it is an error in its own right.
    const withNull = TermSchema.safeParse({ canonical: 'SaaS', never: [...NEVER.slice(0, -1), null] });
    expect(withNull.success).toBe(false);
    if (withNull.success) throw new Error('Expected a null never entry to be rejected');
    expect(withNull.error.issues).toMatchObject([{ code: 'invalid_type', path: ['never', documentedLimit - 1] }]);
  });

  it('caps each never word at the documented word limit, independent of the count', () => {
    // A count caps entries; a length caps characters. Both must pass, so 64
    // never words of exactly `word` characters are valid and one character
    // over in a single entry is not.
    const atWord = 'w'.repeat(LIMITS.word);
    expect(parseLexicon({ terms: [{ canonical: 'SaaS', never: Array.from({ length: documentedLimit }, () => atWord) }] }).terms[0].never).toHaveLength(documentedLimit);

    const result = TermSchema.safeParse({ canonical: 'SaaS', never: [`${atWord}w`] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a never word over the documented word limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['never', 0], maximum: LIMITS.word, message: `must be at most ${LIMITS.word} characters` },
    ]);
  });

  it('reports a later term\'s overflow at its own index', () => {
    const raw = {
      terms: [
        { canonical: 'Within', never: NEVER },
        { canonical: 'Over', never: [...NEVER, 'extra'] },
      ],
    };
    expect(() => parseLexicon(raw)).toThrow(`terms[1].never: at most ${documentedLimit} never words per term`);
  });

  it('shares the documented cap with settings.packs', () => {
    // docs/term-capacity-reference.md: `settings.packs` rides the same
    // `aliases` limit in the schema even though the contract line only names
    // aliases and `never`.
    const packs = Array.from({ length: documentedLimit }, (_, i) => `pack${i}`);
    expect(parseLexicon({ settings: { packs } }).settings?.packs).toEqual(packs);
    expect(() => parseLexicon({ settings: { packs: [...packs, 'extra'] } })).toThrow(
      `settings.packs: at most ${documentedLimit} packs`,
    );
  });
});

describe('the same boundary through the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-never-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes a term at the limit through lexicon add --never, and it reads back', async () => {
    const code = await runAdd('SaaS', [], { never: NEVER, globalPath, cwd: tmp }, makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'SaaS');
    expect(term?.never).toEqual(NEVER);
  });

  it('refuses one word over the limit and writes nothing', async () => {
    await expect(runAdd('SaaS', [], { never: [...NEVER, 'extra'], globalPath, cwd: tmp }, makeIO())).rejects.toThrow(
      `term not added: never: at most ${documentedLimit} never words per term. Nothing was written`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses a merge that overflows an existing term\'s list, on a real run and a dry run', async () => {
    // Each incoming list is under the cap; only the merged result is over.
    // The read-back check on the final bytes is what refuses it.
    await addTerm({ canonical: 'SaaS', aliases: [], never: NEVER.slice(0, 40) }, { globalPath, cwd: tmp });
    const overflow = NEVER.slice(40).concat('extra'); // 25 more: 40 + 25 = 65
    for (const dryRun of [false, true]) {
      await expect(addTerm({ canonical: 'SaaS', aliases: [], never: overflow }, { globalPath, cwd: tmp, dryRun })).rejects.toThrow(
        `Refusing to write lexicon at ${globalPath}: Invalid lexicon:\n  - terms[0].never: at most ${documentedLimit} never words per term`,
      );
      // The refused write left the file as it was.
      const file = await readLexiconFile(globalPath, 'global');
      expect(file.lexicon.terms[0].never).toEqual(NEVER.slice(0, 40));
    }
  });

  it('dedupes never words case-insensitively before the write, while the file format counts duplicates', async () => {
    // 65 raw entries, one a case-variant of another: parseLexicon counts 65
    // and refuses; addTerm dedupes to 64 first and writes (first spelling wins).
    const entries = [...NEVER.slice(0, -1), 'GUARD63', 'guard63'];
    expect(entries).toHaveLength(documentedLimit + 1);
    expect(TermSchema.safeParse({ canonical: 'SaaS', never: entries }).success).toBe(false);

    const { term } = await addTerm({ canonical: 'SaaS', aliases: [], never: entries }, { globalPath, cwd: tmp });
    expect(term.never).toHaveLength(documentedLimit);
    expect(term.never).toContain('GUARD63');
    expect(term.never).not.toContain('guard63');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].never).toHaveLength(documentedLimit);
  });
});
