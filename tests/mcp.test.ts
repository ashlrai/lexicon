import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Lexicon, LoadedLexicon, NormalizeResult, Term } from '../src/core/types.js';

// The core is under construction in parallel; the server is tested against a fake.
const fixtureLexicon: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'], category: 'brand', scope: 'global' },
    { canonical: 'Kubernetes', aliases: ['cooper netties'], category: 'product', scope: 'project' },
  ],
};

const loaded: LoadedLexicon = {
  merged: fixtureLexicon,
  global: { path: '/fake/global/lexicon.yaml', scope: 'global', lexicon: fixtureLexicon, exists: true },
  project: { path: '/fake/repo/.lexicon.yaml', scope: 'project', lexicon: { version: 1, terms: [] }, exists: true },
};

const mocks = vi.hoisted(() => ({
  loadLexicon: vi.fn(),
  normalize: vi.fn(),
  diffSummary: vi.fn(),
  recordHits: vi.fn(),
  addTerm: vi.fn(),
  removeTerm: vi.fn(),
  harvestRepo: vi.fn(),
  exportLexicon: vi.fn(),
  suggestAliases: vi.fn(),
  learnCorrection: vi.fn(),
  suggestCanonicalFor: vi.fn(),
  computeStats: vi.fn(),
}));

vi.mock('../src/core/index.js', () => mocks);

function fakeNormalize(text: string, _lexicon: Lexicon, opts?: { dryRun?: boolean }): NormalizeResult {
  const idx = text.indexOf('Ashler');
  if (idx === -1) return { input: text, output: text, replacements: [], changed: false };
  const output = opts?.dryRun ? text : text.replace('Ashler', 'Ashlr.AI');
  return {
    input: text,
    output,
    changed: output !== text,
    replacements: [
      {
        start: idx,
        end: idx + 'Ashler'.length,
        original: 'Ashler',
        replacement: 'Ashlr.AI',
        canonical: 'Ashlr.AI',
        reason: 'alias',
        confidence: 1,
      },
    ],
  };
}

