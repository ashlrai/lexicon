import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { line, type IO } from './args.js';

type Runner = 'vitest' | 'node';
type Test = { runner: Runner; path: string };

// Only paths whose test coverage has been reviewed belong here. Changes to
// shared configuration, fixtures, dependencies, or unknown files run all tests.
const mappings: Record<string, Test[]> = {
  'src/cli/cmd-test-select.ts': [{ runner: 'vitest', path: 'tests/test-select.test.ts' }, { runner: 'vitest', path: 'tests/cli.test.ts' }, { runner: 'vitest', path: 'tests/e2e.test.ts' }],
  'scripts/check-links.mjs': [{ runner: 'node', path: 'scripts/check-links.test.mjs' }, { runner: 'vitest', path: 'tests/support-doc.test.ts' }],
  'scripts/check-links.test.mjs': [{ runner: 'node', path: 'scripts/check-links.test.mjs' }],
};

export function selectTests(paths: string[], root: string) {
  const files = [...new Set(paths)].sort();
  const selected = new Map<string, Test>();
  const unknown: string[] = [];
  for (const path of files) {
    const tests = mappings[path] ?? (/^(tests|bench)\/[\w./-]+\.test\.ts$/.test(path) && !path.split('/').includes('..')
      ? [{ runner: 'vitest' as const, path }] : undefined);
    if (!tests || tests.some((test) => !existsSync(join(root, test.path)))) {
      unknown.push(path);
      continue;
    }
    for (const test of tests) selected.set(`${test.runner}:${test.path}`, test);
  }
  const full = files.length === 0 || unknown.length > 0;
  const tests = full ? [] : [...selected.values()].sort((a, b) => a.runner.localeCompare(b.runner, 'en') || a.path.localeCompare(b.path, 'en'));
  const commands = full ? [['npm', 'test']] : (['node', 'vitest'] as const).flatMap((runner) => {
    const paths = tests.filter((test) => test.runner === runner).map((test) => test.path);
    return paths.length ? [runner === 'node' ? ['node', '--test', ...paths] : ['npm', 'exec', 'vitest', 'run', '--', ...paths]] : [];
  });
  return { ok: true, full, files, unknown, tests, commands };
}

export function changedFiles(cwd: string): { root: string; files: string[] } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = git('rev-parse', '--show-toplevel').trimEnd();
  const split = (output: string) => output.split('\0').filter(Boolean);
  // --no-renames includes both sides, so a rename cannot hide an unknown path.
  const files = [...split(git('-C', root, 'diff', '--name-only', '-z', '--no-renames', 'HEAD', '--')), ...split(git('-C', root, 'ls-files', '--others', '--exclude-standard', '-z'))];
  return { root, files };
}

export function runTestSelect(paths: string[], opts: { json?: boolean; cwd?: string }, io: IO): void {
  const { root, files } = paths.length ? { root: opts.cwd ?? process.cwd(), files: paths } : changedFiles(opts.cwd ?? process.cwd());
  const result = selectTests(files, root);
  if (opts.json) line(io, JSON.stringify(result, null, 2));
  else {
    line(io, result.full ? 'Run the full suite:' : 'Run the selected tests:');
    for (const command of result.commands) line(io, command.join(' '));
    if (result.unknown.length) line(io, `Full suite required for: ${result.unknown.join(', ')}`);
  }
}
