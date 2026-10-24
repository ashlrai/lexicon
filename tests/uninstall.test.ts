import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from '../src/cli/cmd-install.js';
import type { InstallDeps } from '../src/cli/cmd-install.js';
import {
  registerUninstallCommands,
  removeHooksFromSettings,
  removeServerFromJson,
  removeServerFromToml,
  runUninstall,
} from '../src/cli/cmd-uninstall.js';
import type { UninstallDeps, UninstallOptions } from '../src/cli/cmd-uninstall.js';
import { shellWord } from '../src/core/index.js';
import { makeIO } from './helpers.js';

const CLI_DIR = '/opt/lexicon/dist/cli';
const SERVER = path.resolve(CLI_DIR, '../mcp/server.js');

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-uninstall-home-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-uninstall-cwd-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const installDeps: InstallDeps = { platform: 'darwin', env: { PATH: '' }, cliDir: CLI_DIR };

async function install(client: string, extra: Record<string, unknown> = {}, deps: InstallDeps = installDeps): Promise<void> {
  expect(await runInstall(client, { home, cwd, apply: true, ...extra }, makeIO(), deps)).toBe(0);
}

async function uninstall(client: string | undefined, extra: Partial<UninstallOptions> = {}, deps: UninstallDeps = { platform: 'darwin', env: { PATH: '' } }) {
  const io = makeIO();
  const code = await runUninstall(client, { home, cwd, ...extra }, io, deps);
  return { code, io };
}

// Catches: install and uninstall put every path through the 200-character
// display cap, so a deep home directory's config file (the file written, the
// undo line, the file to fix) ended in an ellipsis.
describe('install and uninstall name a deep config path whole', () => {
  it('cursor and claude', async () => {
    const deep = path.join(home, ...Array.from({ length: 10 }, (_, i) => `a-rather-long-directory-name-${i}`));
    const file = path.join(deep, '.cursor', 'mcp.json');
    const settings = path.join(deep, '.claude', 'settings.json');
    const io = makeIO();
    expect(await runInstall('cursor', { home: deep, cwd, apply: true }, io, installDeps)).toBe(0);
    expect(io.out).toContain(`merge into ${file}:`);
    expect(io.out).toContain(`created ${file}: mcpServers.lexicon`);
    expect(io.out).toContain(`undo: delete the "lexicon" entry under "mcpServers" in ${file} (this run created`);
    const claude = makeIO();
    expect(await runInstall('claude', { home: deep, cwd, apply: true }, claude, { ...installDeps, exec: () => 'Added' })).toBe(0);
    expect(claude.out).toContain(`created ${settings}: added`);
    const un = makeIO();
    expect(await runUninstall('cursor', { home: deep, cwd }, un, { platform: 'darwin', env: { PATH: '' } })).toBe(0);
    expect(un.out).toContain(`removed mcpServers.lexicon from ${file}`);
    await fs.writeFile(file, '{ not json');
    await expect(runUninstall('cursor', { home: deep, cwd }, makeIO(), { platform: 'darwin', env: { PATH: '' } })).rejects.toThrow(`could not read ${file} (`);
    expect(`${io.out}${claude.out}${un.out}`).not.toContain('\u2026');
  });
});

