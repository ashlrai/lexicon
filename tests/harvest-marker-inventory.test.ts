import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the marker inventory aligned with the generic identifier set', () => {
  const source = readFileSync(new URL('../src/core/harvest.ts', import.meta.url), 'utf8');
  const setBody = /const GENERIC_IDENTIFIERS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1];
  expect(setBody).toBeDefined();
  const markerLine = setBody!.trimEnd().split('\n').at(-1)!;
  const sourceMarkers = [...markerLine.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(sourceMarkers).toEqual(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX']);

  const doc = readFileSync(new URL('../docs/harvest-marker-inventory.md', import.meta.url), 'utf8');
  const documented = [...doc.matchAll(/^\| `([^`]+)` \|$/gm)].map((match) => match[1]);
  expect(documented).toEqual(sourceMarkers);
  const line = /\]\(\.\.\/src\/core\/harvest\.ts#L(\d+)\)/.exec(doc)?.[1];
  expect(line).toBeDefined();
  expect(source.split('\n')[Number(line) - 1].trim()).toBe(markerLine.trim());
});
