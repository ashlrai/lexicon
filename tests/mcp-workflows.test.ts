/**
 * MCP tools driven end to end against the real core and real files in temp
 * dirs: the arguments an agent actually sends, not mocked core calls.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';

let repo: string;
let home: string;
const savedEnv = process.env.LEXICON_PATH;

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcpflow-')));
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcpflow-home-')));
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = savedEnv;
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const server = createServer({ cwd: repo });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    return { isError: result.isError === true, text: (result.content ?? []).map((c) => c.text ?? '').join('\n') };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('trust_project with a directory path', () => {
  it('reads the .lexicon.yaml inside the directory, as `lexicon trust <dir>` does', async () => {
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    const status = await call('trust_project', { action: 'status', path: repo });
    expect(status.isError).toBe(false);
    const payload = JSON.parse(status.text) as { status: string; path: string; termCount: number };
    expect(payload.status).toBe('untrusted');
    expect(payload.path).toBe(path.join(repo, '.lexicon.yaml'));
    expect(payload.termCount).toBe(1);
    expect(status.text).not.toContain('EISDIR');
  });
});
