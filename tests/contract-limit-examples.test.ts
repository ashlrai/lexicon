import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseLexicon } from '../src/core/schema.js';

it('runs the documented contract limit examples against the schema', () => {
  const doc = readFileSync('docs/contract-limit-examples.md', 'utf8');
  const blocks = [...doc.matchAll(/```js\n([\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(1);
  const imports = "import assert from 'node:assert/strict';\nimport { parseLexicon } from '@ashlr/lexicon';\n";
  expect(blocks[0][1].startsWith(imports)).toBe(true);
  // Execute the actual example against source, without requiring a built dist/.
  const run = new Function('assert', 'parseLexicon', blocks[0][1].slice(imports.length));
  run(assert, parseLexicon);
});
