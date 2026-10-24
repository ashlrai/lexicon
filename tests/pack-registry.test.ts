/**
 * `lexicon pack` community commands: search, add (preview + confirm), update,
 * remove, show and validate, against a fixture registry index in a temp dir.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runPackAdd,
  runPackList,
  runPackRemove,
  runPackSearch,
  runPackShow,
  runPackUpdate,
  runPackValidate,
} from '../src/cli/cmd-pack.js';
import { sha256Hex } from '../src/core/index.js';
import { makeIO, scripted } from './helpers.js';

const PACK = `name: cardiology
title: Cardiology terms
description: Heart words.
version: 1
author: example
homepage: https://example.com/cardiology
terms:
  - canonical: Metoprolol
    aliases: [metoprolol, metropolol]
    category: brand
`;

let dir: string;
let globalPath: string;
let indexPath: string;

function writeIndex(version: string, packText: string = PACK): string {
  const file = path.join(dir, 'cardiology.yaml');
  writeFileSync(file, packText);
  const p = path.join(dir, 'index.yaml');
  writeFileSync(
    p,
    `version: 1
packs:
  - author: example
    name: cardiology
    title: Cardiology terms
    description: Heart words.
    homepage: https://example.com/cardiology
    version: "${version}"
    terms: 1
    aliases: 2
    checksum: ${sha256Hex(Buffer.from(packText))}
    url: ./cardiology.yaml
`,
  );
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lexicon-pack-cli-test-'));
  globalPath = path.join(dir, 'lexicon.yaml');
  indexPath = writeIndex('1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const baseOpts = () => ({ globalPath, registry: indexPath });

describe('pack search', () => {
  it('needs --registry', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', { globalPath }, io)).toBe(1);
    expect(io.err).toContain('--registry');
    expect(io.out).toBe('');
  });

  // Catches: under --json the refusal was on stderr only, so a script parsing stdout got nothing.
  it('prints { ok: false, error } under --json when it refuses or fails', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', { globalPath, json: true }, io)).toBe(1);
    expect(JSON.parse(io.out)).toEqual({ ok: false, error: expect.stringContaining('needs --registry'), nextStep: 'pass --registry <index>, or run lexicon pack list for the built-in packs' });
    const missing = makeIO();
    expect(await runPackSearch('cardio', { globalPath, json: true, registry: path.join(dir, 'nope.json') }, missing)).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('finds the pack and prints install help', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', baseOpts(), io)).toBe(0);
    expect(io.out).toContain('example/cardiology');
    expect(io.out).toContain('lexicon pack add');
  });

  it('prints JSON with --json', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.packs[0].ref).toBe('example/cardiology');
    expect(parsed.packs[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pack add (community)', () => {
  it('needs --registry for a ref', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { globalPath }, io)).toBe(1);
    expect(io.err).toContain('--registry');
  });

  it('previews without writing when --json and no --yes', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.preview).toBe(true);
    expect(parsed.ref).toBe('example/cardiology');
    expect(parsed.terms[0].canonical).toBe('Metoprolol');
    const { existsSync } = await import('node:fs');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('asks on a terminal and declines by default', async () => {
    const io = makeIO();
    const p = scripted(['n']); // confirm: no
    const code = await runPackAdd(['example/cardiology'], baseOpts(), io, {
      createPrompter: () => p,
      isInteractive: () => true,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('declined; nothing written.');
    const { existsSync } = await import('node:fs');
    expect(existsSync(globalPath)).toBe(false);
  });

  // Catches: off a terminal without --yes, `pack add <ref>` exited 0 with
  // "declined; nothing written." and a hint that said only "pass --yes", so a
  // script read success and a person had to rebuild the command, --registry and all.
  it('off a terminal without --yes writes nothing, prints the full command and exits 1', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology@1'], { ...baseOpts(), project: true, cwd: dir }, io, { isInteractive: () => false })).toBe(1);
    expect(io.err).toContain(`not a terminal, so nothing was written. Review the list above, then run: lexicon pack add example/cardiology@1 --registry ${indexPath} --project --yes`);
    expect(existsSync(path.join(dir, '.lexicon.yaml'))).toBe(false);
    expect(existsSync(globalPath)).toBe(false);
    const spaced = makeIO();
    const odd = path.join(dir, "my reg's", 'index.yaml');
    mkdirSync(path.dirname(odd));
    writeFileSync(odd, readFileSync(indexPath));
    writeFileSync(path.join(path.dirname(odd), 'cardiology.yaml'), PACK);
    expect(await runPackAdd(['example/cardiology'], { globalPath, registry: odd }, spaced, { isInteractive: () => false })).toBe(1);
    expect(spaced.err).toContain(`run: lexicon pack add example/cardiology --registry '${dir}/my reg'\\''s/index.yaml' --yes`);
  });

  it('--yes installs after the preview', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    expect(io.out).toContain('installed example/cardiology');
    expect(io.out).toContain('1 added');
  });

  it('rejects an unknown ref with the index contents', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/neurology'], { ...baseOpts(), yes: true }, io)).toBe(1);
    expect(io.err).toContain('example/cardiology');
  });
});

describe('pack update', () => {
  it('keeps project-only updates in that project and never creates global state', async () => {
    const cwd = path.join(dir, 'project'); mkdirSync(path.join(cwd, '.git'), { recursive: true });
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), cwd, project: true, yes: true }, makeIO())).toBe(0);
    const changed = PACK + '  - canonical: Echocardiogram\n    aliases: [echo cardiogram]\n';
    writeIndex('2', changed);
    expect(await runPackUpdate([], { ...baseOpts(), cwd, project: true, yes: true }, makeIO())).toBe(0);
    expect(readFileSync(path.join(cwd, '.lexicon.yaml'), 'utf8')).toContain('Echocardiogram');
    expect(existsSync(globalPath)).toBe(false);
    const globalList = makeIO(); await runPackList({ globalPath, json: true }, globalList);
    expect(JSON.parse(globalList.out).communityInstalled).toEqual([]);
  });

  it('previews alias and note changes in JSON without writing', async () => {
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, makeIO())).toBe(0);
    const before = readFileSync(globalPath, 'utf8');
    const changed = PACK.replace('metropolol]', 'metropolol, newly-reviewed-alias]').replace('    category: brand', '    category: brand\n    notes: "agent-visible payload"\n    phonetic: "met-oh"\n    caseSensitive: true');
    writeIndex('2', changed);
    const io = makeIO();
    expect(await runPackUpdate([], { ...baseOpts(), json: true }, io)).toBe(0);
    const preview = JSON.parse(io.out).updates[0];
    expect(preview.status).toBe('preview');
    expect(preview.terms[0]).toMatchObject({ notes: 'agent-visible payload', phonetic: 'met-oh', caseSensitive: true });
    expect(preview.changed[0].after.aliases).toContain('newly-reviewed-alias');
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
  });

  it('reports current when the index is unchanged', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackUpdate([], { ...baseOpts(), yes: true }, io2)).toBe(0);
    expect(io2.out).toContain('already current');
  });

  it('previews the diff and applies with --yes', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const v2 = `${PACK}  - canonical: Stent\n    aliases: [stent]\n    category: product\n`;
    const index2 = writeIndex('2', v2);
    const io2 = makeIO();
    expect(await runPackUpdate(['example/cardiology'], { globalPath, registry: index2, yes: true }, io2)).toBe(0);
    expect(io2.out).toContain('update available');
    expect(io2.out).toContain('Stent');
    expect(io2.out).toContain('updated example/cardiology');
  });

  it('asks per update on a terminal', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const v2 = `${PACK}  - canonical: Stent\n    aliases: [stent]\n    category: product\n`;
    const index2 = writeIndex('2', v2);
    const io2 = makeIO();
    const p = scripted(['n']); // decline the update
    const code = await runPackUpdate(['example/cardiology'], { globalPath, registry: index2 }, io2, {
      createPrompter: () => p,
      isInteractive: () => true,
    });
    expect(code).toBe(0);
    expect(io2.out).toContain('skipped; nothing written.');
  });
});

describe('pack update off a terminal', () => {
  // Catches: off a terminal without --yes, `pack update` printed "skipped;
  // nothing written." and exited 0, so a script read success for an update it
  // never applied. `pack add` exits 1 in the same case.
  it('without --yes reports every pack, writes nothing and exits 1', async () => {
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, makeIO())).toBe(0);
    const before = readFileSync(globalPath, 'utf8');
    const index2 = writeIndex('2', `${PACK}  - canonical: Stent\n    aliases: [stent]\n    category: product\n`);
    const io = makeIO();
    expect(await runPackUpdate([], { globalPath, registry: index2 }, io, { isInteractive: () => false })).toBe(1);
    expect(io.out).toContain('example/cardiology: update available');
    expect(io.out).toContain('skipped; nothing written.');
    expect(io.err).toContain(`not a terminal, so nothing was written. Review the list above, then run: lexicon pack update example/cardiology --registry ${index2} --yes`);
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
  });
});

describe('pack remove (community)', () => {
  it('removes via the cache without --registry', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackRemove('example/cardiology', { globalPath }, io2)).toBe(0);
    expect(io2.out).toContain('removed 1 term');
  });
});

describe('pack show (community)', () => {
  it('downloads through --registry into a temp dir', async () => {
    const io = makeIO();
    expect(await runPackShow('example/cardiology', baseOpts(), io)).toBe(0);
    expect(io.out).toContain('example/cardiology');
    expect(io.out).toContain('Metoprolol');
  });
});

describe('pack validate', () => {
  it('accepts the example pack', async () => {
    const io = makeIO();
    expect(await runPackValidate(path.join(dir, 'cardiology.yaml'), { globalPath }, io)).toBe(0);
    expect(io.out).toContain('valid');
  });

  it('fails on an ordinary-word canonical', async () => {
    const bad = path.join(dir, 'badpack.yaml');
    writeFileSync(bad, 'name: badpack\ntitle: Bad\ndescription: x\nversion: 1\nterms:\n  - canonical: Sauce\n    aliases: [sawce]\n');
    const io = makeIO();
    expect(await runPackValidate(bad, { globalPath }, io)).toBe(1);
    expect(io.out).toContain('error:');
    expect(io.out).toContain('ordinary English word');
  });
});

describe('pack list', () => {
  it('shows installed community packs', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackList({ globalPath }, io2)).toBe(0);
    expect(io2.out).toContain('community packs installed:');
    expect(io2.out).toContain('example/cardiology');
  });
});

describe('pack validate file handling', () => {
  it('validates a pack whose file name differs from its name (docs: ./my-pack.yaml) or uses .yml', async () => {
    for (const name of ['my-pack.yaml', 'cardiology.yml', 'Cardiology.yaml']) {
      const file = path.join(dir, name);
      writeFileSync(file, PACK);
      const io = makeIO();
      expect(await runPackValidate(file, { globalPath }, io)).toBe(0);
      expect(io.out).toContain('cardiology');
      expect(io.err).toBe('');
    }
  });

  it('reports a missing file as missing, not as an unknown pack', async () => {
    const io = makeIO();
    expect(await runPackValidate(path.join(dir, 'nope.yaml'), { globalPath }, io)).toBe(1);
    expect(io.err).toContain('file not found');
    expect(io.err).not.toContain('unknown pack');
    // Catches: the error named the path with no next step.
    expect(io.err).toContain(
      'lexicon: check the path (a relative one resolves against the current directory); validate takes a pack YAML file, so to see the packs you can add run lexicon pack list\n',
    );
    const json = makeIO();
    expect(await runPackValidate(path.join(dir, 'nope.yaml'), { globalPath, json: true }, json)).toBe(1);
    expect(JSON.parse(json.out)).toEqual({
      ok: false,
      error: `file not found: ${path.join(dir, 'nope.yaml')}`,
      nextStep: 'check the path (a relative one resolves against the current directory); validate takes a pack YAML file, so to see the packs you can add run lexicon pack list',
    });
  });
});

// Catches: a pack the untrusted project file records read as plain "not installed", with no word that the file was skipped.
describe('pack list / pack search with an untrusted project lexicon', () => {
  function untrustedRepo(): string {
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeFileSync(
      path.join(repo, '.lexicon.yaml'),
      'version: 1\nsettings:\n  packs: [developer, example/cardiology]\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n',
    );
    return repo;
  }

  it('pack list --json adds projectTrust, skippedProject and note; the table warns on stderr', async () => {
    const repo = untrustedRepo();
    const io = makeIO();
    expect(await runPackList({ globalPath, cwd: repo, registry: indexPath, json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out) as {
      packs: { name: string; installed: boolean }[];
      registry: { ref: string; installed: boolean }[];
      projectTrust?: string;
      skippedProject?: string;
      note?: string;
    };
    expect(parsed.packs.find((p) => p.name === 'developer')?.installed).toBe(false);
    expect(parsed.registry[0]).toMatchObject({ ref: 'example/cardiology', installed: false });
    expect(parsed.projectTrust).toBe('untrusted');
    expect(parsed.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    expect(parsed.note).toMatch(/lexicon trust/);
    expect(parsed.note).toMatch(/shows as not installed/);
    expect(io.out).not.toContain('Kubectl');

    const table = makeIO();
    expect(await runPackList({ globalPath, cwd: repo }, table)).toBe(0);
    expect(table.err).toContain(`untrusted project lexicon skipped: ${path.join(repo, '.lexicon.yaml')}`);
  });

  it('pack search --json gives each hit an installed flag and the skipped-project keys', async () => {
    const repo = untrustedRepo();
    const io = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), cwd: repo, json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out) as { packs: { ref: string; installed: boolean }[]; skippedProject?: string; projectTrust?: string };
    expect(parsed.packs[0]).toMatchObject({ ref: 'example/cardiology', installed: false });
    expect(parsed.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    expect(parsed.projectTrust).toBe('untrusted');

    const table = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), cwd: repo }, table)).toBe(0);
    expect(table.err).toContain('untrusted project lexicon skipped');
  });

  it('no project file: no skipped-project keys, and installed flags follow the global file', async () => {
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, makeIO())).toBe(0);
    const io = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), cwd: dir, json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out) as Record<string, unknown> & { packs: { installed: boolean }[] };
    expect(parsed.packs[0].installed).toBe(true);
    expect(parsed).not.toHaveProperty('skippedProject');
    const list = makeIO();
    expect(await runPackList({ ...baseOpts(), cwd: dir, json: true }, list)).toBe(0);
    const listed = JSON.parse(list.out) as Record<string, unknown> & { registry: { installed: boolean }[] };
    expect(listed.registry[0].installed).toBe(true);
    expect(listed).not.toHaveProperty('projectTrust');
  });
});

describe('installed flags: one source of truth across pack list, pack search and MCP list_packs', () => {
  // Catches: pack list marked a community pack installed from the registry
  // state file while pack search and list_packs read settings.packs, so the
  // three disagreed whenever the two records did.
  it('all three read settings.packs; pack list reports the record that disagrees', async () => {
    const cwd = path.join(dir, 'plain'); mkdirSync(cwd, { recursive: true });
    const saved = process.env.LEXICON_PATH;
    const savedRegistries = process.env.LEXICON_REGISTRIES;
    process.env.LEXICON_PATH = globalPath;
    // Step 2 deletes the registry record, which is also what registers the
    // index for MCP; the user's own allowlist keeps list_packs reading it.
    process.env.LEXICON_REGISTRIES = indexPath;
    const { createServer } = await import('../src/mcp/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const listPacksMcp = async (): Promise<{ community: { ref: string; installed: boolean }[]; installed: string[]; registryMismatch?: unknown }> => {
      const server = createServer({ cwd });
      const client = new Client({ name: 'test', version: '0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      try {
        const r = (await client.callTool({ name: 'list_packs', arguments: { registry: indexPath } })) as { content: { text: string }[] };
        return JSON.parse(r.content[0].text);
      } finally {
        await client.close();
        await server.close();
      }
    };
    const flags = async (): Promise<{
      list: boolean;
      search: boolean;
      mcp: boolean;
      listIO: ReturnType<typeof makeIO>;
      searchIO: ReturnType<typeof makeIO>;
      searchMismatch: unknown;
      mcpMismatch: unknown;
    }> => {
      const listIO = makeIO();
      expect(await runPackList({ ...baseOpts(), cwd, json: true }, listIO), listIO.err).toBe(0);
      const search = makeIO();
      expect(await runPackSearch('cardio', { ...baseOpts(), cwd, json: true }, search)).toBe(0);
      const mcp = await listPacksMcp();
      return {
        list: (JSON.parse(listIO.out) as { registry: { ref: string; installed: boolean }[] }).registry[0].installed,
        search: (JSON.parse(search.out) as { packs: { installed: boolean }[] }).packs[0].installed,
        mcp: mcp.community[0].installed,
        listIO,
        searchIO: search,
        searchMismatch: (JSON.parse(search.out) as { registryMismatch?: unknown }).registryMismatch,
        mcpMismatch: mcp.registryMismatch,
      };
    };
    try {
      expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), cwd, yes: true }, makeIO())).toBe(0);
      const installedFile = readFileSync(globalPath, 'utf8');
      expect(installedFile).toContain('example/cardiology');
      const agreed = await flags();
      expect(agreed).toMatchObject({ list: true, search: true, mcp: true });
      expect(agreed.searchMismatch).toBeUndefined();
      expect(agreed.mcpMismatch).toBeUndefined();

      // 1. The registry state still records it; the lexicon file no longer lists it.
      const { parse, stringify } = await import('yaml');
      const doc = parse(installedFile) as { settings: { packs: string[] } };
      doc.settings.packs = doc.settings.packs.filter((p) => p !== 'example/cardiology');
      if (doc.settings.packs.length === 0) delete (doc as { settings?: unknown }).settings;
      writeFileSync(globalPath, stringify(doc));
      expect(readFileSync(globalPath, 'utf8')).not.toContain('example/cardiology');
      const recordOnly = await flags();
      expect(recordOnly).toMatchObject({ list: false, search: false, mcp: false });
      const parsed = JSON.parse(recordOnly.listIO.out) as { communityInstalled: string[]; registryMismatch?: unknown };
      expect(parsed.communityInstalled).toEqual(['example/cardiology']);
      expect(parsed.registryMismatch).toEqual({ fileOnly: [], recordOnly: ['example/cardiology'] });
      expect(recordOnly.listIO.err).toContain('has a registry record but is not in the global lexicon');
      // Catches: only pack list reported the mismatch; search and list_packs said nothing.
      expect(recordOnly.searchMismatch).toEqual({ fileOnly: [], recordOnly: ['example/cardiology'] });
      expect(recordOnly.mcpMismatch).toEqual({ fileOnly: [], recordOnly: ['example/cardiology'] });
      expect(recordOnly.searchIO.err).toContain('example/cardiology has a registry record but is not in');

      // 2. The other way round: the file lists it, the registry state has no record.
      writeFileSync(globalPath, installedFile);
      const statePath = path.join(path.dirname(globalPath), 'registry', 'registry.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { packs: Record<string, unknown> };
      delete state.packs['example/cardiology'];
      writeFileSync(statePath, JSON.stringify(state));
      const fileOnly = await flags();
      expect(fileOnly).toMatchObject({ list: true, search: true, mcp: true });
      expect(JSON.parse(fileOnly.listIO.out)).toMatchObject({ communityInstalled: [], registryMismatch: { fileOnly: ['example/cardiology'], recordOnly: [] } });
      expect(fileOnly.listIO.err).toContain('has no registry record, so pack update will not check it');
      expect(fileOnly.searchMismatch).toEqual({ fileOnly: ['example/cardiology'], recordOnly: [] });
      expect(fileOnly.mcpMismatch).toEqual({ fileOnly: ['example/cardiology'], recordOnly: [] });

      // The table agrees too.
      const table = makeIO();
      expect(await runPackList({ ...baseOpts(), cwd }, table)).toBe(0);
      expect(table.out).toMatch(/community packs installed:[\s\S]*example\/cardiology/);
      expect(table.out).toMatch(/example\/cardiology\s+Cardiology terms\s+1\s+yes/);
    } finally {
      if (saved === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = saved;
      if (savedRegistries === undefined) delete process.env.LEXICON_REGISTRIES;
      else process.env.LEXICON_REGISTRIES = savedRegistries;
    }
  });
});

// Catches: every object-shaped `pack ... --json` document lacked `ok`, though a
// refusal leads with `ok: false`; update and validate, whose document is also
// the failure report, now carry `ok` equal to exit code 0. The vendored
// `pack add --json` array stays a bare array.
describe('pack --json documents lead with ok', () => {
  const doc = (out: string): Record<string, unknown> => {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('ok');
    return parsed;
  };

  it('search, add --json preview, list, show, update, remove and validate', async () => {
    const search = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), json: true }, search)).toBe(0);
    expect(doc(search.out).ok).toBe(true);

    const preview = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), json: true }, preview)).toBe(0);
    expect(doc(preview.out)).toMatchObject({ ok: true, preview: true });

    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, makeIO())).toBe(0);

    const list = makeIO();
    expect(await runPackList({ globalPath, json: true }, list)).toBe(0);
    expect(doc(list.out)).toMatchObject({ ok: true, communityInstalled: ['example/cardiology'] });

    const show = makeIO();
    expect(await runPackShow('example/cardiology', { ...baseOpts(), json: true }, show)).toBe(0);
    expect(doc(show.out)).toMatchObject({ ok: true, ref: 'example/cardiology' });
    const vendored = makeIO();
    expect(await runPackShow('developer', { globalPath, json: true }, vendored)).toBe(0);
    expect(doc(vendored.out)).toMatchObject({ ok: true, name: 'developer' });

    const update = makeIO();
    expect(await runPackUpdate([], { ...baseOpts(), json: true }, update)).toBe(0);
    expect(doc(update.out)).toMatchObject({ ok: true, updates: [{ ref: 'example/cardiology', status: 'current' }] });
    const missing = makeIO();
    expect(await runPackUpdate(['example/neurology'], { ...baseOpts(), json: true }, missing)).toBe(1);
    expect(doc(missing.out)).toMatchObject({ ok: false, updates: [{ ref: 'example/neurology' }] });

    const remove = makeIO();
    expect(await runPackRemove('example/cardiology', { globalPath, json: true }, remove)).toBe(0);
    expect(doc(remove.out)).toMatchObject({ ok: true, removed: ['Metoprolol'] });

    const valid = makeIO();
    expect(await runPackValidate(path.join(dir, 'cardiology.yaml'), { globalPath, json: true }, valid)).toBe(0);
    expect(doc(valid.out)).toMatchObject({ ok: true, errors: [] });
    const bad = path.join(dir, 'badpack.yaml');
    writeFileSync(bad, 'name: badpack\ntitle: Bad\ndescription: x\nversion: 1\nterms:\n  - canonical: Sauce\n    aliases: [sawce]\n');
    const invalid = makeIO();
    expect(await runPackValidate(bad, { globalPath, json: true }, invalid)).toBe(1);
    expect(doc(invalid.out)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('ordinary English word')]) });
  });
});

// Catches: `pack add <community ref> --json --yes` printed the install object
// and then the (empty) vendored results array, two JSON documents on stdout.
describe('pack add --json --yes prints one JSON document', () => {
  it('a single community ref prints only its install object', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), json: true, yes: true }, io)).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(Object.keys(doc)[0]).toBe('ok');
    expect(doc).toMatchObject({ ok: true, preview: false, ref: 'example/cardiology', added: 1, merged: 0 });
  });
});

// Catches: a vendored `pack add` (and `pack remove`) ignored `globalPath`,
// which the community path honours, so it wrote to LEXICON_PATH (or the real
// global lexicon) instead of the file the caller named.
describe('vendored pack add / remove honour globalPath', () => {
  it('writes and removes only the globalPath file', async () => {
    const decoy = path.join(dir, 'decoy', 'lexicon.yaml');
    const saved = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = decoy;
    try {
      const io = makeIO();
      expect(await runPackAdd(['developer'], { globalPath, cwd: dir }, io), io.err).toBe(0);
      expect(io.out).toContain(`merged into ${globalPath}`);
      expect(readFileSync(globalPath, 'utf8')).toContain('source: pack');
      expect(existsSync(decoy)).toBe(false);

      const json = makeIO();
      expect(await runPackAdd(['ai'], { globalPath, cwd: dir, json: true }, json), json.err).toBe(0);
      expect(JSON.parse(json.out)).toMatchObject([{ path: globalPath, scope: 'global' }]);
      expect(existsSync(decoy)).toBe(false);

      const removed = makeIO();
      expect(await runPackRemove('developer', { globalPath, cwd: dir }, removed), removed.err).toBe(0);
      expect(readFileSync(globalPath, 'utf8')).not.toMatch(/- developer\b/);
      expect(existsSync(decoy)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = saved;
    }
  });
});

// Catches: `pack add developer example/x --json` without --yes installed the
// vendored pack, then printed only the community preview and exited 0, so the
// vendored write was unreported; a ref after the preview was never reached.
// Without --json, a decline after a vendored install read "declined; nothing
// written." though the vendored pack had been written.
describe('pack add with a vendored and a previewed or declined community ref reports every ref', () => {
  it('--json without --yes prints one array in argument order: the vendored install and the preview', async () => {
    for (const order of [['developer', 'example/cardiology'], ['example/cardiology', 'developer']]) {
      writeFileSync(globalPath, '');
      const io = makeIO();
      expect(await runPackAdd(order, { ...baseOpts(), cwd: dir, json: true }, io), io.err).toBe(0);
      const doc = JSON.parse(io.out) as Record<string, unknown>[];
      expect(Array.isArray(doc)).toBe(true);
      expect(doc).toHaveLength(2);
      const byRef = (n: string): Record<string, unknown> => doc[order.indexOf(n)]!;
      expect(byRef('developer')).toMatchObject({ pack: { name: 'developer' }, path: globalPath, scope: 'global' });
      expect((byRef('developer') as { added: number }).added).toBeGreaterThan(0);
      expect(byRef('example/cardiology')).toMatchObject({ preview: true, ref: 'example/cardiology', terms: [{ canonical: 'Metoprolol' }] });
      const written = readFileSync(globalPath, 'utf8');
      expect(written).toContain('developer');
      expect(written).not.toContain('Metoprolol');
    }
  });

  it('a single community ref still prints its preview object', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), json: true }, io)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, preview: true, ref: 'example/cardiology' });
  });

  it('the human output names the decline and adds up what was installed', async () => {
    const io = makeIO();
    expect(await runPackAdd(['developer', 'example/cardiology'], { ...baseOpts(), cwd: dir }, io, { isInteractive: () => false })).toBe(1);
    expect(io.out).toContain('installed developer');
    expect(io.out).toContain('declined example/cardiology; nothing written for it.');
    expect(io.out).not.toContain('declined; nothing written.');
    expect(io.out).toContain('the terms are live');
    expect(io.out).toContain('1 pack installed (developer); declined: example/cardiology');
    expect(io.err).toContain(`run: lexicon pack add example/cardiology --registry ${indexPath} --yes`);
    expect(readFileSync(globalPath, 'utf8')).not.toContain('Metoprolol');
  });
});

// Catches: when `pack add <ref...> --json` failed partway (an unknown ref, a
// failed install, a community fetch that failed), stdout held only the refs
// before the failure, so a script could not tell which ref stopped the run.
describe('pack add --json names the ref it stopped at', () => {
  type Entry = Record<string, unknown>;

  it('appends { ref, ok: false, error } and leaves out the refs after it', async () => {
    writeFileSync(globalPath, '');
    const io = makeIO();
    expect(await runPackAdd(['developer', 'example/neurology', 'ai'], { ...baseOpts(), cwd: dir, json: true, yes: true }, io)).toBe(1);
    const doc = JSON.parse(io.out) as Entry[];
    expect(doc).toHaveLength(2);
    expect(doc[0]).toMatchObject({ pack: { name: 'developer' } });
    expect(doc[1]).toEqual({ ref: 'example/neurology', ok: false, error: expect.stringContaining('example/neurology'), nextStep: expect.any(String) });
    expect(Object.keys(doc[1]!)[0]).toBe('ref');
    expect(io.err).toContain('lexicon: example/neurology: ');
    expect(io.err).toContain('lexicon: not attempted: ai');
    expect(readFileSync(globalPath, 'utf8')).not.toContain('ChatGPT');
  });

  it('reports an unknown vendored pack, a missing --registry and a failed fetch the same way', async () => {
    const unknown = makeIO();
    expect(await runPackAdd(['developer', 'nope'], { globalPath, cwd: dir, json: true }, unknown)).toBe(1);
    expect((JSON.parse(unknown.out) as Entry[])[1]).toEqual({ ref: 'nope', ok: false, error: expect.stringContaining('unknown pack "nope"'), nextStep: expect.any(String) });
    expect(unknown.err).toContain('lexicon: nope: unknown pack "nope"');

    const noRegistry = makeIO();
    expect(await runPackAdd(['developer', 'example/cardiology'], { globalPath, cwd: dir, json: true }, noRegistry)).toBe(1);
    const noRegistryDoc = JSON.parse(noRegistry.out) as Entry[];
    expect(noRegistryDoc).toHaveLength(2);
    expect(noRegistryDoc[1]).toEqual({ ref: 'example/cardiology', ok: false, error: expect.stringContaining('--registry'), nextStep: expect.any(String) });

    rmSync(path.join(dir, 'cardiology.yaml'));
    const fetchFailed = makeIO();
    expect(await runPackAdd(['developer', 'example/cardiology'], { ...baseOpts(), cwd: dir, json: true, yes: true }, fetchFailed)).toBe(1);
    const fetchDoc = JSON.parse(fetchFailed.out) as Entry[];
    expect(fetchDoc).toHaveLength(2);
    expect(fetchDoc[1]).toMatchObject({ ref: 'example/cardiology', ok: false, error: expect.any(String) });
  });

  it('a list whose first ref fails is still an array; a single ref is the object', async () => {
    const first = makeIO();
    expect(await runPackAdd(['nope', 'developer'], { globalPath, cwd: dir, json: true }, first)).toBe(1);
    expect(JSON.parse(first.out)).toEqual([{ ref: 'nope', ok: false, error: expect.stringContaining('unknown pack'), nextStep: expect.any(String) }]);
    expect(first.err).toContain('not attempted: developer');
    expect(existsSync(globalPath)).toBe(false);

    const single = makeIO();
    expect(await runPackAdd(['nope'], { globalPath, cwd: dir, json: true }, single)).toBe(1);
    expect(JSON.parse(single.out)).toEqual({ ok: false, ref: 'nope', error: expect.stringContaining('unknown pack'), nextStep: expect.any(String) });
    expect(single.err).not.toContain('not attempted');
  });
});
