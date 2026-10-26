/**
 * The compiled matcher index cache (matcher/serialize.ts + loadMatcherIndex in
 * store.ts): a cached index must be exactly the index buildIndex would build,
 * must be used only for the lexicon it was built from, must survive any kind of
 * damage by rebuilding, and must never be written anywhere but beside the
 * global lexicon.
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every canonical `parseLexicon` saw: `Injectedly` there means the changed project file was parsed. */
const schemaParses = vi.hoisted(() => ({ canonicals: [] as string[] }));
vi.mock('../src/core/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/schema.js')>();
  return {
    ...real,
    parseLexicon: (raw: unknown) => {
      const terms = (raw as { terms?: unknown } | null)?.terms;
      if (Array.isArray(terms)) {
        for (const t of terms) if (typeof (t as { canonical?: unknown })?.canonical === 'string') schemaParses.canonicals.push((t as { canonical: string }).canonical);
      }
      return real.parseLexicon(raw);
    },
  };
});

import { loadCorpus, loadLexicon as loadBenchLexicon } from '../bench/lib.js';
import { buildIndex, findReplacements } from '../src/core/matcher.js';
import { INDEX_FORMAT_VERSION, deserializeIndex, indexKey, serializeIndex } from '../src/core/matcher/serialize.js';
import { normalize, normalizeWithIndex } from '../src/core/normalize.js';
import { INDEX_CACHE_FILE_NAME, INDEX_CACHE_MIN_TERMS, addTerm, cacheChecksum, loadLexicon, loadMatcherIndex, removeAlias, removeTerm, writeLexiconFile } from '../src/core/store.js';
import { trustProject } from '../src/core/trust.js';
import { installLoadedPack, uninstallLoadedPack } from '../src/core/packs.js';
import type { Pack } from '../src/core/packs.js';
import { applyRegistryUpdate, findRegistryEntry, installRegistryPack, loadRegistryIndex, previewRegistryUpdates, sha256Hex, uninstallRegistryPack } from '../src/core/registry.js';
import { runEdit, runReview } from '../src/cli/cmd-review.js';
import type { SpawnEditor } from '../src/cli/cmd-review.js';
import { makeIO, scripted } from './helpers.js';
import type { Lexicon } from '../src/core/types.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A lexicon that exercises every field buildIndex reads. */
const RICH: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'ashler a.i.'], never: ['ashes'] },
    { canonical: 'Wispr Flow', aliases: ['whisper flow'] },
    { canonical: 'Wróblewski', aliases: ['Rublevski'], category: 'person' },
    { canonical: 'LexiconFile', aliases: [], caseSensitive: true },
    { canonical: 'Claude 4', aliases: ['clawd 4'] },
    { canonical: 'Kubernetes', aliases: ['cooper netties', 'k eight s'] },
    { canonical: 'JWT', aliases: ['j w t'] },
    { canonical: 'Bjørn', aliases: [] },
  ],
  settings: { minConfidence: 0.8, protectedWords: ['sauce', 'Boss'], phonetic: true, fuzzy: true, skipCode: false },
};

/** `n` distinct synthetic terms, past INDEX_CACHE_MIN_TERMS when n is. */
function bigLexicon(n: number, extra: Lexicon['terms'] = []): Lexicon {
  const terms = [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, ...extra];
  for (let i = 0; terms.length < n; i++) terms.push({ canonical: `Zorblax${i}`, aliases: [`zorb lax ${i}`] });
  return { version: 1, terms };
}

const roundTrip = (lexicon: Lexicon) => {
  const built = buildIndex(lexicon);
  const json = JSON.parse(JSON.stringify(serializeIndex(built))) as unknown;
  return { built, cached: deserializeIndex(json, lexicon), json };
};

