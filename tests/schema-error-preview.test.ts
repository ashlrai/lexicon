import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-error-preview.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/<!-- preview-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)]
  .map((match): [string, string] => [match[1], match[2]]);

function errorMessage(raw: unknown): string {
  try {
    parseLexicon(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected invalid input to be rejected');
}

describe('schema error preview documentation', () => {
  it('pairs all examples with expected errors', () => {
    expect(examples).toHaveLength(3);
  });

  it.each(examples)('matches the complete parser error for example %#', (yaml, expected) => {
    expect(errorMessage(parseYaml(yaml))).toBe(expected);
  });

  it('replaces the folded preview reference and name format pages', () => {
    for (const page of ['schema-error-preview-reference.md', 'schema-error-name-format.md']) {
      expect(existsSync(new URL(`../docs/${page}`, import.meta.url))).toBe(false);
    }
    expect(doc).toContain('`showTermName` and `refuseUnencodable`');
    expect(doc).toContain('The preview is\nalways the canonical name, even when a different field failed.');
    expect(doc).toMatch(/not bytes,\nUnicode code points or graphemes/);
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

  it.each([
    { code: 'FFFE', canonical: '  \u200bAcme\uFFFE😀\uFFFE  ', preview: 'Acme\\uFFFE😀\\uFFFE' },
    { code: 'FFFF', canonical: '  \u200bAcme\uFFFF😀\uFFFF  ', preview: 'Acme\\uFFFF😀\\uFFFF' },
  ])('renders every U+$code in the term name in each error', ({ code, canonical, preview }) => {
    let error: unknown;
    try {
      parseLexicon({ terms: [{ canonical, aliases: ['bad\uD800'] }] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Invalid lexicon:\n` +
      `  - terms[0].canonical: must not contain U+${code} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${preview}"\n` +
      `  - terms[0].aliases[0]: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "${preview}"`,
    );
  });

  it('leaves valid surrogate pairs intact and cleans the canonical before previewing it', () => {
    expect(() => parseLexicon({ terms: [{ canonical: '  \u200bAcme😀  ', notes: '\uDC00' }] }))
      .toThrowError('in term "Acme😀"');
  });
});
