/**
 * The `notes` length boundary of docs/CONTRACT.md's LIMITS paragraph (`text`,
 * 200 characters) on the surfaces a real file reaches.
 * schema-notes-text-limit.test.ts pins the boundary on the schema itself and
 * on `lexicon add --notes`; schema-notes-overlength.test.ts pins values
 * plainly past it. This file pins the same 200 where bytes on disk are
 * involved:
 *
 * - `readLexiconFile` refuses a hand-edited file whose notes is one over,
 *   naming the path, the field and the limit.
 * - `loadLexicon` skips an untrusted project `.lexicon.yaml` whose notes is
 *   over rather than letting it break the global lexicon (a hostile or broken
 *   repo file is the case the cap exists for), and throws on the same file
 *   once it is trusted.
 * - `addTerm` and `addTerms` refuse before a byte is written, and
 *   `writeLexiconFile`'s read-back check refuses an in-memory lexicon whose
 *   notes is over: every write surface lands on the same rule.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/schema.js';
import { addTerm, addTerms, loadLexicon, readLexiconFile, writeLexiconFile } from '../src/core/store.js';
import { trustProject } from '../src/core/trust.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The notes cap the contract publishes, read back out of its schema section
 * so a change to either side fails here. CONTRACT.md states it as
 * "`text` 200 (notes, phonetic)".
 */
const documentedLimit = (() => {
  const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0] ?? '';
  const match = section.match(/`text` (\d+) \(notes, phonetic\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the text limit for notes and phonetic');
  return Number(match[1]);
})();

let tmp: string;
let globalPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-notes-overflow-file-'));
  globalPath = path.join(tmp, 'lexicon.yaml');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const yamlFor = (notes: string) => `version: 1\nterms:\n  - canonical: Boundary Co\n    notes: ${notes}\n`;

describe('notes overflow in a lexicon file on disk', () => {
  it('keeps the documented limit in step with the schema cap', () => {
    expect(documentedLimit).toBe(200);
    expect(documentedLimit).toBe(LIMITS.text);
  });

  it('reads a notes at the limit back verbatim', async () => {
    const atLimit = 'n'.repeat(documentedLimit);
    await fs.writeFile(globalPath, yamlFor(atLimit));

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].notes).toBe(atLimit);
  });

  it('rejects a notes one over, naming the file, the field and the limit', async () => {
    await fs.writeFile(globalPath, yamlFor('n'.repeat(documentedLimit + 1)));

    const error = await readLexiconFile(globalPath, 'global').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(globalPath);
    expect(error!.message).toContain(`terms[0].notes: must be at most ${documentedLimit} characters`);
  });
});

describe('the same boundary through loadLexicon and the project trust gate', () => {
  const makeRepo = async (notes: string) => {
    const root = path.join(tmp, 'repo');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const projectPath = path.join(root, '.lexicon.yaml');
    await fs.writeFile(projectPath, yamlFor(notes));
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: GlobalTerm\n');
    return { root, projectPath };
  };

  it('skips an untrusted project file whose notes is over, keeping the global terms', async () => {
    const { root, projectPath } = await makeRepo('n'.repeat(documentedLimit + 1));

    const loaded = await loadLexicon({ cwd: root, globalPath });
    expect(loaded.projectTrust).toBe('untrusted');
    expect(loaded.project).toBeUndefined();
    expect(loaded.skippedProject?.path).toBe(projectPath);
    expect(loaded.skippedProject?.lexicon.terms).toEqual([]);
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['GlobalTerm']);

    // The skip is a trust behavior, not a swallow: asked to include the file
    // anyway, the same parse error surfaces.
    await expect(loadLexicon({ cwd: root, globalPath, includeUntrusted: true })).rejects.toThrow(
      `terms[0].notes: must be at most ${documentedLimit} characters`,
    );
  });

  it('throws on the same file once trusted, naming the notes path', async () => {
    const { root, projectPath } = await makeRepo('n'.repeat(documentedLimit + 1));
    await trustProject(projectPath, { globalPath });

    await expect(loadLexicon({ cwd: root, globalPath })).rejects.toThrow(
      `terms[0].notes: must be at most ${documentedLimit} characters`,
    );
  });

  it('merges a trusted project file whose notes is at the limit', async () => {
    const { root, projectPath } = await makeRepo('n'.repeat(documentedLimit));
    await trustProject(projectPath, { globalPath });

    const loaded = await loadLexicon({ cwd: root, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(expect.arrayContaining(['GlobalTerm', 'Boundary Co']));
    expect(loaded.merged.terms.find((t) => t.canonical === 'Boundary Co')?.notes).toBe('n'.repeat(documentedLimit));
  });
});

describe('the same boundary through the write path', () => {
  it('addTerm accepts a notes at the limit, and it reads back', async () => {
    const notes = 'n'.repeat(documentedLimit);
    const { term } = await addTerm({ canonical: 'Boundary Co', aliases: [], notes }, { globalPath, cwd: tmp });
    expect(term.notes).toBe(notes);
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms[0].notes).toBe(notes);
  });

  it.each([false, true])('addTerm refuses a notes one over and writes nothing (dryRun: %s)', async (dryRun) => {
    await expect(
      addTerm(
        { canonical: 'Boundary Co', aliases: [], notes: 'n'.repeat(documentedLimit + 1) },
        { globalPath, cwd: tmp, dryRun },
      ),
    ).rejects.toThrow(
      `term not added: notes: must be at most ${documentedLimit} characters. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('addTerms checks every term before it writes any', async () => {
    await expect(
      addTerms(
        [
          { canonical: 'Fine', aliases: [], notes: 'n'.repeat(documentedLimit) },
          { canonical: 'Over', aliases: [], notes: 'n'.repeat(documentedLimit + 1) },
        ],
        { globalPath, cwd: tmp },
      ),
    ).rejects.toThrow(`term not added: notes: must be at most ${documentedLimit} characters`);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('writeLexiconFile refuses an in-memory lexicon whose notes is over, through the read-back check', async () => {
    await expect(
      writeLexiconFile({
        path: globalPath,
        scope: 'global',
        exists: false,
        lexicon: { version: 1, terms: [{ canonical: 'Boundary Co', aliases: [], notes: 'n'.repeat(documentedLimit + 1) }] },
      }),
    ).rejects.toThrow(
      `Refusing to write lexicon at ${globalPath}: Invalid lexicon:\n  - terms[0].notes: must be at most ${documentedLimit} characters`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });
});
