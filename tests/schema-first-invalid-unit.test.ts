import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { findUnencodableChar, LexiconSchema, parseLexicon } from '../src/core/schema.js';

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

  it.each([
    ['ASCII before noncharacters', 'Hello\uFFFF then \uFFFE', 'U+FFFF'],
    ['BMP text before a high surrogate', 'Café 東京\uDBFFx\uFFFE', 'U+DBFF'],
    ['a valid pair before a low surrogate', 'Rocket 🚀\uDFFF then \uD800', 'U+DFFF'],
    ['a valid pair before a noncharacter', 'Rocket 🚀\uFFFE then \uFFFF', 'U+FFFE'],
    ['a high surrogate before a valid pair', 'Rocket \uD800🚀 then \uFFFF', 'U+D800'],
  ])('reports the first invalid unit after %s', (_description, input, expected) => {
    expect(findUnencodableChar(input)).toBe(expected);

    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Rocket', aliases: [input] }],
      settings: { protectedWords: [input] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid text to be rejected');
    const reason = `must not contain ${expected} (U+FFFE, U+FFFF and unpaired surrogates fit no file format)`;
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'aliases', 0], message: `${reason} in term "Rocket"` },
      { path: ['settings', 'protectedWords', 0], message: reason },
    ]);
  });

  it('accepts mixed valid ASCII, BMP text and supplementary characters', () => {
    const input = 'Hello Café 東京 🚀 𠀀';
    expect(findUnencodableChar(input)).toBeUndefined();
    expect(parseLexicon({ terms: [{ canonical: 'Rocket', aliases: [input] }] }).terms[0].aliases).toEqual([input]);
  });
});