beforeEach(() => {
  mocks.loadLexicon.mockResolvedValue(loaded);
  mocks.normalize.mockImplementation(fakeNormalize);
  mocks.diffSummary.mockImplementation(
    (r: NormalizeResult) =>
      r.replacements.map((x) => `"${x.original}" -> "${x.replacement}" (${x.reason}, ${x.confidence.toFixed(2)})`).join('\n'),
  );
  mocks.recordHits.mockResolvedValue(undefined);
  mocks.suggestAliases.mockImplementation((c: string) => [`${c} heard`, c.toLowerCase()]);
  mocks.addTerm.mockImplementation(async (term: Term, opts?: { scope?: string }) => ({
    file: { path: opts?.scope === 'project' ? '/fake/repo/.lexicon.yaml' : '/fake/global/lexicon.yaml', scope: opts?.scope ?? 'global', lexicon: fixtureLexicon, exists: true },
    term,
    created: true,
  }));
  mocks.removeTerm.mockResolvedValue(true);
  mocks.harvestRepo.mockResolvedValue([
    { canonical: 'FooBar', category: 'identifier', source: 'harvest:repo', evidence: ['src/a.ts'], count: 3, suggestedAliases: ['foo bar'] },
  ]);
  mocks.exportLexicon.mockImplementation((_l: Lexicon, format: string) =>
    format === 'json' ? JSON.stringify(fixtureLexicon) : '## Voice lexicon',
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const { createServer } = await import('../src/mcp/server.js');
  const server = createServer({ cwd: '/fake/repo' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('expected content array');
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') throw new Error('expected text content');
  return first.text;
}

describe('lexicon MCP server', () => {
  it('lists the nine tools', async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'add_term',
          'export_lexicon',
          'harvest_repo',
          'learn_correction',
          'lexicon_stats',
          'list_terms',
          'normalize_transcript',
          'remove_term',
          'suggest_canonical',
        ].sort(),
      );
      const normalizeTool = tools.find((t) => t.name === 'normalize_transcript');
      expect(normalizeTool?.description).toMatch(/dictat/i);
      expect(normalizeTool?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await close();
    }
  });

  it('lists lexicon://me and lexicon://json resources', async () => {
    const { client, close } = await connect();
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('lexicon://me');
      expect(uris).toContain('lexicon://json');
      const me = resources.find((r) => r.uri === 'lexicon://me');
      expect(me?.mimeType).toBe('text/markdown');

      const read = await client.readResource({ uri: 'lexicon://me' });
      const contents = read.contents as Array<{ uri: string; text?: string; mimeType?: string }>;
      expect(contents[0]?.text).toBe('## Voice lexicon');
      expect(mocks.exportLexicon).toHaveBeenCalledWith(fixtureLexicon, 'claude-md');
    } finally {
      await close();
    }
  });

  it('normalize_transcript returns the corrected text and records hits', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: 'normalize_transcript',
        arguments: { text: 'ship it to Ashler today' },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as {
        output: string;
        changed: boolean;
        replacements: unknown[];
        summary: string;
      };
      expect(payload.output).toBe('ship it to Ashlr.AI today');
      expect(payload.changed).toBe(true);
      expect(payload.replacements).toHaveLength(1);
      expect(payload.summary).toContain('"Ashler" -> "Ashlr.AI"');
      expect(mocks.loadLexicon).toHaveBeenCalledWith({ cwd: '/fake/repo' });
      expect(mocks.recordHits).toHaveBeenCalledWith(['Ashlr.AI'], { cwd: '/fake/repo' });
    } finally {
      await close();
    }
  });

  it('normalize_transcript with dryRun does not record hits', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: 'normalize_transcript',
        arguments: { text: 'Ashler', dryRun: true },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as { output: string; changed: boolean };
      expect(payload.output).toBe('Ashler');
      expect(payload.changed).toBe(false);
      expect(mocks.recordHits).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('add_term falls back to suggested aliases', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: 'add_term',
        arguments: { canonical: 'Zoë', category: 'person', scope: 'project' },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as { term: Term; path: string; created: boolean };
      expect(payload.term.aliases).toEqual(['Zoë heard', 'zoë']);
      expect(payload.term.source).toBe('user');
      expect(payload.path).toBe('/fake/repo/.lexicon.yaml');
      expect(payload.created).toBe(true);
      expect(mocks.suggestAliases).toHaveBeenCalledWith('Zoë');
    } finally {
      await close();
    }
  });

  it('list_terms filters case-insensitively over canonical and aliases', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'list_terms', arguments: { query: 'NETTIES' } });
      const payload = JSON.parse(textOf(result)) as {
        terms: Term[];
        counts: { matched: number; total: number };
        paths: { global: string; project?: string };
      };
      expect(payload.terms.map((t) => t.canonical)).toEqual(['Kubernetes']);
      expect(payload.counts).toMatchObject({ matched: 1, total: 2 });
      expect(payload.paths.project).toBe('/fake/repo/.lexicon.yaml');
    } finally {
      await close();
    }
  });

  it('harvest_repo adds candidates with project scope when add is true', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'harvest_repo', arguments: { add: true } });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as { added: number; count: number };
      expect(payload.count).toBe(1);
      expect(payload.added).toBe(1);
      expect(mocks.harvestRepo).toHaveBeenCalledWith('/fake/repo', {});
      expect(mocks.addTerm).toHaveBeenCalledWith(
        expect.objectContaining({ canonical: 'FooBar', aliases: ['foo bar'], scope: 'project', source: 'harvest:repo' }),
        { cwd: '/fake/repo', scope: 'project' },
      );
    } finally {
      await close();
    }
  });

  it('export_lexicon returns the exported string', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'export_lexicon', arguments: { format: 'claude-md' } });
      expect(result.isError).toBe(false);
      expect(textOf(result)).toBe('## Voice lexicon');
    } finally {
      await close();
    }
  });

  it('wraps core errors as isError results instead of protocol errors', async () => {
    mocks.loadLexicon.mockRejectedValueOnce(new Error('disk on fire'));
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'list_terms', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('disk on fire');
    } finally {
      await close();
    }
  });

  it('exposes the voice-context prompt', async () => {
    const { client, close } = await connect();
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toContain('voice-context');
      const prompt = await client.getPrompt({ name: 'voice-context' });
      const message = prompt.messages[0];
      expect(message?.role).toBe('user');
      const text = (message?.content as { type: string; text?: string }).text ?? '';
      expect(text.startsWith('## Voice lexicon')).toBe(true);
      expect(text).toContain('Apply these canonical spellings');
    } finally {
      await close();
    }
  });

  it('sends usage instructions at initialize', async () => {
    const { client, close } = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('lexicon://me');
      expect(instructions).toContain('normalize_transcript');
      expect(instructions).toContain('learn_correction');
      expect(instructions).toMatch(/never rewrite .*code/i);
    } finally {
      await close();
    }
  });

  it('learn_correction records the heard form against the meant term', async () => {
    const learnedTerm: Term = { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashlur'], category: 'brand', scope: 'global' };
    mocks.learnCorrection.mockResolvedValue({
      term: learnedTerm,
      created: false,
      aliasAdded: true,
      file: { path: '/fake/global/lexicon.yaml', scope: 'global', lexicon: fixtureLexicon, exists: true },
    });
    const { client, close } = await connect();
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'learn_correction');
      expect(tool?.description).toMatch(/it's Ashlr\.AI not Ashler/);
      const result = await client.callTool({
        name: 'learn_correction',
        arguments: { heard: 'Ashlur', meant: 'Ashlr.AI' },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as {
        term: Term;
        path: string;
        created: boolean;
        aliasAdded: boolean;
        summary: string;
      };
      expect(payload.term.aliases).toContain('Ashlur');
      expect(payload.path).toBe('/fake/global/lexicon.yaml');
      expect(payload.created).toBe(false);
      expect(payload.aliasAdded).toBe(true);
      expect(payload.summary).toBe('"Ashlur" -> "Ashlr.AI" saved');
      expect(mocks.learnCorrection).toHaveBeenCalledWith({ heard: 'Ashlur', meant: 'Ashlr.AI' }, { cwd: '/fake/repo' });
    } finally {
      await close();
    }
  });

  it('learn_correction passes scope through and reports refusals as isError', async () => {
    mocks.learnCorrection.mockRejectedValueOnce(new Error('"Ashler" and "ashler" are the same spelling; nothing to learn'));
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: 'learn_correction',
        arguments: { heard: 'Ashler', meant: 'ashler', scope: 'project' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('same spelling');
      expect(mocks.learnCorrection).toHaveBeenCalledWith(
        { heard: 'Ashler', meant: 'ashler' },
        { cwd: '/fake/repo', scope: 'project' },
      );
    } finally {
      await close();
    }
  });

  it('suggest_canonical ranks lexicon terms for a garbled word', async () => {
    mocks.suggestCanonicalFor.mockReturnValue([
      { term: fixtureLexicon.terms[0], confidence: 0.91234 },
      { term: fixtureLexicon.terms[1], confidence: 0.6 },
    ]);
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'suggest_canonical', arguments: { heard: 'ashlur' } });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(textOf(result)) as {
        heard: string;
        suggestions: { canonical: string; confidence: number; aliases: string[]; category?: string }[];
      };
      expect(payload.heard).toBe('ashlur');
      expect(payload.suggestions).toEqual([
        { canonical: 'Ashlr.AI', confidence: 0.912, aliases: ['Ashler', 'Ashlar'], category: 'brand' },
        { canonical: 'Kubernetes', confidence: 0.6, aliases: ['cooper netties'], category: 'product' },
      ]);
      expect(mocks.suggestCanonicalFor).toHaveBeenCalledWith('ashlur', fixtureLexicon);
    } finally {
      await close();
    }
  });

  it('lexicon_stats returns computeStats over the freshly loaded lexicon', async () => {
    const stats = {
      termCount: 2,
      aliasCount: 3,
      totalHits: 0,
      topTerms: [],
      neverHit: ['Ashlr.AI', 'Kubernetes'],
      byCategory: { brand: 1, product: 1 },
      bySource: { unknown: 2 },
      files: [{ path: '/fake/global/lexicon.yaml', scope: 'global', terms: 2 }],
    };
    mocks.computeStats.mockReturnValue(stats);
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'lexicon_stats', arguments: {} });
      expect(result.isError).toBe(false);
      expect(JSON.parse(textOf(result))).toEqual(stats);
      expect(mocks.computeStats).toHaveBeenCalledWith(loaded);
      expect(mocks.loadLexicon).toHaveBeenCalledWith({ cwd: '/fake/repo' });
    } finally {
      await close();
    }
  });
});
