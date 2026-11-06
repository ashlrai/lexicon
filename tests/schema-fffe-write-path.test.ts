/**
 * docs/CONTRACT.md: a U+FFFE in any term field is refused by `addTerm` and
 * `addTerms` as `term not added: <field> (...): must not contain U+FFFE ...`,
 * the diagnostic names the code unit, escapes it rather than echoing it, and
 * nothing is written.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNENCODABLE_NOTE } from '../src/core/schema.js';
import { addTerm, addTerms } from '../src/core/store.js';
import type { Term } from '../src/core/types.js';

const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

describe('U+FFFE on the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-fffe-write-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  it.each<[string, Term, string]>([
    ['an alias', { canonical: 'Ashlr.AI', aliases: ['Ash￾ler'] }, 'aliases[0]'],
    ['a never word', { canonical: 'Ashlr.AI', aliases: [], never: ['n￾o'] }, 'never[0]'],
    ['phonetic', { canonical: 'Ashlr.AI', aliases: [], phonetic: 'ash￾ler' }, 'phonetic'],
    ['notes', { canonical: 'Ashlr.AI', aliases: [], notes: 'a￾b' }, 'notes'],
  ])('refuses U+FFFE in %s, names the code unit and the term, and writes nothing', async (_what, term, field) => {
    let message = '';
    try {
      await addTerm(term, opts());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`term not added: ${field}`);
    expect(message).toContain(`${reason} in term "Ashlr.AI"`);
    expect(message).toContain('Nothing was written');
    expect(message).not.toContain('￾');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('escapes U+FFFE in the canonical used as the term label', async () => {
    await expect(addTerm({ canonical: 'Ash￾lr', aliases: [] }, opts())).rejects.toThrow(
      `${reason} in term "Ash\\uFFFElr"`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses the whole addTerms batch and leaves an existing file untouched', async () => {
    await addTerm({ canonical: 'Existing', aliases: [] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(
      addTerms([{ canonical: 'Fine', aliases: [] }, { canonical: 'Bad', aliases: ['x￾y'] }], opts()),
    ).rejects.toThrow(`${reason} in term "Bad"`);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });
});
