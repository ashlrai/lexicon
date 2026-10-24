/**
 * MCP tool annotations: every tool advertises readOnlyHint, destructiveHint,
 * idempotentHint and openWorldHint, and each matches what the tool does.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, withAnnotations } from '../src/mcp/server.js';
import { TOOL_ANNOTATIONS } from '../src/mcp/annotations.js';

let repo: string;
const savedEnv = process.env.LEXICON_PATH;

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcp-annotations-')));
  process.env.LEXICON_PATH = path.join(repo, 'home', 'lexicon.yaml');
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = savedEnv;
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function listed(): Promise<Array<{ name: string; annotations?: Record<string, unknown> }>> {
  const server = createServer({ cwd: repo });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP tool annotations', () => {
  // Catches: no tool carried annotations, so by the spec's defaults every
  // one (list_terms and lexicon_stats included) was a destructive, open-world
  // tool to a client deciding what it may run without asking.
  it('every tool states all four hints, from the one table', async () => {
    const tools = await listed();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject(TOOL_ANNOTATIONS[tool.name]);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      // A read-only tool is never destructive.
      if (tool.annotations?.readOnlyHint === true) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('marks what each tool does', async () => {
    const by = new Map((await listed()).map((t) => [t.name, t.annotations ?? {}]));
    const readOnly = [...by].filter(([, a]) => a.readOnlyHint === true).map(([n]) => n).sort();
    expect(readOnly).toEqual(['export_lexicon', 'lexicon_doctor', 'lexicon_stats', 'list_packs', 'list_terms', 'serve_status', 'suggest_canonical', 'suggest_terms']);
    const destructive = [...by].filter(([, a]) => a.destructiveHint === true).map(([n]) => n).sort();
    expect(destructive).toEqual(['apply_suggestion', 'remove_term', 'trust_project', 'uninstall_client']);
    // It records hits on a real change.
    expect(by.get('normalize_transcript')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    // Registry fetches reach the network.
    expect(by.get('list_packs')?.openWorldHint).toBe(true);
    expect(by.get('add_pack')?.openWorldHint).toBe(true);
    expect(by.get('list_terms')?.openWorldHint).toBe(false);
  });

  it('refuses to register a tool the table does not list', () => {
    expect(() => withAnnotations('no_such_tool', { description: 'x' })).toThrow('MCP tool no_such_tool has no entry in TOOL_ANNOTATIONS');
    expect(withAnnotations('no_such_tool', { annotations: { readOnlyHint: true } })).toEqual({ annotations: { readOnlyHint: true } });
  });
});
