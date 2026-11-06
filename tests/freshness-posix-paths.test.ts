import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { markedFiles, planFreshness } from '../scripts/freshness/lib.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'freshness posix &-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
const names = ['docs/a/z.md', 'docs/a.md', 'examples/deep/B.ts'];
for (const name of names) {
  const absolute = path.join(root, name);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, '<!-- fresh:begin pin:tag -->v0.0.0<!-- fresh:end -->\n');
}

it('returns forward slashes and sorts after normalization, retaining native IO paths', () => {
  const expected = ['docs/a.md', 'docs/a/z.md', 'examples/deep/B.ts'];
  expect(markedFiles(root)).toEqual(expected);
  const plan = planFreshness(root);
  expect(plan.problems).toEqual([]);
  expect(plan.files.map((file) => file.file)).toEqual(expected);
  for (const file of plan.files) {
    expect(file.path).toBe(path.join(root, file.file));
    expect(readFileSync(file.path, 'utf8')).toContain('v0.0.0');
    expect(file.text).toContain('v1.2.3');
  }
});

it('checks, syncs and rechecks nested files with portable diagnostic paths', () => {
  const run = (script: string) => spawnSync(process.execPath, [
    fileURLToPath(new URL(`../scripts/freshness/${script}.mjs`, import.meta.url)), '--root', root,
  ], { encoding: 'utf8' });
  const stale = run('check');
  expect(stale.error).toBeUndefined();
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain('docs/a/z.md:1');
  const synced = run('sync');
  expect(synced.status).toBe(0);
  expect(synced.stdout).toContain('examples/deep/B.ts:1');
  expect(run('check').status).toBe(0);
});
