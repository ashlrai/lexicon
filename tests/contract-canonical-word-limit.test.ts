/**
 * The canonical's length boundary of docs/CONTRACT.md's LIMITS paragraph:
 * `word`, 80, caps the canonical as well as each alias ("`word` 80
 * (canonical, alias)"). A canonical of exactly the documented limit is
 * accepted; one character over is refused as `must be at most 80
 * characters`. Every entry point is exercised: TermSchema, LexiconSchema and
 * parseLexicon (including from YAML text), the stale-global edit check
 * (checkLexiconEdit, which validates the items a hand edit touched), and the
 * CLI write path (runAdd, behind `lexicon add`).
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
const ONE_OVER = `${AT_LIMIT}a`;

describe('contract canonical word limit', () => {
  it('keeps the documented limit in step with the schema cap', () => {
    expect(documentedLimit).toBe(80);
    expect(documentedLimit).toBe(LIMITS.word);
    expect(AT_LIMIT).toHaveLength(80);
    expect(ONE_OVER).toHaveLength(documentedLimit + 1);
  });

  it('accepts a canonical at the documented limit and rejects one character over', () => {
    expect(TermSchema.parse({ canonical: AT_LIMIT }).canonical).toBe(AT_LIMIT);

    const result = TermSchema.safeParse({ canonical: ONE_OVER });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a canonical one over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
  });

  it('rejects one over the documented limit at the term path', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: ONE_OVER }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a canonical one over the documented limit to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path: ['terms', 0, 'canonical'], maximum: documentedLimit, message: `must be at most ${documentedLimit} characters` },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: ONE_OVER }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: must be at most ${documentedLimit} characters`,
    );
  });

  it('reports a later term\'s overflow at its own index', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Within' }, { canonical: ONE_OVER }] })).toThrow(
      `terms[1].canonical: must be at most ${documentedLimit} characters`,
    );
  });

  it('reads the boundary from YAML text', () => {
    // The real file path: YAML text into a document before the schema sees it.
    const yaml = (canonical: string) => ['version: 1', 'terms:', `  - canonical: ${canonical}`, ''].join('\n');
    expect(parseLexicon(parseYaml(yaml(AT_LIMIT))).terms[0].canonical).toBe(AT_LIMIT);
    expect(() => parseLexicon(parseYaml(yaml(ONE_OVER)))).toThrow(
      `terms[0].canonical: must be at most ${documentedLimit} characters`,
    );
  });

  it('names the edited term\'s line in the stale-global edit check', () => {
    // checkLexiconEdit validates only the items a hand edit touched; the same
    // schema cap applies there, named by the item's line in the whole file.
    const lines = ['version: 1', 'terms:'];
    for (let i = 0; i < 20; i += 1) lines.push(`  - canonical: Filler${i}word`);
    const before = `${lines.join('\n')}\n`;

    expect(checkLexiconEdit(before, `${before}  - canonical: ${AT_LIMIT}\n`)).toBeUndefined();
    expect(checkLexiconEdit(before, `${before}  - canonical: ${ONE_OVER}\n`)).toBe(
      `the term at line ${lines.length + 1}: canonical: must be at most ${documentedLimit} characters`,
    );
  });
});

describe('the same boundary through lexicon add', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-canonical-word-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes a canonical at the limit, and it reads back', async () => {
    expect(await runAdd(AT_LIMIT, ['at-limit'], { globalPath, cwd: tmp }, makeIO())).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].canonical).toBe(AT_LIMIT);
  });

  it('refuses one character over the limit and writes nothing', async () => {
    await expect(runAdd(ONE_OVER, ['over'], { globalPath, cwd: tmp }, makeIO())).rejects.toThrow(
      `term not added: canonical: must be at most ${documentedLimit} characters. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('still refuses on a dry run, before anything is written', async () => {
    await expect(runAdd(ONE_OVER, ['over'], { globalPath, cwd: tmp, dryRun: true }, makeIO())).rejects.toThrow(
      `term not added: canonical: must be at most ${documentedLimit} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });
});
