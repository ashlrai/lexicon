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

  it('leaves valid surrogate pairs intact and cleans the canonical before previewing it', () => {
    expect(() => parseLexicon({ terms: [{ canonical: '  \u200bAcme😀  ', notes: '\uDC00' }] }))
      .toThrowError('in term "Acme😀"');
  });
});
