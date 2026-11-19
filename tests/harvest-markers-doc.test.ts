import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/harvest-markers.md is the single list of the TODO-style marker
// literals. It replaced harvest-marker-reference.md, harvest-marker-catalog.md
// and harvest-marker-inventory.md, which repeated the same table; this test
// keeps every assertion those three tests made.
describe('docs/harvest-markers.md marker table', () => {
  const root = process.cwd();
  const source = readFileSync(path.join(root, 'src/core/harvest.ts'), 'utf8');
  const sourceLines = source.split('\n');
  const doc = readFileSync(path.join(root, 'docs/harvest-markers.md'), 'utf8');

  const setBody = /const GENERIC_IDENTIFIERS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1];
  const rows = [
    ...doc.matchAll(/^\| `([^`]+)` \| \[Generic identifier set\]\(\.\.\/src\/core\/harvest\.ts#L(\d+)\) \|$/gm),
  ];

  it('lists the marker literals grouped at the end of GENERIC_IDENTIFIERS, in order', () => {
    expect(setBody).toBeDefined();
    const markerLine = setBody!.trimEnd().split('\n').at(-1)!;
    const sourceMarkers = [...markerLine.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(sourceMarkers).toEqual(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX']);
    expect(rows.map((row) => row[1])).toEqual(sourceMarkers);

    // Every source link points at the marker line itself.
    for (const [, , line] of rows) {
      expect(sourceLines[Number(line) - 1].trim()).toBe(markerLine.trim());
    }
  });

  it('links each marker to a source line that contains it, inside the set', () => {
    const literals = new Set([...setBody!.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    expect(rows).toHaveLength(5);
    for (const [, marker, line] of rows) {
      expect(literals.has(marker)).toBe(true);
      expect(sourceLines[Number(line) - 1]).toContain(`'${marker}'`);
    }
  });

  it('links the set declaration itself', () => {
    const line = /\[generic identifier set\]\(\.\.\/src\/core\/harvest\.ts#L(\d+)\)/.exec(doc)?.[1];
    expect(line).toBeDefined();
    expect(sourceLines[Number(line) - 1]).toContain('const GENERIC_IDENTIFIERS = new Set([');
  });
});
