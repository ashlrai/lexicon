/**
 * The alias-count boundary of docs/CONTRACT.md's LIMITS paragraph: `aliases`,
 * 64, caps each term's `aliases` list ("`aliases` 64 (aliases and `never` per
 * term)"), and docs/term-capacity-reference.md counts each list on its own. A
 * term with 64 aliases is accepted; 65 is refused as `at most 64 aliases per
 * term`. Every entry point is exercised: TermSchema, LexiconSchema,
 * parseLexicon (including from YAML text), the stale-global edit check
 * (checkLexiconEdit, which validates the items a hand edit touched), and the
 * write path behind `lexicon add`, MCP add_term and POST /add (addTerm/runAdd
 * on the real store), including the merge that overflows an existing term's
 * list and the cleanup the write path applies before the file format counts.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LexiconSchema, LIMITS, TermSchema, parseLexicon } from '../src/core/schema.js';
import { checkLexiconEdit } from '../src/core/edit-check.js';
import { addTerm, readLexiconFile } from '../src/core/store.js';
import { runAdd } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

const ZW = '\u200b'; // a zero-width space: stripped before the entry is counted

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const capacity = readFileSync(new URL('../docs/term-capacity-reference.md', import.meta.url), 'utf8');

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
    // docs/term-capacity-reference.md publishes the same row and guidance.
    expect(capacity).toContain(`| Aliases per term | ${documentedLimit} | \`aliases\` |`);
    expect(capacity).toContain(`A term with ${documentedLimit} aliases of ${LIMITS.word} characters each is valid`);
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

  it('counts the alias list separately from the never and context lists', () => {
    // "aliases and never per term" is a cap on each list, not a shared pool:
    // docs/term-capacity-reference.md counts `context` on the same limit too.
    const never = Array.from({ length: documentedLimit }, (_, i) => `guard${i}`);
    const context = Array.from({ length: documentedLimit }, (_, i) => `scope${i}`);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: ALIASES, never, context }] }).terms[0]).toMatchObject({
      aliases: ALIASES,
      never,
      context,
    });

    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: [...ALIASES, 'extra'], never, context }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the alias list over the limit to be rejected even with never and context at the limit');
    expect(result.error.issues).toMatchObject([{ path: ['terms', 0, 'aliases'], maximum: documentedLimit }]);
  });

  it('drops blank entries before counting, but still counts duplicates', () => {
    // docs/term-capacity-reference.md: "Empty list entries are dropped before
    // counting; duplicates still count."
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [...ALIASES, '  '] }] }).terms[0].aliases).toEqual(ALIASES);
    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [...ALIASES, ZW] }] }).terms[0].aliases).toEqual(ALIASES);

    // 65 entries where the extra duplicates an earlier one are still 65 entries.
    expect(TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES, 'alias0'] }).success).toBe(false);

    // A null entry is never silently dropped: it is an error in its own right.
    const withNull = TermSchema.safeParse({ canonical: 'X', aliases: [...ALIASES.slice(0, -1), null] });
    expect(withNull.success).toBe(false);
    if (withNull.success) throw new Error('Expected a null alias entry to be rejected');
    expect(withNull.error.issues).toMatchObject([{ code: 'invalid_type', path: ['aliases', documentedLimit - 1] }]);
  });

  it('reports a later term\'s overflow at its own index', () => {
    const raw = {
      terms: [
        { canonical: 'Within', aliases: ALIASES },
        { canonical: 'Over', aliases: [...ALIASES, 'extra'] },
      ],
    };
    expect(() => parseLexicon(raw)).toThrow(`terms[1].aliases: at most ${documentedLimit} aliases per term`);
  });

  it('applies the same boundary in the stale-global edit check', () => {
    // checkLexiconEdit validates only the items a hand edit touched; the same
    // schema cap applies there, named by the item's line in the whole file.
    const lines = ['version: 1', 'terms:'];
    for (let i = 0; i < 20; i += 1) lines.push(`  - canonical: Filler${i}word`);
    const before = `${lines.join('\n')}\n`;
    const appended = (aliases: readonly string[]) =>
      `${before}  - canonical: Appended\n    aliases:\n${aliases.map((a) => `      - ${a}\n`).join('')}`;

    expect(checkLexiconEdit(before, appended(ALIASES))).toBeUndefined();
    expect(checkLexiconEdit(before, appended([...ALIASES, 'extra']))).toBe(
      `the term at line ${lines.length + 1}: aliases: at most ${documentedLimit} aliases per term`,
    );
  });

  it('applies the same boundary to aliases a hand edit adds inside an existing item', () => {
    const item = (aliases: readonly string[]) =>
      ['version: 1', 'terms:', '  - canonical: Existing', '    aliases:', ...aliases.map((a) => `      - ${a}`), ''].join('\n');
    const have = ALIASES.slice(0, -1);
    const before = item(have);
    expect(checkLexiconEdit(before, item([...have, `alias${documentedLimit - 1}`]))).toBeUndefined();
    expect(checkLexiconEdit(before, item([...have, `alias${documentedLimit - 1}`, 'extra']))).toBe(
      `the term at line 3: aliases: at most ${documentedLimit} aliases per term`,
    );
  });
});

describe('the same boundary through the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-alias-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes a term at the limit through lexicon add, and it reads back', async () => {
    const code = await runAdd('Zephyr', ALIASES, { globalPath, cwd: tmp }, makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'Zephyr');
    expect(term?.aliases).toEqual(ALIASES);
  });

  it('refuses one alias over the limit and writes nothing', async () => {
    await expect(runAdd('Zephyr', [...ALIASES, 'extra'], { globalPath, cwd: tmp }, makeIO())).rejects.toThrow(
      `term not added: aliases: at most ${documentedLimit} aliases per term. Nothing was written`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('still refuses on a dry run, before anything is written', async () => {
    await expect(runAdd('Zephyr', [...ALIASES, 'extra'], { globalPath, cwd: tmp, dryRun: true }, makeIO())).rejects.toThrow(
      `term not added: aliases: at most ${documentedLimit} aliases per term`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses a merge that overflows an existing term\'s list, on a real run and a dry run', async () => {
    // Each incoming list is under the cap; only the merged result is over.
    // The read-back check on the final bytes is what refuses it.
    await addTerm({ canonical: 'Zephyr', aliases: ALIASES.slice(0, 40) }, { globalPath, cwd: tmp });
    const overflow = ALIASES.slice(40).concat('extra'); // 25 more: 40 + 25 = 65
    for (const dryRun of [false, true]) {
      await expect(addTerm({ canonical: 'Zephyr', aliases: overflow }, { globalPath, cwd: tmp, dryRun })).rejects.toThrow(
        `Refusing to write lexicon at ${globalPath}: Invalid lexicon:\n  - terms[0].aliases: at most ${documentedLimit} aliases per term`,
      );
      // The refused write left the file as it was.
      const file = await readLexiconFile(globalPath, 'global');
      expect(file.lexicon.terms[0].aliases).toEqual(ALIASES.slice(0, 40));
    }
  });

  it('refuses a blank entry outright, where the file format would drop it before counting', async () => {
    // The schema drops a blank entry before the count (the file form of this
    // term is valid, shown above), but the write path refuses one: it would
    // vanish on the next read while the command answered success.
    await expect(runAdd('Zephyr', [...ALIASES, '  '], { globalPath, cwd: tmp }, makeIO())).rejects.toThrow(
      `term not added: aliases[${documentedLimit}] ("  ") is blank. Nothing was written; drop that entry or give the word and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('dedupes aliases case-insensitively before the write, while the file format counts duplicates', async () => {
    // 65 raw entries, one a case-variant of another: parseLexicon counts 65
    // and refuses; addTerm dedupes to 64 first and writes (first spelling wins).
    const entries = [...ALIASES.slice(0, -1), 'ALIAS63', 'alias63'];
    expect(entries).toHaveLength(documentedLimit + 1);
    expect(TermSchema.safeParse({ canonical: 'Zephyr', aliases: entries }).success).toBe(false);

    const { term } = await addTerm({ canonical: 'Zephyr', aliases: entries }, { globalPath, cwd: tmp });
    expect(term.aliases).toHaveLength(documentedLimit);
    expect(term.aliases).toContain('ALIAS63');
    expect(term.aliases).not.toContain('alias63');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].aliases).toHaveLength(documentedLimit);
  });

  it('drops an alias that spells the canonical before the count, and the CLI says so', async () => {
    // dedupeAliases removes an alias that folds to the canonical (matching
    // ignores case), so 64 real aliases plus "zephyr" under "Zephyr" writes
    // 64. The file format does not drop it: a hand-written entry like this is
    // still a 65th alias.
    expect(TermSchema.safeParse({ canonical: 'Zephyr', aliases: [...ALIASES, 'zephyr'] }).success).toBe(false);

    const io = makeIO();
    const code = await runAdd('Zephyr', [...ALIASES, 'zephyr'], { globalPath, cwd: tmp }, io);
    expect(code).toBe(0);
    expect(io.out).toContain('note: zephyr was not added as an alias of Zephyr: it differs from the canonical only in case');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].aliases).toEqual(ALIASES);
  });
});
