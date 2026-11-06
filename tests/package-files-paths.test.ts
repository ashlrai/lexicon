import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('lists existing repository paths in package.json files', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files: string[] };
  const missing = pkg.files.filter(
    (entry) => !entry.startsWith('dist') && !entry.startsWith('!') && !existsSync(resolve(root, entry)),
  );

  expect(missing).toEqual([]);
});
