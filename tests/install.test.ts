import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_TABLE,
  codexBlock,
  configPathFor,
  mergeServerIntoJson,
  registerInstallCommands,
  runInstall,
  upsertTomlTable,
} from '../src/cli/cmd-install.js';
import type { InstallDeps, InstallOptions } from '../src/cli/cmd-install.js';
import { hookTimeoutFor, isVolatileEntry, launchCommandLine, launchFor } from '../src/cli/claude-settings.js';
import { makeIO } from './helpers.js';

const CLI_DIR = '/opt/lexicon/dist/cli';
const SERVER = path.resolve(CLI_DIR, '../mcp/server.js');


let home: string;
let cwd: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-install-home-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-install-cwd-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const baseDeps = (platform: NodeJS.Platform = 'darwin'): InstallDeps => ({
  platform,
  env: { PATH: '' },
  cliDir: CLI_DIR,
});

async function run(client: string, extra: Partial<InstallOptions> = {}, deps = baseDeps()) {
  const io = makeIO();
  const code = await runInstall(client, { home, cwd, ...extra }, io, deps);
  return { code, io };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

interface JsonClientCase {
  client: 'cursor' | 'windsurf' | 'gemini' | 'claude-desktop' | 'vscode';
  rel: string;
  key: 'mcpServers' | 'servers';
  entry: Record<string, unknown>;
  rulesHint: string;
}

const JSON_CASES: JsonClientCase[] = [
  {
    client: 'cursor',
    rel: '.cursor/mcp.json',
    key: 'mcpServers',
    entry: { command: 'node', args: [SERVER] },
    rulesHint: '.cursor/rules',
  },
  {
    client: 'windsurf',
    rel: '.codeium/windsurf/mcp_config.json',
    key: 'mcpServers',
    entry: { command: 'node', args: [SERVER] },
    rulesHint: '.windsurfrules',
  },
  {
    client: 'gemini',
    rel: '.gemini/settings.json',
    key: 'mcpServers',
    entry: { command: 'node', args: [SERVER] },
    rulesHint: 'GEMINI.md',
  },
  {
    client: 'claude-desktop',
    rel: 'Library/Application Support/Claude/claude_desktop_config.json',
    key: 'mcpServers',
    entry: { command: 'node', args: [SERVER] },
    rulesHint: 'project instructions',
  },
  {
    client: 'vscode',
    rel: 'Library/Application Support/Code/User/mcp.json',
    key: 'servers',
    entry: { type: 'stdio', command: 'node', args: [SERVER] },
    rulesHint: 'copilot-instructions.md',
  },
];

describe('lexicon install <json client> --apply', () => {
  for (const c of JSON_CASES) {
    describe(c.client, () => {
      it('creates the file with the lexicon entry and is a no-op on the second run', async () => {
        const file = path.join(home, c.rel);

        const first = await run(c.client, { apply: true });
        expect(first.code).toBe(0);
        expect(first.io.out).toContain(`created ${file}`);
        expect(first.io.out).toContain('lexicon export claude-md');
        expect(first.io.out).toContain(c.rulesHint);

        const written = await readJson(file);
        expect(written).toEqual({ [c.key]: { lexicon: c.entry } });
        // 2-space indentation, trailing newline.
        const raw = await fs.readFile(file, 'utf8');
        expect(raw).toBe(`${JSON.stringify(written, null, 2)}\n`);

        const second = await run(c.client, { apply: true });
        expect(second.code).toBe(0);
        expect(second.io.out).toContain('nothing changed');
        expect(await fs.readFile(file, 'utf8')).toBe(raw);
      });

      it('preserves unrelated keys and other servers, and replaces a stale lexicon entry', async () => {
        const file = path.join(home, c.rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify(
            {
              theme: 'dark',
              [c.key]: {
                other: { command: 'other-mcp', args: ['--x'] },
                lexicon: { command: 'node', args: ['/old/path/server.js'] },
              },
            },
            null,
            2,
          ),
        );

        const { code, io } = await run(c.client, { apply: true });
        expect(code).toBe(0);
        expect(io.out).toContain(`updated ${file}`);

        const written = await readJson(file);
        expect(written.theme).toBe('dark');
        const servers = written[c.key] as Record<string, unknown>;
        expect(servers.other).toEqual({ command: 'other-mcp', args: ['--x'] });
        expect(servers.lexicon).toEqual(c.entry);
      });

      it('prints the plan without writing when --apply is absent', async () => {
        const file = path.join(home, c.rel);
        const { code, io } = await run(c.client);
        expect(code).toBe(0);
        expect(io.out).toContain('would merge into');
        expect(io.out).toContain(file);
        expect(io.out).toContain('--apply');
        await expect(fs.access(file)).rejects.toThrow();
      });
    });
  }

  it('refuses to overwrite a file that is not valid JSON', async () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json');
    await expect(run('cursor', { apply: true })).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json');
  });

  it('writes the project-level file with --project / --scope project', async () => {
    const a = await run('cursor', { apply: true, project: true });
    expect(a.code).toBe(0);
    const cursorFile = path.join(cwd, '.cursor', 'mcp.json');
    expect(await readJson(cursorFile)).toEqual({ mcpServers: { lexicon: { command: 'node', args: [SERVER] } } });

    const b = await run('vscode', { apply: true, scope: 'project' });
    expect(b.code).toBe(0);
    expect(await readJson(path.join(cwd, '.vscode', 'mcp.json'))).toEqual({
      servers: { lexicon: { type: 'stdio', command: 'node', args: [SERVER] } },
    });

    // Nothing landed in the home directory.
    await expect(fs.access(path.join(home, '.cursor'))).rejects.toThrow();
  });

  it('rejects --project for clients without a project-level config', async () => {
    await expect(run('windsurf', { project: true })).rejects.toThrow(/no project-level/);
    await expect(run('claude-desktop', { project: true })).rejects.toThrow(/no project-level/);
  });
});

