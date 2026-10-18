/**
 * Multi-term writes outside pack install go through `addTerms` too: one read
 * and one write of the project lexicon for the whole list. One `addTerm` per
 * name re-parsed the growing file on every write (to edit it in place and to
 * check it reads back), so `lexicon harvest --add` of 50 names took about
 * 1.5 s and 200 names about 15 s. The parse count is what these tests pin.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Pass-through wrappers that count YAML parses (as tests/packs.test.ts does). */
const yamlParses = vi.hoisted(() => ({ count: 0 }));
vi.mock('yaml', async (importOriginal) => {
  const real = await importOriginal<typeof import('yaml')>();
  return {
    ...real,
    parse: (...args: Parameters<typeof real.parse>) => {
      yamlParses.count += 1;
      return real.parse(...args);
    },
    parseDocument: (...args: Parameters<typeof real.parseDocument>) => {
      yamlParses.count += 1;
      return real.parseDocument(...args);
    },
  };
});

import { readLexiconFile } from '../src/core/index.js';
import type { HarvestCandidate } from '../src/core/index.js';
import { runHarvest } from '../src/cli/commands.js';
import { runSetup } from '../src/cli/cmd-setup.js';
import { createServer } from '../src/mcp/server.js';
import { makeIO } from './helpers.js';

const NAMES = 50;
/** Distinct made-up product names, so none is an everyday word or in a stoplist. */
const names = Array.from({ length: NAMES }, (_, i) => `Zorbex${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}q`);

let home: string;
let repo: string;
let globalPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-batch-home-')));
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-batch-repo-')));
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  // Each name twice in prose: what harvest needs to propose it (minCount 2).
  await fs.writeFile(path.join(repo, 'README.md'), names.map((n) => `We ship ${n} today. The ${n} team says hi.`).join('\n\n') + '\n');
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  for (const key of ['HOME', 'USERPROFILE', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  // os.homedir() reads USERPROFILE on Windows and ignores HOME.
  process.env.USERPROFILE = home;
  process.env.LEXICON_PATH = globalPath;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  for (const key of ['HOME', 'USERPROFILE', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function projectCanonicals(): Promise<string[]> {
  return (await readLexiconFile(path.join(repo, '.lexicon.yaml'), 'project')).lexicon.terms.map((t) => t.canonical);
}

describe('multi-term writes read and write the lexicon once', () => {
  it('lexicon harvest --add --yes adds 50 names with a bounded number of YAML parses', async () => {
    yamlParses.count = 0;
    const io = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, globalPath }, io, { isInteractive: () => false })).toBe(0);
    const fresh = yamlParses.count;
    expect(io.out).toContain(`added ${NAMES} new terms, merged 0`);
    expect((await projectCanonicals()).sort()).toEqual([...names].sort());

    // Again: every name merges into the trusted file, still one write.
    yamlParses.count = 0;
    const again = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, globalPath }, again, { isInteractive: () => false })).toBe(0);
    expect(again.out).toContain(`added 0 new terms, merged ${NAMES}`);
    expect(await projectCanonicals()).toHaveLength(NAMES);
    // One addTerm per name parsed the file about 3 times per name (150+).
    expect(fresh).toBeLessThan(15);
    expect(yamlParses.count).toBeLessThan(15);
  });

  it('MCP harvest_repo with add writes every candidate in one batch', async () => {
    const server = createServer({ cwd: repo });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      yamlParses.count = 0;
      const result = (await client.callTool({ name: 'harvest_repo', arguments: { add: true, limit: NAMES } })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as { added: number; failures: unknown[]; trusted?: boolean };
      expect(payload).toMatchObject({ added: NAMES, failures: [], trusted: false });
      expect((await projectCanonicals()).sort()).toEqual([...names].sort());
      expect(yamlParses.count).toBeLessThan(15);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lexicon setup --harvest adds the repo names in one write', async () => {
    const candidates: HarvestCandidate[] = names.slice(0, 10).map((canonical) => ({
      canonical,
      category: 'product',
      count: 2,
      evidence: [],
      suggestedAliases: [`${canonical.toLowerCase()} x`],
      source: 'harvest:repo',
    }));
    // Seed the global lexicon first, so the parse count below is the harvest step's.
    const seeded = await runSetup({ cwd: repo, yes: true, clients: 'none', company: 'Ashlr.AI', harvest: false, packs: 'none' }, makeIO(), {
      platform: 'darwin',
      env: { PATH: '' },
      home,
      exec: () => {
        throw new Error('no git');
      },
      isInteractive: () => false,
      serveBlocker: async () => undefined,
    });
    expect(seeded.code).toBe(0);
    let parsesBeforeHarvest = 0;
    yamlParses.count = 0;
    const io = makeIO();
    const { code, summary } = await runSetup({ cwd: repo, yes: true, clients: 'none', harvest: true, packs: 'none' }, io, {
      platform: 'darwin',
      env: { PATH: '' },
      home,
      exec: () => {
        throw new Error('no git');
      },
      isInteractive: () => false,
      serveBlocker: async () => undefined,
      harvest: async () => {
        parsesBeforeHarvest = yamlParses.count;
        return candidates;
      },
    });
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(candidates.map((c) => c.canonical));
    expect(io.out).toContain('added 10 new terms, merged 0');
    expect(await projectCanonicals()).toEqual(candidates.map((c) => c.canonical));
    // The steps after the harvest (the exports, the summary) read the lexicon too,
    // so count only from the harvest to the end. One addTerm per name made 30+.
    expect(yamlParses.count - parsesBeforeHarvest).toBeLessThan(15);
  });
});
