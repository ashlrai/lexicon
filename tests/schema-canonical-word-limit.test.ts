import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('canonical length regression: hard-coded boundary against documented limit', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const contractMatch = schemaSection?.match(/`word` (\d+) \(canonical, alias\)/);
  const documentedLimit = Number(contractMatch![1]);

  it('contract documents 80 characters for canonical length', () => {
    expect(documentedLimit).toBe(80);
    expect(LIMITS.word).toBe(80);
  });

  it('accepts an 80-character canonical', () => {
    const canonical80 = 'a'.repeat(80);
    expect(TermSchema.safeParse({ canonical: canonical80 }).success).toBe(true);
  });

  it('rejects an 81-character canonical as exceeding the documented limit', () => {
    const canonical81 = 'a'.repeat(81);
    const result = TermSchema.safeParse({ canonical: canonical81 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(`must be at most ${documentedLimit} characters`);
    }
  });
});

describe('canonical word length boundary', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`word` (\d+) \(canonical, alias\)/);

  it('takes the limit from the contract: 80 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(80);
    expect(LIMITS.word).toBe(80);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['canonical']],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'canonical']],
  ] as const)('accepts 80 characters and rejects 81 through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    expect(schema.safeParse(wrap({ canonical: 'a'.repeat(limit - 1) })).success).toBe(true);
    expect(schema.safeParse(wrap({ canonical: 'a'.repeat(limit) })).success).toBe(true);

    const result = schema.safeParse(wrap({ canonical: 'a'.repeat(limit + 1) }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(path);
      expect(result.error.issues[0].message).toContain(`must be at most ${limit} characters`);
    }
  });

  it('reports the limit through parseLexicon with the field path', () => {
    const limit = Number(match![1]);
    expect(parseLexicon({ terms: [{ canonical: 'a'.repeat(limit) }] }).terms[0].canonical).toBe('a'.repeat(limit));
    expect(() => parseLexicon({ terms: [{ canonical: 'a'.repeat(limit + 1) }] })).toThrow(
      `terms[0].canonical: must be at most ${limit} characters`,
    );
  });
});

describe('canonical word length boundary: normalization and code points', () => {
  const at = 'a'.repeat(LIMITS.word);

  it('measures the length after trimming and stripping invisible characters', () => {
    const parsed = TermSchema.parse({ canonical: `  ​${at}﻿  ` });
    expect(parsed.canonical).toBe(at);
    // 80 real characters plus one more, padded by invisible characters, is over.
    expect(TermSchema.safeParse({ canonical: ` ​${at}a﻿ ` }).success).toBe(false);
  });

  it('counts a supplementary-plane character as one code point, not two UTF-16 units', () => {
    const at80 = '𠮷'.repeat(LIMITS.word);
    expect(at80.length).toBe(LIMITS.word * 2);
    expect(TermSchema.parse({ canonical: at80 }).canonical).toBe(at80);
    expect(TermSchema.safeParse({ canonical: `${at80}𠮷` }).success).toBe(false);
  });

  it('still requires the canonical to be nonempty under the limit', () => {
    // Unlike an alias entry, which is dropped when it cleans to nothing, the
    // canonical is the term's name: invisible-only is rejected, not removed.
    const result = TermSchema.safeParse({ canonical: ' ​﻿ ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['canonical']);
      expect(result.error.issues[0].message).toBe('must not be empty');
    }
  });
});
