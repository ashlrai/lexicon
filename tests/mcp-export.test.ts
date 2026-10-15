/**
 * export_lexicon takes the same format names as `lexicon export` and the HTTP
 * API, aliases included. Runs the real core against a real file, like
 * tests/mcp-trust-injection.test.ts, because the alias has to survive the
 * tool's input schema as well as the exporter.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';

let home: string;

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-export-')));
  await fs.writeFile(
    path.join(home, 'lexicon.yaml'),
    'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n',
    'utf8',
  );
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterAll(async () => {
  delete process.env.LEXICON_PATH;
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function callExport(format: string): Promise<{ isError: boolean; text: string }> {
  const server = createServer({ cwd: home });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: 'export_lexicon', arguments: { format } })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    return { isError: result.isError === true, text: result.content.map((c) => c.text ?? '').join('\n') };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('export_lexicon format aliases', () => {
  it('accepts wispr-flow and wisprflow as wispr', async () => {
    const wispr = await callExport('wispr');
    expect(wispr.isError).toBe(false);
    expect(wispr.text).toContain('Ashlr.AI');
    for (const alias of ['wispr-flow', 'wisprflow']) {
      expect(await callExport(alias)).toEqual(wispr);
    }
  });

  it('rejects an unknown format with the list of valid ones', async () => {
    const result = await callExport('pdf');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('claude-md');
    expect(result.text).toContain('wispr-flow');
  });
});
