import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, parseLexicon } from '../src/core/schema.js';

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

  it.each(['notes', 'phonetic'])('rejects retained line breaks and unencodable text in %s', (field) => {
    for (const invalid of ['a\nb', 'a\u2028b', 'a\ufffeb', 'a\ud800b']) {
      expect(() => parseLexicon({ terms: [{ canonical: 'X', [field]: invalid }] })).toThrow();
    }
    const parsed = parseLexicon({ terms: [{ canonical: 'X', [field]: null }] });
    expect(parsed.terms[0]).not.toHaveProperty(field);
  });
});
