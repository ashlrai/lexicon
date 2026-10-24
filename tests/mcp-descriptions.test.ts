/**
 * Tool, resource and prompt descriptions checked against what the handlers
 * do: each claim an agent acts on (a default, a cap, an output field, an
 * error shape) is pinned both in the text and in a real call.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { addTerm } from '../src/core/store.js';

let repo: string;
let home: string;
const savedEnv = process.env.LEXICON_PATH;

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcpdesc-')));
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcpdesc-home-')));
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = savedEnv;
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function connected<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer({ cwd: repo });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; blocks: string[]; json: () => Record<string, unknown> }> {
  return connected(async (client) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { text?: string }[] };
    const blocks = (result.content ?? []).map((c) => c.text ?? '');
    return { isError: result.isError === true, blocks, json: () => JSON.parse(blocks[0] ?? '') as Record<string, unknown> };
  });
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string; pattern?: string }> };
}

async function tool(name: string): Promise<ListedTool> {
  const tools = (await connected((client) => client.listTools())).tools as ListedTool[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe('normalize_transcript minConfidence', () => {
  // Catches: "Exact alias matches are always 1" while an exact match the text
  // spells with an extra word break scores 0.95, so minConfidence 0.96 drops it;
  // and the default was not named.
  it('names the default and the 0.95 an invented word break scores, and both hold', async () => {
    const d = (await tool('normalize_transcript')).inputSchema.properties?.minConfidence?.description ?? '';
    expect(d).toContain("Omitted: the lexicon's settings.minConfidence, else 0.82.");
    expect(d).toContain('("open ai" for OpenAI), which scores 0.95 and is refused above that');
    expect(d).not.toContain('always 1');
    await addTerm({ canonical: 'OpenAI', aliases: [] }, { cwd: repo });
    const loose = (await call('normalize_transcript', { text: 'I use open ai daily', dryRun: true })).json();
    expect(loose.replacements).toMatchObject([{ canonical: 'OpenAI', confidence: 0.95 }]);
    const strict = (await call('normalize_transcript', { text: 'I use open ai daily', dryRun: true, minConfidence: 0.96 })).json();
    expect(strict.replacements).toEqual([]);
  });

  // Catches: "it never rewrites text inside code ..." while settings.skipCode: false turns that off.
  it('says the code and path protection follows settings.skipCode, and it does', async () => {
    expect((await tool('normalize_transcript')).description).toContain("(unless the lexicon's settings.skipCode is false)");
    await fs.writeFile(path.join(home, 'lexicon.yaml'), 'version: 1\nsettings:\n  skipCode: false\nterms:\n  - canonical: Hetzner\n    aliases: [hetsner]\n');
    expect((await call('normalize_transcript', { text: 'run `hetsner` now' })).json().output).toBe('run `Hetzner` now');
  });
});

describe('add_term canonical', () => {
  // Catches: the schema took "   " (min 1 only) and the handler refused it as
  // "canonical must not be empty", so a validating client never saw the rule.
  it('declares that a blank canonical is refused, and refuses it by name', async () => {
    const prop = (await tool('add_term')).inputSchema.properties?.canonical;
    expect(prop?.description).toContain('must not be blank');
    expect(prop?.pattern).toBe('\\S');
    const res = await call('add_term', { canonical: '   ' });
    expect(res.isError).toBe(true);
    expect(res.blocks.join('\n')).toContain('must not be blank at canonical');
    await expect(fs.access(path.join(home, 'lexicon.yaml'))).rejects.toThrow();
  });
});

describe('list_terms and lexicon_stats name their result fields', () => {
  // Catches: lexicon_stats said "the most-used terms" with no cap or shape
  // (topTerms is at most 10, terms with no hits left out), and list_terms
  // named none of its fields.
  it('lexicon_stats: topTerms holds at most 10 terms with hits, and the listed keys are the result', async () => {
    const d = (await tool('lexicon_stats')).description ?? '';
    expect(d).toContain('`topTerms` holds at most 10 terms with at least one hit, as { canonical, hits }, most hits first.');
    const terms = Array.from({ length: 12 }, (_, i) => `  - canonical: Term${i}\n    aliases: [alias${i}]\n    hits: ${i}\n`).join('');
    await fs.writeFile(path.join(home, 'lexicon.yaml'), `version: 1\nterms:\n${terms}`);
    const stats = (await call('lexicon_stats', {})).json();
    const top = stats.topTerms as { canonical: string; hits: number }[];
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ canonical: 'Term11', hits: 11 });
    expect(top.some((t) => t.hits === 0)).toBe(false);
    for (const key of Object.keys(stats)) expect(d).toContain(key);
  });

  it('list_terms: the described keys are the result, and a blank query filters nothing', async () => {
    const d = (await tool('list_terms')).description ?? '';
    expect(d).toContain('Returns { terms, counts: { matched, total, global, project }, paths: { global, project? } }');
    await addTerm({ canonical: 'Hetzner', aliases: ['hetsner'] }, { cwd: repo });
    const listed = (await call('list_terms', { query: '   ' })).json();
    expect(Object.keys(listed).sort()).toEqual(['counts', 'paths', 'terms']);
    expect(listed.counts).toEqual({ matched: 1, total: 1, global: 1, project: 0 });
  });
});
