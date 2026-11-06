import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  repository: { url: string };
  bugs: { url: string };
  homepage: string;
};

it('points bugs.url to the repository issues page', () => {
  const repositoryUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  expect(pkg.bugs.url).toBe(`${repositoryUrl}/issues`);
});

it('uses HTTPS for the homepage', () => {
  expect(pkg.homepage).toMatch(/^https:\/\//);
});
