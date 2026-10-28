#!/usr/bin/env node
/** Select Vitest file targets for a merge-base diff. See affected-tests.md. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const sourceFile = /\.(?:[cm]?[jt]sx?)$/;
const testFile = /^(?:tests|src|bench)\/.*\.test\.ts$/;
const documentation = /^(?:[^/]+\.md|docs\/.*\.(?:md|png|jpg|svg))$/;

/** Unknown paths deliberately fall back to the full suite, never no tests. */
export function affectedTests(paths, sources) {
  const changed = [...new Set(paths)].filter(path => !documentation.test(path));
  if (!changed.length) return [];
  // Only code and test files have a dependency mapping. This includes a full
  // fallback for manifests, lockfiles, fixtures, configs and generated assets.
  if (changed.some(path => !/^(?:src|tests|bench|extension\/src)\//.test(path)
    || !sourceFile.test(path) || /(?:\.d\.[cm]?ts|(?:^|\/)types\.ts)$/.test(path) || /(?:^|\/)[^/]*config[^/]*\./i.test(path)
    || !sources.has(path))) return 'ALL';

  const reverse = new Map();
  const runtimeReaders = new Set();
  for (const [path, content] of sources) {
    const { metafile } = buildSync({
      stdin: { contents: content, loader: /[jt]sx$/.test(path) ? 'tsx' : 'ts' },
      bundle: true, write: false, metafile: true, external: ['*'],
      platform: 'node', format: 'esm', treeShaking: false, logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    });
    const imports = Object.values(metafile.inputs).flatMap(input => input.imports);
    // esbuild erases type-only imports. Retain their literal edges too;
    // matches in comments can only add tests, never remove them.
    for (const match of content.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      imports.push({ path: match[1] });
    }
    for (const { path: fileName } of imports) {
      // Filesystem readers and subprocess runners can exercise code without an
      // import edge (bundles, CLI entry points, source inspections).
      if (/^(?:node:)?(?:child_process|fs(?:\/promises)?)$/.test(fileName)) runtimeReaders.add(path);
      if (!fileName.startsWith('.')) continue;
      const relative = posix.normalize(posix.join(posix.dirname(path), fileName));
      const stem = relative.replace(/\.(?:mjs|cjs|js|jsx)$/, '');
      const dependency = [relative, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${relative}/index.ts`]
        .find(candidate => sources.has(candidate));
      if (!dependency) continue;
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(path);
    }
  }
  const reached = new Set(changed);
  // A test-only edit needs only its dependents. Source edits also include tests
  // which inspect files or execute entry points dynamically.
  if (changed.some(path => !testFile.test(path))) {
    for (const path of runtimeReaders) reached.add(path);
  }
  const queue = [...reached];
  for (const path of queue) {
    for (const dependent of reverse.get(path) ?? []) {
      if (!reached.has(dependent)) {
        reached.add(dependent);
        queue.push(dependent);
      }
    }
  }
  const targets = [...reached].filter(path => testFile.test(path)).sort();
  if (targets.some(path => /[\r\n]/.test(path))) return 'ALL';
  // Each changed module must have a path to a test independently of the
  // blanket runtime readers; an untested import chain still needs ALL.
  for (const path of changed) {
    const consumers = new Set([path]);
    for (const consumer of consumers) {
      for (const dependent of reverse.get(consumer) ?? []) consumers.add(dependent);
    }
    if (![...consumers].some(consumer => testFile.test(consumer))) return 'ALL';
  }
  return targets.length ? targets : 'ALL';
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new Error('Usage: node scripts/affected-tests.mjs <base-ref>');
  }
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  cwd = root;
  // Resolve to an object ID before constructing a range; no shell or options
  // from the caller are interpolated into the diff command.
  const base = git(['rev-parse', '--verify', '--end-of-options', `${args[0]}^{commit}`]).trim();
  const paths = git(['diff', '--no-ext-diff', '--no-relative', '--no-renames', '--name-only', '-z', `${base}...HEAD`, '--']).split('\0').filter(Boolean);
  if (paths.every(path => documentation.test(path))) return [];
  const files = git(['ls-files', '--full-name', '--cached', '-z']).split('\0').filter(path => sourceFile.test(path));
  const sources = new Map();
  for (const path of files) {
    try { sources.set(path, readFileSync(resolve(root, path), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return affectedTests(paths, sources);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main();
    process.stdout.write(result === 'ALL' ? 'ALL\n' : result.map(path => `${path}\n`).join(''));
  } catch {
    // Do not turn missing history or a failed Git command into a docs-only diff.
    process.stderr.write('affected-tests: selection failed; check the base ref and checkout. Usage: node scripts/affected-tests.mjs <base-ref>\n');
    process.exitCode = 1;
  }
}
