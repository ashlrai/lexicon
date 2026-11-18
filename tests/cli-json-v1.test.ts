import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { jsonInvocation, jsonV1, versionedIO } from '../src/cli/json-output.js';
import { runDaemonCommand } from '../src/daemon/clipboard.js';
import { makeIO } from './helpers.js';

let home: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-json-v1-'));
  mkdirSync(path.join(home, '.git'));
  writeFileSync(path.join(home, 'lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  writeFileSync(path.join(home, 'terms.txt'), 'Kubernetes\n');
  env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'), LEXICON_PATH: path.join(home, 'lexicon.yaml'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData'), PATH: '', NO_COLOR: '1' };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', home, ...args],
    { env, encoding: 'utf8', timeout: 20_000 });
}

// Every existing command and nested action gets a real, isolated invocation.
// Writes use dry-run; protocols and interactive actions return useful refusals.
const cases: [string, string[], string][] = [
  ['init', ['--dry-run'], 'path'], ['add', ['Zed', 'zedd', '--dry-run'], 'term'],
  ['remove', ['Ashlr.AI', '--dry-run'], 'removed'], ['list', [], 'array'], ['terms', [], 'array'],
  ['terms add', ['Zed', '--heard', 'zedd', '--dry-run'], 'term'], ['normalize', ['Ashler'], 'output'],
  ['harvest', ['--limit', '1'], 'array'], ['export', [], 'formats'], ['path', [], 'global'],
  ['doctor', [], 'checks'], ['mcp', [], 'error'], ['hook', [], 'error'], ['daemon', [], 'error'],
  ['install-claude', [], 'client'], ['test-select', ['tests/cli-json-v1.test.ts'], 'commands'],
  ['import', ['terms.txt', 'text', '--dry-run'], 'counts'], ['install', ['cursor'], 'client'],
  ['uninstall', ['cursor', '--dry-run'], 'changes'], ['trust', ['--list'], 'trusted'],
  ['untrust', ['--dry-run'], 'error'], ['learn', ['Ashler', 'Ashlr.AI', '--dry-run'], 'heard'],
  ['stats', [], 'schemaVersion'], ['pending', [], 'pending'], ['pending list', [], 'pending'],
  ['pending accept', ['--all', '--dry-run'], 'accepted'], ['pending reject', ['--all', '--dry-run'], 'rejected'],
  ['serve', ['--status'], 'up'], ['voice', ['--status'], 'recording'],
  ['setup', ['--dry-run', '--clients', 'none', '--no-harvest', '--no-serve', '--no-packs'], 'plan'],
  ['suggest', [], 'array'], ['review', [], 'error'], ['edit', [], 'error'], ['pack', [], 'commands'],
  ['pack list', [], 'packs'], ['pack add', ['developer', '--dry-run'], '0.added'],
  ['pack remove', ['developer', '--dry-run'], 'removed'], ['pack show', ['developer'], 'name'],
  ['pack search', ['cardiology'], 'error'], ['pack update', ['--dry-run'], 'updates'],
  ['pack validate', ['registry/packs/cardiology.yaml'], 'errors'],
];

for (const [command, args, field] of cases) it(`${command} has a v1 shape`, () => {
  const resolved = args.map((arg) => arg === 'terms.txt' ? path.join(home, arg) : arg.startsWith('registry/') ? path.resolve(arg) : arg);
  const result = run([...command.split(' '), ...resolved, '--json=v1']);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const doc = JSON.parse(result.stdout);
  expect(Object.keys(doc)).toEqual(['schemaVersion', 'ok', 'data']);
  expect(doc).toMatchObject({ schemaVersion: 1, ok: result.status === 0 });
  if (field === 'array') expect(Array.isArray(doc.data)).toBe(true);
  else expect(doc.data).toHaveProperty(field);
});

it('keeps the coverage table complete as commands are added', () => {
  const names: string[] = [];
  const visit = (cmd: ReturnType<typeof buildProgram>, prefix = '') => {
    for (const sub of cmd.commands) {
      const name = `${prefix}${sub.name()}`;
      names.push(name);
      visit(sub, `${name} `);
    }
  };
  visit(buildProgram(makeIO()));
  expect(cases.map(([name]) => name).sort()).toEqual(names.sort());
});

it('preserves legacy JSON and human output', () => {
  expect(JSON.parse(run(['list', '--json']).stdout)).toEqual([{ canonical: 'Ashlr.AI', aliases: ['Ashler'], scope: 'global' }]);
  expect(run(['normalize', 'Ashler']).stdout).toBe('Ashlr.AI\n');
  const legacy = run(['path', '--json']);
  const versioned = run(['path', '--json=v1']);
  expect(JSON.parse(versioned.stdout).data).toEqual(JSON.parse(legacy.stdout));
  expect(run(['path']).stdout).not.toContain('schemaVersion');
});

it('versions parser errors, unknown versions, aliases, help and literal text', () => {
  for (const args of [['add'], ['list', '--limit', 'no'], ['unknown'], ['voice', '--seconds', 'no']]) {
    expect(JSON.parse(run([...args, '--json=v1']).stdout)).toMatchObject({ schemaVersion: 1, ok: false, data: { error: expect.any(String), nextStep: expect.any(String) } });
  }
  expect(JSON.parse(run(['add', 'NeverWritten', '--json=v2']).stdout).data.nextStep).toBe('use --json=v1');
  expect(JSON.parse(run(['list', '--json']).stdout)).toHaveLength(1);
  expect(JSON.parse(run(['ls', '--json=v1']).stdout).data).toHaveLength(1);
  expect(JSON.parse(run(['status', '--json=v1']).stdout).data.checks).toBeInstanceOf(Array);
  expect(JSON.parse(run(['list', '--help', '--json=v1']).stdout).data.output).toContain('Usage:');
  expect(JSON.parse(run(['--version', '--json=v1']).stdout).data.output).toMatch(/^\d+\.\d+\.\d+\n$/);
  expect(JSON.parse(run(['normalize', '--json=v1', '--', '-v']).stdout).data.output).toBe('-v');
  const batch = run(['pack', 'add', 'developer', 'missing-pack', '--dry-run', '--json=v1']);
  expect(batch.status).toBe(1);
  expect(JSON.parse(batch.stdout)).toMatchObject({ schemaVersion: 1, ok: false, data: [{ ok: true }, { ok: false }] });
  expect(run(['normalize', '--', '--json=v1']).stdout).toBe('--json=v1\n');
  expect(jsonInvocation(['normalize', '--json=v1', '--', '-v']).args).toEqual(['normalize', '--json', '--', '-v']);
  expect(jsonV1([{ ok: true }, { ok: false, error: 'failed' }]).ok).toBe(false);
});

it('reports clipboard detection and one-shot results without human text', async () => {
  for (const which of [true, false]) {
    const io = makeIO();
    const code = await runDaemonCommand({ json: true, which, once: !which, quiet: true,
      read: async () => '', write: async () => {}, out: versionedIO(io).stdout, err: io.stderr });
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ schemaVersion: 1, ok: true,
      data: which ? { backend: 'injected' } : { changed: false, written: false, corrections: 0, pasted: false } });
  }
});
