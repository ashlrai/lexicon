import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { type Lexicon, normalize } from '../src/core/index.js';
import { createServer as createMcpServer } from '../src/mcp/server.js';
import { createServer as createHttpServer } from '../src/serve/index.js';

// Exercise the public integration surfaces together, without mocking the core.
const vocabulary: Lexicon = {
  version: 1,
  terms: [
    {
      canonical: 'Ashlr.AI',
      aliases: ['Ashler'],
      category: 'brand',
      scope: 'global',
    },
  ],
};
const toolNames = [
  'add_pack',
  'add_term',
  'apply_suggestion',
  'export_lexicon',
  'harvest_repo',
  'import_dictionary',
  'import_vocabulary',
  'install_client',
  'learn_correction',
  'lexicon_doctor',
  'lexicon_stats',
  'list_packs',
  'list_terms',
  'normalize_transcript',
  'remove_term',
  'serve_status',
  'setup_lexicon',
  'suggest_canonical',
  'suggest_terms',
  'trust_project',
  'uninstall_client',
].sort();

function request(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', headers: { Host: host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

describe('INTEGRATION.md contracts', () => {
  it('normalizes through the library entry point with original-text replacement offsets', () => {
    const input = 'Ask Ashler about Ashler.';
    const before = structuredClone(vocabulary);
    const result = normalize(input, vocabulary);
    expect(result).toMatchObject({
      input,
      output: 'Ask Ashlr.AI about Ashlr.AI.',
      changed: true,
    });
    expect(result.replacements).toHaveLength(2);
    for (const replacement of result.replacements) {
      expect(input.slice(replacement.start, replacement.end)).toBe('Ashler');
      expect(replacement).toMatchObject({
        original: 'Ashler',
        replacement: 'Ashlr.AI',
        reason: 'alias',
        confidence: 1,
      });
    }
    expect(vocabulary).toEqual(before);
    expect(normalize(result.output, vocabulary)).toMatchObject({
      output: result.output,
      changed: false,
      replacements: [],
    });
  });

  it('passes through unmatched text and previews corrections without applying them', () => {
    expect(normalize('An ordinary sentence.', vocabulary)).toEqual({
      input: 'An ordinary sentence.',
      output: 'An ordinary sentence.',
      changed: false,
      replacements: [],
    });
    const preview = normalize('Ashler', vocabulary, { dryRun: true });
    expect(preview).toMatchObject({
      input: 'Ashler',
      output: 'Ashler',
      changed: false,
    });
    expect(preview.replacements).toHaveLength(1);
  });

  it('advertises the complete tool contract over a real MCP connection', async () => {
    const server = createMcpServer();
    const client = new Client({
      name: 'integration-contract',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames);
      for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
      const doc = await readFile(
        new URL('../INTEGRATION.md', import.meta.url),
        'utf8',
      );
      expect(doc).toContain(`stdio, ${tools.length} tools`);
      for (const name of toolNames) expect(doc).toContain(`\`${name}\``);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('binds to loopback and refuses non-loopback Host headers before authentication', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lexicon-integration-'));
    const server = createHttpServer({
      port: 0,
      cwd: home,
      globalPath: path.join(home, 'lexicon.yaml'),
      quiet: true,
    });
    try {
      const info = await server.start();
      expect(info.host).toBe('127.0.0.1');
      expect(await request(info.port, `127.0.0.1:${info.port}`)).toBe(200);
      for (const host of [
        '192.0.2.1',
        '0.0.0.0',
        '[2001:db8::1]',
        'example.test',
        '127.0.0.1.example.test',
      ]) {
        expect(await request(info.port, `${host}:${info.port}`), host).toBe(
          403,
        );
      }
    } finally {
      await server.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});
