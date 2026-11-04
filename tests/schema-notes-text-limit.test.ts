/**
 * The notes text boundary of docs/CONTRACT.md's LIMITS paragraph: `text`,
 * 200 characters, caps a term's `notes` field (its sibling `phonetic` has its
 * own suite in schema-phonetic-text-limit.test.ts). A note of exactly 200 code
 * points is accepted; 201 is refused. The schema measures the cleaned value
 * (invisible characters stripped, ends trimmed), so a raw field over 200 can
 * land on the limit. The same number is enforced by two surfaces, and each is
 * exercised here: the schema itself (TermSchema, LexiconSchema and
 * parseLexicon) and the `lexicon add --notes` write path (runAdd on the real
 * store, the addTerm call MCP add_term and POST /add share).
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';
import { readLexiconFile } from '../src/core/store.js';
import { runAdd } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

const ZW = '\u200b'; // a zero-width space: stripped before the limit is measured

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('notes text length boundary', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`text` (\d+) \(notes, phonetic\)/);

  it('takes the limit from the contract: 200 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(200);
    expect(LIMITS.text).toBe(200);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['notes']],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'notes']],
  ] as const)('accepts notes at the limit and rejects one character over through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    for (const character of ['n', '🙂']) {
      const atLimit = character.repeat(limit);
      expect(schema.safeParse(wrap({ canonical: 'X', notes: atLimit })).success).toBe(true);

      const result = schema.safeParse(wrap({ canonical: 'X', notes: `${atLimit}${character}` }));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an overlong notes field to be rejected');
      expect(result.error.issues).toMatchObject([
        { code: 'too_big', path, maximum: limit, message: `must be at most ${limit} characters` },
      ]);
    }
  });

  it('measures the boundary after trimming and stripping invisible characters', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);

    expect(parseLexicon({ terms: [{ canonical: 'X', notes: `  ${atLimit}\u200b  ` }] }).terms[0].notes).toBe(atLimit);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${atLimit}n` }] })).toThrow(
      `terms[0].notes: must be at most ${limit} characters`,
    );
  });

  it('keeps a term whose notes is at the limit while a later term over it is refused', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);
    const raw = {
      terms: [
        { canonical: 'Within', notes: atLimit },
        { canonical: 'Over', notes: `${atLimit}n` },
      ],
    };

    expect(() => parseLexicon(raw)).toThrow(`terms[1].notes: must be at most ${limit} characters`);
  });

  it('passes validation on a fully populated term whose notes is at the limit', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);
    // Every optional field set: the cap is measured on `notes` alone, and the
    // term-level unencodable check and each sibling field's own rules still run.
    const term = {
      canonical: 'Boundary Co',
      aliases: ['Boundry Co', 'Boundary Company'],
      phonetic: 'BOWN-dree',
      category: 'brand',
      caseSensitive: true,
      scope: 'global',
      source: 'user',
      notes: atLimit,
      createdAt: '2026-11-04T00:00:00Z',
      hits: 12,
      never: ['Boundery Co'],
    };

    expect(TermSchema.parse(term)).toMatchObject({ ...term, notes: atLimit });
    expect(parseLexicon({ terms: [term] }).terms[0]).toMatchObject({ ...term, notes: atLimit });
  });

  it('accepts a hand-edited YAML term whose notes scalar is at the limit', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);
    const lexicon = parseLexicon(
      parseYaml(['version: 1', 'terms:', '  - canonical: Boundary Co', `    notes: ${atLimit}`, ''].join('\n')),
    );

    expect(lexicon.terms[0].notes).toBe(atLimit);
  });
});

describe('the same boundary through lexicon add --notes', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-notes-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = (notes: string) => ({ notes, globalPath, cwd: tmp });

  it('writes a notes at the limit verbatim, and it reads back', async () => {
    // A realistic note of exactly LIMITS.text characters: 'notes' x 40 = 200.
    const atLimit = 'notes'.repeat(LIMITS.text / 5);
    expect(atLimit).toHaveLength(LIMITS.text);

    const code = await runAdd('Boundary Co', [], opts(atLimit), makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'Boundary Co');
    expect(term?.notes).toBe(atLimit);
  });

  it('refuses a notes one character over and writes nothing', async () => {
    const overLimit = 'n'.repeat(LIMITS.text + 1);
    await expect(runAdd('Boundary Co', [], opts(overLimit), makeIO())).rejects.toThrow(
      `term not added: notes: must be at most ${LIMITS.text} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('writes a raw note that cleans to the limit without the invisible', async () => {
    const raw = `${'n'.repeat(100)}${ZW}${'n'.repeat(100)}`; // 201 units, 200 cleaned
    const code = await runAdd('Boundary Co', [], opts(raw), makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'Boundary Co');
    expect(term?.notes).toBe('n'.repeat(LIMITS.text));
  });
});
