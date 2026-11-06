/**
 * The alias's length boundary of docs/CONTRACT.md's LIMITS paragraph:
 * `word`, 80, caps each alias as well as the canonical ("`word` 80
 * (canonical, alias)"). An alias of exactly the documented limit is
 * accepted and kept verbatim; one character over is refused as `must be
 * at most 80 characters` at the entry's index. Every entry point is
 * exercised: TermSchema, LexiconSchema and parseLexicon (including from
 * YAML text), the stale-global edit check (checkLexiconEdit, which
 * validates the items a hand edit touched), and the CLI write path
 * (runAdd, behind `lexicon add`), with the written file read back.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';
import { checkLexiconEdit } from '../src/core/edit-check.js';
import { readLexiconFile } from '../src/core/store.js';
import { runAdd } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The alias word cap the contract publishes, read back out of the doc so
 * a change to either side fails here. CONTRACT.md states it inside the
 * src/core/schema.ts section as "`word` 80 (canonical, alias)".
 */
const documentedLimit = (() => {
  const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = section?.match(/`word` (\d+) \(canonical, alias\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the alias word limit');
  return Number(match[1]);
})();

const AT_LIMIT = 'a'.repeat(documentedLimit);
const ONE_OVER = `${AT_LIMIT}a`;

describe('contract alias word limit', () => {
  it('keeps the documented limit in step with the schema cap', () => {
    expect(documentedLimit).toBe(80);
    expect(documentedLimit).toBe(LIMITS.word);
    expect(AT_LIMIT).toHaveLength(80);
    expect(ONE_OVER).toHaveLength(documentedLimit + 1);
  });

  it('accepts an alias at the documented limit through every entry point', () => {
    const term = { canonical: 'X', aliases: [AT_LIMIT] };
    expect(TermSchema.parse(term).aliases).toEqual([AT_LIMIT]);
    expect(LexiconSchema.parse({ terms: [term] }).terms[0].aliases).toEqual([AT_LIMIT]);
    expect(parseLexicon({ terms: [term] }).terms[0].aliases).toEqual([AT_LIMIT]);
  });

  it('rejects one character over at the alias index', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: ['ok', ONE_OVER] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an alias one over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'aliases', 1], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: ['ok', ONE_OVER] }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases[1]: must be at most ${documentedLimit} characters`,
    );
  });

  it('reports each over-limit alias at its own index', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'X', aliases: ['ok', ONE_OVER, 'fine', ONE_OVER] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the over-limit aliases to be rejected');
    expect(result.error.issues.map((i) => i.path)).toEqual([
      ['terms', 0, 'aliases', 1],
      ['terms', 0, 'aliases', 3],
    ]);
  });

  it('reads the boundary from YAML text', () => {
    // The real file path: YAML text into a document before the schema sees it.
    const yaml = (alias: string) => ['version: 1', 'terms:', '  - canonical: X', '    aliases:', `      - ${alias}`, ''].join('\n');
    expect(parseLexicon(parseYaml(yaml(AT_LIMIT))).terms[0].aliases).toEqual([AT_LIMIT]);
    expect(() => parseLexicon(parseYaml(yaml(ONE_OVER)))).toThrow(
      `terms[0].aliases[0]: must be at most ${documentedLimit} characters`,
    );
  });

  it('names the edited term\'s line in the stale-global edit check', () => {
    // checkLexiconEdit validates only the items a hand edit touched; the same
    // schema cap applies there, named by the item's line in the whole file.
    const lines = ['version: 1', 'terms:'];
    for (let i = 0; i < 20; i += 1) lines.push(`  - canonical: Filler${i}word`);
    const before = `${lines.join('\n')}\n`;
    const appended = (alias: string) => `${before}  - canonical: Appended\n    aliases:\n      - ${alias}\n`;

    expect(checkLexiconEdit(before, appended(AT_LIMIT))).toBeUndefined();
    expect(checkLexiconEdit(before, appended(ONE_OVER))).toBe(
      `the term at line ${lines.length + 1}: aliases[0]: must be at most ${documentedLimit} characters`,
    );
  });

  it('applies the same boundary to an alias a hand edit adds inside an existing item', () => {
    const before = 'version: 1\nterms:\n  - canonical: Existing\n    aliases:\n      - short\n';
    const after = (alias: string) => `${before}      - ${alias}\n`;

    expect(checkLexiconEdit(before, after(AT_LIMIT))).toBeUndefined();
    expect(checkLexiconEdit(before, after(ONE_OVER))).toBe(
      `the term at line 3: aliases[1]: must be at most ${documentedLimit} characters`,
    );
  });

  it('counts characters, not UTF-16 code units, at the boundary', () => {
    // A supplementary-plane character is one character a person counts but
    // two UTF-16 code units; `word` 80 in the contract means the former.
    const at = '\u{1F680}'.repeat(documentedLimit);
    const over = '\u{1F680}'.repeat(documentedLimit + 1);
    expect(at).toHaveLength(documentedLimit * 2);
    expect([...at]).toHaveLength(documentedLimit);

    expect(parseLexicon({ terms: [{ canonical: 'X', aliases: [at] }] }).terms[0].aliases).toEqual([at]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [over] }] })).toThrow(
      `terms[0].aliases[0]: must be at most ${documentedLimit} characters`,
    );
  });

  it.each([
    ['never', (doc: string) => ({ terms: [{ canonical: 'X', never: [doc] }] }), ['terms', 0, 'never', 0]],
    ['context', (doc: string) => ({ terms: [{ canonical: 'X', context: [doc] }] }), ['terms', 0, 'context', 0]],
    ['settings.protectedWords', (doc: string) => ({ settings: { protectedWords: [doc] } }), ['settings', 'protectedWords', 0]],
    ['settings.packs', (doc: string) => ({ settings: { packs: [doc] } }), ['settings', 'packs', 0]],
  ] as const)('caps every word-list entry the same way: %s', (_name, wrap, path) => {
    expect(LexiconSchema.safeParse(wrap(AT_LIMIT)).success).toBe(true);

    const result = LexiconSchema.safeParse(wrap(ONE_OVER));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an entry one over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path, maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });
});

describe('the same boundary through lexicon add', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-alias-word-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes an alias at the limit, and it reads back verbatim', async () => {
    expect(await runAdd('QuasarCanon', [AT_LIMIT], { globalPath, cwd: tmp }, makeIO())).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0]).toMatchObject({ canonical: 'QuasarCanon', aliases: [AT_LIMIT] });
  });

  it('refuses an alias one over the limit, naming the entry, and writes nothing', async () => {
    await expect(runAdd('QuasarCanon', ['fine', ONE_OVER], { globalPath, cwd: tmp }, makeIO())).rejects.toThrow(
      `term not added: aliases[1] ("${'a'.repeat(24)}..."): must be at most ${documentedLimit} characters. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('still refuses on a dry run, before anything is written', async () => {
    await expect(runAdd('QuasarCanon', [ONE_OVER], { globalPath, cwd: tmp, dryRun: true }, makeIO())).rejects.toThrow(
      `term not added: aliases[0] ("${'a'.repeat(24)}..."): must be at most ${documentedLimit} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });
});
