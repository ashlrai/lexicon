/**
 * `--version` and `--help` stay byte-identical, and the version path does not
 * load the lexicon core. No timings: a slow machine must not flake this.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM_DIST = process.env.LEXICON_E2E_DIST === '1';
const CLI = FROM_DIST ? path.join(ROOT, 'dist/cli/index.js') : path.join(ROOT, 'src/cli/index.ts');
const MCP = FROM_DIST ? path.join(ROOT, 'dist/mcp/server.js') : path.join(ROOT, 'src/mcp/server.ts');
const TRACE = path.join(ROOT, 'tests/helpers/import-trace.mjs');
const HELP = readFileSync(path.join(ROOT, 'tests/fixtures/cli-help.txt'), 'utf8');
const VERSION = `${JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string}\n`;

/** Linked by a real command, and by nothing the version flag needs. */
const VERSION_SKIPS = [
  '/src/core/index.ts',
  '/dist/core/index.js',
  '/node_modules/zod/',
  '/node_modules/yaml/',
  '/node_modules/double-metaphone/',
  '/src/cli/commands.ts',
  '/dist/cli/commands.js',
  '/src/cli/program.ts',
  '/dist/cli/program.js',
  '/src/cli/run.ts',
  '/dist/cli/run.js',
  '/node_modules/commander/',
];

/** Help builds the commander program. It still must not load the lexicon core. */
const HELP_SKIPS = [
  '/src/core/index.ts',
  '/dist/core/index.js',
  '/node_modules/zod/',
  '/node_modules/yaml/',
  '/node_modules/double-metaphone/',
  '/src/cli/commands.ts',
  '/dist/cli/commands.js',
  '/src/cli/cmd-voice.ts',
  '/dist/cli/cmd-voice.js',
  '/src/voice/',
  '/dist/voice/',
  '/src/serve/config.ts',
  '/dist/serve/config.js',
  '/src/serve/server.ts',
  '/dist/serve/server.js',
];

function nodeArgs(script: string): string[] {
  return /\.[cm]?js$/.test(script) ? [script] : ['--import', 'tsx', script];
}

function run(script: string, args: readonly string[], traceFile?: string, stdin?: string): { code: number | null; stdout: string; stderr: string; urls: string } {
  const r = spawnSync(process.execPath, ['--import', TRACE, ...nodeArgs(script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: stdin,
    timeout: 15_000,
    env: { ...process.env, ...(traceFile ? { LEXICON_IMPORT_TRACE: traceFile } : {}) },
  });
  const urls = traceFile ? readFileSync(traceFile, 'utf8') : '';
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, urls };
}

function traceFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'lexicon-trace-')), 'urls.txt');
}

describe('CLI startup', () => {
  it('prints the package version for --version, -V and -v', () => {
    for (const flag of ['--version', '-V', '-v']) {
      const r = run(CLI, [flag]);
      expect(r.code, flag).toBe(0);
      expect(r.stdout, flag).toBe(VERSION);
      expect(r.stderr, flag).toBe('');
    }
  });

  it('prints the same help for --help and -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = run(CLI, [flag]);
      expect(r.code, flag).toBe(0);
      expect(r.stdout, flag).toBe(HELP);
      expect(r.stderr, flag).toBe('');
    }
  });

  it('does not import the core, commander or command handlers for --version', () => {
    const file = traceFile();
    const r = run(CLI, ['--version'], file);
    expect(r.stdout).toBe(VERSION);
    expect(r.code).toBe(0);
    for (const heavy of VERSION_SKIPS) expect(r.urls, heavy).not.toContain(heavy);
  });

  it('does not import the core or command handlers for --help', () => {
    const file = traceFile();
    const r = run(CLI, ['--help'], file);
    expect(r.stdout).toBe(HELP);
    // commander is how help is built. If the trace missed it, the guard below
    // would pass for the wrong reason.
    expect(r.urls).toContain('/node_modules/commander/');
    for (const heavy of HELP_SKIPS) expect(r.urls, heavy).not.toContain(heavy);
  });

  it('does not import the lexicon core while answering MCP initialize', () => {
    const file = traceFile();
    const r = run(
      MCP,
      [],
      file,
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-test', version: '0' } },
      })}\n`,
    );
    expect(r.stdout).toContain('"protocolVersion":"2025-06-18"');
    expect(r.stdout).toContain('"name":"lexicon"');
    expect(r.urls).not.toContain('/src/core/index.ts');
    expect(r.urls).not.toContain('/dist/core/index.js');
    expect(r.urls).not.toContain('/node_modules/yaml/');
    expect(r.urls).not.toContain('/node_modules/double-metaphone/');
    expect(r.urls).not.toContain('/src/cli/commands.ts');
    expect(r.urls).not.toContain('/dist/cli/commands.js');
    expect(r.urls).not.toContain('/src/cli/cmd-import.ts');
    expect(r.urls).not.toContain('/dist/cli/cmd-import.js');
  });
});
