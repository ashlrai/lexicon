import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-error-name-format.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/<!-- name-format-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)];

function errorMessage(raw: unknown): string {
  try {
    parseLexicon(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected invalid input to be rejected');
}

describe('schema error name format', () => {
  it('matches the complete documented parser error', () => {
    expect(examples).toHaveLength(1);
    expect(errorMessage(parseYaml(examples[0][1]))).toBe(examples[0][2]);
  });

  it.each([
    [34, 'A'.repeat(34) + '\\uFFFF'],
    [35, 'A'.repeat(35) + '\\uFF…'],
  ])('escapes before applying the boundary for %i leading units', (count, label) => {
    expect(errorMessage({ terms: [{ canonical: 'A'.repeat(count) + '\uFFFF' }] }))
      .toContain(`in term "${label}"`);
  });

  it('uses the cleaned canonical as the name for another invalid field', () => {
    const message = errorMessage({ terms: [{ canonical: '  \u200bAcme\uFFFE🚀  ', notes: 'bad\uDC00' }] });
    expect(message).toContain('terms[0].notes: must not contain U+DC00');
    expect(message).toContain('in term "Acme\\uFFFE🚀"');
  });
});
