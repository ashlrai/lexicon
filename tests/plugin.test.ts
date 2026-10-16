import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
