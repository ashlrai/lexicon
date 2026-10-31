import { describe, expect, it } from 'vitest';
import { DEFAULT_PACKS, loadPack, normalize } from '../src/core/index.js';

describe('legal starter pack', () => {
  it('ships 25 opt-in terms with required aliases and normalizes a legal sentence', async () => {
    const pack = await loadPack('legal');
    expect(pack.terms).toBe(25);
    expect(pack.aliases).toBe(50);
    expect(DEFAULT_PACKS).not.toContain('legal');
    expect(pack.lexicon.terms.find((term) => term.canonical === 'res ipsa loquitur')?.aliases)
      .toContain('res ipsa loquiter');
    expect(normalize('res ipsa loquiter under f r c p with quantum mer uit', pack.lexicon).output)
      .toBe('res ipsa loquitur under FRCP with quantum meruit');
  });

  it('protects ordinary prose and every explicit never word', async () => {
    const { lexicon } = await loadPack('legal');
    const prose = 'The editor and auditor met the tester and taster at the bank. The party will play its part.';
    expect(normalize(prose, lexicon)).toMatchObject({ output: prose, replacements: [] });
    const guarded = lexicon.terms.filter((term) => term.never?.length);
    expect(guarded).toHaveLength(4);
    for (const term of guarded) {
      for (const word of term.never ?? []) {
        expect(term.aliases).not.toContain(word);
        expect(normalize(word, lexicon)).toMatchObject({ output: word, replacements: [] });
      }
    }
  });
});
