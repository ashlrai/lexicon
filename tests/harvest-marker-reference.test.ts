import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('harvest marker reference', () => {
  it('lists the five marker literals from the generic identifier set with source links', () => {
    const root = process.cwd();
    const source = readFileSync(path.join(root, 'src/core/harvest.ts'), 'utf8');
    const setBody = /const GENERIC_IDENTIFIERS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1];
    expect(setBody).toBeDefined();
    const literals = new Set([...setBody!.matchAll(/'([^']+)'/g)].map((match) => match[1]));

    const doc = readFileSync(path.join(root, 'docs/harvest-marker-reference.md'), 'utf8');
    const rows = [...doc.matchAll(/^\| `([^`]+)` \| \[Generic identifier set\]\(\.\.\/src\/core\/harvest\.ts#L(\d+)\) \|$/gm)];
    expect(rows.map((row) => row[1])).toEqual(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX']);
    for (const [, marker, line] of rows) {
      expect(literals.has(marker)).toBe(true);
      expect(source.split('\n')[Number(line) - 1]).toContain(`'${marker}'`);
    }
  });
});
