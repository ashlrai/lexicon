import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('links the terminal setup cast from the README and ships the recording', () => {
  const root = process.cwd();
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  expect(readme).toMatch(/(?<!!)\[[^\]]+\]\(docs\/assets\/cli-setup\.cast\)/);
  expect(statSync(path.join(root, 'docs/assets/cli-setup.cast')).isFile()).toBe(true);
});
