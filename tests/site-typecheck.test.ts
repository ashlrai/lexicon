/**
 * site/ is the demo page's own module: a browser tsconfig (DOM lib, no node
 * types) over site/app.ts and the browser-safe core files it imports.
 * `npm run typecheck` compiles it after the root and extension configs, so a
 * change that only breaks the browser program (a node: global like `Buffer`
 * in an exporter app.ts imports, or an implicit any in site code) fails CI
 * even while both other compiles stay clean.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

interface Tsconfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

function readTsconfig(rel: string): Tsconfig {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')) as Tsconfig;
  if (!cfg.extends) return cfg;
  const parent = readTsconfig(path.posix.join(path.posix.dirname(rel), cfg.extends));
  return { ...parent, ...cfg, compilerOptions: { ...parent.compilerOptions, ...cfg.compilerOptions } };
}

describe('site module typecheck', () => {
  it('site/tsconfig.json compiles clean under strict', () => {
    const run = spawnSync(process.execPath, [TSC, '-p', 'site/tsconfig.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 55_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  }, 60_000);

  it('keeps strict and noImplicitAny on', () => {
    const opts = readTsconfig('site/tsconfig.json').compilerOptions ?? {};
    expect(opts.strict).toBe(true);
    expect(opts.noImplicitAny).toBe(true);
  });

  it('stays wired into npm run typecheck', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain('site/tsconfig.json');
  });
});
