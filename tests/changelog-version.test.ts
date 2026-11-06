import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('lists the package version in the changelog release table', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

  expect(changelog.split(/\r?\n/).some((line) => line.startsWith(`| ${version} |`))).toBe(true);
});
