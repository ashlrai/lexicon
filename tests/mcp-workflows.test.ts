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

describe('remove_term', () => {
  it('tells the agent where a term lives when the requested scope does not hold it', async () => {
    const added = await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'], scope: 'project' });
    expect(added.isError).toBe(false);

    const miss = await call('remove_term', { canonical: 'kubectl', scope: 'global' });
    expect(miss.isError).toBe(false);
    const payload = JSON.parse(miss.text) as { removed: boolean; foundIn?: string; note?: string };
    expect(payload.removed).toBe(false);
    expect(payload.foundIn).toBe('project');
    expect(payload.note).toMatch(/scope "project"/);

    const hit = await call('remove_term', { canonical: 'kubectl', scope: 'project' });
    expect(JSON.parse(hit.text)).toMatchObject({ removed: true });

    const gone = JSON.parse((await call('remove_term', { canonical: 'kubectl' })).text) as { removed: boolean; foundIn?: string; note?: string };
    expect(gone.removed).toBe(false);
    expect(gone.foundIn).toBeUndefined();
    expect(gone.note).toMatch(/list_terms/);
  });

  it('removes a single alias with `alias`, and errors on an unknown term or alias', async () => {
    await call('add_term', { canonical: 'Hetzner', aliases: ['Hetsner', 'Het zner'] });
    const removed = await call('remove_term', { canonical: 'hetzner', alias: 'het zner' });
    expect(removed.isError).toBe(false);
    expect(JSON.parse(removed.text)).toMatchObject({
      canonical: 'Hetzner',
      alias: 'het zner',
      removed: true,
      aliases: ['Hetsner'],
      paths: [path.join(home, 'lexicon.yaml')],
    });
    const listed = JSON.parse((await call('list_terms', { query: 'hetzner' })).text) as { terms: { aliases: string[] }[] };
    expect(listed.terms[0]?.aliases).toEqual(['Hetsner']);

    const unknownAlias = await call('remove_term', { canonical: 'Hetzner', alias: 'Hetznr' });
    expect(unknownAlias.isError).toBe(true);
    expect(unknownAlias.text).toMatch(/"Hetznr" is not an alias of "Hetzner"/);
    const unknownTerm = await call('remove_term', { canonical: 'Nope', alias: 'x' });
    expect(unknownTerm.isError).toBe(true);
    expect(unknownTerm.text).toMatch(/no term "Nope"/);
  });
});

describe('add_term errors', () => {
  it('do not leak the internal function name', async () => {
    const res = await call('add_term', { canonical: '   ' });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('canonical must not be empty');
  });
});
