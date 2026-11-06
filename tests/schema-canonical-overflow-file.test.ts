import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/schema.js';
import { readLexiconFile } from '../src/core/store.js';

// The documented limit (docs/CONTRACT.md, `LIMITS.word`) applies to a lexicon
// file on disk too, not only to parsed objects: one character over is refused.
describe('canonical overflow in a lexicon YAML file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lexicon-canonical-overflow-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readWith(canonical: string) {
    const file = path.join(dir, 'lexicon.yaml');
    await writeFile(file, `terms:\n  - canonical: ${canonical}\n`, 'utf8');
    return readLexiconFile(file, 'global');
  }

  it('reads a canonical at the limit', async () => {
    const at = 'a'.repeat(LIMITS.word);
    expect((await readWith(at)).lexicon.terms[0]?.canonical).toBe(at);
  });

  it('rejects a canonical one character over the limit, naming the field and the limit', async () => {
    await expect(readWith('a'.repeat(LIMITS.word + 1))).rejects.toThrow(
      `terms[0].canonical: must be at most ${LIMITS.word} characters`,
    );
  });
});
