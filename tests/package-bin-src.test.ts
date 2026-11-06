import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};

it('has a source file for every package binary', () => {
  for (const [name, path] of Object.entries(pkg.bin)) {
    expect(path, `${name} binary path`).toMatch(/^\.\/dist\/.+\.js$/);
    const source = path.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts');
    expect(existsSync(resolve(root, source)), `${name} source: ${source}`).toBe(true);
  }
});
