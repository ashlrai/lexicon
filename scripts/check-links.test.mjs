import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, linksIn, targets } from './check-links.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'linkcheck-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

test('a relative link to a missing file is broken; one that exists resolves', () => {
  const root = fixture({
    'README.md': '[ok](docs/page.md) [gone](docs/nope.md)\n',
    'docs/page.md': '# Page\n',
  });
  const r = check(root);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.broken, ['README.md:1  missing file: docs/nope.md']);
  rmSync(root, { recursive: true });
});

test('fragments are held to the target file headings, GitHub slug rules', () => {
  const root = fixture({
    'README.md': '[a](docs/page.md#how-it-works) [b](docs/page.md#missing) [c](#readme)\n',
    'docs/page.md': '# How it works!\n\nText.\n',
  });
  const r = check(root);
  assert.deepEqual(r.broken, [
    `README.md:1  no such heading in ${join('docs', 'page.md')}: #missing`,
    'README.md:1  no such heading in this file: #readme',
  ]);
  rmSync(root, { recursive: true });
});

test('repeated headings de-duplicate the way GitHub does, and <a id> anchors count', () => {
  const root = fixture({
    'README.md': '[x](docs/p.md#install-1) [y](docs/p.md#old-name)\n',
    'docs/p.md': '# Install\n\n# Install\n\n<a id="old-name"></a>\n',
  });
  assert.deepEqual(check(root).broken, []);
  rmSync(root, { recursive: true });
});

test('links inside fenced code and inline code are ignored', () => {
  const root = fixture({
    'README.md': '```\n[not a link](missing.md)\n```\n`[inline](missing2.md)` [real](docs/p.md)\n',
    'docs/p.md': '# P\n',
  });
  const r = check(root);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.broken, []);
  rmSync(root, { recursive: true });
});

test('external URLs are counted, not fetched; mailto and data too', () => {
  const root = fixture({
    'README.md': '[site](https://example.invalid/x) [mail](mailto:a@b.c) [img](data:image/png;base64,AA)\n',
  });
  const r = check(root);
  assert.equal(r.external, 3);
  assert.equal(r.checked, 0);
  assert.deepEqual(r.broken, []);
  rmSync(root, { recursive: true });
});

test('targets picks up root-level markdown, not just the original fixed list', () => {
  const root = fixture({
    'INTEGRATION.md': '# x\n',
    'docs/DEEP.md': '# x\n',
    'notes.txt': 'x',
  });
  assert.deepEqual(targets(root), ['INTEGRATION.md', join('docs', 'DEEP.md')]);
  rmSync(root, { recursive: true });
});

test('the repository itself has no broken relative links', () => {
  const r = check(repoRoot);
  assert.deepEqual(r.broken, []);
  assert.ok(r.files > 50 && r.checked > 400, `unexpected coverage: ${JSON.stringify(r)}`);
});

test('targets retains UTF-16 ordering across root and nested markdown', () => {
  const names = ['z.md', 'B.md', 'a.md', '10.md', '2.md', 'é.md', 'docs/z.md', 'docs/B.md'];
  const root = fixture(Object.fromEntries(names.map((name) => [name, '# Page\n'])));
  try {
    assert.deepEqual(targets(root), ['10.md', '2.md', 'B.md', 'a.md', join('docs', 'B.md'), join('docs', 'z.md'), 'z.md', 'é.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
