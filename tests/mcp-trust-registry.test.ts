/**
 * MCP `trust_project` and a trust registry (`trust.json`) that cannot be used.
 * Real core, temp dirs only: LEXICON_PATH points the registry at a fresh
 * directory, so nothing here touches the real home.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { getTrustPath } from '../src/core/index.js';

let repo: string;
let cfg: string;
let saved: string | undefined;
const BROKEN = '{ "version": 1, "trusted": {';

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcp-registry-')));
  cfg = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcp-registry-cfg-')));
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  saved = process.env.LEXICON_PATH;
  process.env.LEXICON_PATH = path.join(cfg, 'lexicon.yaml');
  await fs.writeFile(getTrustPath({ cwd: repo }), BROKEN);
});

afterEach(async () => {
  if (saved === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = saved;
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(cfg, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function call(args: Record<string, unknown>, asked?: string[]): Promise<{ isError: boolean; text: string }> {
  const server = createServer({ cwd: repo });
  const client = new Client({ name: 'test', version: '0' }, asked ? { capabilities: { elicitation: {} } } : undefined);
  if (asked) {
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return { action: 'accept', content: { trust: true } };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: 'trust_project', arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { isError: result.isError === true, text: result.content.map((c) => c.text ?? '').join('\n') };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('trust_project with a trust registry it cannot use', () => {
  // Catches: status read the broken registry as empty and answered
  // `trusted: []` and `status: 'untrusted'`, so the model asked to trust a
  // file the next call then refused.
  it('status is an error naming the registry, its problem and the fix', async () => {
    const registryPath = getTrustPath({ cwd: repo });
    const result = await call({ action: 'status' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`the trust registry at ${registryPath} is not valid JSON`);
    expect(result.text).toContain('move it aside');
    expect(result.text).not.toContain('"trusted": []');
    expect(await fs.readFile(registryPath, 'utf8')).toBe(BROKEN);
  });

  // Catches: trust put the elicitation question to the user and only then
  // found the registry broken, so their yes was answered with a refusal.
  it('trust refuses before asking the user', async () => {
    const registryPath = getTrustPath({ cwd: repo });
    const asked: string[] = [];
    const result = await call({ action: 'trust' }, asked);
    expect(result.isError).toBe(true);
    expect(asked).toEqual([]);
    expect(result.text).toContain(`the trust registry at ${registryPath} is not valid JSON`);
    expect(result.text).toContain('nothing was trusted');
    expect(await fs.readFile(registryPath, 'utf8')).toBe(BROKEN);
  });
});
