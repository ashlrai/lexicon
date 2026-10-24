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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { addTerm } from '../src/core/store.js';
import { runDoctorReport } from '../src/cli/commands.js';

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

describe('harvest_repo and suggest_terms', () => {
  // Catches: minCount read as a floor for every candidate, while the directory
  // name, git authors, package names and dot-TLD brands bypass it.
  it('harvest_repo: minCount does not hold back a package name, as the schema says', async () => {
    const d = (await tool('harvest_repo')).inputSchema.properties?.minCount?.description ?? '';
    expect(d).toContain('The directory name, git authors, package names and dot-TLD brands (Ashlr.AI) are proposed at any count.');
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'zorblatt' }));
    const res = (await call('harvest_repo', { minCount: 50 })).json();
    const names = (res.candidates as { canonical: string }[]).map((c) => c.canonical);
    expect(names).toContain('zorblatt');
    const first = (res.candidates as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(first).sort()).toEqual(['canonical', 'category', 'count', 'evidence', 'source', 'suggestedAliases']);
    expect(Object.keys(res).sort()).toEqual(['candidates', 'count', 'root']);
  });

  // Catches: the description did not say the result is a bare array, nor that
  // an empty one carries its reason in a second block.
  it('suggest_terms: a bare array, and an empty one comes with a second block', async () => {
    const d = (await tool('suggest_terms')).description ?? '';
    expect(d).toContain('The result is a bare JSON array, best first. An empty array comes with a second text block');
    // A two-letter directory gives no harvest name, and there is no history or term yet.
    await fs.mkdir(path.join(repo, 'xy'));
    const empty = await call('suggest_terms', { cwd: path.join(repo, 'xy') });
    expect(empty.isError).toBe(false);
    expect(JSON.parse(empty.blocks[0] ?? '')).toEqual([]);
    expect(empty.blocks[1]).toMatch(/^No suggestions: there is no voice history yet/);
    await addTerm({ canonical: 'Hetzner', aliases: ['hetsner'] }, { cwd: repo });
    await fs.writeFile(path.join(repo, 'xy', 'package.json'), JSON.stringify({ name: 'zorblatt' }));
    const full = await call('suggest_terms', { cwd: path.join(repo, 'xy') });
    expect((JSON.parse(full.blocks[0] ?? '') as unknown[]).length).toBeGreaterThan(0);
    expect(full.blocks).toHaveLength(1);
  });
});

describe('import_dictionary and import_vocabulary', () => {
  // Catches: "pass either path or content" while both together import the
  // content and let the path's extension pick the format.
  it('import_dictionary with both: content is imported, the path is not read, its extension picks the format', async () => {
    const d = (await tool('import_dictionary')).description ?? '';
    expect(d).toContain("With both, content is imported and path is not read: only its file name is used, so its extension steers format 'auto'");
    const res = await call('import_dictionary', { content: 'word,replacement\nhead sner,Hetzner\n', path: 'missing-dict.csv', dryRun: true });
    expect(res.isError).toBe(false);
    const report = res.json();
    expect(report.terms).toMatchObject([{ canonical: 'Hetzner', aliases: ['head sner'] }]);
  });

  // Catches: the preview cap, the single use and the 20-preview window were in
  // no description, so an agent holding an old token got "preview is missing".
  it('import_vocabulary: a token is used once and is dropped once 20 newer previews were made', async () => {
    const d = (await tool('import_vocabulary')).description ?? '';
    expect(d).toContain('(at most 50 per preview, across the sources chosen)');
    expect(d).toContain('a token is gone after one apply, after five minutes, or once 20 newer previews were made');
    await connected(async (client) => {
      const preview = async (): Promise<string> => {
        const r = (await client.callTool({ name: 'import_vocabulary', arguments: { sources: [] } })) as { content: { text: string }[] };
        return (JSON.parse(r.content[0]?.text ?? '') as { previewToken: string }).previewToken;
      };
      const apply = async (token: string) =>
        (await client.callTool({ name: 'import_vocabulary', arguments: { sources: [], apply: true, previewToken: token, approvedCandidateIds: [] } })) as { isError?: boolean; content: { text: string }[] };
      const tokens: string[] = [];
      for (let i = 0; i < 21; i += 1) tokens.push(await preview());
      expect((await apply(tokens[0]!)).isError).toBe(true);
      expect((await apply(tokens[1]!)).isError).not.toBe(true);
      const again = await apply(tokens[1]!);
      expect(again.isError).toBe(true);
      expect(again.content[0]?.text).toContain('preview is missing, expired');
    });
  });
});

describe('lexicon_doctor, serve_status and trust_project name every field they answer with', () => {
  // Catches: `error` (present exactly when ok is false) was in no description.
  it('lexicon_doctor: `error` is described and is there when ok is false', async () => {
    expect((await tool('lexicon_doctor')).description).toContain('`error` (only when ok is false: the first failing check)');
    await fs.writeFile(path.join(home, 'lexicon.yaml'), 'version: 1\nterms: [\n');
    const report = await runDoctorReport({ cwd: repo, audience: 'mcp' }, { home, platform: 'linux', env: { PATH: '', LEXICON_PATH: path.join(home, 'lexicon.yaml') }, exec: () => '' });
    expect(report.ok).toBe(false);
    expect(typeof report.error).toBe('string');
  });

  // Catches: `url` is on every serve_status result and no description said so.
  it('serve_status: every result carries url', async () => {
    expect((await tool('serve_status')).description).toContain('Every result carries `url`, the /health address probed');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const down = (await call('serve_status', {})).json();
      expect(down).toMatchObject({ up: false, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/) });
      fetchSpy.mockResolvedValueOnce(new Response('{"hello":"world"}', { status: 200, headers: { 'content-type': 'application/json' } }));
      const foreign = (await call('serve_status', {})).json();
      expect(foreign).toMatchObject({ up: false, url: down.url });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // Catches: the status and result words were in no description, so 'changed'
  // or 'declined' had to be guessed from a sample call.
  it("trust_project: the status words are described, and 'none', 'missing' and 'untrusted' are what status answers", async () => {
    const d = (await tool('trust_project')).description ?? '';
    for (const word of ["'trusted'", "'untrusted'", "'changed'", "'missing'", "'invalid'", "'none'", "'updated'", "'re-pinned'", "'already-trusted'", "'declined'"]) {
      expect(d).toContain(word);
    }
    expect((await call('trust_project', { action: 'status' })).json()).toMatchObject({ status: 'none' });
    expect((await call('trust_project', { action: 'status', path: 'nope.yaml' })).json()).toMatchObject({ status: 'missing' });
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms: []\n');
    expect((await call('trust_project', { action: 'status' })).json()).toMatchObject({ status: 'untrusted' });
    expect((await call('trust_project', { action: 'untrust' })).json()).toMatchObject({ removed: false });
  });
});
