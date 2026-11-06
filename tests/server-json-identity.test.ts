import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface PackageJson {
  mcpName?: string;
  homepage?: string;
  repository?: { url?: string } | string;
}

interface ServerJson {
  name?: string;
  websiteUrl?: string;
  repository?: { url?: string };
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;

// npm stores repository URLs as git+https://…git; the registry wants the plain web URL.
const plainRepositoryUrl = (url: string): string => url.replace(/^git\+/, '').replace(/\.git$/, '');

const pkg = readJson<PackageJson>('package.json');
const server = readJson<ServerJson>('server.json');

it('keeps server.json name equal to package.json mcpName', () => {
  expect(pkg.mcpName).toBeTruthy();
  expect(server.name).toBe(pkg.mcpName);
});

it('keeps server.json websiteUrl equal to package.json homepage', () => {
  expect(pkg.homepage).toBeTruthy();
  expect(server.websiteUrl).toBe(pkg.homepage);
});

it('keeps server.json repository.url equal to the package.json repository url without git+ and .git', () => {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  expect(repository).toBeTruthy();
  expect(server.repository?.url).toBe(plainRepositoryUrl(repository ?? ''));
});
