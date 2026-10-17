import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Lexicon, LexiconFile, LoadedLexicon, NormalizeResult, Term } from '../src/core/types.js';
import type { DoctorReport, IO } from '../src/cli/commands.js';
import type { SetupOptions, SetupPlan, SetupSummary } from '../src/cli/cmd-setup.js';
import type { TermSuggestion } from '../src/core/suggestTerms.js';

// The server is tested against a fake core: these assertions are about the tool
// schemas, the argument plumbing and the result shapes, not about what the core
// computes. The real core is exercised by its own suites (and, for the trust
// tool's sanitizing, by mcp-trust-injection.test.ts, which mocks nothing).
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
  loadMatcherIndex: vi.fn(),
  normalizeWithIndex: vi.fn(),
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
  // trust_project
  getTrustPath: vi.fn(),
  hashFile: vi.fn(),
  isTrusted: vi.fn(),
  listTrusted: vi.fn(),
  readLexiconFile: vi.fn(),
  resolvePaths: vi.fn(),
  sanitizeForDisplay: vi.fn(),
  trustAllEnabled: vi.fn(),
  trustProject: vi.fn(),
  untrustProject: vi.fn(),
  // suggest_terms (built alongside; reached through the core index)
  suggestTerms: vi.fn(),
  loadVoiceHistory: vi.fn(),
  // packs / registry
  listPacks: vi.fn(),
  installPack: vi.fn(),
  loadRegistryIndex: vi.fn(),
  findRegistryEntry: vi.fn(),
  downloadPack: vi.fn(),
  verifyPackChecksum: vi.fn(),
  parsePackText: vi.fn(),
  installRegistryPack: vi.fn(),
  // import_vocabulary
  listImportSources: vi.fn(),
  getImportSource: vi.fn(),
  harvestImportSources: vi.fn(),
  applyImportCandidates: vi.fn(),
}));

// CLI handlers the agent-native tools reuse. Each is mocked at its module so
// the server never pulls the real CLI (and its disk access) into this test.
const cli = vi.hoisted(() => ({
  runDoctorReport: vi.fn(),
  runImport: vi.fn(),
  runInstall: vi.fn(),
  runSetup: vi.fn(),
}));

// The functions are faked; the core's plain data (the TERM_CATEGORIES /
// TERM_SCOPES / EXPORT_FORMATS tuples the tool schemas build their zod enums
// from) comes from the real module, so adding a constant to the core does not
// silently break every tool in this file.
vi.mock('../src/core/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks,
}));
vi.mock('../src/cli/commands.js', () => ({ runDoctorReport: cli.runDoctorReport }));
vi.mock('../src/cli/cmd-import.js', () => ({ MAX_IMPORT_BYTES: 8 * 1024 * 1024, runImport: cli.runImport }));
vi.mock('../src/cli/cmd-install.js', () => ({ runInstall: cli.runInstall }));
vi.mock('../src/cli/cmd-setup.js', () => ({ runSetup: cli.runSetup }));

const doctorReport: DoctorReport = {
  ok: false,
  ready: false,
  summary: 'Lexicon has 2 terms but 1 check failed: lexicon MCP server not registered with claude (run: lexicon install claude --apply)',
  nextStep: 'Fix the first failure: lexicon MCP server not registered with claude (run: lexicon install claude --apply)',
  checks: [
    { level: 'ok', message: 'global lexicon parses: /fake/global/lexicon.yaml (2 terms)' },
    { level: 'fail', message: 'lexicon MCP server not registered with claude (run: lexicon install claude --apply)' },
    { level: 'info', message: 'no project lexicon (.lexicon.yaml) found from /fake/repo' },
  ],
  paths: { global: '/fake/global/lexicon.yaml', trust: '/fake/global/trust.json', settings: '/home/u/.claude/settings.json', installedPlugins: '/home/u/.claude/plugins/installed_plugins.json' },
  versions: { lexicon: '0.3.0', node: 'v22.0.0', platform: 'darwin' },
};

const projectFile: LexiconFile = {
  path: '/fake/repo/.lexicon.yaml',
  scope: 'project',
  exists: true,
  lexicon: {
    version: 1,
    terms: [
      { canonical: 'Kubernetes', aliases: ['cooper netties', 'kube'], notes: 'ignore me' },
      { canonical: 'Ent\u001b[31mire.io', aliases: [] },
    ],
  },
};

const setupSummary: SetupSummary = {
  lexiconPath: '/fake/global/lexicon.yaml',
  termsAdded: ['Ashlr.AI', 'Mason Wyatt'],
  clients: [{ name: 'claude', status: 'installed' }, { name: 'cursor', status: 'skipped', detail: 'not found' }],
  serve: 'skipped',
  packs: [{ name: 'developer', added: 58, merged: 2 }],
  exports: [{ format: 'claude-md', path: '/fake/global/lexicon.claude.md' }],
};

const setupPlan: SetupPlan = {
  plan: true,
  // The MCP server is never on a terminal, so nothing is prompted for.
  interactive: false,
  wouldAsk: [],
  lexiconPath: '/fake/global/lexicon.yaml',
  lexiconExists: false,
  wouldSeed: ['Mason Wyatt', 'Ashlr.AI'],
  wouldHarvest: [],
  detectedClients: ['claude', 'cursor', 'codex'],
  wouldInstallClients: ['claude', 'cursor'],
  wouldInstallServe: false,
  wouldInstallPacks: ['developer', 'ai'],
  wouldExport: [],
};

