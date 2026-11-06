/**
 * The phonetic text boundary of docs/CONTRACT.md's LIMITS paragraph: `text`,
 * 200 characters, caps a term's `phonetic` hint (its sibling `notes` has its
 * own suite in schema-notes-text-limit.test.ts). A hint of exactly 200 code
 * points is accepted; 201 is refused. The schema measures the cleaned value
 * (invisible characters stripped, ends trimmed), so a raw field over 200 can
 * land on the limit. The same number is enforced by three surfaces, and each
 * is exercised here: the schema itself (TermSchema, LexiconSchema and
 * parseLexicon), the setup pre-check `setupHintProblem` that refuses a bad
 * `--phonetic` before any step runs, and the `lexicon add --phonetic` write
 * path (runAdd on the real store).
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';
import { addTerm, addTerms, readLexiconFile } from '../src/core/store.js';
import { runAdd } from '../src/cli/commands.js';
import { setupHintProblem } from '../src/cli/setup/detect.js';
import { makeIO } from './helpers.js';

const ZW = '\u200b'; // a zero-width space: stripped before the limit is measured

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('phonetic text length boundary', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`text` (\d+) \(notes, phonetic\)/);

  it('takes the limit from the contract: 200 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(200);
    expect(LIMITS.text).toBe(200);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['phonetic']],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'phonetic']],
  ] as const)('accepts a phonetic at the limit and rejects one character over through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    for (const character of ['p', '𠮷']) {
      const atLimit = character.repeat(limit);
      expect(schema.safeParse(wrap({ canonical: 'X', phonetic: atLimit })).success).toBe(true);

      const result = schema.safeParse(wrap({ canonical: 'X', phonetic: `${atLimit}${character}` }));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an overlong phonetic field to be rejected');
      expect(result.error.issues).toMatchObject([
        { code: 'too_big', path, maximum: limit, message: `must be at most ${limit} characters` },
      ]);
    }
  });

  it('reads a phonetic at the limit back verbatim, and counts code points not code units', () => {
    const limit = Number(match![1]);
    // A supplementary-plane hint of 200 characters takes 400 UTF-16 code
    // units on the wire and still passes: the cap is the character count.
    const emoji = '🙂'.repeat(limit);
    expect(emoji).toHaveLength(limit * 2);
    const lex = parseLexicon({ terms: [{ canonical: 'X', phonetic: emoji }] });
    expect(lex.terms[0].phonetic).toBe(emoji);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `${emoji}🙂` }] })).toThrow(
      `terms[0].phonetic: must be at most ${limit} characters`,
    );
  });

  it('measures the boundary after trimming and stripping invisible characters', () => {
    const limit = Number(match![1]);
    const atLimit = 'p'.repeat(limit);

    // 201 code units on the wire, at the limit once the zero-width space is gone.
    const raw = `${'p'.repeat(100)}${ZW}${'p'.repeat(100)}`;
    expect(Array.from(raw)).toHaveLength(limit + 1);
    expect(parseLexicon({ terms: [{ canonical: 'X', phonetic: raw }] }).terms[0].phonetic).toBe(atLimit);
    expect(parseLexicon({ terms: [{ canonical: 'X', phonetic: `  ${atLimit}  ` }] }).terms[0].phonetic).toBe(atLimit);

    // Stripping does not rescue a hint that stays over the limit without it.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `${atLimit}${ZW}p` }] })).toThrow(
      `terms[0].phonetic: must be at most ${limit} characters`,
    );
  });

  it('keeps a term whose phonetic is at the limit while a later term over it is refused', () => {
    const limit = Number(match![1]);
    const atLimit = 'p'.repeat(limit);
    const raw = {
      terms: [
        { canonical: 'Within', phonetic: atLimit },
        { canonical: 'Over', phonetic: `${atLimit}p` },
      ],
    };

    expect(() => parseLexicon(raw)).toThrow(`terms[1].phonetic: must be at most ${limit} characters`);
  });

  it('enforces the same boundary in the setup pre-check, before any step runs', () => {
    // setupHintProblem is the only enforcement of this limit outside the
    // schema: --phonetic and the interactive hint prompt go through it first.
    const limit = Number(match![1]);
    const atLimit = 'p'.repeat(limit);

    expect(setupHintProblem(atLimit)).toBeUndefined();
    expect(setupHintProblem(`  ${atLimit}${ZW}  `)).toBeUndefined();
    expect(setupHintProblem(`${atLimit}p`)).toBe(`must be at most ${limit} characters (it has ${limit + 1})`);
    expect(setupHintProblem(`${atLimit}${ZW}p`)).toBe(`must be at most ${limit} characters (it has ${limit + 1})`);
  });
});

describe('the same boundary through lexicon add --phonetic', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-phonetic-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = (phonetic: string) => ({ phonetic, globalPath, cwd: tmp });

  it('writes a phonetic at the limit verbatim, and it reads back', async () => {
    // A realistic hint of exactly LIMITS.text characters: 'ASH-' x 50 = 200.
    const atLimit = 'ASH-'.repeat(LIMITS.text / 4);
    expect(atLimit).toHaveLength(LIMITS.text);

    const code = await runAdd('Boundary Co', [], opts(atLimit), makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'Boundary Co');
    expect(term?.phonetic).toBe(atLimit);
  });

  it('refuses a phonetic one character over and writes nothing', async () => {
    const overLimit = 'p'.repeat(LIMITS.text + 1);
    await expect(runAdd('Boundary Co', [], opts(overLimit), makeIO())).rejects.toThrow(
      `term not added: phonetic: must be at most ${LIMITS.text} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('writes a raw hint that cleans to the limit without the invisible', async () => {
    const raw = `${'p'.repeat(100)}${ZW}${'p'.repeat(100)}`; // 201 units, 200 cleaned
    const code = await runAdd('Boundary Co', [], opts(raw), makeIO());
    expect(code).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    const term = file.lexicon.terms.find((t) => t.canonical === 'Boundary Co');
    expect(term?.phonetic).toBe('p'.repeat(LIMITS.text));
  });

  it('names the file, the field and the limit when a lexicon on disk has a phonetic one over', async () => {
    const bad = path.join(tmp, 'bad.yaml');
    await fs.writeFile(bad, `terms:\n  - canonical: Ashlr.AI\n    phonetic: ${'p'.repeat(LIMITS.text + 1)}\n`);

    const error = await readLexiconFile(bad, 'global').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(bad);
    expect(error!.message).toContain(`terms[0].phonetic: must be at most ${LIMITS.text} characters`);
  });

  it('reads a hand-edited YAML hint at the documented limit and rejects one character more', async () => {
    const match = contract.match(/`text` (\d+) \(notes, phonetic\)/);
    expect(match).not.toBeNull();
    const limit = Number(match![1]);
    const phonetic = `${'ash-'.repeat((limit - 4) / 4)}🙂abc`;
    expect(Array.from(phonetic)).toHaveLength(limit);
    const yaml = (value: string) => `terms:\n  - canonical: Boundary Co\n    phonetic: "${value}"\n`;

    await fs.writeFile(globalPath, yaml(phonetic));
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms[0].phonetic).toBe(phonetic);

    await fs.writeFile(globalPath, yaml(`${phonetic}x`));
    await expect(readLexiconFile(globalPath, 'global')).rejects.toThrow(
      `terms[0].phonetic: must be at most ${limit} characters`,
    );
  });
});

describe('the same boundary through the core addTerm and addTerms', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-phonetic-limit-core-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('addTerm refuses a phonetic one over with the documented message and writes nothing', async () => {
    const term = { canonical: 'Boundary Co', aliases: [], phonetic: 'p'.repeat(LIMITS.text + 1) };
    await expect(addTerm(term, { globalPath, cwd: tmp })).rejects.toThrow(
      `term not added: phonetic: must be at most ${LIMITS.text} characters. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('addTerm accepts a phonetic at the limit', async () => {
    const phonetic = 'p'.repeat(LIMITS.text);
    const { term } = await addTerm({ canonical: 'Boundary Co', aliases: [], phonetic }, { globalPath, cwd: tmp });
    expect(term.phonetic).toBe(phonetic);
  });

  it('addTerms checks every term before it writes any', async () => {
    const terms = [
      { canonical: 'Fine', aliases: [], phonetic: 'p'.repeat(LIMITS.text) },
      { canonical: 'Over', aliases: [], phonetic: 'p'.repeat(LIMITS.text + 1) },
    ];
    await expect(addTerms(terms, { globalPath, cwd: tmp })).rejects.toThrow(
      `term not added: phonetic: must be at most ${LIMITS.text} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });
});
