import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { findUnencodableChar, parseLexicon } from '../src/core/schema.js';

describe('first invalid code unit documentation', () => {
  const doc = readFileSync(new URL('../docs/schema-first-invalid-unit.md', import.meta.url), 'utf8');
  const examples = [...doc.matchAll(/<!-- first-unit-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)];

  it('matches the documented YAML and complete error', () => {
    expect(examples).toHaveLength(1);
    let message: string | undefined;
    try {
      parseLexicon(parseYaml(examples[0][1]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(examples[0][2]);
  });

  it.each([
    ['\uFFFF\uFFFE', 'U+FFFF'],
    ['\uFFFE\uFFFF', 'U+FFFE'],
    ['\uD800x\uDC00', 'U+D800'],
    ['\uDC00x\uD800', 'U+DC00'],
    ['\uD800\uD83D\uDE80\uFFFF', 'U+D800'],
    ['\uD83D\uDE80\uDC00\uFFFF', 'U+DC00'],
    ['\uD83D\uDE80', undefined],
  ])('finds the first invalid unit in %j', (input, expected) => {
    expect(findUnencodableChar(input)).toBe(expected);
  });
});
