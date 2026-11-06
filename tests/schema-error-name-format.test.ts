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

  it('shows each term name at its own 40-character cutoff in a multi-term error', () => {
    const short = 'Short name';
    const atLimit = 'A'.repeat(39) + 'B';
    const long = 'C'.repeat(39) + 'DE';
    expect(errorMessage({ terms: [
      { canonical: short, aliases: ['\uFFFF'] },
      { canonical: atLimit, notes: '\uFFFE' },
      { canonical: long, never: ['\uD800'] },
    ] })).toBe([
      'Invalid lexicon:',
      `  - terms[0].aliases[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${short}"`,
      `  - terms[1].notes: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${atLimit}"`,
      `  - terms[2].never[0]: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${'C'.repeat(39)}…"`,
    ].join('\n'));
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
