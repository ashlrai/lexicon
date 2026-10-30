import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('non-English name benchmark contract', () => {
  const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const section = contract.split('## Non-English name benchmark (issue #8)')[1]?.split('\n## ')[0] ?? '';

  it('keeps issue #8 open for measurement before phonetics changes', () => {
    expect(section).toMatch(/\[Issue #8\]\(https:\/\/github\.com\/ashlrai\/lexicon\/issues\/8\) remains an open measurement\s+task/);
    expect(section).toMatch(/before choosing changes to the phonetics/);
    expect(section).toMatch(/phonetic pass uses English-tuned Double Metaphone/);
  });

  it('distinguishes synthetic comparisons from real-world accuracy', () => {
    expect(section).toMatch(/synthetic fixture supports repeatable matcher\s+comparisons/);
    expect(section).toMatch(/does not establish accuracy on representative real-world\s+non-English dictation/);
    expect(section).toMatch(/no real-world accuracy claim/);
    expect(section).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
  });
});
