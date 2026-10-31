import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/schema.js';

const readDoc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../docs/${name}`, import.meta.url)), 'utf8');

describe('schema limits reference', () => {
  it('agrees with the contract and schema constants for every limit', () => {
    const contract = readDoc('CONTRACT.md');
    const reference = readDoc('contract-limits-reference.md');
    const contractLimits = contract.split('\n').find((line) => line.startsWith('- `LIMITS`:'));
    expect(contractLimits).toBeDefined();
    expect(reference).toContain('[schema contract](CONTRACT.md#srccoreschemats)');

    const rows = [
      ['word', 'Unicode code points per value', 'Canonical spelling and each alias, `never` word, protected word and pack name'],
      ['text', 'Unicode code points per value', '`notes` and `phonetic`'],
      ['aliases', 'entries per list per term', 'The `aliases` and `never` lists, each counted separately'],
      ['terms', 'terms per lexicon file', 'The `terms` list in a global or project file'],
      ['protectedWords', 'entries per list', '`settings.protectedWords`'],
    ] as const;

    expect(rows.map(([name]) => name).sort()).toEqual(Object.keys(LIMITS).sort());
    for (const [name, unit, scope] of rows) {
      expect(contractLimits).toContain(`\`${name}\` ${LIMITS[name]}`);
      expect(reference).toContain(`| \`${name}\` | ${LIMITS[name]} ${unit} | ${scope} |`);
    }
    expect(reference).toContain(`\`settings.packs\`: ${LIMITS.aliases} entries per settings list`);
  });

  it('is linked from the documentation index', () => {
    expect(readDoc('README.md')).toContain('[contract-limits-reference.md](contract-limits-reference.md)');
  });
});
