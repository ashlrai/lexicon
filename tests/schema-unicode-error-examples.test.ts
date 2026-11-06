import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-unicode-error-examples.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/<!-- unicode-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)]
  .map((match): [string, string] => [match[1], match[2]]);

describe('Unicode error preview examples', () => {
  it('includes a surrogate, a noncharacter and a truncated preview', () => {
    expect(examples).toHaveLength(3);
    expect(examples[0][0]).toContain('\\uD800');
    expect(examples[1][0]).toContain('\\uFFFE');
    expect(examples[2][1]).toContain('\\uFF…');
  });

  it.each(examples)('matches the complete parser error for example %#', (yaml, expected) => {
    try {
      parseLexicon(parseYaml(yaml));
      expect.fail('Expected the example to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(expected);
    }
  });
});
