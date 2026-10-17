/**
 * MCP tools driven end to end against the real core and real files in temp
 * dirs: the arguments an agent actually sends, not mocked core calls.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { runList } from '../src/cli/commands.js';
import { trustProject } from '../src/core/trust.js';
import { makeIO } from './helpers.js';

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

/**
 * The repo's .lexicon.yaml, created empty and trusted as `lexicon trust`
 * would: an MCP write into a trusted file keeps it trusted, so the tests
 * below that need project terms merged start from here.
 */
async function trustedProjectFile(): Promise<string> {
  const file = path.join(repo, '.lexicon.yaml');
  await fs.writeFile(file, 'version: 1\nterms: []\n');
  await trustProject(file);
  return file;
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
    await trustedProjectFile();
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

  // Catches: without `scope` only the project copy went, and the result said nothing about the global copy.
  it('names the copy left in the other lexicon file when the term is in both', async () => {
    await trustedProjectFile();
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'] });
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube cuddle'], scope: 'project' });

    const first = JSON.parse((await call('remove_term', { canonical: 'kubectl' })).text) as {
      removed: boolean;
      path?: string;
      stillIn?: { scope: string; path: string }[];
      note?: string;
    };
    expect(first.removed).toBe(true);
    expect(first.path).toBe(path.join(repo, '.lexicon.yaml'));
    expect(first.stillIn).toEqual([{ scope: 'global', path: path.join(home, 'lexicon.yaml') }]);
    expect(first.note).toMatch(/still in the global lexicon/);
    expect(first.note).toMatch(/scope "global"/);

    const second = JSON.parse((await call('remove_term', { canonical: 'kubectl', scope: 'global' })).text) as Record<string, unknown>;
    expect(second).toEqual({ canonical: 'kubectl', removed: true, path: path.join(home, 'lexicon.yaml') });
    const listed = JSON.parse((await call('list_terms', { query: 'kubectl' })).text) as { terms: unknown[] };
    expect(listed.terms).toEqual([]);
  });

  // Catches: scope "global" removed the global copy with plain `removed: true` while the untrusted project copy waited to win once trusted.
  it('names a copy in the untrusted project lexicon by path, and never edits that file', async () => {
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'] });
    const projectFile = path.join(repo, '.lexicon.yaml');
    const text = 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube cuddle]\n';
    await fs.writeFile(projectFile, text);

    const result = JSON.parse((await call('remove_term', { canonical: 'kubectl', scope: 'global' })).text) as Record<string, unknown>;
    expect(result).toMatchObject({
      canonical: 'kubectl',
      removed: true,
      path: path.join(home, 'lexicon.yaml'),
      untrustedProject: { path: projectFile, trust: 'untrusted' },
    });
    expect(result).not.toHaveProperty('stillIn');
    expect(result.note).toMatch(/not trusted/);
    expect(result.note).toMatch(/lexicon trust/);
    expect(JSON.stringify(result)).not.toContain('cube cuddle');
    expect(await fs.readFile(projectFile, 'utf8')).toBe(text);
  });

  // Catches: the bare trust error left the agent no way to remove the global copy it could reach.
  it('a refused untrusted project copy says scope "global" removes the global one', async () => {
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'] });
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube cuddle]\n');
    const refused = await call('remove_term', { canonical: 'Kubectl' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/untrusted/);
    expect(refused.text).toMatch(/scope "global"/);
  });

  // Catches: removing an alias from the global copy reported plain success while the untrusted project copy kept that alias.
  it('with `alias`, names an untrusted project copy that holds the alias; without scope the refusal points at scope "global"', async () => {
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube control', 'cube cuddle'] });
    const projectFile = path.join(repo, '.lexicon.yaml');
    const text = 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube cuddle, secret spelling]\n';
    await fs.writeFile(projectFile, text);

    const refused = await call('remove_term', { canonical: 'kubectl', alias: 'cube cuddle' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/untrusted/);
    expect(refused.text).toMatch(/alias and scope "global"/);

    const result = JSON.parse((await call('remove_term', { canonical: 'kubectl', alias: 'cube cuddle', scope: 'global' })).text) as Record<string, unknown>;
    expect(result).toMatchObject({
      canonical: 'Kubectl',
      alias: 'cube cuddle',
      removed: true,
      aliases: ['cube control'],
      untrustedProject: { path: projectFile, trust: 'untrusted' },
    });
    expect(result.note).toMatch(/lexicon trust/);
    expect(JSON.stringify(result)).not.toContain('secret spelling');
    expect(await fs.readFile(projectFile, 'utf8')).toBe(text);

    // An alias the project copy does not hold is not reported.
    const plain = JSON.parse((await call('remove_term', { canonical: 'kubectl', alias: 'cube control', scope: 'global' })).text) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('untrustedProject');
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

describe('suggest_canonical with an untrusted project lexicon', () => {
  // Catches: no suggestions read as "not in the lexicon" while the name sat in the skipped project file.
  it('reports the skipped project file by path, never its terms', async () => {
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    const payload = JSON.parse((await call('suggest_canonical', { heard: 'cube control' })).text) as {
      suggestions: unknown[];
      skippedProject?: string;
      projectTrust?: string;
    };
    expect(payload.suggestions).toEqual([]);
    expect(payload.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    expect(payload.projectTrust).toBe('untrusted');
    expect(JSON.stringify(payload)).not.toContain('Kubectl');
  });

  it('carries no skippedProject key when there is no project file', async () => {
    const payload = JSON.parse((await call('suggest_canonical', { heard: 'cube control' })).text) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('skippedProject');
  });
});

describe('add_term with an alias another term holds', () => {
  // Reported plain success while the next transcript still went to the other term.
  it('reports the other term and the remove_term call that lets the new alias win', async () => {
    await call('add_term', { canonical: 'Verse', aliases: ['Versel'] });
    const payload = JSON.parse((await call('add_term', { canonical: 'Vercel', aliases: ['versel', 'vercell'] })).text) as {
      conflicts?: unknown[];
      note?: string;
    };
    expect(payload.conflicts).toEqual([{ canonical: 'Verse', scope: 'global', as: 'alias', spelling: 'Versel' }]);
    expect(payload.note).toContain('call remove_term with canonical "Verse", alias "Versel", scope "global"');
  });

  it('adds nothing when no other term holds the aliases', async () => {
    const payload = JSON.parse((await call('add_term', { canonical: 'Vercel', aliases: ['versel'] })).text) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['created', 'path', 'term']);
  });
});

describe('add_term errors', () => {
  it('do not leak the internal function name', async () => {
    const res = await call('add_term', { canonical: '   ' });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('canonical must not be empty');
  });
});

describe('normalize_transcript with an untrusted project lexicon', () => {
  // An agent in a repo whose .lexicon.yaml is not trusted yet got an
  // unchanged transcript and no reason why; list_terms and lexicon://me say so.
  it('names the skipped file (path only) so the agent can tell the user', async () => {
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Phantom\n    aliases: [Fantom]\n');
    const res = await call('normalize_transcript', { text: 'ask fantom' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text) as { output: string; changed: boolean; skippedProject?: string; projectTrust?: string; note?: string };
    expect(payload.output).toBe('ask fantom');
    expect(payload.changed).toBe(false);
    expect(payload.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    expect(payload.projectTrust).toBe('untrusted');
    expect(payload.note).toMatch(/lexicon trust/);
    expect(res.text).not.toContain('Fantom');
  });

  it('adds nothing when there is no project file', async () => {
    const payload = JSON.parse((await call('normalize_transcript', { text: 'ask fantom' })).text) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['changed', 'output', 'replacements', 'summary']);
  });
});

describe('undeclared arguments', () => {
  // The SDK's default object schema strips unknown keys, so `alias` (for
  // `aliases`) vanished and add_term went ahead and auto-suggested aliases
  // the agent never asked for.
  it('are refused by name instead of silently dropped', async () => {
    const res = await call('add_term', { canonical: 'Foo', alias: 'fu' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Unrecognized key: "alias"/);
    const listed = JSON.parse((await call('list_terms', {})).text) as { terms: unknown[] };
    expect(listed.terms).toEqual([]);

    const typo = await call('normalize_transcript', { txt: 'ashler' });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/Unrecognized key: "txt"/);
    const noArgsTool = await call('lexicon_stats', { verbose: true });
    expect(noArgsTool.isError).toBe(true);
  });

  it('are declared as not allowed in every tool schema', async () => {
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) expect([tool.name, tool.inputSchema.additionalProperties]).toEqual([tool.name, false]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('still accepts every declared argument', async () => {
    const res = await call('normalize_transcript', { text: 'hello', dryRun: true, minConfidence: 0.9 });
    expect(res.isError).toBe(false);
  });
});

// Catches: list_packs, add_pack, list_terms, suggest_canonical and
// trust_project descriptions told the model to relay `lexicon pack remove`,
// `lexicon pack update` or `lexicon trust`, which a plugin-only user has no
// binary for; every CLI command a description names comes with its npx form.
describe('tool descriptions that name a lexicon command', () => {
  it('also name the npx form of it', async () => {
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const missing: string[] = [];
      for (const tool of (await client.listTools()).tools) {
        const text = tool.description ?? '';
        for (const m of text.matchAll(/`lexicon ([a-z]+(?: [a-z]+)?)/g)) {
          const command = m[1].split(' ')[0];
          if (!text.includes(`npx @ashlr/lexicon ${command}`)) missing.push(`${tool.name}: lexicon ${m[1]}`);
        }
      }
      expect(missing).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('blank required strings', () => {
  // `.min(1)` let "  " through: remove_term answered "no term" as a success
  // and suggest_canonical searched for nothing.
  it('are refused for remove_term and suggest_canonical', async () => {
    const remove = await call('remove_term', { canonical: '   ' });
    expect(remove.isError).toBe(true);
    expect(remove.text).toMatch(/must not be blank at canonical/);
    const alias = await call('remove_term', { canonical: 'Foo', alias: ' ' });
    expect(alias.isError).toBe(true);
    expect(alias.text).toMatch(/must not be blank at alias/);
    const suggest = await call('suggest_canonical', { heard: '\t ' });
    expect(suggest.isError).toBe(true);
    expect(suggest.text).toMatch(/must not be blank at heard/);
  });

  // import_dictionary with blank content answered a success with 0 terms, so an
  // agent that lost the file's text on the way reported an import that read nothing.
  it('are refused for import_dictionary content and path', async () => {
    for (const content of ['', '  \n\t']) {
      const res = await call('import_dictionary', { content });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/at content/);
    }
    const res = await call('import_dictionary', { path: ' ' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/must not be blank at path/);
  });

  // Catches: the tool parses `lexicon import --json`, whose success now leads with the CLI's `ok: true`; the tool result keeps its shape.
  it('import_dictionary returns the import report without the CLI ok key', async () => {
    const res = await call('import_dictionary', { content: 'word,replacement\nhead sner,Hetzner\n', dryRun: true });
    expect(res.isError).toBe(false);
    const report = JSON.parse(res.text) as Record<string, unknown>;
    expect(report).not.toHaveProperty('ok');
    expect(report).toHaveProperty('terms');
  });
});

describe('lexicon_stats and voice-context with an untrusted project lexicon', () => {
  // Both left the repo's terms out with no word why, while list_terms,
  // normalize_transcript and lexicon://me named the skipped file.
  it('name the skipped file, path only', async () => {
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Phantom\n    aliases: [Fantom]\n');
    const stats = await call('lexicon_stats', {});
    const payload = JSON.parse(stats.text) as { termCount: number; skippedProject?: string; note?: string };
    expect(payload.termCount).toBe(0);
    expect(payload.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    expect(payload.note).toMatch(/lexicon trust/);
    expect(stats.text).not.toContain('Fantom');

    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const prompt = await client.getPrompt({ name: 'voice-context' });
      const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
      expect(text).toContain(`untrusted project lexicon at ${path.join(repo, '.lexicon.yaml')} that was not loaded`);
      expect(text).not.toContain('Fantom');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('add nothing when there is no project file', async () => {
    const payload = JSON.parse((await call('lexicon_stats', {})).text) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('skippedProject');
  });
});

describe('normalize_transcript limits', () => {
  async function callWith(opts: { normalizeBudgetMs?: number; normalizeMaxChars?: number }, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer({ cwd: repo, ...opts });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name: 'normalize_transcript', arguments: args })) as ToolResult;
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content ?? []).map((c) => c.text ?? '').join('\n')) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  beforeEach(async () => {
    await fs.writeFile(process.env.LEXICON_PATH as string, 'version: 1\nterms:\n  - canonical: Hetzner\n    aliases: [Hetsner]\n');
  });

  // A huge paste used to be matched in full on the server's one thread, with
  // no time budget, holding every other tool call for seconds.
  it('stops at the time budget and says the rest was not checked', async () => {
    const payload = await callWith({ normalizeBudgetMs: 0 }, { text: 'Hetsner then Hetsner' });
    expect(payload.output).toBe('Hetzner then Hetsner');
    expect(payload.incomplete).toMatchObject({ reasons: ['time'], totalChars: 20 });
    expect((payload.incomplete as { note: string }).note).toMatch(/0 ms/);
  });

  it('checks only the first maxChars and passes the rest through unchanged', async () => {
    const text = 'Hetsner one two three Hetsner';
    const payload = await callWith({ normalizeMaxChars: 20 }, { text });
    // Cut back to the last space, so "three" is not matched as a fragment.
    expect(payload.output).toBe('Hetzner one two three Hetsner');
    expect(payload.changed).toBe(true);
    expect(payload.incomplete).toMatchObject({ reasons: ['length'], checkedChars: 16, totalChars: text.length });
    expect((payload.incomplete as { note: string }).note).toMatch(/first 16 of 29 characters/);
  });

  it('adds no incomplete field when both limits hold', async () => {
    const payload = await callWith({}, { text: 'ask Hetsner' });
    expect(payload.output).toBe('ask Hetzner');
    expect(payload.incomplete).toBeUndefined();
  });

  it('applies the default length cap', async () => {
    const { MCP_NORMALIZE_MAX_CHARS } = await import('../src/mcp/tools/terms.js');
    const text = `Hetsner ${'word '.repeat(Math.ceil(MCP_NORMALIZE_MAX_CHARS / 5))}Hetsner`;
    const payload = await callWith({ normalizeBudgetMs: 60_000 }, { text });
    expect((payload.output as string).startsWith('Hetzner ')).toBe(true);
    expect((payload.output as string).endsWith(' Hetsner')).toBe(true);
    expect((payload.incomplete as { reasons: string[] }).reasons).toContain('length');
  });
});

describe('suggest_canonical length', () => {
  // Scoring is linear in the length of `heard` for every alias: a pasted
  // paragraph took seconds (100k characters, 4.5 s against 2000 terms).
  it('refuses a `heard` longer than a correction can be, before scoring it', async () => {
    await fs.writeFile(process.env.LEXICON_PATH as string, 'version: 1\nterms:\n  - canonical: Hetzner\n    aliases: [Hetsner]\n');
    const long = await call('suggest_canonical', { heard: 'the hetsner box is down again '.repeat(400) });
    expect(long.isError).toBe(true);
    expect(long.text).toMatch(/at most 60 characters/);
    expect(long.text).toMatch(/only the garbled word/);

    const ok = await call('suggest_canonical', { heard: '  hetsnr  ' });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text)).toMatchObject({ suggestions: [{ canonical: 'Hetzner' }] });
  });
});

describe('apply_suggestion on a term in the project lexicon', () => {
  // Catches: with no `scope`, an 'alias' (or 'never') suggestion for a term
  // that lives in the project file was written to a new global copy of the
  // term. The project term wins the merge, so the alias never took effect;
  // the suggestion carries no scope, so the agent could not pass the right one.
  it('writes the alias where the term lives, so the next normalize uses it', async () => {
    await trustedProjectFile();
    const added = await call('add_term', { canonical: 'Kubernetes', aliases: ['cooper netties'], scope: 'project' });
    expect(added.isError).toBe(false);
    const projectPath = path.join(repo, '.lexicon.yaml');

    const applied = await call('apply_suggestion', { suggestion: { kind: 'alias', canonical: 'Kubernetes', alias: 'kuber nettys' } });
    expect(applied.isError).toBe(false);
    expect(JSON.parse(applied.text)).toMatchObject({ path: projectPath, created: false });

    const never = await call('apply_suggestion', { suggestion: { kind: 'never', canonical: 'kubernetes', alias: 'cubes' } });
    expect(JSON.parse(never.text)).toMatchObject({ path: projectPath, created: false });

    const normalized = JSON.parse((await call('normalize_transcript', { text: 'deploy to kuber nettys' })).text) as { output: string };
    expect(normalized.output).toBe('deploy to Kubernetes');
    await expect(fs.stat(process.env.LEXICON_PATH as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('apply_suggestion stale on a term in both lexicon files', () => {
  // Catches: removeTerm stops at the first file that holds the term, so a
  // stale term with a project copy and a global copy lost only the project
  // copy, and the result said "removed" while the global one kept firing.
  it('removes the copy it targets and names the other one', async () => {
    await trustedProjectFile();
    expect((await call('add_term', { canonical: 'Kubernetes', aliases: ['cooper netties'], scope: 'project' })).isError).toBe(false);
    expect((await call('add_term', { canonical: 'Kubernetes', aliases: ['cube netties'], scope: 'global' })).isError).toBe(false);
    const projectPath = path.join(repo, '.lexicon.yaml');
    const globalPath = process.env.LEXICON_PATH as string;

    const first = JSON.parse((await call('apply_suggestion', { suggestion: { kind: 'stale', canonical: 'Kubernetes', scope: 'project', path: projectPath } })).text) as {
      removed: boolean;
      path?: string;
      stillIn?: { scope: string; path: string }[];
      summary: string;
    };
    expect(first).toMatchObject({ removed: true, path: projectPath, stillIn: [{ scope: 'global', path: globalPath }] });
    expect(first.summary).toContain(globalPath);
    expect(first.summary).toMatch(/scope "global"/);

    const second = JSON.parse((await call('apply_suggestion', { suggestion: { kind: 'stale', canonical: 'Kubernetes' }, scope: 'global' })).text) as Record<string, unknown>;
    expect(second).toMatchObject({ removed: true, path: globalPath });
    expect(second.stillIn).toBeUndefined();
    const normalized = JSON.parse((await call('normalize_transcript', { text: 'deploy to cube netties' })).text) as { output: string };
    expect(normalized.output).toBe('deploy to cube netties');
  });
});

describe('learn_correction when another term already claims `heard`', () => {
  // Catches: "it's Vercel not Versel" while Versel is an alias of Verse.
  // The alias was added to Vercel and reported saved, but the next transcript
  // still came out as "Verse", and nothing told the agent why or what to do.
  it('reports the other term and how to drop the alias from it', async () => {
    await call('add_term', { canonical: 'Verse', aliases: ['Versel'] });
    const res = await call('learn_correction', { heard: 'versel', meant: 'Vercel' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text) as { aliasAdded: boolean; conflict?: { canonical: string; scope: string; as: string }; summary: string };
    expect(payload.aliasAdded).toBe(true);
    expect(payload.conflict).toEqual({ canonical: 'Verse', scope: 'global', as: 'alias', spelling: 'Versel' });
    expect(payload.summary).toMatch(/also an alias of "Verse"/);
    expect(payload.summary).toMatch(/remove_term with canonical "Verse", alias "Versel"/);

    // Following the note makes the correction take effect.
    await call('remove_term', { canonical: 'Verse', alias: 'Versel' });
    const normalized = JSON.parse((await call('normalize_transcript', { text: 'deploy to versel' })).text) as { output: string };
    expect(normalized.output).toBe('deploy to Vercel');
  });

  it('escapes a quote in the remove_term arguments it names', async () => {
    await call('add_term', { canonical: 'The "Verse" Co', aliases: ['Ver"sel'] });
    const payload = JSON.parse((await call('learn_correction', { heard: 'ver"sel', meant: 'Vercel' })).text) as { summary: string };
    expect(payload.summary).toContain('remove_term with canonical "The \\"Verse\\" Co", alias "Ver\\"sel", scope "global"');
  });

  it('names a term whose canonical is the heard spelling, which no alias can override', async () => {
    await call('add_term', { canonical: 'Verse', aliases: ['vurse'] });
    const payload = JSON.parse((await call('learn_correction', { heard: 'Verse', meant: 'Vercel' })).text) as { conflict?: { canonical: string; as: string }; summary: string };
    expect(payload.conflict).toMatchObject({ canonical: 'Verse', as: 'canonical' });
    expect(payload.summary).toMatch(/"Verse" is its own term/);
  });

  it('adds no conflict when nothing else claims it', async () => {
    const payload = JSON.parse((await call('learn_correction', { heard: 'Versel', meant: 'Vercel' })).text) as Record<string, unknown>;
    expect(payload.conflict).toBeUndefined();
  });
});

describe('tool and resource descriptions agree with what the code does', () => {
  async function listed(): Promise<{ tools: { name: string; description?: string }[]; resources: { uri: string; description?: string }[]; instructions: string }> {
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return {
        tools: (await client.listTools()).tools,
        resources: (await client.listResources()).resources,
        instructions: client.getInstructions() ?? '',
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  // Catches: "a pack is sixty-odd terms" while the shipped packs hold 14 to 82.
  it('add_pack and the server instructions state no pack size the packs do not have', async () => {
    const { tools, instructions } = await listed();
    const addPack = tools.find((t) => t.name === 'add_pack')?.description ?? '';
    for (const text of [addPack, instructions]) expect(text).not.toMatch(/sixty/i);
    expect(addPack).toMatch(/list_packs[^.]*`terms`/);
    const sizes = JSON.parse((await call('list_packs', {})).text) as { packs: { terms: number }[] };
    expect(new Set(sizes.packs.map((p) => p.terms)).size).toBeGreaterThan(1);
  });

  // Catches: lexicon://json promised "global + project" but leaves an untrusted project file out.
  it('lexicon://json says an untrusted project lexicon is left out, and it is', async () => {
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    const { resources } = await listed();
    expect(resources.find((r) => r.uri === 'lexicon://json')?.description).toMatch(/untrusted/);
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const read = await client.readResource({ uri: 'lexicon://json' });
      const text = (read.contents[0] as { text: string }).text;
      expect(text).not.toContain('Kubectl');
      // Additive keys naming the skipped file (path only); the lexicon keys are unchanged.
      const parsed = JSON.parse(text) as { version: number; terms: unknown[]; skippedProject?: string; projectTrust?: string; note?: string };
      expect(parsed.terms).toEqual([]);
      expect(parsed.version).toBe(1);
      expect(parsed.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
      expect(parsed.projectTrust).toBe('untrusted');
      expect(parsed.note).toMatch(/lexicon trust/);
      await fs.rm(path.join(repo, '.lexicon.yaml'));
      const plain = JSON.parse(((await client.readResource({ uri: 'lexicon://json' })).contents[0] as { text: string }).text) as Record<string, unknown>;
      expect(plain).not.toHaveProperty('skippedProject');
      expect(plain).not.toHaveProperty('projectTrust');
    } finally {
      await client.close();
      await server.close();
    }
  });

  // Catches: "adds `heard` as an alias of `meant`" while a new term also gets
  // generated misspellings, and a case-only correction recases the term instead.
  it('learn_correction names the generated aliases and the case-only recase', async () => {
    const { tools } = await listed();
    const description = tools.find((t) => t.name === 'learn_correction')?.description ?? '';
    const learned = JSON.parse((await call('learn_correction', { heard: 'open klaw', meant: 'OpenClaw' })).text) as { term: { aliases: string[] } };
    expect(learned.term.aliases.length).toBeGreaterThan(1);
    expect(description).toMatch(/generated/);
    const recased = JSON.parse((await call('learn_correction', { heard: 'OpenClaw', meant: 'Openclaw' })).text) as { term: { canonical: string } };
    expect(recased.term.canonical).toBe('Openclaw');
    expect(description).toMatch(/case-only/);
  });
});

describe('list_packs with an untrusted project lexicon', () => {
  // Catches: a pack the skipped project file records read as plain `installed: false`.
  it('carries projectTrust, skippedProject and a note, path only', async () => {
    const projectFile = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(projectFile, 'version: 1\nsettings:\n  packs: [developer]\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    const payload = JSON.parse((await call('list_packs', {})).text) as {
      packs: { name: string; installed: boolean }[];
      projectTrust?: string;
      skippedProject?: string;
      note?: string;
    };
    expect(payload.packs.find((p) => p.name === 'developer')?.installed).toBe(false);
    expect(payload.projectTrust).toBe('untrusted');
    expect(payload.skippedProject).toBe(projectFile);
    expect(payload.note).toMatch(/lexicon trust/);
    expect(payload.note).toMatch(/shows as not installed/);
    expect(JSON.stringify(payload)).not.toContain('Kubectl');
  });

  it('carries no skipped-project keys without a project file', async () => {
    const payload = JSON.parse((await call('list_packs', {})).text) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('skippedProject');
    expect(payload).not.toHaveProperty('note');
  });
});

describe('lexicon list --full and MCP list_terms', () => {
  // Catches: `lexicon list --json` is a bare array, so a script had no counts, paths or skipped-project keys list_terms gives.
  it('--full prints the list_terms object; plain --json stays a bare array', async () => {
    await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'] });
    await call('add_term', { canonical: 'Hetzner', aliases: ['het zner'] });
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Secret\n    aliases: [secret]\n');
    const mcp = JSON.parse((await call('list_terms', { query: 'kube' })).text) as Record<string, unknown>;

    const full = makeIO();
    expect(await runList({ cwd: repo, query: 'kube', full: true }, full)).toBe(0);
    // The CLI leads with `ok: true` (a --json success); the rest is the list_terms object.
    const { ok, ...cli } = JSON.parse(full.out) as Record<string, unknown>;
    expect(ok).toBe(true);
    expect(Object.keys(JSON.parse(full.out) as object)[0]).toBe('ok');
    expect(Object.keys(cli).sort()).toEqual(Object.keys(mcp).sort());
    const { note: cliNote, ...cliRest } = cli;
    const { note: mcpNote, ...mcpRest } = mcp;
    expect(cliRest).toEqual(mcpRest);
    expect(cliRest).toMatchObject({ counts: { matched: 1, total: 2, global: 2, project: 0 }, projectTrust: 'untrusted', skippedProject: path.join(repo, '.lexicon.yaml') });
    expect(cliNote).toMatch(/lexicon trust/);
    expect(mcpNote).toMatch(/lexicon trust/);
    expect(full.out).not.toContain('Secret');

    const bare = makeIO();
    expect(await runList({ cwd: repo, query: 'kube', json: true }, bare)).toBe(0);
    expect(JSON.parse(bare.out)).toEqual(mcp.terms);
  });
});

describe('voice-context and lexicon://me', () => {
  async function read(): Promise<{ prompt: string; me: string }> {
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const prompt = await client.getPrompt({ name: 'voice-context' });
      const me = await client.readResource({ uri: 'lexicon://me' });
      return {
        prompt: prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n'),
        me: me.contents.map((c) => ('text' in c ? String(c.text) : '')).join('\n'),
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  // Catches: an empty lexicon came back as an empty table under "Apply these canonical spellings".
  it('say the lexicon is empty instead of asking to apply an empty table', async () => {
    const { prompt, me } = await read();
    expect(prompt).toContain('the lexicon has no terms yet');
    expect(prompt).not.toContain('Apply these canonical spellings');
    expect(me).toContain('the lexicon has no terms yet');

    await fs.writeFile(path.join(home, 'lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
    const filled = await read();
    expect(filled.prompt).toContain('Apply these canonical spellings');
    expect(filled.prompt).not.toContain('no terms yet');
    expect(filled.me).not.toContain('no terms yet');
  });

  // Catches: the skipped file's path went into raw markdown unsanitized, so a
  // bidi override in a cloned directory's name reached the conversation.
  it('sanitize the skipped project path', async () => {
    const nasty = path.join(repo, 'evil‮name');
    await fs.mkdir(path.join(nasty, '.git'), { recursive: true });
    await fs.writeFile(path.join(nasty, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Phantom\n    aliases: [Fantom]\n');
    const server = createServer({ cwd: nasty });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const prompt = await client.getPrompt({ name: 'voice-context' });
      const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
      const me = (await client.readResource({ uri: 'lexicon://me' })).contents.map((c) => ('text' in c ? String(c.text) : '')).join('\n');
      for (const t of [text, me]) {
        expect(t).toContain('evilname');
        expect(t).not.toContain('‮');
        expect(t).not.toContain('Fantom');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('a lexicon file that does not parse', () => {
  // Catches: lexicon://me, lexicon://json and voice-context failed with the bare
  // parse error, so a model reading them had the file but not the fix.
  it('resources, prompts and tools name the file and the fix', async () => {
    const globalPath = process.env.LEXICON_PATH as string;
    await fs.writeFile(globalPath, 'version: 1\nterms: [\n', 'utf8');
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const failures: string[] = [];
      for (const uri of ['lexicon://me', 'lexicon://json']) {
        failures.push(await client.readResource({ uri }).then(() => 'resolved', (e: unknown) => (e as Error).message));
      }
      failures.push(await client.getPrompt({ name: 'voice-context' }).then(() => 'resolved', (e: unknown) => (e as Error).message));
      const tool = (await client.callTool({ name: 'list_terms', arguments: {} })) as ToolResult;
      expect(tool.isError).toBe(true);
      failures.push((tool.content ?? []).map((c) => c.text ?? '').join('\n'));
      for (const message of failures) {
        expect(message).toContain(`Failed to parse lexicon YAML at ${globalPath}`);
        // Catches: plugin-only users were told to run a `lexicon` they may not have installed.
        expect(message).toContain('by running `lexicon edit` (or `npx @ashlr/lexicon edit`), then check it with lexicon_doctor');
      }
      // The onboard prompt reads no lexicon and still works.
      expect((await client.getPrompt({ name: 'onboard' })).messages.length).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('names lexicon edit --project for a broken trusted project file', async () => {
    const projectPath = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms: [\n', 'utf8');
    const prev = process.env.LEXICON_TRUST_ALL;
    process.env.LEXICON_TRUST_ALL = '1';
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const message = await client.readResource({ uri: 'lexicon://me' }).then(() => 'resolved', (e: unknown) => (e as Error).message);
      expect(message).toContain(projectPath);
      expect(message).toContain('`lexicon edit --project` (or `npx @ashlr/lexicon edit --project`)');
    } finally {
      if (prev === undefined) delete process.env.LEXICON_TRUST_ALL;
      else process.env.LEXICON_TRUST_ALL = prev;
      await client.close();
      await server.close();
    }
  });
});

// Catches: a tool whose declared input schema disagrees with what the call
// accepts (a required argument the handler treats as optional, or a property
// typed one way and parsed another). Every tool in tools/list is probed with
// its required arguments missing and with each property given the wrong type;
// both must come back as an error that names the argument, never as a success.
describe('every tool rejects a missing required argument and a mistyped property', () => {
  interface PropSchema {
    type?: string | string[];
    enum?: unknown[];
  }
  /** A value of the wrong type for the property (or outside its enum). */
  const mistyped = (s: PropSchema): unknown => {
    if (s.enum) return '__not_a_member__';
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    return t === 'string' ? 12345 : t === 'boolean' || t === 'number' || t === 'integer' || t === 'array' || t === 'object' ? 'wrong type' : null;
  };
  /** A well-typed placeholder for a required property, so only the probed one is wrong. */
  const valid = (s: PropSchema): unknown => {
    if (s.enum) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    return t === 'string' ? 'Zork' : t === 'object' ? { kind: 'alias', canonical: 'Zork', alias: 'zorc' } : t === 'array' ? [] : t === 'boolean' ? false : 1;
  };

  it('walks tools/list', async () => {
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    // Nothing here should get past validation, but never let a probe touch the real home.
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const textOf = (r: ToolResult): string => (r.content ?? []).map((c) => c.text ?? '').join('\n');
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(20);
      let probes = 0;
      for (const tool of tools) {
        const props = (tool.inputSchema.properties ?? {}) as Record<string, PropSchema>;
        const required = (tool.inputSchema.required ?? []) as string[];
        const base = Object.fromEntries(required.map((k) => [k, valid(props[k] ?? {})]));
        for (const name of required) {
          const rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== name));
          const r = (await client.callTool({ name: tool.name, arguments: rest })) as ToolResult;
          expect([tool.name, name, r.isError]).toEqual([tool.name, name, true]);
          expect(textOf(r), `${tool.name} without ${name}`).toContain(name);
          probes += 1;
        }
        for (const [name, schema] of Object.entries(props)) {
          const value = mistyped(schema);
          expect([tool.name, name, value]).not.toEqual([tool.name, name, null]);
          const r = (await client.callTool({ name: tool.name, arguments: { ...base, [name]: value } })) as ToolResult;
          expect([tool.name, name, r.isError]).toEqual([tool.name, name, true]);
          expect(textOf(r), `${tool.name} with ${name}=${JSON.stringify(value)}`).toMatch(new RegExp(`Input validation error[\\s\\S]*\\b${name}\\b`));
          probes += 1;
        }
      }
      expect(probes).toBeGreaterThan(40);
      // Nothing was written anywhere.
      await expect(fs.stat(path.join(home, 'lexicon.yaml'))).rejects.toThrow();
      await expect(fs.stat(path.join(repo, '.lexicon.yaml'))).rejects.toThrow();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      await client.close();
      await server.close();
    }
  });
});

describe('apply_suggestion with a scope that does not hold the term', () => {
  // Catches: an 'alias' or 'never' suggestion applied with an explicit scope
  // (or a suggestion scope from before the term moved) naming the file the
  // term is not in. addTerm created a copy of the term there holding only the
  // new word, reported as saved; a project copy wins the merge, so the global
  // term's never words and category stopped applying.
  it('refuses, writes nothing, and keeps the global term whole', async () => {
    const globalPath = process.env.LEXICON_PATH as string;
    const projectPath = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: Vercel\n    aliases: [versel]\n    category: brand\n    never: [vessel]\n');
    const before = await fs.readFile(globalPath, 'utf8');

    for (const args of [
      { suggestion: { kind: 'alias', canonical: 'Vercel', alias: 'versal' }, scope: 'project' },
      { suggestion: { kind: 'never', canonical: 'Vercel', alias: 'parcel' }, scope: 'project' },
      { suggestion: { kind: 'alias', canonical: 'Vercel', alias: 'versal', scope: 'project', path: projectPath } },
    ]) {
      const res = await call('apply_suggestion', args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain(`"Vercel" is in the global lexicon (${globalPath}), not the project one`);
      expect(res.text).toContain('nothing was written');
      expect(res.text).toContain('without scope');
    }
    await expect(fs.stat(projectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);

    // Without a scope it goes where the term lives, and the term keeps its never word.
    const applied = await call('apply_suggestion', { suggestion: { kind: 'alias', canonical: 'Vercel', alias: 'versal' } });
    expect(JSON.parse(applied.text)).toMatchObject({ path: globalPath, created: false });
    const listed = JSON.parse((await call('list_terms', {})).text) as { terms: Array<{ canonical: string; never?: string[]; category?: string; aliases: string[] }> };
    expect(listed.terms.find((t) => t.canonical === 'Vercel')).toMatchObject({ category: 'brand', never: ['vessel'], aliases: ['versel', 'versal'] });
  });

  it('accepts a scope that holds a copy of the term', async () => {
    const globalPath = process.env.LEXICON_PATH as string;
    expect((await call('add_term', { canonical: 'Kubernetes', aliases: ['cooper netties'], scope: 'project' })).isError).toBe(false);
    expect((await call('add_term', { canonical: 'Kubernetes', aliases: ['cube netties'], scope: 'global' })).isError).toBe(false);
    const res = await call('apply_suggestion', { suggestion: { kind: 'alias', canonical: 'Kubernetes', alias: 'kuber nettys' }, scope: 'global' });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ path: globalPath, created: false });
  });
});

describe('project-scope writes from MCP never trust the project file', () => {
  const savedTrustAll = process.env.LEXICON_TRUST_ALL;
  beforeEach(() => {
    delete process.env.LEXICON_TRUST_ALL;
  });
  afterEach(() => {
    if (savedTrustAll === undefined) delete process.env.LEXICON_TRUST_ALL;
    else process.env.LEXICON_TRUST_ALL = savedTrustAll;
  });

  async function trustStatus(): Promise<string> {
    return (JSON.parse((await call('trust_project', { action: 'status' })).text) as { status: string }).status;
  }

  // Catches: add_term, learn_correction, apply_suggestion and import_dictionary
  // with scope: 'project' created the repo's .lexicon.yaml and registered it as
  // trusted, so a model decided what every later prompt in that repo is
  // rewritten with; trusting a project file is the user's call.
  it.each([
    ['add_term', { canonical: 'Kubectl', aliases: ['cube control'], scope: 'project' }],
    ['learn_correction', { heard: 'cube control', meant: 'Kubectl', scope: 'project' }],
    ['apply_suggestion', { suggestion: { kind: 'term', canonical: 'Kubectl', aliases: ['cube control'] }, scope: 'project' }],
    ['import_dictionary', { content: 'Kubectl: cube control\n', format: 'text', scope: 'project' }],
  ] as const)('%s writes a new project file untrusted and names the trust step', async (tool, args) => {
    const projectPath = path.join(repo, '.lexicon.yaml');
    const res = await call(tool, args);
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text) as { path: string; trusted: boolean; nextStep: string };
    expect(payload).toMatchObject({ path: projectPath, trusted: false });
    expect(payload.nextStep).toContain('which is not trusted');
    expect(payload.nextStep).toContain('`npx @ashlr/lexicon trust`');
    expect(payload.nextStep).toContain('trust_project with action "trust"');
    expect(await fs.readFile(projectPath, 'utf8')).toContain('Kubectl');
    expect(await trustStatus()).toBe('untrusted');
    const listed = JSON.parse((await call('list_terms', {})).text) as { terms: unknown[]; skippedProject?: string };
    expect(listed.terms).toEqual([]);
    expect(listed.skippedProject).toBe(projectPath);
  });

  // Catches: a write into an existing untrusted file returned the file's own
  // copy of the term (its notes and aliases) to the model.
  it('merges into an existing untrusted file without trusting it or reading its term back', async () => {
    const projectPath = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [PLANTED-ALIAS]\n    notes: PLANTED-NOTE\n');
    for (const [tool, args] of [
      ['add_term', { canonical: 'Kubectl', aliases: ['cube control'], scope: 'project' }],
      ['learn_correction', { heard: 'cube cuddle', meant: 'Kubectl', scope: 'project' }],
      ['import_dictionary', { content: 'Kubectl: cube cutter\n', format: 'text', scope: 'project' }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, `${tool}: ${res.text}`).toBe(false);
      expect(JSON.parse(res.text)).toMatchObject({ path: projectPath, trusted: false });
      expect(res.text).not.toContain('PLANTED');
    }
    expect(await trustStatus()).toBe('untrusted');
    const onDisk = await fs.readFile(projectPath, 'utf8');
    for (const alias of ['PLANTED-ALIAS', 'cube control', 'cube cuddle', 'cube cutter']) expect(onDisk).toContain(alias);
  });

  it('keeps a trusted project file trusted and merged after the edit', async () => {
    const projectPath = await trustedProjectFile();
    const res = await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'], scope: 'project' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text) as { path: string; trusted?: boolean; nextStep?: string };
    expect(payload.path).toBe(projectPath);
    expect(payload.trusted).toBeUndefined();
    expect(payload.nextStep).toBeUndefined();
    expect(await trustStatus()).toBe('trusted');
    const normalized = JSON.parse((await call('normalize_transcript', { text: 'run cube control apply' })).text) as { output: string };
    expect(normalized.output).toBe('run Kubectl apply');
  });

  it('leaves a project file that changed since it was trusted unpinned', async () => {
    const projectPath = await trustedProjectFile();
    await fs.appendFile(projectPath, '# edited by hand\n');
    expect(await trustStatus()).toBe('changed');
    const res = await call('add_term', { canonical: 'Kubectl', aliases: ['cube control'], scope: 'project' });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ trusted: false });
    expect(await trustStatus()).toBe('changed');
  });
});

describe('harvest_repo and suggest_terms on a model-chosen path', () => {
  const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-repo');
  let outside: string;
  const savedRoots = process.env.LEXICON_HARVEST_ROOTS;
  const savedTrustAll = process.env.LEXICON_TRUST_ALL;

  beforeEach(async () => {
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mcpflow-outside-')));
    await fs.cp(FIXTURE, path.join(outside, 'other'), { recursive: true });
    await fs.cp(FIXTURE, path.join(repo, 'app'), { recursive: true });
    delete process.env.LEXICON_HARVEST_ROOTS;
    delete process.env.LEXICON_TRUST_ALL;
  });

  afterEach(async () => {
    if (savedRoots === undefined) delete process.env.LEXICON_HARVEST_ROOTS;
    else process.env.LEXICON_HARVEST_ROOTS = savedRoots;
    if (savedTrustAll === undefined) delete process.env.LEXICON_TRUST_ALL;
    else process.env.LEXICON_TRUST_ALL = savedTrustAll;
    await fs.rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Catches: add: true wrote the candidates into the repo's .lexicon.yaml and
  // registered it as trusted, so a model decided what every later prompt in
  // that repo is rewritten with; trusting a project file is the user's call.
  it('add: true writes the project file but leaves it untrusted, and names the trust step', async () => {
    const res = await call('harvest_repo', { add: true, minCount: 1 });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text) as { added: number; path: string; trusted: boolean; nextStep: string };
    const projectPath = path.join(repo, '.lexicon.yaml');
    expect(payload.added).toBeGreaterThan(0);
    expect(payload).toMatchObject({ path: projectPath, trusted: false });
    expect(payload.nextStep).toContain('`npx @ashlr/lexicon trust`');
    expect(await fs.readFile(projectPath, 'utf8')).toContain('canonical:');

    const status = JSON.parse((await call('trust_project', { action: 'status' })).text) as { status: string };
    expect(status.status).toBe('untrusted');
    // Not merged: list_terms sees only the (empty) global lexicon and names the skipped file.
    const listed = JSON.parse((await call('list_terms', {})).text) as { terms: unknown[]; skippedProject?: string };
    expect(listed.terms).toEqual([]);
    expect(listed.skippedProject).toBe(projectPath);

    // A second harvest merges into the untrusted file rather than failing the trust gate.
    const again = await call('harvest_repo', { add: true, minCount: 1 });
    expect(again.isError).toBe(false);
    expect(JSON.parse(again.text)).toMatchObject({ trusted: false });
  });

  // Catches: `path` was resolved and read wherever it pointed (a probe read /etc).
  it('refuses a path outside the server directory, its git root and the allowed roots', async () => {
    const res = await call('harvest_repo', { path: path.join(outside, 'other'), add: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('outside the directories this server may read');
    expect(res.text).toContain(`\`lexicon harvest ${path.join(outside, 'other')}\``);
    expect(res.text).toContain('npx @ashlr/lexicon harvest');
    expect(res.text).toContain('LEXICON_HARVEST_ROOTS');
    await expect(fs.stat(path.join(outside, 'other', '.lexicon.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });

    expect((await call('harvest_repo', { path: '/etc' })).isError).toBe(true);
    expect((await call('harvest_repo', { path: '..' })).isError).toBe(true);

    const sug = await call('suggest_terms', { cwd: path.join(outside, 'other') });
    expect(sug.isError).toBe(true);
    expect(sug.text).toContain('lexicon suggest --cwd');
  });

  it('resolves symlinks before the check, so a link inside the repo cannot point out of it', async () => {
    await fs.symlink(path.join(outside, 'other'), path.join(repo, 'link'));
    const res = await call('harvest_repo', { path: 'link' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('outside the directories this server may read');
    expect((await call('suggest_terms', { cwd: 'link' })).isError).toBe(true);
  });

  it('reads a subdirectory of the repo and a directory listed in LEXICON_HARVEST_ROOTS', async () => {
    const inside = await call('harvest_repo', { path: 'app', minCount: 1 });
    expect(inside.isError).toBe(false);
    expect(JSON.parse(inside.text)).toMatchObject({ root: path.join(repo, 'app') });
    expect((await call('suggest_terms', { cwd: 'app' })).isError).toBe(false);

    process.env.LEXICON_HARVEST_ROOTS = ['/nonexistent-root', outside].join(path.delimiter);
    const listed = await call('harvest_repo', { path: path.join(outside, 'other'), minCount: 1 });
    expect(listed.isError).toBe(false);
    expect((await call('suggest_terms', { cwd: path.join(outside, 'other') })).isError).toBe(false);
  });

  it('reads any directory the client named as an MCP root', async () => {
    const { pathToFileURL } = await import('node:url');
    const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const server = createServer({ rootsTimeoutMs: 2000 });
    const client = new Client({ name: 'roots', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(repo).href }, { uri: pathToFileURL(outside).href }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: 'harvest_repo', arguments: { path: path.join(outside, 'other'), minCount: 1 } })) as ToolResult;
      expect(res.isError).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
