import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('catalogs the marker literals grouped at the end of GENERIC_IDENTIFIERS', () => {
  const root = process.cwd();
  const source = readFileSync(path.join(root, 'src/core/harvest.ts'), 'utf8');
  const setBody = /const GENERIC_IDENTIFIERS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1];
  expect(setBody).toBeDefined();
  const markerLine = setBody!.trimEnd().split('\n').at(-1)!;
  const sourceMarkers = [...markerLine.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(sourceMarkers).toEqual(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX']);

  const doc = readFileSync(path.join(root, 'docs/harvest-marker-catalog.md'), 'utf8');
  const catalogMarkers = [...doc.matchAll(/^\| `([^`]+)` \|$/gm)].map((match) => match[1]);
  expect(catalogMarkers).toEqual(sourceMarkers);
  const sourceLine = /\]\(\.\.\/src\/core\/harvest\.ts#L(\d+)\)/.exec(doc)?.[1];
  expect(sourceLine).toBeDefined();
  expect(source.split('\n')[Number(sourceLine) - 1].trim()).toBe(markerLine.trim());
});
