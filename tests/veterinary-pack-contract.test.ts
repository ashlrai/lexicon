import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('proposed veterinary starter pack', () => {
  const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const outline = contract.split('### Proposed profession starter pack: veterinary medicine\n')[1]?.split('\n## ')[0] ?? '';

  it('distinguishes candidate terms from a shipped pack or observed aliases', () => {
    expect(outline).toMatch(/not an implemented or installable pack/);
    expect(outline).toMatch(/no\s+aliases are asserted here to be observed speech-to-text errors/);
    for (const term of ['pyometra', 'brachycephalic', 'leptospirosis', 'ovariohysterectomy']) {
      expect(outline).toContain(term);
    }
    const packs = new URL('../packs/', import.meta.url);
    const shipped = readdirSync(packs).filter((file) => file.endsWith('.yaml'))
      .map((file) => readFileSync(new URL(file, packs), 'utf8')).join('\n');
    expect(shipped).not.toMatch(/^(?:name|title|description):.*veterinar/im);
  });

  it('calls for evidence, held-out evaluation and false-positive checks before shipping', () => {
    expect(outline).toMatch(/consented,\s+de-identified dictation/);
    expect(outline).toMatch(/aliases only when supported by observed errors/);
    expect(outline).toMatch(/ordinary\s+English words as standalone aliases/);
    expect(outline).toMatch(/held-out evaluation separate from those used to choose aliases/);
    expect(outline).toMatch(/with and without the candidate pack/);
    expect(outline).toMatch(/corrected\s+errors, missed errors and unintended changes/);
    expect(outline).toMatch(/clean sentences and ordinary\s+speech containing confusable words/);
    expect(outline).toMatch(/validate its schema and safety, add pack tests/);
    expect(outline).toMatch(/does not change the current\s+pack list, defaults or installation behavior/);
  });
});
