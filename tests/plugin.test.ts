import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO_ROOT, 'plugin', 'mcp-server.mjs');

interface McpServerEntry {
  command: string;
  args?: string[];
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T;
}

describe('Claude Code plugin manifest', () => {
  // Claude Code substitutes only the bare ${CLAUDE_PLUGIN_ROOT} in plugin MCP
  // config; a shell-style default like ${CLAUDE_PLUGIN_ROOT:-.} is left alone
  // and the server then runs relative to the user's cwd and never connects.
  it('declares the lexicon MCP server inline with the bare ${CLAUDE_PLUGIN_ROOT}', () => {
    const manifest = readJson<{ mcpServers?: unknown }>('.claude-plugin/plugin.json');
    expect(typeof manifest.mcpServers).toBe('object');
    const servers = manifest.mcpServers as Record<string, McpServerEntry>;
    const entry = servers.lexicon;
    expect(entry.command).toBe('node');
    const args = entry.args ?? [];
    for (const arg of args) expect(arg).not.toMatch(/\$\{[^}]*:-/);
    expect(args).toEqual(['${CLAUDE_PLUGIN_ROOT}/plugin/mcp-server.mjs']);
    const resolved = args[0].replace('${CLAUDE_PLUGIN_ROOT}', REPO_ROOT);
    expect(path.resolve(resolved)).toBe(BUNDLE);
  });

  it('keeps the project .mcp.json free of unsupported variable defaults', () => {
    const project = readJson<{ mcpServers: Record<string, McpServerEntry> }>('.mcp.json');
    const args = project.mcpServers.lexicon.args ?? [];
    for (const arg of args) expect(arg).not.toMatch(/\$\{/);
    expect(path.resolve(REPO_ROOT, args[0])).toBe(BUNDLE);
  });
});

describe('lexicon-mcp flags (plugin bundle)', () => {
  const run = (flag: string) =>
    spawnSync(process.execPath, [BUNDLE, flag], { input: '', encoding: 'utf8', timeout: 10_000 });

  it('--version prints the package version and exits 0', () => {
    const { version } = readJson<{ version: string }>('package.json');
    const r = run('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it('--help prints a one-line usage and exits 0', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Usage: lexicon-mcp/);
  });
});

describe('plugin manifests agree with the package and the bundles', () => {
  const { version } = readJson<{ version: string }>('package.json');

  // Caught only at tag time by scripts/release-contract.mjs before this.
  it('plugin.json and the marketplace entry carry the package.json version and name', () => {
    const plugin = readJson<{ name: string; version: string }>('.claude-plugin/plugin.json');
    const market = readJson<{ plugins: { name: string; version: string; source: string }[] }>('.claude-plugin/marketplace.json');
    expect(plugin.version).toBe(version);
    const entry = market.plugins.find((p) => p.name === plugin.name);
    expect(entry?.version).toBe(version);
    const source = path.resolve(REPO_ROOT, entry?.source ?? '');
    expect(readJson<{ name: string }>(path.relative(REPO_ROOT, path.join(source, '.claude-plugin', 'plugin.json'))).name).toBe(plugin.name);
  });

  it('every hooks.json command runs a committed file under ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooks = readJson<{ hooks: Record<string, { hooks: { type: string; command: string }[] }[]> }>('hooks/hooks.json');
    const events = Object.keys(hooks.hooks).sort();
    expect(events).toEqual(['SessionStart', 'UserPromptSubmit']);
    for (const groups of Object.values(hooks.hooks)) {
      for (const hook of groups.flatMap((g) => g.hooks)) {
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(hook.command);
        expect(m, hook.command).not.toBeNull();
        expect(existsSync(path.join(REPO_ROOT, m?.[1] ?? '')), hook.command).toBe(true);
      }
    }
  });

  it('the hook entry stub imports a bundle that exists', () => {
    const stub = readFileSync(path.join(REPO_ROOT, 'plugin', 'hook.mjs'), 'utf8');
    const targets = [...stub.matchAll(/new URL\(\s*["']\.\/([^"']+)["']/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(existsSync(path.join(REPO_ROOT, 'plugin', target)), target).toBe(true);
  });

  it('skills and commands have frontmatter and name only MCP tools the server registers', () => {
    const tools = new Set<string>();
    const toolsDir = path.join(REPO_ROOT, 'src', 'mcp', 'tools');
    for (const file of readdirSync(toolsDir)) {
      for (const m of readFileSync(path.join(toolsDir, file), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)) tools.add(m[1]);
    }
    expect(tools.size).toBeGreaterThan(0);
    const docs = [
      ...readdirSync(path.join(REPO_ROOT, 'skills')).map((d) => path.join('skills', d, 'SKILL.md')),
      ...readdirSync(path.join(REPO_ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => path.join('commands', f)),
    ];
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      const text = readFileSync(path.join(REPO_ROOT, doc), 'utf8');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(front, doc).not.toBeNull();
      expect(front?.[1], doc).toMatch(/^description: \S/m);
      if (doc.startsWith('skills')) expect(front?.[1], doc).toMatch(new RegExp(`^name: ${path.basename(path.dirname(doc))}$`, 'm'));
      // A snake_case word in backticks that looks like a tool (verb_object) must be one.
      const named = [...text.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
      const unknown = named.filter((n) => !tools.has(n));
      expect(unknown, doc).toEqual([]);
    }
  });
});

/** Starts `bundle`, initializes, calls one tool, and returns the tool's text. */
function callBundleTool(bundle: string, tool: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no tools/call answer from ${bundle}; stderr: ${err}`));
    }, 15_000);
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } };
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result?.content?.[0]?.text ?? '');
          return;
        }
      }
    });
    const send = (m: unknown): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } });
  });
}

describe('plugin bundles find package files from where they are installed', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lexicon-plugin-layout-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // plugin/mcp-server.mjs is one level below the package root, not two like
  // dist/voice/models.js, so a fixed `../../bench/audio/models` from the module
  // looked in a sibling of the install (npm's @ashlr/, Claude Code's plugin
  // cache). Only the package's own bench/ may count as the repo models dir.
  it('the MCP bundle never looks for whisper models outside its package', async () => {
    const pkg = path.join(tmp, 'lexicon');
    mkdirSync(path.join(pkg, 'plugin'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@ashlr/lexicon', version: '9.9.9' }));
    copyFileSync(BUNDLE, path.join(pkg, 'plugin', 'mcp-server.mjs'));
    const outside = path.join(tmp, 'bench', 'audio', 'models');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'ggml-base.en.bin'), 'planted');
    const home = path.join(tmp, 'home');
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      LEXICON_PATH: path.join(home, 'lexicon.yaml'),
      LEXICON_WHISPER_MODELS: path.join(home, 'models'),
    };
    const report = JSON.parse(await callBundleTool(path.join(pkg, 'plugin', 'mcp-server.mjs'), 'lexicon_doctor', env, home)) as {
      checks: Array<{ message: string }>;
      versions: { lexicon: string };
    };
    expect(report.versions.lexicon).toBe('9.9.9');
    const model = report.checks.find((c) => c.message.startsWith('whisper model'));
    expect(model?.message).toMatch(/absent/);
    expect(model?.message).not.toContain(outside);
  });
});

/** Runs `node <script> ...args` with stdin left open (as on a terminal) and resolves on exit or after `ms`. */
function runWithOpenStdin(script: string, args: string[], ms: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
  });
}

describe('hook.mjs flags (plugin bundle)', () => {
  const HOOK = path.join(REPO_ROOT, 'plugin', 'hook.mjs');
  const version = readJson<{ version: string }>('package.json').version;

  // Without these the hook waited for EOF on stdin, so `node plugin/hook.mjs
  // --version` (the obvious install check) hung on a terminal.
  it('--version prints the package version and exits 0 without reading stdin', async () => {
    const r = await runWithOpenStdin(HOOK, ['--version'], 10_000);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it('--help prints a one-line usage and exits 0 without reading stdin', async () => {
    const r = await runWithOpenStdin(HOOK, ['--help'], 10_000);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/^Usage: .*UserPromptSubmit and SessionStart/);
  });
});