describe('serializeIndex / deserializeIndex', () => {
  it('rebuilds exactly the index buildIndex builds, map order included', () => {
    for (const lexicon of [RICH, loadBenchLexicon(), bigLexicon(300)]) {
      const { built, cached } = roundTrip(lexicon);
      expect(cached).toBeDefined();
      expect(cached).toEqual(built);
      for (const name of ['exact', 'collapsed', 'phoneticKeys', 'fuzzyBuckets'] as const) {
        expect([...cached![name].keys()]).toEqual([...built[name].keys()]);
        for (const [k, list] of built[name]) {
          expect((cached![name].get(k as never) as readonly { alias: string }[]).map((e) => e.alias)).toEqual(list.map((e) => e.alias));
        }
      }
      // Entries point at the lexicon's own term objects, not copies.
      for (const e of cached!.aliasEntries) expect(e.term).toBe(lexicon.terms[e.termIndex]);
      for (const e of cached!.phoneticEntries) expect(e.term).toBe(lexicon.terms[e.termIndex]);
    }
  });

  it('gives the same replacements as a freshly built index on the whole benchmark corpus', () => {
    const lexicon = loadBenchLexicon();
    const { built, cached } = roundTrip(lexicon);
    for (const c of loadCorpus()) {
      expect(findReplacements(c.heard, cached!), c.id).toEqual(findReplacements(c.heard, built));
      expect(normalizeWithIndex(c.heard, cached!).output, c.id).toBe(normalize(c.heard, lexicon).output);
    }
  });

  it('returns undefined for anything that is not what serializeIndex wrote', () => {
    const { json } = roundTrip(RICH);
    const j = json as Record<string, unknown>;
    const variants: unknown[] = [
      null,
      42,
      'index',
      { ...j, v: INDEX_FORMAT_VERSION + 1 },
      { ...j, aliases: 'nope' },
      { ...j, never: (j.never as unknown[]).slice(1) },
      { ...j, hasExplicitAliases: [...(j.hasExplicitAliases as unknown[]), 1] },
      { ...j, aliases: [[RICH.terms.length, 'x', 0, 0, 0, 0, [], 1, 1]] },
      { ...j, aliases: [[0, 'x', 0, 0, 0, 0, [], 1]] },
      { ...j, aliases: [[0, 7, 0, 0, 0, 0, [], 1, 1]] },
      { ...j, aliases: [[0, 'x', 0, 0, 0, 0, ['a'], 1, 1]] },
      { ...j, aliases: [[0, 'x', 0, 0, 0, 0, [], 2, 1]] },
      { ...j, aliases: [[0, 'x', 0, 0, 0, 0, [], 1, 0]] },
      { ...j, phonetics: [[0, 'x', 'x', '', 0]] },
      { ...j, phonetics: [[-1, 'x', 'x', 'KS', 0]] },
      { ...j, minConfidence: 'high' },
      { ...j, protectedWords: [1] },
    ];
    for (const v of variants) expect(deserializeIndex(v, RICH)).toBeUndefined();
  });
});

describe('indexKey', () => {
  const key = (edit: (l: Lexicon) => void): string => {
    const copy = structuredClone(RICH);
    edit(copy);
    return indexKey(copy);
  };
  const base = indexKey(RICH);

  it('changes with everything buildIndex reads', () => {
    expect(key((l) => l.terms[0].aliases.push('Ashlur'))).not.toBe(base);
    expect(key((l) => (l.terms[0].canonical = 'Ashlr.ai'))).not.toBe(base);
    expect(key((l) => (l.terms[0].never = ['ash']))).not.toBe(base);
    expect(key((l) => (l.terms[1].caseSensitive = true))).not.toBe(base);
    expect(key((l) => l.terms.reverse())).not.toBe(base);
    expect(key((l) => l.terms.pop())).not.toBe(base);
    expect(key((l) => (l.settings!.minConfidence = 0.9))).not.toBe(base);
    expect(key((l) => (l.settings!.phonetic = false))).not.toBe(base);
    expect(key((l) => (l.settings!.fuzzy = false))).not.toBe(base);
    expect(key((l) => (l.settings!.skipCode = true))).not.toBe(base);
    expect(key((l) => l.settings!.protectedWords!.push('dude'))).not.toBe(base);
    expect(key((l) => delete l.settings)).not.toBe(base);
  });

  it('ignores what the matcher never reads, so a hit counter does not throw the cache away', () => {
    expect(key((l) => (l.terms[0].hits = 99))).toBe(base);
    expect(key((l) => (l.terms[0].notes = 'n'))).toBe(base);
    expect(key((l) => (l.terms[0].category = 'brand'))).toBe(base);
    expect(key((l) => (l.terms[0].scope = 'project'))).toBe(base);
  });

  it('is pinned to the code that builds the index: change that code, bump INDEX_FORMAT_VERSION', () => {
    // Everything buildIndex's output depends on. Any edit to these files can
    // change the index a lexicon compiles to, and a cached index from the old
    // code would then be read as current. When this fails: bump
    // INDEX_FORMAT_VERSION in src/core/matcher/serialize.ts if the change can
    // alter buildIndex's output (or the serialized shape), then record the new
    // version and digest below.
    const files = [
      'src/core/matcher/build.ts',
      'src/core/matcher/text.ts',
      'src/core/matcher/tuning.ts',
      'src/core/matcher/serialize.ts',
      'node_modules/double-metaphone/package.json',
    ];
    const hash = createHash('sha256');
    for (const f of files) {
      const text = readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n');
      // Only the version of the metaphone dependency matters, not its install metadata.
      hash.update(f.endsWith('package.json') ? String((JSON.parse(text) as { version: string }).version) : text);
    }
    expect({ version: INDEX_FORMAT_VERSION, digest: hash.digest('hex') }).toEqual(RECORDED);
  });
});

