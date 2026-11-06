import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vitest performance files', () => {
  it('lists existing files', () => {
    const root = new URL('../', import.meta.url);
    const config = readFileSync(new URL('vitest.config.ts', root), 'utf8');
    const array = config.match(/\bconst\s+PERF_FILES\s*=\s*\[([\s\S]*?)\]/);
    expect(array, 'PERF_FILES array must exist').not.toBeNull();

    const paths = Array.from(array?.[1].matchAll(/(['"])(.*?)\1/g) ?? [], (match) => match[2]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(new URL(path, root)), `${path} must exist`).toBe(true);
    }
  });
});
