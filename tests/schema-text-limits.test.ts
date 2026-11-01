import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const doc = readFileSync(new URL('../docs/schema-text-limits.md', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('notes and phonetic text limits', () => {
  it('links the reference and records the contract value for both fields', () => {
    expect(index).toContain('(schema-text-limits.md)');
    expect(doc).toContain('(CONTRACT.md#srccoreschemats)');
    expect(contract).toContain(`\`text\` ${LIMITS.text} (notes, phonetic)`);
    expect(doc).toContain(`200 for a term's \`notes\` and \`phonetic\` fields`);
    expect(LIMITS.text).toBe(200);
  });

  it('executes the published boundary example against the schema', () => {
    const blocks = [...doc.matchAll(/```js\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(1);
    const imports = "import assert from 'node:assert/strict';\nimport { parseLexicon } from '@ashlr/lexicon';\n";
    expect(blocks[0][1].startsWith(imports)).toBe(true);
    new Function('assert', 'parseLexicon', blocks[0][1].slice(imports.length))(assert, parseLexicon);
  });

  it.each(['notes', 'phonetic'] as const)('enforces the contract limit through both schemas for %s', (field) => {
    const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
    const match = schemaSection?.match(/`text` (\d+) \(notes, phonetic\)/);
    expect(match).toBeTruthy();
    const limit = Number(match![1]);
    const atLimit = 'x'.repeat(limit);

    for (const [schema, wrap, path] of [
      [TermSchema, (term: object) => term, [field]],
      [LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, field]],
    ] as const) {
      expect(schema.safeParse(wrap({ canonical: 'X', [field]: atLimit })).success).toBe(true);
      const result = schema.safeParse(wrap({ canonical: 'X', [field]: `${atLimit}x` }));
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected an overlong field to be rejected');
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path, message: `must be at most ${limit} characters` }),
      ]));
    }
  });

  it.each(['notes', 'phonetic'] as const)('enforces the inclusive 200-code-point limit for %s', (field) => {
    for (const character of ['x', '🙂']) {
      const atLimit = character.repeat(200);
      const parse = (value: string) => parseLexicon({ terms: [{ canonical: 'X', [field]: value }] });

      expect(parse(atLimit).terms[0][field]).toBe(atLimit);
      expect(() => parse(`${atLimit}${character}`)).toThrow(
        new RegExp(`terms\\[0\\]\\.${field}: must be at most 200 characters`),
      );
      // Length is measured after trimming and removing the documented invisible characters.
      expect(parse(`  ${atLimit}\u200b  `).terms[0][field]).toBe(atLimit);
    }
  });

  it('applies the limit independently to both fields', () => {
    const text = 'x'.repeat(200);
    const term = parseLexicon({ terms: [{ canonical: 'X', notes: text, phonetic: text }] }).terms[0];
    expect(term.notes).toBe(text);
    expect(term.phonetic).toBe(text);
  });

  it.each(['notes', 'phonetic'])('rejects retained line breaks and unencodable text in %s', (field) => {
    for (const invalid of ['a\nb', 'a\u2028b', 'a\ufffeb', 'a\ud800b']) {
      expect(() => parseLexicon({ terms: [{ canonical: 'X', [field]: invalid }] })).toThrow();
    }
    const parsed = parseLexicon({ terms: [{ canonical: 'X', [field]: null }] });
    expect(parsed.terms[0]).not.toHaveProperty(field);
  });
});
