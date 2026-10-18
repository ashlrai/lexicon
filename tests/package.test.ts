import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What `npm pack` (and so `npm publish`) puts in the tarball, without running
 * `npm pack`: npm 10 runs the `prepare` script for `npm pack --dry-run` even
 * with `--ignore-scripts`, which would rebuild dist/ and plugin/ under the
 * other suites. npm-packlist is the library npm itself computes the list with,
 * so the answer is the one the published package gets. It ships inside npm,
 * not in this repo's node_modules, so the test finds npm next to node (or
 * through npm_execpath when run under `npm test` or `npx`) and is skipped when
 * no npm install is found.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function npmRoot(): string | undefined {
  const bin = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath ? path.resolve(path.dirname(process.env.npm_execpath), '..') : undefined,
    path.join(bin, '..', 'lib', 'node_modules', 'npm'),
    path.join(bin, 'node_modules', 'npm'),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const real = realpathSync(dir);
      if (existsSync(path.join(real, 'node_modules', 'npm-packlist')) && existsSync(path.join(real, 'node_modules', '@npmcli', 'arborist'))) return real;
    } catch {
      // not this one
    }
  }
  return undefined;
}

const NPM_ROOT = npmRoot();

let packed: Promise<string[]> | undefined;
function packedFiles(): Promise<string[]> {
  packed ??= (async () => {
    const req = createRequire(path.join(NPM_ROOT as string, 'package.json'));
    const Arborist = req('@npmcli/arborist') as new (opts: { path: string }) => { loadActual(): Promise<unknown> };
    const packlist = req('npm-packlist') as (tree: unknown) => Promise<string[]>;
    const tree = await new Arborist({ path: REPO_ROOT }).loadActual();
    return (await packlist(tree)).map((f) => f.split(path.sep).join('/')).sort();
  })();
  return packed;
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T;
}

interface PackageJson {
  version: string;
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, string | Record<string, string>>;
}

const rel = (p: string) => path.posix.normalize(p.replace(/^\.\//, ''));
const BUILT = existsSync(path.join(REPO_ROOT, 'dist', 'cli', 'index.js'));

describe.skipIf(!NPM_ROOT)('published package contents', () => {
  it.skipIf(!BUILT)('packs every bin, main, types and exports target (needs npm run build)', async () => {
    const files = new Set(await packedFiles());
    const pkg = readJson<PackageJson>('package.json');
    const targets = [
      ...Object.values(pkg.bin),
      pkg.main,
      pkg.types,
      ...Object.values(pkg.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target))),
    ].map(rel);
    for (const target of targets) expect(files, target).toContain(target);
  });

  it('packs the plugin bundles, manifests, packs, skills and commands the runtime loads', async () => {
    const files = new Set(await packedFiles());
    const required = [
      'plugin/mcp-server.mjs',
      'plugin/hook.mjs',
      'plugin/hook-main.mjs',
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      '.mcp.json',
      'README.md',
      'LICENSE',
      ...readdirSync(path.join(REPO_ROOT, 'packs')).filter((f) => f.endsWith('.yaml')).map((f) => `packs/${f}`),
      ...readdirSync(path.join(REPO_ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`),
      ...readdirSync(path.join(REPO_ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => `commands/${f}`),
    ];
    for (const file of required) expect(files, file).toContain(file);
  });

  // Catches: tsc's .js.map files shipped (104 of them, ~870 KB) pointing at
  // ../../src/*.ts, which the package does not contain.
  it('ships no source maps, sources, tests, fixtures or dev-only files', async () => {
    const files = await packedFiles();
    const devOnly = files.filter(
      (f) =>
        f.endsWith('.map') ||
        /\.test\.[cm]?[jt]s$/.test(f) ||
        /(^|\/)\.env(\.|$)/.test(f) ||
        /^(src|tests|bench|examples|extension|scripts|site|web|apps|docs|registry|packaging|node_modules)\//.test(f) ||
        /^tsconfig.*\.json$|^vitest\.config\./.test(f) ||
        (f.endsWith('.ts') && !f.endsWith('.d.ts')),
    );
    expect(devOnly).toEqual([]);
  });
});

// Catches: `exports` had no `./package.json` subpath and no `default`
// condition, so tooling that resolves `@ashlr/lexicon/package.json` (to read
// the version) hit ERR_PACKAGE_PATH_NOT_EXPORTED, and a resolver that asks
// for neither `import` nor `types` found no target for the package itself.
describe('package.json exports', () => {
  const pkg = readJson<PackageJson & { name: string }>('package.json');
  // Self-reference by name: Node resolves it through this package.json's exports.
  const req = createRequire(path.join(REPO_ROOT, 'tests', 'package.test.ts'));

  it('exports ./package.json and gives "." a default condition after import and types', () => {
    expect(pkg.exports['./package.json']).toBe('./package.json');
    const root = pkg.exports['.'] as Record<string, string>;
    expect(Object.keys(root)).toEqual(['types', 'import', 'default']);
    expect(root.default).toBe(root.import);
    expect(root.default).toBe(pkg.main);
  });

  it('resolves @ashlr/lexicon/package.json through the exports map', () => {
    expect(req.resolve(`${pkg.name}/package.json`)).toBe(path.join(REPO_ROOT, 'package.json'));
  });

  it.skipIf(!BUILT)('resolves @ashlr/lexicon under the require condition to the default target (needs npm run build)', () => {
    expect(req.resolve(pkg.name)).toBe(path.join(REPO_ROOT, rel(pkg.main)));
  });
});
