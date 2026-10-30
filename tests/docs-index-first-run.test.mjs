import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const index = readFileSync(path.join(docs, 'README.md'), 'utf8');

test('linked documentation index rows point to existing files', () => {
  const rows = index.split(/\r?\n/).filter((line) => /^\|\s*\[/.test(line));
  assert.ok(rows.length > 0, 'expected linked index rows');
  for (const row of rows) {
    const link = /^\|\s*\[([^\]]+)\]\(([^)]+)\)/.exec(row);
    assert.ok(link, `invalid linked index row: ${row}`);
    const target = path.resolve(docs, decodeURIComponent(link[2].split('#')[0]));
    assert.ok(statSync(target, { throwIfNoEntry: false })?.isFile(),
      `${link[1]} points to a missing file: ${link[2]}`);
  }
});
