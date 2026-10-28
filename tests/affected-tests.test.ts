import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { affectedTests, main } from '../scripts/affected-tests.mjs';

// Fixtures are git diff --name-only output; production uses -z for odd paths.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/affected-tests/${name}.diff`, import.meta.url), 'utf8').trim().split('\n');
const sources = new Map([
  ['src/core/matcher.ts', 'export const match = 1;'],
  ['src/core/index.ts', 'export { match } from "./matcher.js";'],
  ['src/core/normalize.ts', 'export const normalize = () => import("./index.js");'],
  ['tests/matcher.test.ts', 'import { match } from "../src/core/matcher.js";'],
  ['tests/normalize.test.ts', 'import "../src/core/normalize.js";'],
  ['tests/other.test.ts', 'import "vitest";'],
  ['tests/e2e.test.ts', 'import { spawnSync } from "node:child_process";'],
  ['tests/inspect.test.ts', 'import { readFileSync } from "node:fs";'],
]);

describe('affected test selection', () => {
  it('prints an empty list for the docs-only fixture', () => {
    expect(affectedTests(fixture('docs-only'), sources)).toEqual([]);
  });
  it('selects direct, transitive, dynamic and runtime consumers for a module', () => {
    expect(affectedTests(fixture('single-module'), sources)).toEqual([
      'tests/e2e.test.ts', 'tests/inspect.test.ts', 'tests/matcher.test.ts', 'tests/normalize.test.ts',
    ]);
  });
  it('selects ALL for the lockfile fixture', () => {
    expect(affectedTests(fixture('lockfile'), sources)).toBe('ALL');
  });
  it.each(['vitest.config.ts', 'tsconfig.json', 'web/package-lock.json', 'web/package.json', 'src/serve/config.ts', 'tests/fixtures/data.yaml', 'scripts/affected-tests.mjs', 'unknown/file.ts', 'docs/example.ts'])(
    'falls back to ALL for %s', path => expect(affectedTests([path], sources)).toBe('ALL'),
  );
  it('selects only the changed test, sorted and deduplicated', () => {
    expect(affectedTests(['tests/other.test.ts', 'README.md', 'tests/matcher.test.ts', 'tests/other.test.ts'], sources))
      .toEqual(['tests/matcher.test.ts', 'tests/other.test.ts']);
  });
  it('falls back for deleted and unreferenced modules', () => {
    expect(affectedTests(['src/core/deleted.ts'], sources)).toBe('ALL');
    expect(affectedTests(['src/new.ts'], new Map([...sources, ['src/new.ts', '']]))).toBe('ALL');
  });
  it('does not let unrelated runtime readers hide an untested import chain', () => {
    const untested = new Map([...sources, ['src/new.ts', ''], ['src/consumer.ts', 'import \"./new.js\";']]);
    expect(affectedTests(['src/new.ts'], untested)).toBe('ALL');
  });
  it('retains type-only dependencies', () => {
    const typed = new Map(sources);
    typed.set('src/core/contract.ts', 'export interface Match {}');
    typed.set('tests/typed.test.ts', 'import type { Match } from \"../src/core/contract.js\";');
    expect(affectedTests(['src/core/contract.ts'], typed)).toContain('tests/typed.test.ts');
  });
  it('terminates on import cycles', () => {
    const cyclic = new Map(sources);
    cyclic.set('src/core/matcher.ts', 'import "./index.js";');
    expect(affectedTests(fixture('single-module'), cyclic)).toContain('tests/matcher.test.ts');
  });
  it('returns no targets for an empty diff', () => expect(affectedTests([], sources)).toEqual([]));
  it('reads a real merge-base diff without modifying the repository', () => {
    expect(main(['HEAD'])).toEqual([]);
    const script = resolve('scripts/affected-tests.mjs');
    expect(execFileSync(process.execPath, [script, 'HEAD'], { encoding: 'utf8' })).toBe('');
  });
  it.each([[], ['--help'], ['HEAD', 'extra'], ['refs/heads/nonexistent-affected-tests-base']].map(args => ({ args })))('fails closed on invalid arguments $args', ({ args }) => {
    const result = spawnSync(process.execPath, ['scripts/affected-tests.mjs', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('affected-tests: selection failed');
  });
});
