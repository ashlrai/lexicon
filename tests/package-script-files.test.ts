import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(__dirname, '..');

describe('package scripts reference existing files', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  const raw = pkg.scripts ?? {};

  // Extract every scripts/... path from all script values, filtering to
  // those ending in .mjs or .ts  (e.g. "node scripts/build-bundle.mjs").
  const scriptRefs = Object.values(raw)
    .flatMap((val: string) =>
      [...val.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(mjs|ts)/g)].map(
        m => m[0],
      ),
    )
    .filter((p, i, a) => a.indexOf(p) === i); // deduplicate

  it('exports at least 5 scripts/... paths from package.json', () => {
    expect(scriptRefs.length).toBeGreaterThanOrEqual(5);
  });

  it.each(scriptRefs)('all scripts/%s exists on disk', (path: string) => {
    expect(existsSync(join(REPO_ROOT, path))).toBe(true);
  });
});
