import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, selectTests } from '../src/cli/cmd-test-select.js';

const root = process.cwd();

describe('changed-file test selection', () => {
  it('deduplicates and sorts paths and test commands regardless of input order', () => {
    const paths = ['tests/test-select.test.ts', 'scripts/check-links.mjs', 'tests/test-select.test.ts'];
    const result = selectTests(paths, root);
    expect(result).toEqual(selectTests([...paths].reverse(), root));
    expect(result.full).toBe(false);
    expect(result.commands).toEqual([
      ['node', '--test', 'scripts/check-links.test.mjs'],
      ['npm', 'exec', 'vitest', 'run', '--', 'tests/support-doc.test.ts', 'tests/test-select.test.ts'],
    ]);
  });

  it('falls back for unknown, missing, unsafe, and empty inputs', () => {
    for (const paths of [[], ['unknown.ts'], ['tests/missing.test.ts'], ['tests/../other.test.ts'], ['tests/test-select.test.ts', 'package.json']]) {
      expect(selectTests(paths, root)).toMatchObject({ full: true, tests: [], commands: [['npm', 'test']] });
    }
  });

  it('exposes the same selection through the JSON CLI', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'test-select', 'tests/test-select.test.ts', '--json'], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(selectTests(['tests/test-select.test.ts'], root));
  });

  it('includes staged, unstaged, untracked and both sides of renames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-select-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
      writeFileSync(join(dir, 'old'), 'old'); writeFileSync(join(dir, 'modified'), 'before');
      git('add', '.'); git('commit', '-m', 'initial');
      git('mv', 'old', 'new'); writeFileSync(join(dir, 'modified'), 'after'); writeFileSync(join(dir, 'untracked'), 'new');
      expect(changedFiles(dir).files.sort()).toEqual(['modified', 'new', 'old', 'untracked']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