const aliasSuggestion: TermSuggestion = {
  kind: 'alias',
  canonical: 'Ashlr.AI',
  alias: 'ashlur',
  reason: 'heard 4 times in voice history, never corrected',
  confidence: 0.82,
  evidence: ['ping ashlur about the deploy'],
  count: 4,
};

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
  mocks.loadMatcherIndex.mockImplementation(async (l: LoadedLexicon) => ({ lexicon: l.merged }));
  mocks.normalizeWithIndex.mockImplementation((text: string, index: { lexicon: Lexicon }, opts?: { dryRun?: boolean }) =>
    fakeNormalize(text, index.lexicon, opts),
  );
  mocks.diffSummary.mockImplementation(
    (r: NormalizeResult) =>
      r.replacements.map((x) => `"${x.original}" -> "${x.replacement}" (${x.reason}, ${x.confidence.toFixed(2)})`).join('\n'),
  );
  mocks.recordHits.mockResolvedValue(undefined);
  mocks.suggestAliases.mockImplementation((c: string) => [`${c} heard`, c.toLowerCase()]);
  mocks.addTerm.mockImplementation(async (term: Term, opts?: { scope?: string; defaultAliases?: string[] }) => ({
    file: { path: opts?.scope === 'project' ? '/fake/repo/.lexicon.yaml' : '/fake/global/lexicon.yaml', scope: opts?.scope ?? 'global', lexicon: fixtureLexicon, exists: true },
    term: term.aliases.length === 0 && opts?.defaultAliases ? { ...term, aliases: opts.defaultAliases } : term,
    created: true,
  }));
  mocks.removeTerm.mockResolvedValue(true);
  mocks.harvestRepo.mockResolvedValue([
    { canonical: 'FooBar', category: 'identifier', source: 'harvest:repo', evidence: ['src/a.ts'], count: 3, suggestedAliases: ['foo bar'] },
  ]);
  mocks.exportLexicon.mockImplementation((_l: Lexicon, format: string) =>
    format === 'json' ? JSON.stringify(fixtureLexicon) : '## Voice lexicon',
  );
  mocks.getTrustPath.mockReturnValue('/fake/global/trust.json');
  mocks.hashFile.mockResolvedValue('abcdef0123456789');
  mocks.isTrusted.mockResolvedValue('untrusted');
  mocks.listTrusted.mockResolvedValue([]);
  mocks.readLexiconFile.mockResolvedValue(projectFile);
  mocks.resolvePaths.mockReturnValue({ global: '/fake/global/lexicon.yaml', project: '/fake/repo/.lexicon.yaml' });
  mocks.sanitizeForDisplay.mockImplementation((s: string) => s.replace(/\x1b\[[0-9;]*m|[\x00-\x1f]/g, ''));
  mocks.trustAllEnabled.mockReturnValue(false);
  mocks.trustProject.mockResolvedValue({ sha256: 'abcdef0123456789', trustedAt: '2026-09-19T00:00:00.000Z' });
  mocks.untrustProject.mockResolvedValue(true);
  mocks.suggestTerms.mockResolvedValue([aliasSuggestion]);
  mocks.loadVoiceHistory.mockResolvedValue([]);
  cli.runDoctorReport.mockResolvedValue(doctorReport);
  cli.runInstall.mockImplementation(async (client: string, opts: { apply?: boolean }, io: IO) => {
    io.stdout(`1. Add the lexicon MCP server to ${client}\n   ${opts.apply ? 'merge into' : 'would merge into'} /home/u/.cursor/mcp.json\n`);
    return 0;
  });
  cli.runImport.mockImplementation(async (file: string, opts: { dryRun?: boolean; project?: boolean }, io: IO, readInput?: (f: string, c: string) => Promise<string>) => {
    const content = readInput ? await readInput(file, '/fake/repo') : '';
    io.stdout(
      `${JSON.stringify({
        format: 'text',
        scope: opts.project ? 'project' : 'global',
        dryRun: opts.dryRun ?? false,
        terms: content.split('\n').filter(Boolean).map((l) => ({ canonical: l.split(':')[0], aliases: [], created: true })),
        skipped: [],
        counts: { total: 1, created: 1, merged: 0, skipped: 0 },
      })}\n`,
    );
    return 0;
  });
  cli.runSetup.mockImplementation(async (opts: SetupOptions) =>
    opts.dryRun
      ? { code: 0, summary: { lexiconPath: setupPlan.lexiconPath, termsAdded: [], clients: [], serve: 'skipped', exports: [] }, plan: setupPlan }
      : { code: 0, summary: setupSummary },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// `elicit` makes the client advertise elicitation and answer every request with it,
// standing in for the user answering the client's prompt.
async function connect(
  elicit?: (message: string) => ElicitResult | Promise<ElicitResult>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { createServer } = await import('../src/mcp/server.js');
  const server = createServer({ cwd: '/fake/repo' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, elicit ? { capabilities: { elicitation: {} } } : undefined);
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message));
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
  it('lists the twenty tools', async () => {
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
          'lexicon_doctor',
          'install_client',
          'trust_project',
          'import_dictionary',
          'import_vocabulary',
          'suggest_terms',
          'apply_suggestion',
          'setup_lexicon',
          'serve_status',
          'list_packs',
          'add_pack',
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
      // The suggestions go in as the fallback for a new term, never as aliases to merge.
      expect(mocks.addTerm).toHaveBeenLastCalledWith(
        { canonical: 'Zoë', aliases: [], source: 'user', category: 'person', scope: 'project' },
        { cwd: '/fake/repo', scope: 'project', defaultAliases: ['Zoë heard', 'zoë'] },
      );
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

  // Catches: harvest_repo with add: true answered isError: false with
  // added: 0 when every write failed, so an agent reported the candidates as added.
  it('harvest_repo with add is an error when no candidate could be written, and notes a partial failure', async () => {
    const { client, close } = await connect();
    try {
      mocks.addTerm.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      const failed = await client.callTool({ name: 'harvest_repo', arguments: { add: true } });
      expect(failed.isError).toBe(true);
      expect(JSON.parse(textOf(failed))).toMatchObject({
        count: 1,
        added: 0,
        failures: [{ canonical: 'FooBar', error: 'EACCES: permission denied' }],
        note: expect.stringContaining('1 of 1 candidates were not added'),
      });

      mocks.harvestRepo.mockResolvedValueOnce([
        { canonical: 'FooBar', category: 'product', count: 2, evidence: [], suggestedAliases: ['foo bar'], source: 'harvest:repo' },
        { canonical: 'BazQux', category: 'product', count: 2, evidence: [], suggestedAliases: [], source: 'harvest:repo' },
      ]);
      mocks.addTerm.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      const partial = await client.callTool({ name: 'harvest_repo', arguments: { add: true } });
      expect(partial.isError).toBe(false);
      expect(JSON.parse(textOf(partial))).toMatchObject({ added: 1, note: expect.stringContaining('1 of 2 candidates were not added') });
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
      expect(instructions).toContain('setup_lexicon');
      expect(instructions).toMatch(/setup_lexicon previews by default/i);
      expect(instructions).toMatch(/harvest: true and serve: true only for what the user agreed to/);
      expect(instructions).toMatch(/omitted clients install nothing/i);
      expect(instructions).toContain('suggest_terms');
      expect(instructions).toContain('lexicon_doctor');
      expect(instructions).toMatch(/preview install_client/i);
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

  it('learn_correction names an untrusted project lexicon that also claims heard, by path only', async () => {
    mocks.learnCorrection.mockResolvedValue({
      term: { canonical: 'Vercel', aliases: ['Versel'], scope: 'global' },
      created: true,
      aliasAdded: true,
      file: { path: '/fake/global/lexicon.yaml', scope: 'global', lexicon: fixtureLexicon, exists: true },
      untrustedProject: { path: '/fake/repo/.lexicon.yaml', trust: 'untrusted' },
    });
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'learn_correction', arguments: { heard: 'Versel', meant: 'Vercel' } });
      const payload = JSON.parse(textOf(result)) as { untrustedProject?: unknown; summary: string };
      expect(payload.untrustedProject).toEqual({ path: '/fake/repo/.lexicon.yaml', trust: 'untrusted' });
      expect(payload.summary).toContain('/fake/repo/.lexicon.yaml is not trusted');
      expect(payload.summary).toContain('`lexicon trust`');
      expect(payload.summary).toContain('also claims "Versel"');
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

  // ------------------------------------------------------------ agent-native

  describe('agent-native tools', () => {
    it('lexicon_doctor returns the structured report for the server cwd', async () => {
      const { client, close } = await connect();
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'lexicon_doctor');
        expect(tool?.description).toMatch(/corrections are not happening/);
        expect(tool?.description).toContain('an integration declaration was found');
        expect(tool?.description).toContain('does not verify a live client connection or an actual correction');
        expect(tool?.description).not.toContain('true means corrections will actually happen');
        const result = await client.callTool({ name: 'lexicon_doctor', arguments: {} });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toEqual(doctorReport);
        expect(cli.runDoctorReport).toHaveBeenCalledWith({ cwd: '/fake/repo' });
      } finally {
        await close();
      }
    });

    it('install_client previews by default and applies only with apply: true', async () => {
      const { client, close } = await connect();
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'install_client');
        expect(tool?.description).toMatch(/preview/i);
        expect(tool?.description).toMatch(/confirm/i);

        const preview = await client.callTool({ name: 'install_client', arguments: { client: 'cursor' } });
        expect(preview.isError).toBe(false);
        const p = JSON.parse(textOf(preview)) as { client: string; scope: string; applied: boolean; ok: boolean; output: string; next?: string };
        expect(p).toMatchObject({ client: 'cursor', scope: 'user', applied: false, ok: true });
        expect(p.output).toContain('would merge into /home/u/.cursor/mcp.json');
        expect(p.next).toMatch(/apply: true/);
        expect(cli.runInstall).toHaveBeenCalledWith(
          'cursor',
          { cwd: '/fake/repo', apply: false },
          expect.objectContaining({ stdout: expect.any(Function) }),
          expect.objectContaining({ cliDir: expect.stringMatching(/dist[\\/]cli$/) }),
        );

        const applied = await client.callTool({ name: 'install_client', arguments: { client: 'codex', apply: true, scope: 'project' } });
        const a = JSON.parse(textOf(applied)) as { applied: boolean; scope: string; output: string; next?: string };
        expect(a.applied).toBe(true);
        expect(a.scope).toBe('project');
        expect(a.output).toContain('merge into');
        expect(a.next).toBeUndefined();
        expect(cli.runInstall).toHaveBeenLastCalledWith('codex', { cwd: '/fake/repo', apply: true, scope: 'project' }, expect.anything(), expect.anything());
      } finally {
        await close();
      }
    });

    it('install_client rejects clients outside the enum', async () => {
      const { client, close } = await connect();
      try {
        const result = await client.callTool({ name: 'install_client', arguments: { client: 'emacs' } });
        expect(result.isError).toBe(true);
        expect(cli.runInstall).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('trust_project status reports the state with a sanitized preview and never the notes', async () => {
      const { client, close } = await connect();
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'trust_project');
        expect(tool?.description).toMatch(/ask/i);
        expect(tool?.description).toMatch(/never trust/i);
        expect(tool?.description).toMatch(/instead of reading \.lexicon\.yaml yourself/);
        expect(tool?.description).toMatch(/Do not open the file with Read or cat/);
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'status' } });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(textOf(result)) as {
          action: string;
          path: string;
          status: string;
          termCount: number;
          more: number;
          preview: { canonical: string; firstAlias?: string; aliasCount: number; hasNotes: boolean }[];
          registry: string;
          trustAll: boolean;
          trusted: unknown[];
        };
        expect(payload).toMatchObject({ action: 'status', path: '/fake/repo/.lexicon.yaml', status: 'untrusted', termCount: 2, more: 0, registry: '/fake/global/trust.json', trustAll: false, trusted: [] });
        expect(payload.preview).toEqual([
          { canonical: 'Kubernetes', firstAlias: 'cooper netties', aliasCount: 2, hasNotes: true },
          { canonical: 'Entire.io', aliasCount: 0, hasNotes: false },
        ]);
        expect(textOf(result)).not.toContain('ignore me');
        expect(mocks.readLexiconFile).toHaveBeenCalledWith('/fake/repo/.lexicon.yaml', 'project');
        expect(mocks.trustProject).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('trust_project status without a project file says so instead of failing', async () => {
      mocks.resolvePaths.mockReturnValue({ global: '/fake/global/lexicon.yaml' });
      const { client, close } = await connect();
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'status' } });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toMatchObject({ status: 'none' });
        const trust = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(trust.isError).toBe(true);
        expect(textOf(trust)).toMatch(/pass a path/);
      } finally {
        await close();
      }
    });

    it('trust_project trust asks the user, then pins the file and returns the term count and preview', async () => {
      const asked: string[] = [];
      const { client, close } = await connect((message) => {
        asked.push(message);
        return { action: 'accept', content: { trust: true } };
      });
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust', path: 'sub/.lexicon.yaml' } });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
        expect(payload).toMatchObject({
          action: 'trust',
          path: path.join(path.resolve('/fake/repo'), 'sub', '.lexicon.yaml'),
          previousStatus: 'untrusted',
          status: 'trusted',
          result: 'trusted',
          sha256: 'abcdef012345',
          termCount: 2,
        });
        expect((payload.preview as unknown[]).length).toBe(2);
        expect(mocks.trustProject).toHaveBeenCalledWith(path.join(path.resolve('/fake/repo'), 'sub', '.lexicon.yaml'), { cwd: '/fake/repo', expectedSha256: 'abcdef0123456789' });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/Trust the project lexicon at .*sub.*\.lexicon\.yaml\? Its 2 term\(s\) \(Kubernetes, Entire\.io\)/);
        expect(asked[0]).not.toContain('ignore me');
      } finally {
        await close();
      }
    });

    it('trust_project trust never trusts on the agent\'s word when the client cannot ask the user', async () => {
      const { client, close } = await connect();
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/needs the user's approval and this client cannot ask them/);
        expect(textOf(result)).toMatch(/lexicon trust/);
        expect(mocks.trustProject).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('trust_project trust does nothing when the user declines or cancels', async () => {
      for (const answer of [
        { action: 'decline' },
        { action: 'cancel' },
        { action: 'accept', content: { trust: false } },
      ] as ElicitResult[]) {
        const { client, close } = await connect(() => answer);
        try {
          const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
          expect(result.isError).toBe(false);
          expect(JSON.parse(textOf(result))).toMatchObject({ action: 'trust', status: 'untrusted', result: 'declined' });
        } finally {
          await close();
        }
      }
      expect(mocks.trustProject).not.toHaveBeenCalled();
    });

    it('trust_project trust refuses when the file changes after the user saw it', async () => {
      const { client, close } = await connect(() => {
        mocks.hashFile.mockResolvedValue('feedface');
        return { action: 'accept', content: { trust: true } };
      });
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/changed while waiting for approval; nothing was trusted/);
        expect(mocks.trustProject).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('trust_project trust revokes a pin whose bytes differ from what the user approved', async () => {
      mocks.trustProject.mockResolvedValueOnce({ sha256: 'feedface00000000', trustedAt: '2026-09-19T00:00:00.000Z' });
      const { client, close } = await connect(() => ({ action: 'accept', content: { trust: true } }));
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/changed while it was being trusted; trust was revoked/);
        expect(mocks.untrustProject).toHaveBeenCalledWith('/fake/repo/.lexicon.yaml', { cwd: '/fake/repo' });
      } finally {
        await close();
      }
    });

    it('trust_project trust re-pins an already trusted file without asking', async () => {
      mocks.isTrusted.mockResolvedValue('trusted');
      const { client, close } = await connect();
      try {
        const result = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toMatchObject({ result: 're-pinned' });
      } finally {
        await close();
      }
    });

    it('trust_project refuses a missing or invalid file and untrust reports removal', async () => {
      mocks.readLexiconFile.mockResolvedValueOnce({ ...projectFile, exists: false, lexicon: { version: 1, terms: [] } });
      const { client, close } = await connect();
      try {
        const missing = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(missing.isError).toBe(true);
        expect(textOf(missing)).toMatch(/does not exist/);
        mocks.readLexiconFile.mockRejectedValueOnce(new Error('bad yaml at line 3'));
        const invalid = await client.callTool({ name: 'trust_project', arguments: { action: 'trust' } });
        expect(invalid.isError).toBe(true);
        expect(textOf(invalid)).toMatch(/refusing to trust an invalid lexicon: bad yaml/);
        expect(mocks.trustProject).not.toHaveBeenCalled();

        const untrust = await client.callTool({ name: 'trust_project', arguments: { action: 'untrust' } });
        expect(JSON.parse(textOf(untrust))).toMatchObject({ action: 'untrust', removed: true });
        expect(mocks.untrustProject).toHaveBeenCalledWith('/fake/repo/.lexicon.yaml', { cwd: '/fake/repo' });
      } finally {
        await close();
      }
    });

    it('import_dictionary runs a dry run over inline content and returns the report', async () => {
      const { client, close } = await connect();
      try {
        const result = await client.callTool({
          name: 'import_dictionary',
          arguments: { content: 'Ashlr.AI: Ashler, Ashlar\n', dryRun: true },
        });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(textOf(result)) as { format: string; scope: string; dryRun: boolean; terms: { canonical: string }[] };
        expect(payload).toMatchObject({ format: 'text', scope: 'global', dryRun: true });
        expect(payload.terms.map((t) => t.canonical)).toEqual(['Ashlr.AI']);
        expect(cli.runImport).toHaveBeenCalledWith(
          '-',
          { cwd: '/fake/repo', format: 'auto', project: false, dryRun: true, json: true },
          expect.anything(),
          expect.any(Function),
        );
        const withPath = await client.callTool({ name: 'import_dictionary', arguments: { path: 'dict.csv', format: 'wispr', scope: 'project' } });
        expect(withPath.isError).toBe(false);
        expect(cli.runImport).toHaveBeenLastCalledWith('dict.csv', { cwd: '/fake/repo', format: 'wispr', project: true, dryRun: false, json: true }, expect.anything(), undefined);
      } finally {
        await close();
      }
    });

    it('import_dictionary needs path or content and surfaces CLI failures', async () => {
      const { client, close } = await connect();
      try {
        const neither = await client.callTool({ name: 'import_dictionary', arguments: {} });
        expect(neither.isError).toBe(true);
        expect(textOf(neither)).toMatch(/pass path or content/);
        cli.runImport.mockImplementationOnce(async (_f: string, _o: unknown, io: IO) => {
          io.stderr('lexicon: unknown import format "nope"\n');
          return 1;
        });
        const failed = await client.callTool({ name: 'import_dictionary', arguments: { content: 'x' } });
        expect(failed.isError).toBe(true);
        expect(textOf(failed)).toContain('unknown import format');
      } finally {
        await close();
      }
    });

    describe('import_vocabulary', () => {
      const fakeSource = (id: string) => ({
        id,
        label: `${id} source`,
        privacy: `Reads ${id}.`,
        implemented: true,
        checkAvailable: async () => ({ available: id === 'github' }),
        harvest: async () => [],
      });
      const githubSource = fakeSource('github');
      const candidate = {
        canonical: 'Mason Wyatt',
        category: 'person',
        source: 'import:github',
        evidence: ['GitHub profile name'],
        count: 1,
        suggestedAliases: [],
      };

      beforeEach(() => {
        mocks.listImportSources.mockReturnValue([fakeSource('contacts'), fakeSource('calendar'), githubSource]);
        mocks.getImportSource.mockImplementation((id: string) => fakeSource(id));
        mocks.harvestImportSources.mockResolvedValue([candidate]);
        mocks.applyImportCandidates.mockResolvedValue({ added: 1, merged: 0, skipped: 0, path: '/fake/global/lexicon.yaml' });
      });

      it('previews availability and candidates without writing', async () => {
        const { client, close } = await connect();
        try {
          const result = await client.callTool({ name: 'import_vocabulary', arguments: { sources: ['github'] } });
          expect(result.isError).toBe(false);
          const payload = JSON.parse(textOf(result)) as {
            applied: boolean;
            sources: { id: string; available: boolean; privacy: string }[];
            candidates: { canonical: string; source: string }[];
            next: string;
          };
          expect(payload.applied).toBe(false);
          const byId = new Map(payload.sources.map((s) => [s.id, s]));
          expect(byId.get('github')).toMatchObject({ id: 'github', available: true, chosen: true });
          expect(byId.get('contacts')).toMatchObject({ available: false });
          expect(payload.sources[2].privacy).toMatch(/github/);
          expect(payload.candidates).toMatchObject([{ canonical: 'Mason Wyatt', source: 'import:github' }]);
          expect(payload.next).toMatch(/apply: true/);
          expect(mocks.applyImportCandidates).not.toHaveBeenCalled();
        } finally {
          await close();
        }
      });

      it('without sources returns descriptions without probing or harvesting', async () => {
        const probe = vi.fn(async () => ({ available: true }));
        mocks.listImportSources.mockReturnValue([{ ...githubSource, checkAvailable: probe }]);
        const { client, close } = await connect();
        try {
          const result = await client.callTool({ name: 'import_vocabulary', arguments: {} });
          expect(result.isError).toBe(false);
          expect(JSON.parse(textOf(result)).candidates).toEqual([]);
          expect(probe).not.toHaveBeenCalled();
          expect(mocks.harvestImportSources).not.toHaveBeenCalled();
        } finally { await close(); }
      });

      it('requires explicit sources and candidate approval before applying', async () => {
        const { client, close } = await connect();
        try {
          for (const arguments_ of [{ apply: true }, { apply: true, sources: ['github'] }]) {
            const result = await client.callTool({ name: 'import_vocabulary', arguments: arguments_ });
            expect(result.isError).toBe(true);
          }
          expect(mocks.harvestImportSources).not.toHaveBeenCalled();
          expect(mocks.applyImportCandidates).not.toHaveBeenCalled();
        } finally { await close(); }
      });

      it('applies selected snapshot ids only and never re-harvests changed sources', async () => {
        const omitted = { ...candidate, canonical: 'Unapproved Person' };
        mocks.harvestImportSources.mockResolvedValue([candidate, omitted]);
        const { client, close } = await connect();
        try {
          const preview = JSON.parse(textOf(await client.callTool({ name: 'import_vocabulary', arguments: { sources: ['github'] } })));
          mocks.harvestImportSources.mockResolvedValue([{ ...candidate, canonical: 'New After Preview' }]);
          const args = { apply: true, sources: ['github'], previewToken: preview.previewToken, approvedCandidateIds: [preview.candidates[0].id] };
          const result = await client.callTool({ name: 'import_vocabulary', arguments: args });
          expect(result.isError).toBe(false);
          expect(JSON.parse(textOf(result))).toMatchObject({ applied: true, added: 1 });
          expect(mocks.harvestImportSources).toHaveBeenCalledTimes(1);
          expect(mocks.applyImportCandidates).toHaveBeenCalledWith([candidate], { cwd: '/fake/repo' });
          expect((await client.callTool({ name: 'import_vocabulary', arguments: args })).isError).toBe(true);
        } finally { await close(); }
      });

      it('retains an approved preview when the snapshot cache is at capacity', async () => {
        const { client, close } = await connect();
        try {
          const previews = [];
          for (let i = 0; i < 20; i++) {
            previews.push(JSON.parse(textOf(await client.callTool({ name: 'import_vocabulary', arguments: { sources: ['github'] } }))));
          }
          const first = previews[0];
          const result = await client.callTool({ name: 'import_vocabulary', arguments: {
            apply: true, sources: ['github'], previewToken: first.previewToken,
            approvedCandidateIds: [first.candidates[0].id],
          } });
          expect(result.isError).toBe(false);
          expect(mocks.applyImportCandidates).toHaveBeenCalledWith([candidate], { cwd: '/fake/repo' });
        } finally { await close(); }
      });

      it('rejects ids absent from a preview and changed destination scope', async () => {
        const { client, close } = await connect();
        try {
          const preview = JSON.parse(textOf(await client.callTool({ name: 'import_vocabulary', arguments: { sources: ['github'] } })));
          const args = { apply: true, sources: ['github'], previewToken: preview.previewToken };
          expect((await client.callTool({ name: 'import_vocabulary', arguments: { ...args, approvedCandidateIds: ['00'.repeat(32)] } })).isError).toBe(true);
          expect((await client.callTool({ name: 'import_vocabulary', arguments: { ...args, approvedCandidateIds: [preview.candidates[0].id], scope: 'project' } })).isError).toBe(true);
          expect(mocks.applyImportCandidates).not.toHaveBeenCalled();
        } finally { await close(); }
      });
    });

    describe('community packs over MCP', () => {
      const entry = {
        ref: 'example/cardiology',
        author: 'example',
        name: 'cardiology',
        title: 'Cardiology terms',
        description: 'Heart words.',
        homepage: '',
        version: '1',
        terms: 1,
        aliases: 2,
        checksum: 'ab'.repeat(32),
        url: './cardiology.yaml',
      };

      beforeEach(() => {
        mocks.listPacks.mockResolvedValue([
          { name: 'developer', title: 'Dev', description: 'd', version: 1, author: '', homepage: '', terms: 2, aliases: 3, path: '/fake/developer.yaml' },
        ]);
        mocks.loadLexicon.mockResolvedValue({ ...loaded, global: { ...loaded.global, lexicon: { version: 1, terms: [] } } });
        mocks.loadRegistryIndex.mockResolvedValue({ index: { packs: [entry] }, base: '/fake' });
        mocks.findRegistryEntry.mockReturnValue(entry);
        mocks.downloadPack.mockResolvedValue(Buffer.from('pack-bytes'));
        mocks.verifyPackChecksum.mockReturnValue(undefined);
        mocks.parsePackText.mockReturnValue({
          name: 'cardiology',
          title: 'Cardiology terms',
          lexicon: { version: 1, terms: [{ canonical: 'Metoprolol', aliases: ['metoprolol'], category: 'brand', notes: 'Preview this context note', phonetic: ['met-oh-pro-lol'], caseSensitive: true }] },
        });
        mocks.installRegistryPack.mockResolvedValue({
          ref: 'example/cardiology',
          pack: { name: 'cardiology', title: 'Cardiology terms' },
          added: 1,
          merged: 0,
          path: '/fake/global/lexicon.yaml',
          scope: 'global',
        });
        mocks.installPack.mockResolvedValue({
          pack: { name: 'developer', title: 'Dev' },
          added: 2,
          merged: 0,
          path: '/fake/global/lexicon.yaml',
          scope: 'global',
        });
      });

      it('list_packs includes community entries with a registry', async () => {
        const { client, close } = await connect();
        try {
          const result = await client.callTool({ name: 'list_packs', arguments: { registry: '/fake/index.yaml' } });
          expect(result.isError).toBe(false);
          const payload = JSON.parse(textOf(result)) as { packs: unknown[]; community: { ref: string; installed: boolean }[] };
          expect(payload.packs.length).toBe(1);
          expect(payload.community).toMatchObject([{ ref: 'example/cardiology', installed: false }]);
          expect(mocks.loadRegistryIndex).toHaveBeenCalledWith('/fake/index.yaml');
        } finally {
          await close();
        }
      });

      it('add_pack previews a community pack until confirm: true', async () => {
        const { client, close } = await connect();
        try {
          const preview = await client.callTool({
            name: 'add_pack',
            arguments: { name: 'example/cardiology', registry: '/fake/index.yaml' },
          });
          expect(preview.isError).toBe(false);
          const p = JSON.parse(textOf(preview)) as { installed: boolean; previewDigest: string; preview: { ref: string; terms: { canonical: string }[] }; next: string };
          expect(p.installed).toBe(false);
          expect(p.preview.ref).toBe('example/cardiology');
          expect(p.preview.terms).toMatchObject([{ canonical: 'Metoprolol', notes: 'Preview this context note', phonetic: ['met-oh-pro-lol'], caseSensitive: true }]);
          expect(p.next).toMatch(/confirm: true/);
          expect(mocks.installRegistryPack).not.toHaveBeenCalled();

          const applied = await client.callTool({
            name: 'add_pack',
            arguments: { name: 'example/cardiology', registry: '/fake/index.yaml', confirm: true, previewDigest: p.previewDigest },
          });
          expect(applied.isError).toBe(false);
          const a = JSON.parse(textOf(applied)) as { name: string; summary: string };
          expect(a.name).toBe('example/cardiology');
          expect(a.summary).toMatch(/1 new/);
          expect(mocks.installRegistryPack).toHaveBeenCalledWith(entry, '/fake', '/fake/index.yaml', { cwd: '/fake/repo', approvedBytes: Buffer.from('pack-bytes') });
        } finally {
          await close();
        }
      });

      it('rejects confirmation without a preview digest and alias-only content drift', async () => {
        const { client, close } = await connect();
        try {
          const args = { name: 'example/cardiology', registry: '/fake/index.yaml' };
          const preview = JSON.parse(textOf(await client.callTool({ name: 'add_pack', arguments: args })));
          expect((await client.callTool({ name: 'add_pack', arguments: { ...args, confirm: true } })).isError).toBe(true);
          mocks.downloadPack.mockResolvedValue(Buffer.from('changed-alias-only-content'));
          mocks.parsePackText.mockReturnValue({ name: 'cardiology', title: 'Cardiology terms', lexicon: { version: 1, terms: [{ canonical: 'Metoprolol', aliases: ['new alias'], notes: 'New context note', category: 'brand' }] } });
          const changed = await client.callTool({ name: 'add_pack', arguments: { ...args, confirm: true, previewDigest: preview.previewDigest } });
          expect(changed.isError).toBe(true);
          expect(textOf(changed)).toMatch(/changed/);
          expect(mocks.installRegistryPack).not.toHaveBeenCalled();
          const fresh = JSON.parse(textOf(await client.callTool({ name: 'add_pack', arguments: args })));
          expect(fresh.preview.terms[0]).toMatchObject({ aliases: ['new alias'], notes: 'New context note' });
        } finally { await close(); }
      });

      it('add_pack still installs vendored packs directly', async () => {
        const { client, close } = await connect();
        try {
          const result = await client.callTool({ name: 'add_pack', arguments: { name: 'developer' } });
          expect(result.isError).toBe(false);
          const payload = JSON.parse(textOf(result)) as { name: string };
          expect(payload.name).toBe('developer');
          expect(mocks.installPack).toHaveBeenCalledWith('developer', { cwd: '/fake/repo' });
        } finally {
          await close();
        }
      });

      it('add_pack refuses a community ref without a registry', async () => {
        const { client, close } = await connect();
        try {
          const result = await client.callTool({ name: 'add_pack', arguments: { name: 'example/cardiology' } });
          expect(result.isError).toBe(true);
          expect(textOf(result)).toMatch(/needs the registry parameter/);
        } finally {
          await close();
        }
      });
    });

    it('suggest_terms loads the lexicon and voice history and returns the suggestions', async () => {
      const { client, close } = await connect();
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'suggest_terms');
        expect(tool?.description).toMatch(/apply_suggestion/);
        const result = await client.callTool({ name: 'suggest_terms', arguments: { limit: 5 } });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toEqual([aliasSuggestion]);
        expect(mocks.loadVoiceHistory).toHaveBeenCalledWith('/fake/global/lexicon.yaml');
        expect(mocks.suggestTerms).toHaveBeenCalledWith({ loaded, history: [], cwd: '/fake/repo', limit: 5 });
      } finally {
        await close();
      }
    });

    it('apply_suggestion merges an alias, adds a term, records a never-word and removes a stale term', async () => {
      const { client, close } = await connect();
      try {
        const alias = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: aliasSuggestion } });
        expect(alias.isError).toBe(false);
        expect(JSON.parse(textOf(alias))).toMatchObject({ kind: 'alias', canonical: 'Ashlr.AI', path: '/fake/global/lexicon.yaml', summary: '"ashlur" -> "Ashlr.AI" saved' });
        // A scope naming a file the term is not in (Ashlr.AI is only global) is
        // refused: writing there would create a copy holding just the alias.
        mocks.addTerm.mockClear();
        const elsewhere = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { ...aliasSuggestion, scope: 'project', path: '/fake/repo/.lexicon.yaml' } } });
        expect(elsewhere.isError).toBe(true);
        expect(textOf(elsewhere)).toContain('"Ashlr.AI" is in the global lexicon (/fake/global/lexicon.yaml), not the project one');
        expect(mocks.addTerm).not.toHaveBeenCalled();
        // The scope suggest_terms reported is honoured when passed back.
        await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { ...aliasSuggestion, scope: 'global', path: '/fake/global/lexicon.yaml' } } });
        expect(mocks.addTerm).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'global' }), { cwd: '/fake/repo', scope: 'global' });
        await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: aliasSuggestion } });
        // No scope given: written where the term lives (Ashlr.AI is a global term).
        expect(mocks.addTerm).toHaveBeenLastCalledWith({ canonical: 'Ashlr.AI', aliases: ['ashlur'], source: 'user', scope: 'global' }, { cwd: '/fake/repo', scope: 'global' });

        const term = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { kind: 'term', canonical: 'Supabase' }, scope: 'project' } });
        expect(term.isError).toBe(false);
        expect(mocks.addTerm).toHaveBeenLastCalledWith(
          { canonical: 'Supabase', aliases: ['Supabase heard', 'supabase'], source: 'user', scope: 'project' },
          { cwd: '/fake/repo', scope: 'project' },
        );
        const harvested = await client.callTool({
          name: 'apply_suggestion',
          arguments: { suggestion: { kind: 'term', canonical: 'tRPC', aliases: ['t r p c', ' trpc '], category: 'product', reason: 'seen 12 times in the repo', confidence: 0.7, evidence: [], count: 12 } },
        });
        expect(harvested.isError).toBe(false);
        expect(mocks.addTerm).toHaveBeenLastCalledWith({ canonical: 'tRPC', aliases: ['t r p c', 'trpc'], source: 'user', category: 'product' }, { cwd: '/fake/repo' });

        const never = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { kind: 'never', canonical: 'Kubernetes', alias: 'cuber' } } });
        expect(never.isError).toBe(false);
        expect(JSON.parse(textOf(never))).toMatchObject({ summary: '"cuber" will never be rewritten to "Kubernetes"' });
        // Written where the term lives (Kubernetes is a project term).
        expect(mocks.addTerm).toHaveBeenLastCalledWith(
          { canonical: 'Kubernetes', aliases: [], source: 'user', never: ['cuber'], scope: 'project' },
          { cwd: '/fake/repo', scope: 'project' },
        );

        // Catches: an alias or never word for a term no longer in the lexicon
        // created a new term holding only that word, reported as "saved".
        mocks.addTerm.mockClear();
        for (const gone of [{ kind: 'never', canonical: 'SaaS', alias: 'sauce' }, { kind: 'alias', canonical: 'Gone.io', alias: 'gone eye oh' }]) {
          const res = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: gone } });
          expect(res.isError).toBe(true);
          expect(textOf(res)).toContain(`no term "${gone.canonical}" in the lexicon`);
          expect(textOf(res)).toContain('nothing was written');
        }
        expect(mocks.addTerm).not.toHaveBeenCalled();

        const stale = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { kind: 'stale', canonical: 'Kubernetes' } } });
        expect(JSON.parse(textOf(stale))).toMatchObject({ kind: 'stale', removed: true });
        expect(mocks.removeTerm).toHaveBeenCalledWith('Kubernetes', { cwd: '/fake/repo' });

        const bare = await client.callTool({ name: 'apply_suggestion', arguments: { suggestion: { kind: 'alias', canonical: 'Ashlr.AI' } } });
        expect(bare.isError).toBe(true);
        expect(textOf(bare)).toMatch(/needs an alias/);
      } finally {
        await close();
      }
    });

    it('setup_lexicon without apply is a dry run: returns the plan and writes nothing', async () => {
      const { client, close } = await connect();
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'setup_lexicon');
        expect(tool?.description).toMatch(/Preview by default/);
        expect(tool?.description).toMatch(/apply: true, clients: \[\.\.\.\] and serve: true only if the user agreed to each/);
        // Says what it asks for and what it does not do.
        expect(tool?.description).toMatch(/their own name/);
        expect(tool?.description).toMatch(/claude, claude-desktop, codex, cursor, windsurf, gemini, vscode/);
        expect(tool?.description).toMatch(/does not install clients that are not listed/);
        expect(tool?.description).toMatch(/does not harvest the repo unless harvest: true/);
        expect(tool?.description).toMatch(/does not install the local API unless serve: true/);
        expect((tool?.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty('harvest');
        const result = await client.callTool({
          name: 'setup_lexicon',
          arguments: { company: 'Ashlr.AI', person: 'Mason Wyatt', clients: ['claude', 'cursor'] },
        });
        expect(result.isError).toBe(false);
        const body = JSON.parse(textOf(result)) as Record<string, unknown>;
        expect(body).toEqual({ ...setupPlan, next: expect.stringMatching(/Nothing was written.*apply: true/) });
        expect(body).not.toHaveProperty('summary');
        expect(cli.runSetup).toHaveBeenCalledWith(
          { cwd: '/fake/repo', yes: true, json: true, company: 'Ashlr.AI', person: 'Mason Wyatt', clients: 'claude,cursor', serve: false, dryRun: true },
          expect.objectContaining({ stdout: expect.any(Function) }),
          expect.objectContaining({ cliDir: expect.any(String) }),
        );

        // apply: false is the same preview; omitted clients preview "none", never "all detected".
        // The plan lists wouldHarvest whether or not harvest is passed (only an apply needs it).
        await client.callTool({ name: 'setup_lexicon', arguments: { apply: false } });
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'none', serve: false, dryRun: true }, expect.anything(), expect.anything());
        await client.callTool({ name: 'setup_lexicon', arguments: { harvest: true } });
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'none', serve: false, dryRun: true }, expect.anything(), expect.anything());
        await client.callTool({ name: 'setup_lexicon', arguments: { harvest: false } });
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'none', serve: false, harvest: false, dryRun: true }, expect.anything(), expect.anything());
      } finally {
        await close();
      }
    });

    it('setup_lexicon apply: true installs only the listed clients and the login service only with serve: true', async () => {
      const { client, close } = await connect();
      try {
        const result = await client.callTool({
          name: 'setup_lexicon',
          arguments: { apply: true, company: 'Ashlr.AI', person: 'Mason Wyatt', clients: ['claude', 'cursor'], serve: true },
        });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toEqual({ ok: true, applied: true, summary: setupSummary });
        const [opts] = cli.runSetup.mock.calls.at(-1) as [SetupOptions];
        expect(opts).toEqual({ cwd: '/fake/repo', yes: true, json: true, company: 'Ashlr.AI', person: 'Mason Wyatt', clients: 'claude,cursor', serve: true, harvest: false });
        expect(opts).not.toHaveProperty('dryRun');

        // apply without clients installs none; serve and harvest are off unless explicitly true.
        const bare = await client.callTool({ name: 'setup_lexicon', arguments: { apply: true } });
        expect(bare.isError).toBe(false);
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'none', serve: false, harvest: false }, expect.anything(), expect.anything());

        await client.callTool({ name: 'setup_lexicon', arguments: { apply: true, clients: [], serve: false } });
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'none', serve: false, harvest: false }, expect.anything(), expect.anything());

        // harvest: true is the only way the apply writes the project lexicon.
        await client.callTool({ name: 'setup_lexicon', arguments: { apply: true, clients: ['claude'], harvest: true } });
        expect(cli.runSetup).toHaveBeenLastCalledWith({ cwd: '/fake/repo', yes: true, json: true, clients: 'claude', serve: false, harvest: true }, expect.anything(), expect.anything());
      } finally {
        await close();
      }
    });

    it('setup_lexicon relays a failing apply as ok: false with its stderr', async () => {
      cli.runSetup.mockImplementationOnce(async (_o: unknown, io: IO) => {
        io.stderr('setup: claude mcp add failed\n');
        return { code: 1, summary: { ...setupSummary, clients: [{ name: 'claude', status: 'failed', detail: 'claude mcp add failed' }] } };
      });
      const { client, close } = await connect();
      try {
        const result = await client.callTool({ name: 'setup_lexicon', arguments: { apply: true, clients: ['claude'] } });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, applied: true, stderr: 'setup: claude mcp add failed' });
      } finally {
        await close();
      }
    });

    it('serve_status reports down when nothing listens and relays /health when up', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-status-'));
      // serve.json lives beside the global lexicon.
      mocks.resolvePaths.mockReturnValue({ global: path.join(dir, 'lexicon.yaml') });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const { client, close } = await connect();
      try {
        // No serve.json yet: the default port, and nothing is created.
        const down = await client.callTool({ name: 'serve_status', arguments: {} });
        expect(down.isError).toBe(false);
        expect(JSON.parse(textOf(down))).toMatchObject({ up: false, error: 'ECONNREFUSED' });
        expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:41733/health', expect.objectContaining({ signal: expect.anything() }));
        await expect(readFile(path.join(dir, 'serve.json'), 'utf8')).rejects.toThrow();

        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, version: '0.3.0', terms: 36, port: 41733 }), { status: 200 }));
        const up = await client.callTool({ name: 'serve_status', arguments: {} });
        expect(JSON.parse(textOf(up))).toEqual({ up: true, url: 'http://127.0.0.1:41733/health', ok: true, version: '0.3.0', terms: 36, port: 41733 });

        // Catches: any 200 on the port read as up, though it was not lexicon serve.
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'fine' }), { status: 200 }));
        const foreign = JSON.parse(textOf(await client.callTool({ name: 'serve_status', arguments: {} }))) as Record<string, unknown>;
        expect(foreign).toMatchObject({ up: false, error: 'unexpected /health response (not lexicon serve)' });
        expect(String(foreign.hint)).toContain('lexicon serve --port <n>');

        // `lexicon serve --port 41799` records its port in serve.json; status
        // must probe that port, as `serve --status` and desktop clients do.
        await writeFile(path.join(dir, 'serve.json'), JSON.stringify({ port: 41799, token: 'a'.repeat(32), createdAt: 'x' }));
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, version: '0.5.5', terms: 2, port: 41799 }), { status: 200 }));
        const custom = await client.callTool({ name: 'serve_status', arguments: {} });
        expect(JSON.parse(textOf(custom))).toMatchObject({ up: true, url: 'http://127.0.0.1:41799/health', port: 41799 });
        expect(fetchSpy).toHaveBeenLastCalledWith('http://127.0.0.1:41799/health', expect.objectContaining({ signal: expect.anything() }));

        // Running but failing (a broken lexicon file): not "down", and the
        // server's own message, which it gives in full to the token holder.
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'internal error: Failed to parse lexicon YAML at /x/lexicon.yaml: bad' }), { status: 500 }),
        );
        const failing = JSON.parse(textOf(await client.callTool({ name: 'serve_status', arguments: {} }))) as Record<string, unknown>;
        expect(failing).toMatchObject({ up: false, running: true, status: 500, error: expect.stringContaining('Failed to parse lexicon YAML') });
        expect(String(failing.hint)).not.toContain('Start it');
        const init = fetchSpy.mock.lastCall?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'a'.repeat(32)}`);
      } finally {
        fetchSpy.mockRestore();
        await close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('exposes the onboard prompt as a short user-role script', async () => {
      const { client, close } = await connect();
      try {
        const { prompts } = await client.listPrompts();
        expect(prompts.map((p) => p.name).sort()).toEqual(['onboard', 'voice-context']);
        const prompt = await client.getPrompt({ name: 'onboard' });
        const message = prompt.messages[0];
        expect(message?.role).toBe('user');
        const text = (message?.content as { type: string; text?: string }).text ?? '';
        expect(text.split('\n').length).toBeLessThan(25);
        expect(text).toContain('setup_lexicon');
        expect(text).toContain('add_term');
        expect(text).toMatch(/spelled exactly/i);
        expect(text).toMatch(/pronounce/i);
        expect(text).toMatch(/teammates/i);
        expect(text).toMatch(/which agent clients/i);
        expect(text).toMatch(/sentence I can dictate/i);
        expect(mocks.loadLexicon).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });
  });
});

describe('MCP roots pick the project directory', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os');
    rootA = await mkdtemp(path.join(os.tmpdir(), 'lexicon-roots-a-'));
    rootB = await mkdtemp(path.join(os.tmpdir(), 'lexicon-roots-b-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A client that advertises roots and answers roots/list from `roots()` (or throws). */
  async function connectWithRoots(
    roots: () => { uri: string; name?: string }[],
    serverOpts: { cwd?: string } = {},
  ): Promise<{ client: Client; close: () => Promise<void>; asked: () => number }> {
    const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { createServer } = await import('../src/mcp/server.js');
    const server = createServer({ ...serverOpts, rootsTimeoutMs: 500 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'roots-client', version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
    let asked = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      asked += 1;
      return { roots: roots() };
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      asked: () => asked,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('uses the first existing file:// root for loads and for tools that write', async () => {
    vi.stubEnv('LEXICON_CWD', '');
    const { pathToFileURL } = await import('node:url');
    // (The SDK itself rejects a roots/list answer holding a non-file URI; cwdFromRoots also skips one.)
    const { client, close, asked } = await connectWithRoots(() => [
      { uri: pathToFileURL(path.join(rootA, 'missing')).href },
      { uri: pathToFileURL(rootA).href, name: 'A' },
      { uri: pathToFileURL(rootB).href },
    ]);
    try {
      await client.readResource({ uri: 'lexicon://me' });
      expect(asked()).toBe(1);
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: rootA });
      await client.callTool({ name: 'add_term', arguments: { canonical: 'Zed', aliases: ['zedd'] } });
      expect(mocks.addTerm).toHaveBeenLastCalledWith(expect.objectContaining({ canonical: 'Zed' }), { cwd: rootA });
    } finally {
      await close();
    }
  });

  it('holds a tool call that races a slow roots/list answer until it lands', async () => {
    vi.stubEnv('LEXICON_CWD', '');
    const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { pathToFileURL } = await import('node:url');
    const { createServer } = await import('../src/mcp/server.js');
    const server = createServer({ rootsTimeoutMs: 2000 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'slow-roots', version: '0.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { roots: [{ uri: pathToFileURL(rootA).href }] };
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // add_term never calls load(); it still must not run against process.cwd().
      await client.callTool({ name: 'add_term', arguments: { canonical: 'Zed', aliases: ['zedd'] } });
      expect(mocks.addTerm).toHaveBeenLastCalledWith(expect.objectContaining({ canonical: 'Zed' }), { cwd: rootA });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('follows roots/list_changed', async () => {
    vi.stubEnv('LEXICON_CWD', '');
    const { pathToFileURL } = await import('node:url');
    let current = rootA;
    const { client, close, asked } = await connectWithRoots(() => [{ uri: pathToFileURL(current).href }]);
    try {
      await client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: rootA });
      current = rootB;
      await client.sendRootsListChanged();
      await vi.waitFor(() => expect(asked()).toBe(2));
      await client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: rootB });
    } finally {
      await close();
    }
  });

  it('keeps an explicit directory (option or LEXICON_CWD) and never asks for roots', async () => {
    const { pathToFileURL } = await import('node:url');
    const viaOption = await connectWithRoots(() => [{ uri: pathToFileURL(rootA).href }], { cwd: '/fake/repo' });
    try {
      await viaOption.client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: '/fake/repo' });
      expect(viaOption.asked()).toBe(0);
    } finally {
      await viaOption.close();
    }
    vi.stubEnv('LEXICON_CWD', rootB);
    const viaEnv = await connectWithRoots(() => [{ uri: pathToFileURL(rootA).href }]);
    try {
      await viaEnv.client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: rootB });
      expect(viaEnv.asked()).toBe(0);
    } finally {
      await viaEnv.close();
    }
  });

  it('falls back to process.cwd() when the client has no usable root or roots/list fails', async () => {
    vi.stubEnv('LEXICON_CWD', '');
    const { pathToFileURL } = await import('node:url');
    const none = await connectWithRoots(() => [{ uri: pathToFileURL(path.join(rootA, 'gone')).href }]);
    try {
      await none.client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: process.cwd() });
    } finally {
      await none.close();
    }
    const failing = await connectWithRoots(() => {
      throw new Error('no roots for you');
    });
    try {
      const result = await failing.client.callTool({ name: 'list_terms', arguments: {} });
      expect(result.isError).toBe(false);
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: process.cwd() });
    } finally {
      await failing.close();
    }
  });

  it('does not ask a client that does not advertise roots', async () => {
    vi.stubEnv('LEXICON_CWD', '');
    const { client, close } = await connect();
    try {
      await client.readResource({ uri: 'lexicon://me' });
      expect(mocks.loadLexicon).toHaveBeenLastCalledWith({ cwd: '/fake/repo' });
    } finally {
      await close();
    }
  });

  it('cwdFromRoots takes only an existing local directory', async () => {
    const { cwdFromRoots } = await import('../src/mcp/server.js');
    const { pathToFileURL } = await import('node:url');
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(rootA, 'file.txt');
    await writeFile(file, 'x');
    expect(cwdFromRoots([])).toBeUndefined();
    expect(cwdFromRoots([{ uri: 'file:///definitely/not/here' }, { uri: pathToFileURL(file).href }])).toBeUndefined();
    expect(cwdFromRoots([{ uri: 'not a uri' }, { uri: 'https://example.com/repo' }, { uri: pathToFileURL(rootB).href }])).toBe(rootB);
  });
});
