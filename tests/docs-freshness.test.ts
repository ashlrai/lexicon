import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const guides = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'llms-install.md', 'docs/AGENTS.md'];

describe('source-backed documentation freshness', () => {
  it('documents exactly the registered MCP tools and all their schema arguments', async () => {
    // createServer uses TOOL_REGISTRARS from src/mcp/tools/index.ts. Listing
    // schemas executes no tool and needs no lexicon or client configuration.
    const server = createServer({ cwd: root });
    const client = new Client({ name: 'docs-freshness', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const rows = [...read('docs/MCP.md').split('## Tools\n')[1].split('## Resources')[0].matchAll(/^\| `([a-z_]+)` \| ([^|]*)\|/gm)];
      expect(rows.map((row) => row[1]).sort()).toEqual(tools.map((tool) => tool.name).sort());
      for (const tool of tools) {
        const row = rows.find((entry) => entry[1] === tool.name)!;
        const documented = [...row[2].replace(/\([^)]*\)/g, '').matchAll(/`([a-zA-Z]+)\??`/g)].map((entry) => entry[1]);
        expect([...new Set(documented)].sort(), `${tool.name} arguments`).toEqual(
          Object.keys(tool.inputSchema.properties ?? {}).sort(),
        );
      }
      for (const file of guides) {
        const names = [...read(file).matchAll(/`([a-z]+_[a-z_]+) \{/g)].map((entry) => entry[1]);
        for (const name of names) expect(tools.map((tool) => tool.name), `${file}: ${name}`).toContain(name);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses existing CLI commands and flags in fenced shell examples', () => {
    // Capture command registration before parseAsync runs any command. One
    // source subprocess checks the whole tree without builds or user writes.
    const script = `
      import { Command } from 'commander';
      const tree = (command) => ({
        name: command.name(),
        flags: command.options.flatMap((option) => [option.long, option.short].filter(Boolean)),
        commands: command.commands.map(tree),
      });
      Command.prototype.parseAsync = async function () {
        console.log(JSON.stringify(tree(this)));
        return this;
      };
      await import('./src/cli/index.ts');
    `;
    interface CommandDoc { name: string; flags: string[]; commands: CommandDoc[] }
    const cli = JSON.parse(execFileSync(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: root, encoding: 'utf8', timeout: 30_000 })) as CommandDoc;
    let checked = 0;
    for (const file of guides) {
      for (const block of read(file).matchAll(/```(?:bash|sh|console)\n([\s\S]*?)```/g)) {
        for (const line of block[1].split('\n')) {
          const example = /^\s*(?:\$ )?lexicon\s+([^#\n]+)/.exec(line)?.[1];
          if (!example) continue;
          const command = example.trim().split(/\s+/)[0];
          if (command.startsWith('-')) {
            expect(cli.flags, `${file}: ${line}`).toContain(command);
            continue;
          }
          const registered = cli.commands.find((entry) => entry.name === command);
          expect(registered, `${file}: ${line}`).toBeDefined();
          // Nested commands have their own option sets.
          const nested = /^(pack|pending)\s+([a-z-]+)/.exec(example);
          const target = nested ? registered!.commands.find((entry) => entry.name === nested[2]) : registered;
          expect(target, `${file}: ${line}`).toBeDefined();
          for (const flag of example.match(/--[a-z][a-z-]*/g) ?? []) {
            expect([...cli.flags, ...target!.flags], `${file}: ${line}`).toContain(flag);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 60_000);
});
