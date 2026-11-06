/**
 * The notes boundary of docs/CONTRACT.md's LIMITS paragraph (`text`, 200
 * characters) on the import write path: a CSV `notes` cell of exactly 200
 * characters is imported and read back whole; one over is refused by the same
 * schema rule `lexicon add --notes` hits, and nothing is written.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/core/schema.js';
import { readLexiconFile } from '../src/core/store.js';
import { runImport } from '../src/cli/cmd-import.js';
import { makeIO } from './helpers.js';

describe('notes limit through lexicon import (csv)', () => {
  let tmp: string;
  let globalPath: string;
  const prevPath = process.env.LEXICON_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-notes-import-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
    vi.stubEnv('LEXICON_PATH', globalPath);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (prevPath !== undefined) process.env.LEXICON_PATH = prevPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const csv = (notes: string) => `canonical,alias,notes\nBoundary Co,Boundry Co,${notes}\n`;
  const run = (notes: string) => runImport('terms.csv', { format: 'csv', cwd: tmp }, makeIO(), async () => csv(notes));

  it('imports a notes cell at the limit and reads it back whole', async () => {
    const atLimit = 'notes'.repeat(LIMITS.text / 5);
    expect(atLimit).toHaveLength(LIMITS.text);

    expect(await run(atLimit)).toBe(0);

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.find((t) => t.canonical === 'Boundary Co')?.notes).toBe(atLimit);
  });

  it('refuses a notes cell one character over and writes nothing', async () => {
    await expect(run('n'.repeat(LIMITS.text + 1))).rejects.toThrow(`notes: must be at most ${LIMITS.text} characters`);
    expect(existsSync(globalPath)).toBe(false);
  });
});
