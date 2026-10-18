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
  const result = await callExportBlocks({ format });
  return { isError: result.isError, text: result.blocks.join('\n') };
}

async function callExportBlocks(args: Record<string, unknown>, cwd = home): Promise<{ isError: boolean; blocks: string[] }> {
  const server = createServer({ cwd });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: 'export_lexicon', arguments: args })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    return { isError: result.isError === true, blocks: result.content.map((c) => c.text ?? '') };
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

// Catches: the export came back as one bare text block whatever happened, so
// a category filter that matched nothing returned an empty string, and a repo
// whose .lexicon.yaml is untrusted got a global-only export with no word that
// its terms were left out (`lexicon export` says so on stderr, lexicon://json
// in `note`).
describe('export_lexicon notes', () => {
  it('returns the export alone when there is nothing to say', async () => {
    const result = await callExportBlocks({ format: 'text' });
    expect(result.isError).toBe(false);
    expect(result.blocks).toEqual(['Ashlr.AI: Ashler\n']);
  });

  it('says so in a second block when no term matched the categories', async () => {
    const result = await callExportBlocks({ format: 'text', categories: ['person'] });
    expect(result.isError).toBe(false);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toBe('');
    expect(result.blocks[1]).toMatch(/^Note \(not part of the export\): No term matched categories \["person"\]/);
    expect(result.blocks[1]).toContain('list_terms');
  });

  it('names a skipped untrusted project lexicon in a second block, leaving the export as is', async () => {
    const repo = path.join(home, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Zephyrine\n    aliases: [Zefyrine]\n', 'utf8');
    try {
      const result = await callExportBlocks({ format: 'text' }, repo);
      expect(result.isError).toBe(false);
      expect(result.blocks[0]).toBe('Ashlr.AI: Ashler\n');
      expect(result.blocks).toHaveLength(2);
      expect(result.blocks[1]).toContain('untrusted project .lexicon.yaml');
      expect(result.blocks[1]).toContain('Its terms are not in this export.');
      expect(result.blocks.join('\n')).not.toContain('Zefyrine');
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
