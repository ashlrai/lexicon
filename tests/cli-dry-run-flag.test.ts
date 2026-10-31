/** Exercise the public flag, including the write that each preview promises. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { LIMITS } from '../src/core/schema.js';
import { makeIO } from './helpers.js';

const seed = '# Keep this comment and formatting.\nversion: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, Ashlar]\n';
let home: string;
let cwd: string;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-dry-run-flag-')));
  cwd = path.join(home, 'repo');
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  projectPath = path.join(cwd, '.lexicon.yaml');
  mkdirSync(path.join(cwd, '.git'), { recursive: true });
  mkdirSync(path.dirname(globalPath), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('LEXICON_PATH', globalPath);
  vi.stubEnv('LEXICON_TRUST_ALL', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function cli(args: string[], code = 0): Promise<string> {
  const io = makeIO();
  const previousCode = process.exitCode;
  process.exitCode = 0;
  try {
    await buildProgram(io).parseAsync(['--cwd', cwd, ...args], { from: 'user' });
    expect(process.exitCode, io.err).toBe(code);
    return io.out;
  } finally {
    process.exitCode = previousCode;
  }
}

// Include sidecars and mtimes so an identical rewrite or new cache also fails.
function snapshot() {
  return readdirSync(home, { recursive: true, encoding: 'utf8' }).sort().map((name) => {
    const file = path.join(home, name);
    const stat = statSync(file);
    return [name, stat.isDirectory() ? 'directory' : [readFileSync(file).toString('hex'), stat.mtimeMs, stat.mode]];
  });
}

const cases = [
  { name: 'init', args: ['init'], plan: 'would create', applied: 'created', changesLexicon: true },
  { name: 'add', args: ['add', 'QuasarBridge', 'quasar bridge'], plan: 'would create QuasarBridge', applied: 'created QuasarBridge', changesLexicon: true },
  { name: 'remove', args: ['remove', 'Ashlr.AI'], plan: 'would remove Ashlr.AI', applied: 'removed Ashlr.AI', changesLexicon: true },
  { name: 'learn', args: ['learn', 'Ashlur', 'Ashlr.AI'], plan: 'would learn Ashlur -> Ashlr.AI', applied: 'learned Ashlur -> Ashlr.AI', changesLexicon: true },
  { name: 'untrust', args: ['untrust'], plan: 'would untrust', applied: 'untrusted', changesLexicon: false },
  { name: 'pack add', args: ['pack', 'add', 'voice-tools'], plan: 'would install voice-tools', applied: 'installed voice-tools', changesLexicon: true },
];

describe.each(['global', 'project'] as const)('%s CLI dry-run flag acceptance', (scope) => {
  it.each(cases)('$name prints its plan, preserves bytes, and permits the promised write', async (test) => {
    const target = scope === 'project' ? projectPath : globalPath;
    // Untrust always targets a project; all other commands exercise both scopes.
    writeFileSync(projectPath, scope === 'project' ? seed : 'version: 1\nterms: []\n');
    writeFileSync(globalPath, seed);
    await cli(['trust', '--yes']);
    if (test.name === 'init') rmSync(target);
    const args = [...test.args, ...(test.name === 'untrust' ? [projectPath] : scope === 'project' ? ['--project'] : [])];
    const before = snapshot();
    const original = test.name === 'init' ? undefined : readFileSync(target);
    const plan = await cli([...args, '--dry-run']);
    expect(plan).toContain(test.plan);
    expect(plan).toContain(test.name === 'untrust' ? projectPath : target);
    expect(snapshot()).toEqual(before);
    expect(await cli(args)).toContain(test.applied);
    const actual = readFileSync(target);
    if (test.changesLexicon) expect(actual).not.toEqual(original);
    else {
      expect(actual).toEqual(original);
      expect(JSON.parse(await cli(['trust', '--list', '--json'])).trusted).toEqual([]);
      expect(await cli(['untrust', projectPath])).toContain('was not trusted');
    }
  });

  it.each([true, false])('rejects overflowing pack metadata before writing (dry-run=%s)', async (dry) => {
    const target = scope === 'project' ? projectPath : globalPath;
    const packs = Array.from({ length: LIMITS.aliases }, (_, i) => `pack-${i}`);
    writeFileSync(target, `${seed}settings:\n  packs: ${JSON.stringify(packs)}\n`);
    if (scope === 'project') await cli(['trust', '--yes']);
    const before = snapshot();
    const args = ['pack', 'add', 'voice-tools', '--json', ...(scope === 'project' ? ['--project'] : []), ...(dry ? ['--dry-run'] : [])];
    const result = JSON.parse(await cli(args, 1));
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('settings.packs');
    expect(snapshot()).toEqual(before);
  });
});