describe('lexicon install codex --apply (TOML)', () => {
  const rel = '.codex/config.toml';
  const block = `[${CODEX_TABLE}]\ncommand = "node"\nargs = [${JSON.stringify(SERVER)}]`;

  it('creates config.toml with the block and is a no-op on the second run', async () => {
    const file = path.join(home, rel);
    const first = await run('codex', { apply: true });
    expect(first.code).toBe(0);
    expect(first.io.out).toContain(`created ${file}`);
    expect(first.io.out).toContain('AGENTS.md');
    expect(await fs.readFile(file, 'utf8')).toBe(`${block}\n`);

    const second = await run('codex', { apply: true });
    expect(second.io.out).toContain('nothing changed');
    expect(await fs.readFile(file, 'utf8')).toBe(`${block}\n`);
  });

  it('replaces an existing [mcp_servers.lexicon] block and keeps everything else', async () => {
    const file = path.join(home, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = [
      'model = "o3"',
      '',
      '[mcp_servers.lexicon]',
      'command = "node"',
      'args = ["/old/server.js"]',
      '',
      '[mcp_servers.lexicon.env]',
      'FOO = "bar"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');
    await fs.writeFile(file, original);

    const { io } = await run('codex', { apply: true });
    expect(io.out).toContain(`updated ${file}`);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toBe(
      [
        'model = "o3"',
        '',
        block,
        '',
        '[mcp_servers.lexicon.env]',
        'FOO = "bar"',
        '',
        '[mcp_servers.other]',
        'command = "other"',
        '',
      ].join('\n'),
    );
    expect(text).not.toContain('/old/server.js');
    expect(text.match(/\[mcp_servers\.lexicon\]/g)).toHaveLength(1);
  });

  it('appends after existing content when the block is absent', async () => {
    const file = path.join(home, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n');
    await run('codex', { apply: true });
    const text = await fs.readFile(file, 'utf8');
    expect(text).toBe(`model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n${block}\n`);
  });

  it('writes ./.codex/config.toml with --project', async () => {
    await run('codex', { apply: true, project: true });
    expect(await fs.readFile(path.join(cwd, '.codex', 'config.toml'), 'utf8')).toBe(`${block}\n`);
  });
});

describe('platform-specific paths', () => {
  it('uses %APPDATA% on Windows for Claude Desktop and VS Code', () => {
    const ctx = { home: 'C:\\Users\\me', cwd: 'C:\\repo', platform: 'win32' as const, env: { APPDATA: 'C:\\AppData' }, project: false };
    expect(configPathFor('claude-desktop', ctx)).toBe(path.join('C:\\AppData', 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('vscode', ctx)).toBe(path.join('C:\\AppData', 'Code', 'User', 'mcp.json'));
  });

  it('uses ~/.config on Linux for VS Code and Claude Desktop', () => {
    // path.join, not a '/'-joined literal: configPathFor builds with the
    // host's path flavour, so on a Windows runner these are backslash paths.
    const ctx = { home: '/home/me', cwd: '/repo', platform: 'linux' as const, env: {}, project: false };
    expect(configPathFor('vscode', ctx)).toBe(path.join('/home/me', '.config', 'Code', 'User', 'mcp.json'));
    expect(configPathFor('claude-desktop', ctx)).toBe(path.join('/home/me', '.config', 'Claude', 'claude_desktop_config.json'));
  });

  it('follows XDG_CONFIG_HOME for Claude Desktop but not for VS Code, which ignores it', () => {
    // Claude Desktop reads $XDG_CONFIG_HOME on Linux; VS Code hardcodes
    // $HOME/.config/Code (userDataProfile.ts) and never looks at the variable,
    // so honouring it here would write a file VS Code does not read.
    const ctx = { home: '/home/me', cwd: '/repo', platform: 'linux' as const, env: { XDG_CONFIG_HOME: '/xdg' }, project: false };
    expect(configPathFor('claude-desktop', ctx)).toBe(path.join('/xdg', 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('vscode', ctx)).toBe(path.join('/home/me', '.config', 'Code', 'User', 'mcp.json'));
  });

  it('honours CODEX_HOME and GEMINI_CLI_HOME, which those CLIs document', () => {
    const base = { home: '/home/me', cwd: '/repo', platform: 'linux' as const, project: false };
    expect(configPathFor('codex', { ...base, env: { CODEX_HOME: '/alt/codex' } })).toBe(path.join('/alt/codex', 'config.toml'));
    expect(configPathFor('codex', { ...base, env: {} })).toBe(path.join('/home/me', '.codex', 'config.toml'));
    // GEMINI_CLI_HOME names the directory that *holds* .gemini, not .gemini.
    expect(configPathFor('gemini', { ...base, env: { GEMINI_CLI_HOME: '/alt' } })).toBe(path.join('/alt', '.gemini', 'settings.json'));
    expect(configPathFor('gemini', { ...base, env: {} })).toBe(path.join('/home/me', '.gemini', 'settings.json'));
  });
});

describe('pure helpers', () => {
  it('mergeServerIntoJson does not mutate its input and reports no change for identical entries', () => {
    const entry = { command: 'node', args: ['/x'] };
    const input = { mcpServers: { lexicon: entry, other: { command: 'o', args: [] } }, extra: 1 };
    const snapshot = JSON.stringify(input);
    const r = mergeServerIntoJson(input, 'mcpServers', entry);
    expect(r.changed).toBe(false);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(r.next).toEqual(input);
  });

  it('mergeServerIntoJson refuses a non-object server map', () => {
    expect(() => mergeServerIntoJson({ mcpServers: 'nope' }, 'mcpServers', { command: 'node', args: [] })).toThrow(
      /not an object/,
    );
  });

  it('upsertTomlTable handles an empty file, a header with comment, and idempotence', () => {
    const b = codexBlock({ command: 'node', args: ['/a b/server.js', 'C:\\x\\y.js'] });
    expect(b).toBe('[mcp_servers.lexicon]\ncommand = "node"\nargs = ["/a b/server.js", "C:\\\\x\\\\y.js"]');

    const empty = upsertTomlTable('', CODEX_TABLE, b);
    expect(empty).toEqual({ next: `${b}\n`, changed: true });

    const again = upsertTomlTable(empty.next, CODEX_TABLE, b);
    expect(again.changed).toBe(false);
    expect(again.next).toBe(empty.next);

    const withComment = `[mcp_servers.lexicon] # managed\ncommand = "old"\n`;
    const replaced = upsertTomlTable(withComment, CODEX_TABLE, b);
    expect(replaced.changed).toBe(true);
    expect(replaced.next).toBe(`${b}\n`);
  });

  it('upsertTomlTable keeps a user comment between the lexicon block and the next table', () => {
    const b = codexBlock({ command: 'node', args: ['/new/server.js'] });
    const original = ['[mcp_servers.lexicon]', 'command = "old"', '', '# keep me', '[other]', 'x = 1', ''].join('\n');
    const replaced = upsertTomlTable(original, CODEX_TABLE, b);
    expect(replaced.changed).toBe(true);
    expect(replaced.next).toBe([b, '', '# keep me', '[other]', 'x = 1', ''].join('\n'));
    expect(upsertTomlTable(replaced.next, CODEX_TABLE, b)).toEqual({ next: replaced.next, changed: false });

    // Same at the end of the file, and with indented / multiple comment lines.
    const tail = ['[mcp_servers.lexicon]', 'command = "old"', '  # one', '# two', ''].join('\n');
    expect(upsertTomlTable(tail, CODEX_TABLE, b).next).toBe([b, '  # one', '# two', ''].join('\n'));
  });
});

describe('generic, claude and the commander wiring', () => {
  it('prints the generic snippet and the list of clients when no client is given', async () => {
    const { code, io } = await run('generic');
    expect(code).toBe(0);
    expect(io.out).toContain('"mcpServers"');
    // The path sits inside a JSON snippet, so on Windows its separators are
    // JSON-escaped. Compare against the escaped form rather than the raw path.
    expect(io.out).toContain(JSON.stringify(SERVER).slice(1, -1));
    for (const c of ['codex', 'cursor', 'windsurf', 'gemini', 'claude-desktop', 'vscode']) {
      expect(io.out).toContain(`lexicon install ${c}`);
    }
  });

  it('rejects an unknown client', async () => {
    await expect(run('emacs')).rejects.toThrow(/unknown client "emacs"/);
  });

  it('delegates claude to runInstallClaude (print mode) with the --home settings path', async () => {
    const { code, io } = await run('claude');
    expect(code).toBe(0);
    expect(io.out).toContain('claude mcp add --scope user lexicon');
    expect(io.out).toContain(path.join(home, '.claude', 'settings.json'));
    expect(io.out).toContain('UserPromptSubmit');
  });

  it('registers `install [client]` on a commander program', async () => {
    const io = makeIO();
    const program = new Command().name('lexicon').option('--cwd <dir>').exitOverride();
    registerInstallCommands(program, io);
    // The registered action resolves the real server path: the committed plugin bundle when
    // present (a normal checkout), else dist/mcp/server.js. Only the file location matters here.
    await program.parseAsync(['node', 'lexicon', 'install', 'cursor', '--home', home, '--apply']);
    const written = await readJson(path.join(home, '.cursor', 'mcp.json'));
    const servers = written.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.lexicon.command).toBe('node');
    expect(servers.lexicon.args[0]).toMatch(/[\\/](plugin[\\/]mcp-server\.mjs|mcp[\\/]server\.js)$/);
    expect(io.out).toContain('created');
  });
});

// ---------------------------------------------------------------------------
// Running from an npx cache
// ---------------------------------------------------------------------------

/**
 * `npx @ashlr/lexicon@latest setup` is the headline path, and it runs out of
 * `~/.npm/_npx/<hash>/`, which npm garbage-collects. Writing that absolute
 * path into Cursor's config would leave the user with an MCP server that
 * works today and is gone next week, so every writer switches to an `npx`
 * command that re-resolves the package instead.
 */
describe('installing from an npx cache', () => {
  const NPX_CLI = '/Users/u/.npm/_npx/abc123/node_modules/@ashlr/lexicon/dist/cli';

  it('detects a cache path and leaves a real install alone', () => {
    expect(isVolatileEntry(`${NPX_CLI}/index.js`)).toBe(true);
    expect(isVolatileEntry('/opt/homebrew/lib/node_modules/@ashlr/lexicon/dist/cli/index.js')).toBe(false);
    expect(isVolatileEntry('/Users/u/code/lexicon/dist/cli/index.js')).toBe(false);
  });

  it('writes an npx command rather than a path npm may delete', () => {
    const launch = launchFor(`${NPX_CLI}/../mcp/server.js`, 'mcp', '1.2.3');
    expect(launch).toEqual({ command: 'npx', args: ['-y', '@ashlr/lexicon@1.2.3', 'mcp'], viaNpx: true });
    // Pinned, not @latest: a config should keep behaving the way it did the day it was written.
    expect(launch.args.join(' ')).not.toContain('@latest');
  });

  it('keeps `node <path>` for a real install', () => {
    expect(launchFor('/opt/lexicon/dist/mcp/server.js', 'mcp', '1.2.3')).toEqual({
      command: 'node',
      args: ['/opt/lexicon/dist/mcp/server.js'],
      viaNpx: false,
    });
  });

  it('gives the hook room for npx to resolve, and quotes paths but not package specs', () => {
    const viaNpx = launchFor(`${NPX_CLI}/../hooks/user-prompt-submit.js`, 'hook', '1.2.3');
    const direct = launchFor('/opt/lexicon/dist/hooks/user-prompt-submit.js', 'hook', '1.2.3');
    expect(hookTimeoutFor(direct)).toBe(5);
    expect(hookTimeoutFor(viaNpx)).toBeGreaterThan(5);
    expect(launchCommandLine(viaNpx, 'linux')).toBe('npx -y @ashlr/lexicon@1.2.3 hook');
    expect(launchCommandLine(direct, 'linux')).toBe('node "/opt/lexicon/dist/hooks/user-prompt-submit.js"');
  });

  it('does not backslash-escape a Windows path, which would write a path that is not the file', () => {
    const viaNpxWin = launchFor(`${NPX_CLI}/../hooks/user-prompt-submit.js`, 'hook', '1.2.3');
    // The POSIX branch doubles a backslash because that is the shell's escape
    // character. On Windows it is the path separator and nothing else, so
    // doubling it turned C:\Users\me\... into "C:\\Users\\me\\..." in
    // settings.json -- a hook command pointing at a file that does not exist.
    const win = launchFor('C:\\Users\\me\\lexicon\\dist\\hooks\\user-prompt-submit.js', 'hook', '1.2.3');
    expect(launchCommandLine(win, 'win32')).toBe('node "C:\\Users\\me\\lexicon\\dist\\hooks\\user-prompt-submit.js"');
    expect(launchCommandLine(win, 'win32')).not.toContain('\\\\');

    // A path with a space is still quoted, which is the point of quoting at all.
    const spaced = launchFor('C:\\Program Files\\lexicon\\hook.js', 'hook', '1.2.3');
    expect(launchCommandLine(spaced, 'win32')).toBe('node "C:\\Program Files\\lexicon\\hook.js"');

    // $ and a backtick are ordinary characters to cmd.exe and PowerShell;
    // escaping them the POSIX way would corrupt a path that contains one.
    const odd = launchFor('C:\\odd$dir\\hook.js', 'hook', '1.2.3');
    expect(launchCommandLine(odd, 'win32')).toBe('node "C:\\odd$dir\\hook.js"');

    // The npx form carries no path and is identical on both.
    expect(launchCommandLine(viaNpxWin, 'win32')).toBe('npx -y @ashlr/lexicon@1.2.3 hook');
  });

  it('writes the npx form into a client config end to end', async () => {
    const io = makeIO();
    const code = await runInstall('cursor', { apply: true, home, cwd }, io, { cliDir: NPX_CLI, platform: 'darwin', env: {} });
    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { lexicon: { command: string; args: string[] } };
    };
    expect(written.mcpServers.lexicon.command).toBe('npx');
    expect(written.mcpServers.lexicon.args[0]).toBe('-y');
    expect(written.mcpServers.lexicon.args.at(-1)).toBe('mcp');
    // Nothing in the config may point into the cache directory.
    expect(JSON.stringify(written)).not.toContain('_npx');
  });
});

describe('claude registration is idempotent', () => {
  it('reports an existing `claude mcp add` entry as unchanged rather than failed', async () => {
    const io = makeIO();
    const code = await runInstall('claude', { apply: true, home, cwd }, io, {
      cliDir: CLI_DIR,
      // What the real `claude mcp add` says the second time you run it.
      exec: () => {
        throw new Error('Command failed: claude mcp add: MCP server lexicon already exists in user config');
      },
    } as InstallDeps);
    expect(code).toBe(0);
    expect(io.out).toContain('already registered with claude, nothing changed');
    expect(io.out).not.toContain('failed:');
  });

  it('still fails, with the reason, for a real error', async () => {
    const io = makeIO();
    const code = await runInstall('claude', { apply: true, home, cwd }, io, {
      cliDir: CLI_DIR,
      exec: () => {
        throw new Error('Command failed: claude: not found');
      },
    } as InstallDeps);
    expect(code).toBe(1);
    expect(io.out).toContain('failed: Command failed: claude: not found');
  });
});
