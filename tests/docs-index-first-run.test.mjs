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

test('tray request scope distinguishes the issue request from open implementation details', () => {
  const scope = readFileSync(path.join(docs, 'tray-request-scope.md'), 'utf8');
  const [request, context] = scope.split('## Current context');
  const open = context?.split('## Open implementation details')[1]?.split('## Verification requested by the issue')[0];
  assert.ok(index.includes('(tray-request-scope.md)'), 'scope is discoverable from the index');
  assert.match(request, /github\.com\/ashlrai\/lexicon\/issues\/13/);
  for (const item of ['Windows', 'Linux', 'Fix clipboard', 'lexicon daemon --once --paste',
    'Dictate', 'lexicon voice --toggle --paste', 'Open lexicon', 'Preferences', 'Quit',
    'global shortcut', 'PATH']) {
    assert.ok(request.includes(item), `request is missing ${item}`);
  }
  assert.ok(open, 'expected a separate open implementation details section');
  for (const item of ['toolkit', 'paste', 'shortcut', 'discovery']) {
    assert.match(open, new RegExp(`\\*\\*Open:\\*\\*[^\\n]*(?:\\n(?!- ).*)*${item}`, 'i'),
      `${item} should be labeled open`);
  }
});