describe('lexicon uninstall <json client>', () => {
  // Catches: there was no way to take an install back out short of editing
  // each client's config by hand.
  it('gives back the file as it was before install, comments and formatting included', async () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const before = '{\n    // my servers\n    "mcpServers": {\n        "other": { "command": "x", "args": ["a", "b"] } // keep\n    },\n    "theme": "dark",\n}\n';
    await fs.writeFile(file, before);
    await install('cursor');
    expect(await fs.readFile(file, 'utf8')).toContain('"lexicon"');

    const dry = await uninstall('cursor', { dryRun: true });
    expect(dry.code).toBe(0);
    expect(dry.io.out).toContain(`would remove mcpServers.lexicon from ${file}`);
    expect(dry.io.out).toContain(`to remove it, run: lexicon --cwd ${shellWord(cwd)} uninstall cursor --home ${shellWord(home)}`);
    expect(await fs.readFile(file, 'utf8')).toContain('"lexicon"');

    const real = await uninstall('cursor');
    expect(real.code).toBe(0);
    expect(real.io.out).toContain(`removed mcpServers.lexicon from ${file}`);
    expect(real.io.out).toContain('lexicon install cursor --apply puts it back');
    expect(await fs.readFile(file, 'utf8')).toBe(before);

    const again = await uninstall('cursor');
    expect(again.io.out).toContain(`${file}: no mcpServers.lexicon, nothing to remove`);
  });

  it('removes the VS Code servers entry at project scope and leaves a missing file alone', async () => {
    await install('vscode', { project: true });
    const file = path.join(cwd, '.vscode', 'mcp.json');
    const { io } = await uninstall('vscode', { scope: 'project' });
    expect(io.out).toContain(`removed servers.lexicon from ${file}`);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ servers: {} });
    const missing = await uninstall('gemini');
    expect(missing.code).toBe(0);
    expect(missing.io.out).toContain(`${path.join(home, '.gemini', 'settings.json')}: does not exist, nothing to remove`);
  });

  it('never touches a "lexicon" server lexicon install did not write', async () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const mine = JSON.stringify({ mcpServers: { lexicon: { command: 'python3', args: ['/me/lexicon.py'] } } }, null, 2);
    await fs.writeFile(file, mine);
    const { code, io } = await uninstall('cursor');
    expect(code).toBe(0);
    expect(io.out).toContain(`${file}: mcpServers.lexicon was not written by lexicon install (python3 /me/lexicon.py); left as it is`);
    expect(await fs.readFile(file, 'utf8')).toBe(mine);
  });

  it('refuses a file it cannot parse, an unknown client and no client, writing nothing', async () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ nope');
    await expect(uninstall('cursor')).rejects.toThrow(/could not read .*nothing was changed/);
    expect(await fs.readFile(file, 'utf8')).toBe('{ nope');
    await expect(uninstall('emacs')).rejects.toThrow(/unknown client "emacs"/);
    await expect(uninstall(undefined)).rejects.toThrow(/name the client/);
    await expect(uninstall('generic')).rejects.toThrow(/unknown client/);
  });

  it('--json prints the changes', async () => {
    await install('windsurf');
    const { code, io } = await uninstall('windsurf', { json: true, dryRun: true });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc).toMatchObject({
      ok: true,
      client: 'windsurf',
      scope: 'user',
      dryRun: true,
      changes: [{ file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), entry: 'mcpServers.lexicon', outcome: 'removed' }],
    });
    const bad = await uninstall('nope', { json: true });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.io.out)).toMatchObject({ ok: false });
    expect(bad.io.err).toContain('lexicon: unknown client "nope"');
  });
});