/** See the fingerprint test above. */
const RECORDED = { version: 2, digest: '1cc3f0f4c049faa2b9aad0da1f2350eefb411a04316f2fa2f99f0da3845a202c' };

describe('loadMatcherIndex', () => {
  let tmp: string;
  let globalPath: string;
  const cachePath = (): string => path.join(path.dirname(globalPath), INDEX_CACHE_FILE_NAME);

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-index-cache-')));
    globalPath = path.join(tmp, 'global', 'lexicon.yaml');
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const write = (lexicon: Lexicon) => writeLexiconFile({ path: globalPath, scope: 'global', lexicon, exists: false });
  const load = (cwd = tmp) => loadLexicon({ cwd, globalPath, env: {} });

  it('leaves a small lexicon uncached', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS - 1));
    const loaded = await load();
    expect(await loadMatcherIndex(loaded)).toEqual(buildIndex(loaded.merged));
    await expect(fs.stat(cachePath())).rejects.toThrow();
  });

  it('writes the index beside the global lexicon (0600), then reads it back instead of rebuilding', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const loaded = await load();
    const first = await loadMatcherIndex(loaded);
    expect(first).toEqual(buildIndex(loaded.merged));
    if (process.platform !== 'win32') expect((await fs.stat(cachePath())).mode & 0o777).toBe(0o600);

    // Proof the cached entry is what gets used: doctor an alias in it, keeping the key.
    const entry = JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { index: { aliases: unknown[][] } };
    const ashler = entry.index.aliases.find((t) => t[1] === 'Ashler')!;
    ashler[3] = 'doctored';
    ashler[5] = 'doctored';
    await fs.writeFile(cachePath(), JSON.stringify(entry));
    const again = await loadMatcherIndex(await load());
    expect(again.exact.get('doctored')?.[0].term.canonical).toBe('Ashlr.AI');
    expect(again.exact.get('ashler')).toBeUndefined();
  });

  it('rebuilds once the lexicon changes, and keeps the entry across hit-count changes', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    await loadMatcherIndex(await load());
    const before = await fs.readFile(cachePath(), 'utf8');

    // Hits live outside the key: the same entry serves.
    const withHits = await load();
    withHits.merged.terms[0].hits = 123;
    await loadMatcherIndex(withHits);
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(before);

    await write(bigLexicon(INDEX_CACHE_MIN_TERMS, [{ canonical: 'Vercel', aliases: ['versel'] }]));
    const changed = await load();
    const index = await loadMatcherIndex(changed);
    expect(index).toEqual(buildIndex(changed.merged));
    expect(normalizeWithIndex('deploy to versel', index).output).toBe('deploy to Vercel');
    expect(await fs.readFile(cachePath(), 'utf8')).not.toBe(before);
  });

  it('rebuilds from a corrupt, truncated, foreign or older entry and replaces it', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const loaded = await load();
    await loadMatcherIndex(loaded);
    const good = await fs.readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(good) as { version: number; key: string; index: Record<string, unknown> };
    const damaged = [
      '',
      '{ not json',
      good.slice(0, Math.floor(good.length / 2)),
      JSON.stringify({ ...parsed, version: parsed.version + 1 }),
      JSON.stringify({ ...parsed, key: 'other' }),
      JSON.stringify({ ...parsed, index: { ...parsed.index, aliases: [[99999, 'x', 0, 0, 0, 0, [], 1, 1]] } }),
      JSON.stringify({ ...parsed, index: null }),
    ];
    for (const text of damaged) {
      await fs.writeFile(cachePath(), text);
      expect(await loadMatcherIndex(loaded)).toEqual(buildIndex(loaded.merged));
      expect(await fs.readFile(cachePath(), 'utf8')).toBe(good);
    }
  });

  it('does not write when told not to', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    await loadMatcherIndex(await load(), { write: false });
    await expect(fs.stat(cachePath())).rejects.toThrow();
  });

  it('a global write refreshes an existing entry, so the next load reads it instead of rebuilding', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    await loadMatcherIndex(await load());
    const before = await fs.readFile(cachePath(), 'utf8');

    await write(bigLexicon(INDEX_CACHE_MIN_TERMS, [{ canonical: 'Vercel', aliases: ['versel'] }]));
    const after = await fs.readFile(cachePath(), 'utf8');
    expect(after).not.toBe(before);
    const loaded = await load();
    const entry = JSON.parse(after) as { version: number; key: string; index: unknown };
    expect(entry.version).toBe(INDEX_FORMAT_VERSION);
    expect(entry.key).toBe(indexKey(loaded.merged));
    expect(deserializeIndex(entry.index, loaded.merged)).toEqual(buildIndex(loaded.merged));
    if (process.platform !== 'win32') expect((await fs.stat(cachePath())).mode & 0o777).toBe(0o600);

    // The hook's load is a hit: it neither rebuilds nor rewrites the entry.
    const index = await loadMatcherIndex(loaded);
    expect(normalizeWithIndex('deploy to versel', index).output).toBe('deploy to Vercel');
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(after);
  });

  it('a write creates no entry where none was, and a small lexicon leaves the entry alone', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    await expect(fs.stat(cachePath())).rejects.toThrow();

    await loadMatcherIndex(await load());
    const before = await fs.readFile(cachePath(), 'utf8');
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS - 1));
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(before);
  });

  it('respects the trust gate and never writes into the project directory', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const projectPath = path.join(repo, '.lexicon.yaml');
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [{ canonical: 'Quuxly', aliases: ['kwuxly'] }] }, exists: false });

    // Untrusted: the project term is in neither the index nor its cache key.
    const untrusted = await load(repo);
    expect(untrusted.projectTrust).toBe('untrusted');
    const idx1 = await loadMatcherIndex(untrusted);
    expect(normalizeWithIndex('ping kwuxly', idx1).changed).toBe(false);
    expect(await fs.readFile(cachePath(), 'utf8')).not.toContain('Quuxly');

    // Trusted: merged, so a different key, and the entry is rebuilt with it.
    await trustProject(projectPath, { globalPath });
    const trusted = await load(repo);
    expect(trusted.projectTrust).toBe('trusted');
    const idx2 = await loadMatcherIndex(trusted);
    expect(normalizeWithIndex('ping kwuxly', idx2).output).toBe('ping Quuxly');
    expect(await fs.readFile(cachePath(), 'utf8')).toContain('Quuxly');

    // Untrusted again (file changed since trust): back to the global-only index.
    await fs.appendFile(projectPath, '# edited\n');
    const changed = await load(repo);
    expect(changed.projectTrust).toBe('changed');
    expect(normalizeWithIndex('ping kwuxly', await loadMatcherIndex(changed)).changed).toBe(false);

    const repoFiles = await fs.readdir(repo);
    expect(repoFiles.sort()).toEqual(['.git', '.lexicon.yaml']);
  });

  // Catches: one entry only, so alternating between two repos rebuilt the
  // index (about 55 ms for 2000 terms) on every switch.
  it('keeps up to CACHE_ENTRIES merges, least recently used out, and switches back without a rebuild', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const repos: { repo: string; projectPath: string }[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const repo = path.join(tmp, `repo-${name}`);
      await fs.mkdir(path.join(repo, '.git'), { recursive: true });
      const projectPath = path.join(repo, '.lexicon.yaml');
      await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [{ canonical: `Quux${name}`, aliases: [`kwux ${name}`] }] }, exists: false });
      await trustProject(projectPath, { globalPath });
      repos.push({ repo, projectPath });
    }
    const dir = path.dirname(globalPath);
    const spills = async (): Promise<string[]> => (await fs.readdir(dir)).filter((n) => /^index-cache\.[0-9a-f]{8}\.json$/.test(n)).sort();
    const spillOf = (projectPath: string): string => path.join(dir, `index-cache.${cacheChecksum(projectPath)}.json`);
    const mainProject = async (): Promise<string | undefined> => (JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string }).project;
    const prompt = async (i: number): Promise<void> => {
      const index = await loadMatcherIndex(await load(repos[i].repo));
      const name = 'abcde'[i];
      expect(normalizeWithIndex(`ping kwux ${name}`, index).output).toBe(`ping Quux${name}`);
      // Spill mtimes order the entries; keep them apart on a coarse clock.
      await new Promise((r) => setTimeout(r, 25));
    };

    await prompt(0);
    await prompt(1);
    expect(await mainProject()).toBe(repos[1].projectPath);
    expect(await spills()).toEqual([path.basename(spillOf(repos[0].projectPath))]);
    const spilled = await fs.stat(spillOf(repos[0].projectPath));
    const spilledText = await fs.readFile(spillOf(repos[0].projectPath), 'utf8');

    // Back in repo a: its entry is renamed into place, not rebuilt (a rebuild writes a new file).
    await prompt(0);
    const main = await fs.stat(cachePath());
    expect(main.ino).toBe(spilled.ino);
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(spilledText);
    expect(await spills()).toEqual([path.basename(spillOf(repos[1].projectPath))]);

    // Five repos: the least recently used (b, last used before c, d and e) is dropped.
    await prompt(2);
    await prompt(3);
    await prompt(4);
    expect(await mainProject()).toBe(repos[4].projectPath);
    expect(await spills()).toEqual([repos[0], repos[2], repos[3]].map((r) => path.basename(spillOf(r.projectPath))).sort());
    if (process.platform !== 'win32') {
      for (const f of [cachePath(), ...(await spills()).map((n) => path.join(dir, n))]) expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
    }
    // Nothing is ever written into a repo.
    for (const { repo } of repos) expect((await fs.readdir(repo)).sort()).toEqual(['.git', '.lexicon.yaml']);
  });

  it('validates a spill entry like the main one: a stale or damaged one is rebuilt, never used', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const repos: string[] = [];
    for (const name of ['a', 'b']) {
      const repo = path.join(tmp, `repo-${name}`);
      await fs.mkdir(path.join(repo, '.git'), { recursive: true });
      const projectPath = path.join(repo, '.lexicon.yaml');
      await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [{ canonical: `Quux${name}`, aliases: [`kwux ${name}`] }] }, exists: false });
      await trustProject(projectPath, { globalPath });
      repos.push(repo);
    }
    await loadMatcherIndex(await load(repos[0]));
    await loadMatcherIndex(await load(repos[1]));
    const spill = path.join(path.dirname(globalPath), `index-cache.${cacheChecksum(path.join(repos[0], '.lexicon.yaml'))}.json`);
    const good = await fs.readFile(spill, 'utf8');
    await fs.writeFile(spill, good.slice(0, Math.floor(good.length / 2)));
    const loaded = await load(repos[0]);
    expect(await loadMatcherIndex(loaded)).toEqual(buildIndex(loaded.merged));
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(good);
    // The damaged spill is gone, superseded by the rebuilt main entry.
    await expect(fs.stat(spill)).rejects.toThrow();
  });

  /** A repo with a trusted project lexicon, the way `lexicon trust` leaves it. */
  async function trustedRepo(terms: Lexicon['terms'] = [{ canonical: 'Quuxly', aliases: ['kwuxly'] }]): Promise<{ repo: string; projectPath: string }> {
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const projectPath = path.join(repo, '.lexicon.yaml');
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: { version: 1, terms }, exists: false });
    await trustProject(projectPath, { globalPath });
    return { repo, projectPath };
  }

  /** The hook's load in `cwd` is a hit: it neither rebuilds nor rewrites the entry. */
  async function expectHit(cwd: string, text: string, output?: string): Promise<void> {
    const before = await fs.readFile(cachePath(), 'utf8');
    const loaded = await load(cwd);
    const entry = JSON.parse(before) as { key: string; index: unknown; project?: string };
    expect(entry.key).toBe(indexKey(loaded.merged));
    expect(deserializeIndex(entry.index, loaded.merged)).toEqual(buildIndex(loaded.merged));
    const index = await loadMatcherIndex(loaded);
    if (output !== undefined) expect(normalizeWithIndex(text, index).output).toBe(output);
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(before);
  }

  // Catches: the entry was refreshed for the global lexicon alone, so with a
  // trusted project lexicon the first prompt after every write still rebuilt
  // the index (and the refresh had thrown the merged entry away for nothing).
  it('a global write refreshes an entry built with a trusted project for the same merge', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const { repo, projectPath } = await trustedRepo();
    await loadMatcherIndex(await load(repo));
    expect((JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string }).project).toBe(projectPath);

    await write(bigLexicon(INDEX_CACHE_MIN_TERMS, [{ canonical: 'Vercel', aliases: ['versel'] }]));
    const entry = JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string };
    expect(entry.project).toBe(projectPath);
    await expectHit(repo, 'ping kwuxly on versel', 'ping Quuxly on Vercel');
    expect(await fs.readdir(repo)).toEqual(expect.arrayContaining(['.git', '.lexicon.yaml']));
    expect((await fs.readdir(repo)).length).toBe(2);
  });

  it('a project write rebuilds the entry for the global lexicon merged with that file', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    await loadMatcherIndex(await load());
    const { repo, projectPath } = await trustedRepo();
    // trustedRepo's write came before the trust, so the entry is still global-only.
    await addTerm({ canonical: 'Hetzner', aliases: ['hets ner'] }, { cwd: repo, globalPath, env: {}, scope: 'project' });
    expect((JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string }).project).toBe(projectPath);
    await expectHit(repo, 'ping kwuxly on hets ner', 'ping Quuxly on Hetzner');

    await removeAlias('Hetzner', 'hets ner', { cwd: repo, globalPath, env: {}, scope: 'project' });
    await expectHit(repo, 'ping kwuxly');
    expect((await load(repo)).merged.terms.find((t) => t.canonical === 'Hetzner')?.aliases).toEqual([]);
    await removeTerm('Quuxly', { cwd: repo, globalPath, env: {}, scope: 'project' });
    await expectHit(repo, 'ping kwuxly', 'ping kwuxly');
  });

  it('leaves the entry alone for a project write the trust gate keeps out of the merge, and creates none', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    // No entry yet: a project write creates none.
    await addTerm({ canonical: 'Quuxly', aliases: ['kwuxly'] }, { cwd: repo, globalPath, env: {}, scope: 'project' });
    await expect(fs.stat(cachePath())).rejects.toThrow();

    await loadMatcherIndex(await load());
    const before = await fs.readFile(cachePath(), 'utf8');
    // Changed since it was trusted: the next write to it is left untrusted and out of the merge.
    await fs.appendFile(path.join(repo, '.lexicon.yaml'), '# edited\n');
    await addTerm({ canonical: 'Hetzner', aliases: ['hets ner'] }, { cwd: repo, globalPath, env: {}, scope: 'project', leaveUntrusted: true });
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(before);
  });

  it('a global write after the project lost its trust indexes the global lexicon alone', async () => {
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS));
    const { repo, projectPath } = await trustedRepo();
    await loadMatcherIndex(await load(repo));
    await fs.appendFile(projectPath, '# edited\n');
    await write(bigLexicon(INDEX_CACHE_MIN_TERMS, [{ canonical: 'Vercel', aliases: ['versel'] }]));
    expect((JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string }).project).toBeUndefined();
    await expectHit(repo, 'ping kwuxly on versel', 'ping kwuxly on Vercel');
  });
});

