import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_TABLE,
  codexBlock,
  configPathFor,
  lexiconServerEnv,
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
        // Catches: the write named its file but not how to take the entry out again.
        expect(first.io.out).toContain(`undo: delete the "lexicon" entry under "${c.key}" in ${file}`);
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
        expect(io.out).not.toContain('undo:');
        await expect(fs.access(file)).rejects.toThrow();
      });

      it('keeps client-owned options when previewing and refreshing an existing launch', async () => {
        const file = path.join(home, c.rel);
        const options = {
          env: { LEXICON_PATH: path.join(home, 'custom dictionary', 'lexicon.yaml') },
          disabled: true,
          timeout: 12345,
          autoApprove: [],
          customClientOption: { enabled: false },
        };
        const original = JSON.stringify({ [c.key]: { lexicon: { command: 'old-node', args: ['/old/server.js'], ...options } } });
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, original);
        await run(c.client);
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        await run(c.client, { apply: true });
        const written = await readJson(file);
        expect((written[c.key] as Record<string, unknown>).lexicon).toEqual({ ...options, ...c.entry });
        const refreshed = await fs.readFile(file, 'utf8');
        const second = await run(c.client, { apply: true });
        expect(second.io.out).toContain('nothing changed');
        expect(await fs.readFile(file, 'utf8')).toBe(refreshed);
      });

      it.each([null, [], 'invalid', { url: 'http://example.invalid/mcp' }, { type: 'http', url: 'http://example.invalid/mcp' }])(
        'refuses an incompatible existing Lexicon entry without changing the file: %j', async (entry) => {
          const file = path.join(home, c.rel);
          const original = JSON.stringify({ [c.key]: { lexicon: entry } });
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, original);
          await expect(run(c.client, { apply: true })).rejects.toThrow(/refusing|different transport/);
          expect(await fs.readFile(file, 'utf8')).toBe(original);
        },
      );
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
    expect(first.io.out).toContain(`undo: delete the [${CODEX_TABLE}] table from ${file}`);
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

  it.each([null, [], 'invalid', 123])('does not replace a valid JSON non-object config: %j', async (value) => {
    const file = path.join(home, '.cursor', 'mcp.json');
    const original = JSON.stringify(value);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    await expect(run('cursor', { apply: true })).rejects.toThrow(/not an object/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
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

  // Catches: `lexicon install --apply` with no client printed the generic
  // snippet ("add --apply to write the config"), wrote nothing and exited 0.
  it('refuses --apply or --project with no client, naming the client to pass, and writes nothing', async () => {
    const io = makeIO();
    await expect(runInstall(undefined, { home, cwd, apply: true }, io, baseDeps())).rejects.toMatchObject({
      name: 'CliRefusal',
      message: '--apply needs a client: with none named, lexicon install only prints the generic configuration and writes nothing',
      nextStep: 'name the client to write, e.g. lexicon install cursor --apply (one of: claude, codex, cursor, windsurf, gemini, claude-desktop, vscode)',
    });
    expect(io.out).toBe('');
    await expect(run('generic', { project: true })).rejects.toThrow(/^--project needs a client/);
    const doc = await run('generic', { apply: true, project: true, json: true });
    expect(doc.code).toBe(1);
    expect(JSON.parse(doc.io.out)).toEqual({
      ok: false,
      error: '--apply --project needs a client: with none named, lexicon install only prints the generic configuration and writes nothing',
      nextStep: 'name the client to write, e.g. lexicon install cursor --apply --project (one of: claude, codex, cursor, windsurf, gemini, claude-desktop, vscode)',
    });
    expect(await fs.readdir(home)).toEqual([]);
    expect(await fs.readdir(cwd)).toEqual([]);
    expect((await run('generic')).io.out).toContain('name a client and add --apply to write its config');
  });

  // Catches: install had no --json, so an unknown client reached a script only as stderr text.
  describe('--json', () => {
    it('prints { ok: false, error, nextStep } for an unknown client or scope', async () => {
      const unknown = await run('emacs', { json: true });
      expect(unknown.code).toBe(1);
      const doc = JSON.parse(unknown.io.out) as { ok: boolean; error: string; nextStep: string };
      expect(doc.ok).toBe(false);
      expect(doc.error).toMatch(/unknown client "emacs"/);
      expect(doc.nextStep).toContain('cursor');
      expect(doc.nextStep).toContain('lexicon install cursor --json');

      const scope = await run('cursor', { json: true, scope: 'team' });
      expect(scope.code).toBe(1);
      expect(JSON.parse(scope.io.out)).toEqual({
        ok: false,
        error: '--scope must be "user" or "project" (got "team")',
        nextStep: 'pass --scope user or --scope project',
      });
    });

    it('prints the preview and then the written file as one document each', async () => {
      const preview = await run('cursor', { json: true });
      expect(preview.code).toBe(0);
      const p = JSON.parse(preview.io.out) as { ok: boolean; client: string; scope: string; applied: boolean; written: unknown[]; output: string };
      expect(p).toMatchObject({ ok: true, client: 'cursor', scope: 'user', applied: false, written: [] });
      expect(p.output).toContain('would merge into');
      expect(p.output).not.toMatch(/\x1b\[/);

      const applied = await run('cursor', { json: true, apply: true });
      expect(applied.code).toBe(0);
      const file = path.join(home, '.cursor', 'mcp.json');
      expect(JSON.parse(applied.io.out)).toMatchObject({ ok: true, applied: true, written: [{ file, outcome: 'created' }] });
      expect(await readJson(file)).toHaveProperty('mcpServers.lexicon');
    });

    it('is a flag of the install command', () => {
      const program = new Command();
      registerInstallCommands(program, makeIO());
      const install = program.commands.find((c) => c.name() === 'install');
      expect(install?.options.map((o) => o.long)).toContain('--json');
    });
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

  // The plugin's MCP server runs from <config>/plugins/cache/<marketplace>/lexicon/<version>/.
  // install_client and setup_lexicon called from a plugin session wrote that
  // versioned path into Cursor, Codex and the Claude hooks, which then ran the
  // old version after a plugin update and nothing once Claude Code removed it.
  it('treats Claude Code\'s per-version plugin cache as a cache too', () => {
    const plugin = '/Users/u/.claude/plugins/cache/ashlrai/lexicon/0.5.6/plugin';
    expect(isVolatileEntry(`${plugin}/mcp-server.mjs`)).toBe(true);
    expect(isVolatileEntry('C:\\Users\\u\\.claude\\plugins\\cache\\ashlrai\\lexicon\\0.5.6\\plugin\\hook.mjs')).toBe(true);
    expect(launchFor(`${plugin}/mcp-server.mjs`, 'mcp', '0.5.6')).toEqual({ command: 'npx', args: ['-y', '@ashlr/lexicon@0.5.6', 'mcp'], viaNpx: true });
    expect(launchCommandLine(launchFor(`${plugin}/hook.mjs`, 'hook', '0.5.6'), 'linux')).toBe('npx -y @ashlr/lexicon@0.5.6 hook');
    // Another plugin's cache, and a checkout that merely has a plugins/ directory, are not this.
    expect(isVolatileEntry('/Users/u/.claude/plugins/cache/ashlrai/other/1.0.0/plugin/mcp-server.mjs')).toBe(false);
    expect(isVolatileEntry('/Users/u/code/lexicon/plugin/mcp-server.mjs')).toBe(false);
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
    // Catches: neither step said how to take lexicon back out of Claude Code.
    expect(io.out).toContain('undo: claude mcp remove --scope user lexicon');
    expect(io.out).toContain(
      `undo: delete the lexicon hook entries under hooks.UserPromptSubmit and hooks.SessionStart in ${path.join(home, '.claude', 'settings.json')}`,
    );
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

describe('LEXICON_PATH and LEXICON_CWD reach the installed server', () => {
  // The installer resolves LEXICON_CWD against the install cwd, so on Windows
  // the expected value takes that cwd's drive.
  const work = (): string => path.resolve(cwd, '/work/repo');
  const lexEnv = (): InstallDeps => ({ ...baseDeps(), env: { PATH: '', LEXICON_PATH: 'lex/my.yaml', LEXICON_CWD: '/work/repo' } });

  it('lexiconServerEnv keeps only set variables, as absolute paths', () => {
    expect(lexiconServerEnv({ PATH: '/bin' }, '/c')).toBeUndefined();
    expect(lexiconServerEnv({ LEXICON_PATH: '  ' }, '/c')).toBeUndefined();
    expect(lexiconServerEnv({ LEXICON_PATH: 'a.yaml' }, '/c')).toEqual({ LEXICON_PATH: path.resolve('/c', 'a.yaml') });
  });

  it('writes them into a JSON client entry, never over a variable the user set there', async () => {
    const file = path.join(home, '.cursor/mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ mcpServers: { lexicon: { command: 'node', args: ['/old.js'], env: { MINE: '1', LEXICON_PATH: '/stale.yaml' } } } }));
    const r = await run('cursor', { apply: true }, lexEnv());
    expect(r.code).toBe(0);
    const entry = ((await readJson(file)).mcpServers as Record<string, { env: Record<string, string> }>).lexicon;
    expect(entry.env).toEqual({ MINE: '1', LEXICON_PATH: '/stale.yaml', LEXICON_CWD: work() });
    // A fresh entry gets both.
    await fs.writeFile(file, '{}');
    await run('cursor', { apply: true }, lexEnv());
    const fresh = ((await readJson(file)).mcpServers as Record<string, { env: Record<string, string> }>).lexicon;
    expect(fresh.env).toEqual({ LEXICON_PATH: path.resolve(cwd, 'lex/my.yaml'), LEXICON_CWD: work() });
    expect(r.io.out).toContain('"LEXICON_PATH"');
    // Unset in the shell: the entry is written without env, as before.
    const plain = await run('windsurf', { apply: true });
    expect(plain.code).toBe(0);
    const ws = (await readJson(path.join(home, '.codeium/windsurf/mcp_config.json'))).mcpServers as Record<string, Record<string, unknown>>;
    expect(ws.lexicon.env).toBeUndefined();
  });

  it('writes an inline env table for Codex, or adds missing keys to an existing [mcp_servers.lexicon.env]', async () => {
    const file = path.join(home, '.codex/config.toml');
    await run('codex', { apply: true }, lexEnv());
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain(`env = { LEXICON_PATH = ${JSON.stringify(path.resolve(cwd, 'lex/my.yaml'))}, LEXICON_CWD = ${JSON.stringify(work())} }`);

    await fs.writeFile(file, ['[mcp_servers.lexicon]', 'command = "node"', 'args = ["/old.js"]', '', '[mcp_servers.lexicon.env]', 'FOO = "bar"', 'LEXICON_PATH = "/stale.yaml"', ''].join('\n'));
    await run('codex', { apply: true }, lexEnv());
    const merged = await fs.readFile(file, 'utf8');
    expect(merged).not.toContain('env = {');
    expect(merged).toContain('FOO = "bar"');
    expect(merged).toContain('LEXICON_PATH = "/stale.yaml"');
    expect(merged).not.toContain(JSON.stringify(path.resolve(cwd, 'lex/my.yaml')));
    expect(merged).toContain(`LEXICON_CWD = ${JSON.stringify(work())}`);
    const again = await run('codex', { apply: true }, lexEnv());
    expect(again.io.out).toContain('nothing changed');
  });

  it('passes them to `claude mcp add -e` ahead of --scope', async () => {
    const calls: string[][] = [];
    const io = makeIO();
    const code = await runInstall('claude', { apply: true, home, cwd }, io, {
      ...lexEnv(),
      exec: (_file: string, args: readonly string[]) => {
        calls.push([...args]);
        return 'added';
      },
    });
    expect(code).toBe(0);
    const args = calls[0] ?? [];
    expect(args.slice(0, 7)).toEqual([
      'mcp', 'add', '-e', `LEXICON_PATH=${path.resolve(cwd, 'lex/my.yaml')}`, '-e', `LEXICON_CWD=${work()}`, '--scope',
    ]);
    expect(args.indexOf('lexicon')).toBeGreaterThan(args.indexOf('--scope'));
  });
});
