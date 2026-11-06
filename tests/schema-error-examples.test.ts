import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../src/core/schema.js';

describe('documented schema error examples', () => {
  const doc = readFileSync(new URL('../docs/schema-error-examples.md', import.meta.url), 'utf8');
  const examples = [...doc.matchAll(/<!-- schema-example -->\s*```yaml\n([\s\S]*?)\n```\s*```text\n([\s\S]*?)\n```/g)]
    .map((match): [string, string] => [match[1], match[2]]);

  it('keeps every example paired with its expected error', () => {
    expect(examples).toHaveLength(4);
  });

  it.each(examples)('matches the parser for example %#', (yaml, expected) => {
    let message: string | undefined;
    try {
      parseLexicon(parseYaml(yaml));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(expected);
  });
});