/**
 * Writes outside store.ts (pack install and uninstall, which the registry's
 * install, update and removal go through, `lexicon review` and `lexicon edit`)
 * must leave the index cache refreshed for the merge the hook matches next,
 * as addTerm does, so the first prompt after them is a hit.
 */
describe('index cache after writes outside store.ts', () => {
  let tmp: string;
  let globalPath: string;
  let repo: string;
  let projectPath: string;
  const cachePath = (): string => path.join(path.dirname(globalPath), INDEX_CACHE_FILE_NAME);
  const load = (cwd = repo) => loadLexicon({ cwd, globalPath, env: {} });

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-index-cache-writers-')));
    globalPath = path.join(tmp, 'global', 'lexicon.yaml');
    await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: bigLexicon(INDEX_CACHE_MIN_TERMS), exists: false });
    repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    projectPath = path.join(repo, '.lexicon.yaml');
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [{ canonical: 'Quuxly', aliases: ['kwuxly'] }] }, exists: false });
    await trustProject(projectPath, { globalPath });
    // The hook's first prompt in the repo: the entry now indexes the merge.
    await loadMatcherIndex(await load());
    expect((JSON.parse(await fs.readFile(cachePath(), 'utf8')) as { project?: string }).project).toBe(projectPath);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** The next load in `cwd` is a hit (no rebuild, no rewrite), and corrects `text` to `output`. */
  async function expectHit(text: string, output: string, cwd = repo): Promise<void> {
    const before = await fs.readFile(cachePath(), 'utf8');
    const loaded = await load(cwd);
    expect((JSON.parse(before) as { key: string }).key).toBe(indexKey(loaded.merged));
    expect(normalizeWithIndex(text, await loadMatcherIndex(loaded)).output).toBe(output);
    expect(await fs.readFile(cachePath(), 'utf8')).toBe(before);
  }

  const PACK: Pack = {
    name: 'cachetest',
    title: 'Cache test',
    description: 'One term.',
    version: 1,
    author: '',
    homepage: '',
    terms: 1,
    aliases: 1,
    path: '',
    lexicon: { version: 1, terms: [{ canonical: 'Hetzner', aliases: ['hets ner'] }] },
  };

  it('pack install and uninstall into a trusted project file', async () => {
    await installLoadedPack(PACK, 'cachetest', { cwd: repo, globalPath, scope: 'project' });
    await expectHit('ping kwuxly on hets ner', 'ping Quuxly on Hetzner');
    await uninstallLoadedPack(PACK, 'cachetest', { cwd: repo, globalPath, scope: 'project' });
    await expectHit('ping kwuxly on hets ner', 'ping Quuxly on hets ner');
  });

  const PACK_YAML = (extra = ''): string =>
    `name: cardiology\ntitle: Cardiology terms\ndescription: Heart words.\nversion: 1\nauthor: example\nhomepage: https://example.com/cardiology\nterms:\n  - canonical: Metoprolol\n    aliases: [metropolol]\n${extra}`;
  async function registryIndex(packYaml: string, version: string): Promise<string> {
    const packFile = path.join(tmp, 'cardiology.yaml');
    await fs.writeFile(packFile, packYaml);
    const indexPath = path.join(tmp, 'index.yaml');
    await fs.writeFile(
      indexPath,
      `version: 1\npacks:\n  - author: example\n    name: cardiology\n    title: Cardiology terms\n    description: Heart words.\n    version: "${version}"\n    terms: 1\n    aliases: 1\n    checksum: ${sha256Hex(Buffer.from(packYaml))}\n    url: ./cardiology.yaml\n`,
    );
    return indexPath;
  }

  it('registry install, update and removal in a trusted project file', async () => {
    const opts = { cwd: repo, globalPath, scope: 'project' as const };
    const indexPath = await registryIndex(PACK_YAML(), '1');
    const { index, base } = await loadRegistryIndex(indexPath);
    await installRegistryPack(findRegistryEntry(index, 'example/cardiology'), base, indexPath, opts);
    await expectHit('ping kwuxly about metropolol', 'ping Quuxly about Metoprolol');

    const index2 = await registryIndex(PACK_YAML('  - canonical: Stent\n    aliases: [stint]\n'), '2');
    const [preview] = await previewRegistryUpdates(['example/cardiology'], index2, opts);
    expect((await applyRegistryUpdate(preview, index2, opts)).status).toBe('updated');
    await expectHit('a stint for metropolol', 'a Stent for Metoprolol');

    await uninstallRegistryPack('example/cardiology', undefined, opts);
    await expectHit('a stint for metropolol', 'a stint for metropolol');
  });

  // Catches: refreshIndexCache reloaded the merge the entry indexes with the
  // default load, so a global write after that project file changed parsed it.
  it('a global write does not parse the project file the entry indexes once it is no longer trusted', async () => {
    await fs.appendFile(projectPath, '  - canonical: Injectedly\n    aliases: [injected lee]\n');
    expect((await load()).projectTrust).toBe('changed');
    schemaParses.canonicals.length = 0;
    await addTerm({ canonical: 'Vercel', aliases: ['versel'] }, { cwd: tmp, globalPath, scope: 'global' });
    expect(schemaParses.canonicals).toContain('Vercel');
    expect(schemaParses.canonicals).not.toContain('Injectedly');
    // The repo's prompt still leaves the changed file out.
    const loaded = await load();
    expect(normalizeWithIndex('deploy to versel with injected lee', await loadMatcherIndex(loaded)).output).toBe('deploy to Vercel with injected lee');
  });

  it('lexicon review --project', async () => {
    const io = makeIO();
    expect(await runReview({ cwd: repo, globalPath, project: true }, io, scripted(['d']))).toBe(0);
    expect(io.out).toContain('removed 1');
    await expectHit('ping kwuxly', 'ping kwuxly');
  });

  it('lexicon edit, of the project file and of the global file', async () => {
    const append = (extra: string): SpawnEditor => async (_cmd, _args, file) => {
      await fs.appendFile(file, extra);
      return 0;
    };
    expect(await runEdit({ cwd: repo, globalPath, project: true }, makeIO(), append('  - canonical: Hetzner\n    aliases: [hets ner]\n'), { EDITOR: 'fake' })).toBe(0);
    await expectHit('ping kwuxly on hets ner', 'ping Quuxly on Hetzner');

    // The global file, with the entry indexing the global lexicon alone.
    await loadMatcherIndex(await load(tmp));
    expect(await runEdit({ cwd: tmp, globalPath }, makeIO(), append('  - canonical: Vercel\n    aliases: [versel]\n'), { EDITOR: 'fake' })).toBe(0);
    await expectHit('deploy to versel', 'deploy to Vercel', tmp);
  });
});

