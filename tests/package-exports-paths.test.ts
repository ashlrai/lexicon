import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every string leaf under a value, so conditional exports like { types, import, default } all count.
const stringLeaves = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
};

// ./dist/X.js and ./dist/X.d.ts both map to src/X.ts. Anything else is unmapped and reported.
const sourceFor = (target: string): string | undefined => {
  const match = /^\.\/dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(target);
  return match ? `src/${match[1]}.ts` : undefined;
};

it('maps main and exports "." dist targets to existing src files', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    main: string;
    exports: Record<string, unknown>;
  };
  const targets = [pkg.main, ...stringLeaves(pkg.exports['.'])];
  const problems = targets.flatMap((target) => {
    const source = sourceFor(target);
    if (!source) return [`${target}: not a ./dist/X.js or ./dist/X.d.ts path`];
    return existsSync(resolve(root, source)) ? [] : [`${target}: missing ${source}`];
  });

  expect(targets.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
