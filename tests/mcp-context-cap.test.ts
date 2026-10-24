/**
 * lexicon://me and the voice-context prompt are read into model context (the
 * server instructions tell agents to read lexicon://me at session start), so
 * they are capped at MODEL_CONTEXT_MAX_CHARS. A 3000-term lexicon used to put
 * about 236 KB into the conversation. Runs the real core against a real file,
 * like tests/mcp-export.test.ts, because the cap is about what the exporter
 * actually writes.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_CONTEXT_MAX_CHARS, createServer } from '../src/mcp/server.js';

let home: string;
const TERMS = 3000;

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-ctxcap-')));
  const terms = Array.from({ length: TERMS }, (_, i) => ({
    canonical: `Term${String(i).padStart(4, '0')}`,
    aliases: [`term ${i} alpha`, `term ${i} bravo`, `term ${i} charlie`],
    category: 'other',
    notes: 'a note long enough to make each row cost something in the table',
  }));
  // One heavily used term late in the alphabet and one brand with a long row:
  // the cap ranks them ahead of the plain terms that sort before them.
  terms.push({ canonical: 'Zzz.Used', aliases: ['zee used'], category: 'other', notes: 'used', hits: 50 } as never);
  terms.push({
    canonical: 'Aaa.Long',
    aliases: Array.from({ length: 64 }, (_, i) => `${'long alias '.repeat(6)}${i}`),
    category: 'brand',
  } as never);
  await fs.writeFile(path.join(home, 'lexicon.yaml'), stringify({ version: 1, terms }), 'utf8');
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterAll(async () => {
  delete process.env.LEXICON_PATH;
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer({ cwd: home });
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

describe('lexicon://me and voice-context stay under the model context cap', () => {
  it('lexicon://me keeps the rows that fit, the most used first, and says how to get the rest', async () => {
    const text = await withClient(async (client) => {
      const read = await client.readResource({ uri: 'lexicon://me' });
      return read.contents.map((c) => ('text' in c ? c.text : '')).join('\n');
    });
    expect(text.length).toBeLessThanOrEqual(MODEL_CONTEXT_MAX_CHARS);
    // Header, table and footer survive.
    expect(text).toContain('## Voice lexicon');
    expect(text).toContain('| Canonical |');
    expect(text).toContain('ask rather than guess');
    // The term with hits and the brand are kept although plain terms fill the cap.
    expect(text).toContain('| Zzz.Used |');
    expect(text).toContain('| Aaa.Long |');
    expect(text).toContain('| Term0000 |');
    expect(text).not.toContain('| Term2999 |');
    const kept = text.split('\n').filter((l) => /^\| (Term\d{4}|Zzz\.Used|Aaa\.Long) \|/.test(l)).length;
    const omitted = TERMS + 2 - kept;
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain(`${omitted} more terms`);
    expect(text).toContain('list_terms');
    expect(text).toContain('export_lexicon');
  });

  it('voice-context is capped the same way and still ends with the instruction', async () => {
    const text = await withClient(async (client) => {
      const prompt = await client.getPrompt({ name: 'voice-context' });
      return prompt.messages.map((m) => String((m.content as { text?: string }).text)).join('\n');
    });
    expect(text.length).toBeLessThanOrEqual(MODEL_CONTEXT_MAX_CHARS + 400);
    expect(text).toContain('| Zzz.Used |');
    expect(text).toMatch(/more terms/);
    expect(text).toContain('Apply these canonical spellings');
  });

  it('the full lexicon is still reachable through list_terms and export_lexicon', async () => {
    await withClient(async (client) => {
      const listed = (await client.callTool({ name: 'list_terms', arguments: { query: 'Term2999' } })) as { content: { text: string }[] };
      expect(listed.content[0].text).toContain('Term2999');
      const exported = (await client.callTool({ name: 'export_lexicon', arguments: { format: 'claude-md' } })) as { content: { text: string }[] };
      expect(exported.content[0].text).toContain('| Term2999 |');
      expect(exported.content[0].text).toContain('Aaa.Long');
    });
  });
});