describe('fuzzy buckets sorted by length', () => {
  it('are sorted, and the length window the fuzzy pass scans holds every entry the length check admits', async () => {
    const { firstAtLeast } = await import('../src/core/matcher/build.js');
    const index = buildIndex(loadBenchLexicon());
    for (const bucket of index.fuzzyBuckets.values()) {
      for (let i = 1; i < bucket.length; i++) expect(bucket[i - 1].normLower.length).toBeLessThanOrEqual(bucket[i].normLower.length);
      for (const m of [0, 0.01, 0.5, 0.8, 0.82, 0.85, 0.9, 0.95, 0.999, 1]) {
        for (let wlen = 1; wlen <= 60; wlen++) {
          const admitted = bucket.filter((e) => Math.abs(wlen - e.normLower.length) <= (1 - m) * Math.max(wlen, e.normLower.length));
          // The same bounds findBest uses (matcher.ts, fuzzy pass).
          const lowest = Math.floor(m * wlen) - 1;
          const highest = m > 0 ? Math.ceil(wlen / m) + 1 : Number.POSITIVE_INFINITY;
          const scanned: typeof bucket[number][] = [];
          for (let k = lowest > 0 ? firstAtLeast(bucket, lowest) : 0; k < bucket.length && bucket[k].normLower.length <= highest; k++) scanned.push(bucket[k]);
          for (const e of admitted) expect(scanned).toContain(e);
        }
      }
    }
  });
});
