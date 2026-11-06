import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function binToSourcePath(binPath: string): string | null {
  const match = binPath.match(/^(\.\/)?dist\/(.+)\.js$/);
  return match ? `src/${match[2]}.ts` : null;
}

it('maps every package.json bin entry to an existing source file', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    bin: Record<string, string> | string;
  };
  const binEntries = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);

  expect(binEntries.length).toBeGreaterThan(0);

  const missing = binEntries.filter((entry) => {
    const srcPath = binToSourcePath(entry);
    return !srcPath || !existsSync(resolve(root, srcPath));
  });

  expect(missing).toEqual([]);
});

it('fails unless source file exists for mapped ./dist/X.js path', () => {
  expect(binToSourcePath('./dist/cli/index.js')).toBe('src/cli/index.ts');
  expect(binToSourcePath('./dist/mcp/server.js')).toBe('src/mcp/server.ts');
  const missingMapped = binToSourcePath('./dist/nonexistent-binary-path.js');
  expect(missingMapped).toBe('src/nonexistent-binary-path.ts');
  expect(existsSync(resolve(root, missingMapped!))).toBe(false);
  expect(binToSourcePath('./other/binary.sh')).toBeNull();
});