describe('lexicon uninstall codex', () => {
  it('removes the lexicon table and its env sub-table, leaving the rest of config.toml', async () => {
    const file = path.join(home, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const before = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n# trailing note\n';
    await fs.writeFile(file, before);
    await install('codex', {}, { ...installDeps, env: { PATH: '', LEXICON_PATH: '/l/lexicon.yaml' } });
    const installed = await fs.readFile(file, 'utf8');
    expect(installed).toContain('[mcp_servers.lexicon]');
    const { io } = await uninstall('codex');
    expect(io.out).toContain(`removed [mcp_servers.lexicon] from ${file}`);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('pure: sub-tables go with an owned table, a foreign table stays', () => {
    const owned = `a = 1\n\n[mcp_servers.lexicon]\ncommand = "node"\nargs = [${JSON.stringify(SERVER)}]\n\n[mcp_servers.lexicon.env]\nLEXICON_PATH = "/x"\n\n[other]\nb = 2\n`;
    expect(removeServerFromToml(owned)).toEqual({ next: 'a = 1\n\n[other]\nb = 2\n', outcome: 'removed' });
    const foreign = '[mcp_servers.lexicon]\ncommand = "lexicon-dev"\nargs = []\n';
    expect(removeServerFromToml(foreign)).toEqual({ next: foreign, outcome: 'kept' });
    expect(removeServerFromToml('x = 1\n').outcome).toBe('absent');
  });
});

describe('lexicon uninstall claude', () => {
  const get = (args: string, scope = 'User config (available in all your projects)') =>
    `lexicon:\n  Scope: ${scope}\n  Status: ok\n  Type: stdio\n  Command: node\n  Args: ${args}\n`;

  it('removes the registration and only the lexicon hooks', async () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    await install('claude', {}, { ...installDeps, exec: () => 'Added' });
    // A hook of the user's own, in the same event and in its own group.
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };
    settings.hooks.UserPromptSubmit?.[0]?.hooks.push({ type: 'command', command: 'echo mine' });
    settings.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'echo pre' }] }];
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const calls: string[][] = [];
    const exec = (_f: string, args: readonly string[]): string => {
      calls.push([...args]);
      return args[1] === 'get' ? get(SERVER) : 'Removed';
    };
    const dry = await uninstall('claude', { dryRun: true }, { env: { PATH: '' }, exec });
    expect(dry.code).toBe(0);
    expect(calls.map((c) => c[1])).toEqual(['get']);
    expect(dry.io.out).toContain('would remove lexicon server from claude mcp (user scope)');
    expect(dry.io.out).toContain(`would remove lexicon hooks (hooks.UserPromptSubmit, hooks.SessionStart) from ${settingsPath}`);

    const { code, io } = await uninstall('claude', {}, { env: { PATH: '' }, exec });
    expect(code).toBe(0);
    expect(calls.at(-1)).toEqual(['mcp', 'remove', '--scope', 'user', 'lexicon']);
    expect(io.out).toContain(`removed lexicon hooks (hooks.UserPromptSubmit, hooks.SessionStart) from ${settingsPath}`);
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    });
  });

  it('leaves a foreign registration, one at another scope and an unregistered one alone', async () => {
    for (const [out, expected] of [
      [get('/me/mine.js'), 'lexicon server was not written by lexicon install (node /me/mine.js); left as it is'],
      [get(SERVER, 'Project config (shared via .mcp.json)'), 'the lexicon server is registered at project scope, not user'],
    ] as const) {
      const calls: string[][] = [];
      const exec = (_f: string, args: readonly string[]): string => {
        calls.push([...args]);
        return out;
      };
      const { code, io } = await uninstall('claude', {}, { env: { PATH: '' }, exec });
      expect(code).toBe(0);
      expect(io.out).toContain(expected);
      expect(calls.some((c) => c[1] === 'remove')).toBe(false);
    }
    const none = await uninstall('claude', {}, {
      env: { PATH: '' },
      exec: () => {
        throw new Error('No MCP server found with name: lexicon');
      },
    });
    expect(none.code).toBe(0);
    expect(none.io.out).toContain('no lexicon server registered, nothing to remove');
    const broken = await uninstall('claude', {}, {
      env: { PATH: '' },
      exec: () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    expect(broken.code).toBe(1);
    expect(broken.io.out).toContain('to remove it by hand: claude mcp remove --scope user lexicon');
  });

  // Catches: `claude mcp get` has no --scope and shows the local-scope
  // registration over the user-scope one, so the user-scope server an
  // install wrote was reported as not registered and left behind.
  it('removes the user-scope registration under a local-scope one, read from .claude.json', async () => {
    const local = get('/me/local.js', 'Local config (private to you in this project)');
    const calls: string[][] = [];
    const exec = (_f: string, args: readonly string[]): string => {
      calls.push([...args]);
      return args[1] === 'get' ? local : 'Removed';
    };
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { lexicon: { type: 'stdio', command: 'node', args: [SERVER] } } }));
    const { code, io } = await uninstall('claude', {}, { env: { PATH: '' }, exec });
    expect(code).toBe(0);
    expect(calls.at(-1)).toEqual(['mcp', 'remove', '--scope', 'user', 'lexicon']);
    expect(io.out).toContain('removed lexicon server from claude mcp (user scope)');
    expect(io.out).toContain('note: a local-scope lexicon registration is there too and stays; to remove it: claude mcp remove --scope local lexicon');

    // A user-scope server of the user's own under it is named and kept.
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { lexicon: { command: 'python3', args: ['/me/mine.py'] } } }));
    calls.length = 0;
    const kept = await uninstall('claude', {}, { env: { PATH: '' }, exec });
    expect(kept.io.out).toContain('lexicon server was not written by lexicon install (python3 /me/mine.py); left as it is');
    expect(calls.some((c) => c[1] === 'remove')).toBe(false);

    // CLAUDE_CONFIG_DIR moves .claude.json.
    const dir = path.join(home, 'alt');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { lexicon: { command: 'node', args: [SERVER] } } }));
    calls.length = 0;
    await uninstall('claude', {}, { env: { PATH: '', CLAUDE_CONFIG_DIR: dir }, exec, settingsPath: path.join(dir, 'settings.json') });
    expect(calls.at(-1)).toEqual(['mcp', 'remove', '--scope', 'user', 'lexicon']);

    // An unreadable one is a failure that says how to remove it by hand.
    await fs.writeFile(path.join(home, '.claude.json'), '{ not json');
    const broken = await uninstall('claude', {}, { env: { PATH: '' }, exec });
    expect(broken.code).toBe(1);
    expect(broken.io.out).toContain(`could not read ${path.join(home, '.claude.json')} to check the user-scope registration (claude mcp get shows the local-scope one)`);
    expect(broken.io.out).toContain('to remove it by hand: claude mcp remove --scope user lexicon');
  });

  it('removes the project-scope registration under a local-scope one, read from .mcp.json', async () => {
    const calls: string[][] = [];
    const exec = (_f: string, args: readonly string[]): string => {
      calls.push([...args]);
      return args[1] === 'get' ? get('/me/local.js', 'Local config (private to you in this project)') : 'Removed';
    };
    await fs.writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { lexicon: { command: 'node', args: [SERVER] } } }));
    const { io } = await uninstall('claude', { scope: 'project' }, { env: { PATH: '' }, exec });
    expect(calls.at(-1)).toEqual(['mcp', 'remove', '--scope', 'project', 'lexicon']);
    expect(io.out).toContain('removed lexicon server from claude mcp (project scope)');
  });

  it('at project scope reads the repo settings.json', async () => {
    await install('claude', { scope: 'project' }, { ...installDeps, exec: () => 'Added' });
    const exec = (_f: string, args: readonly string[]): string => (args[1] === 'get' ? get(SERVER, 'Project config (shared via .mcp.json)') : '');
    const { io } = await uninstall('claude', { scope: 'project' }, { env: { PATH: '' }, exec });
    const file = path.join(cwd, '.claude', 'settings.json');
    expect(io.out).toContain(`removed lexicon hooks (hooks.UserPromptSubmit, hooks.SessionStart) from ${file}`);
    expect(io.out).toContain('removed lexicon server from claude mcp (project scope)');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({});
  });
});

