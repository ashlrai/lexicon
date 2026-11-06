import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-error-preview.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/<!-- preview-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)]
  .map((match): [string, string] => [match[1], match[2]]);

describe('schema error preview documentation', () => {
  it('pairs all examples with expected errors', () => {
    expect(examples).toHaveLength(3);
  });

  it.each(examples)('matches the parser for example %#', (yaml, expected) => {
    expect(() => parseLexicon(parseYaml(yaml))).toThrowError(expected);
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
