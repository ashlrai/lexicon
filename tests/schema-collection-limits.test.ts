import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/schema.js';

const read = (file: string) => readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');

describe('schema collection limits reference', () => {
  it('is indexed and agrees with the contract and schema limits', () => {
    const reference = read('schema-collection-limits.md');
    const contract = read('CONTRACT.md');
    expect(read('README.md')).toContain('[schema-collection-limits.md](schema-collection-limits.md)');
    expect(reference).toContain('[schema contract](CONTRACT.md#srccoreschemats)');
    expect(reference).toContain(`| \`terms\` | ${LIMITS.terms} |`);
    expect(reference).toContain(`| \`aliases\` | ${LIMITS.aliases} |`);
    expect(reference).toContain(`| \`never\` | ${LIMITS.aliases} |`);
    expect(contract).toContain(`\`aliases\` ${LIMITS.aliases} (aliases and \`never\` per term), \`terms\` ${LIMITS.terms}`);
  });
});