describe('pure helpers', () => {
  it('removeServerFromJson and removeHooksFromSettings never mutate their input', () => {
    const cfg = { mcpServers: { lexicon: { command: 'npx', args: ['-y', '@ashlr/lexicon@0.5.0', 'mcp'] }, b: {} } };
    const copy = structuredClone(cfg);
    expect(removeServerFromJson(cfg, 'mcpServers')).toEqual({ next: { mcpServers: { b: {} } }, outcome: 'removed' });
    expect(cfg).toEqual(copy);
    const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${path.join('/x', 'plugin', 'hook.mjs')}"` }] }] }, other: 1 };
    const before = structuredClone(settings);
    expect(removeHooksFromSettings(settings)).toEqual({ settings: { other: 1 }, removed: 1 });
    expect(settings).toEqual(before);
    expect(removeHooksFromSettings({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'lexicon-my-script.sh' }] }] } }).removed).toBe(0);
  });

  it('registers `uninstall [client]` with --dry-run on a commander program', () => {
    const program = new Command().name('lexicon').option('--cwd <dir>');
    registerUninstallCommands(program, makeIO());
    const cmd = program.commands.find((c) => c.name() === 'uninstall');
    expect(cmd?.options.map((o) => o.long)).toEqual(['--dry-run', '--scope', '--project', '--home', '--json']);
  });
});
