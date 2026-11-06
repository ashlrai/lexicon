/**
 * Exit code for an unknown command.
 *
 * This file intentionally does not mock the core: the unknown-command handler
 * lives in program.ts and only Commander participates, so mocking core would
 * break the behaviour we are testing.
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Spawn the real CLI and return status + stdout/stderr. */
function lexicon(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('lexicon <unknown-command>', () => {
  it('exits non-zero when given a command that does not exist', () => {
    const r = lexicon(['xyzzy']);
    expect(r.status).toBeTypeOf('number');
    expect(r.status).not.toBe(0);
  });

  it('prints a plain "unknown command" message on stderr', () => {
    const r = lexicon(['foobar']);
    expect(r.stderr).toContain('unknown command');
  });

  it('exits non-zero for any nonsense string as a top-level command', () => {
    const r = lexicon(['qzxsw']);
    expect(r.status).not.toBe(0);
  });
});
