import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const documented = Number(contract.match(/`word` (\d+) \(canonical, alias\)/)?.[1]);

/** A mixed canonical (spaces, dots, case, accents, digits) padded to exactly `length` code points. */
function canonicalOfLength(length: number): string {
  const base = 'Ashlr.AI Café Auth0 v2';
  return base + 'x'.repeat(length - [...base].length);
}

describe('canonical at the documented limit with realistic text', () => {
  it('uses the limit the contract documents', () => {
    expect(documented).toBe(LIMITS.word);
  });

  it('accepts a mixed-character canonical of exactly the limit and keeps it unchanged', () => {
    const canonical = canonicalOfLength(documented);
    expect([...canonical]).toHaveLength(documented);
    const lexicon = parseLexicon({ terms: [{ canonical, aliases: ['ashler'] }] });
    expect(lexicon.terms[0].canonical).toBe(canonical);
  });

  it('accepts one character under and rejects one over, naming the field and the limit', () => {
    expect(parseLexicon({ terms: [{ canonical: canonicalOfLength(documented - 1) }] }).terms).toHaveLength(1);
    expect(() => parseLexicon({ terms: [{ canonical: canonicalOfLength(documented + 1) }] })).toThrow(
      `terms[0].canonical: must be at most ${documented} characters`,
    );
  });
});
