import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
// Current user guides only. Historical measurements and design proposals can
// intentionally contain commands from other releases or commands not built yet.
const guides = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'llms-install.md', 'llms.txt', 'llms-full.txt',
  'docs/AGENTS.md', 'docs/COPY-PASTE.md', 'docs/QUICKSTART.md', 'docs/MATCHING.md',
  'docs/LIBRARY.md', 'docs/LOCAL-API.md', 'docs/CLI-JSON.md', 'docs/CLIENTS.md',
  'docs/DAEMON.md', 'docs/EXPORTS.md', 'docs/EXTENSION.md', 'docs/GROWING.md',
  'docs/PACKS.md', 'docs/SUGGEST.md', 'docs/TRUST.md', 'docs/VOICE.md', 'docs/doctor-fix.md',
];

describe('source-backed documentation freshness', () => {
  it('runs the versioned JSON guide examples as one document each without writing a lexicon', () => {
    const home = mkdtempSync(join(tmpdir(), 'lexicon-docs-json-'));
    const lexiconPath = join(home, 'lexicon.yaml');
    // Stop project discovery at the disposable directory.
    mkdirSync(join(home, '.git'));
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), LEXICON_PATH: lexiconPath,
      LEXICON_CWD: home, LEXICON_TRUST_ALL: '' };
    try {
      const blocks = [...read('docs/CLI-JSON.md').matchAll(/```sh\n([\s\S]*?)```/g)];
      const examples = blocks.flatMap((block) => block[1].trim().split('\n'));
      expect(examples.length).toBeGreaterThanOrEqual(3);
      for (const example of examples) {
        // These examples use double-quoted strings and simple bare arguments.
        const args = example.match(/"[^"]*"|\S+/g)!.map((word) => word.replace(/^"|"$/g, ''));
        expect(args.shift()).toBe('lexicon');
        const stdout = execFileSync(process.execPath,
          ['--import', 'tsx', 'src/cli/index.ts', '--cwd', home, ...args],
          { cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
        const doc = JSON.parse(stdout);
        expect(Object.keys(doc).sort(), example).toEqual(['data', 'ok', 'schemaVersion']);
        expect(doc, example).toMatchObject({ schemaVersion: 1, ok: true });
        if (args[0] === 'list') expect(doc.data).toEqual([]);
        if (args[0] === 'normalize') expect(doc.data.output).toBe('ask Ashlr.AI');
      }
      expect(existsSync(lexiconPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the documented caller-context example without changing the transcript offsets', () => {
    const section = read('docs/LIBRARY.md').split('## Caller context\n')[1]?.split('\n## ')[0];
    const example = section?.match(/```ts\n([\s\S]*?)```/)?.[1];
    expect(example).toBeDefined();
    const script = example!.replace("from '@ashlr/lexicon'", "from './src/core/index.ts'");
    const result = JSON.parse(execFileSync(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: root, encoding: 'utf8', timeout: 30_000 }));

    expect(result.withoutContext).toEqual({
      input: 'ask Lucas to deploy', output: 'ask Lucas to deploy', replacements: [], changed: false,
    });
    expect(result.withContext).toEqual({
      input: 'ask Lucas to deploy', output: 'ask locus to deploy', changed: true,
      replacements: [{ start: 4, end: 9, original: 'Lucas', replacement: 'locus', canonical: 'locus', reason: 'alias', confidence: 1 }],
    });
  });

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

  it('points the audio benchmark and client install guidance at their corresponding commands', () => {
    const readme = read('README.md');
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    const measured = readme.split('## Measured')[1].split('## Install')[0];
    expect(measured).toContain('npm run bench:audio');
    expect(scripts['bench:audio']).toContain('bench/audio/');
    expect(readme.split('| Codex |')[1].split('\n')[0]).toContain('lexicon install codex --json');
    expect(readme.split('| Cursor |')[1].split('\n')[0]).toContain('lexicon install cursor --json');
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
          const invocation = /^\s*(?:\$ )?lexicon\s+([^#\n]+)/.exec(line)?.[1];
          if (!invocation) continue;
          // Quoted transcript text is positional data, including flag-like words.
          const example = invocation.replace(/"[^"]*"|'[^']*'/g, '');
          const command = example.trim().split(/\s+/)[0];
          if (command.startsWith('-')) {
            expect(cli.flags, `${file}: ${line}`).toContain(command);
            continue;
          }
          const registered = cli.commands.find((entry) => entry.name === command);
          expect(registered, `${file}: ${line}`).toBeDefined();
          // Descend through all registered groups, including terms add.
          let target = registered!;
          const flags = [...cli.flags, ...target.flags, '--help', '-h'];
          for (const word of example.trim().split(/\s+/).slice(1)) {
            if (!target.commands.length || word.startsWith('-')) break;
            const nested = target.commands.find((entry) => entry.name === word);
            expect(nested, `${file}: ${line}`).toBeDefined();
            target = nested!;
            flags.push(...target.flags);
          }
          for (const flag of example.split(/\s--\s/)[0].match(/--[a-z][a-z-]*/g) ?? []) {
            expect(flags, `${file}: ${line}`).toContain(flag);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 60_000);
});
