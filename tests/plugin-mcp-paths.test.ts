import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('lists existing repository paths in plugin MCP server arguments', () => {
  const plugin = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8')) as {
    mcpServers: Record<string, { args?: string[] }>;
  };
  const prefix = '${CLAUDE_PLUGIN_ROOT}/';
  const missing = Object.values(plugin.mcpServers)
    .flatMap((server) => server.args ?? [])
    .filter((arg) => arg.includes(prefix) && !existsSync(arg.replace(prefix, `${root}/`)));

  expect(missing).toEqual([]);
});
