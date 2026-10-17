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
