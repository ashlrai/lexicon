/**
 * The shared exit-codes table (src/cli/exit-codes.ts): one command per code,
 * through the real CLI, plus the table shown in --help and in the README.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE, exitCodesHelpText } from '../src/cli/exit-codes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'lexicon-exit-'));
const lexiconPath = join(home, 'lexicon.yaml');
writeFileSync(lexiconPath, 'version: 1\nterms: []\n');

function lexicon(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', home, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, LEXICON_PATH: lexiconPath },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('exit codes', () => {
  it('names two numbers: 0 ok, 1 for usage, not found and runtime failure', () => {
    expect([EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_FAILURE]).toEqual([0, 1, 1, 1]);
  });

  it('0 success: lexicon path', () => {
    expect(lexicon(['path']).status).toBe(EXIT_OK);
  });

  it('1 usage error: an unknown command', () => {
    expect(lexicon(['xyzzy']).status).toBe(EXIT_USAGE);
  });

  it('1 not found: remove a term that is not there, with the same --json shape as before', () => {
    const r = lexicon(['remove', 'Nothere', '--json']);
    expect(r.status).toBe(EXIT_NOT_FOUND);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(doc.ok).toBe(false);
    expect(doc).not.toHaveProperty('code');
    expect(typeof doc.error).toBe('string');
    expect(typeof doc.nextStep).toBe('string');
  });

  it('1 runtime failure: a --cwd that is not a directory', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', join(home, 'nope'), 'list'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LEXICON_PATH: lexiconPath },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(EXIT_FAILURE);
  });

  it('--help and the README both list the codes', () => {
    expect(lexicon(['--help']).stdout).toContain(exitCodesHelpText());
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toMatch(/\| 0 \| ok \|\n\| 1 \| failed/);
  });
});
