import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Alias generation is suggest.ts's job and has its own suite. The stub is
// deterministic and offers every name one suggestion with a space in it and one
// without, so these tests measure the only alias decision harvestRepo makes:
// which candidates are allowed to carry a guessed word boundary at all.
vi.mock('../src/core/suggest.js', () => ({
  suggestAliases: (canonical: string): string[] => [`${canonical} spaced`, `${canonical}tight`],
}));

import { HARVEST_MAX_FILES, harvestReport, harvestRepo, harvestTruncatedNote, HARVEST_STOPLIST } from '../src/core/harvest.js';
import { runHarvest } from '../src/cli/commands.js';
import { createServer } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeIO } from './helpers.js';
import type { HarvestCandidate } from '../src/core/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-repo');

let tmp: string;
let repo: string;
let hasGit = true;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-harvest-')));
  repo = path.join(tmp, 'openclaw-repo');
  await fs.cp(FIXTURE, repo, { recursive: true });
  try {
    git(['init', '-q'], repo);
    git(['-c', 'user.name=Mason Wyatt', '-c', 'user.email=mason@example.com', 'commit', '-q', '--allow-empty', '-m', 'one'], repo);
    git(['-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.com', 'commit', '-q', '--allow-empty', '-m', 'two'], repo);
    git(['-c', 'user.name=Mason Wyatt', '-c', 'user.email=mason@example.com', 'commit', '-q', '--allow-empty', '-m', 'three'], repo);
  } catch {
    hasGit = false;
  }
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function byName(candidates: HarvestCandidate[], name: string): HarvestCandidate | undefined {
  return candidates.find((c) => c.canonical.toLowerCase() === name.toLowerCase());
}

describe('harvestRepo', () => {
  it('finds the package name, classes, brands, authors and directory name', async () => {
    const candidates = await harvestRepo(repo);
    const names = candidates.map((c) => c.canonical);

    const pkg = byName(candidates, 'openclaw');
    expect(pkg).toBeDefined();
    // First-seen spelling wins: README "OpenClaw" is seen before package.json#name? No —
    // directory name is bumped first, but it is "openclaw-repo"; package.json comes
    // first in the walk (sorted), so the bare package name spelling wins.
    expect(pkg?.canonical).toBe('openclaw');
    expect(pkg?.category).toBe('product');
    expect(pkg?.evidence).toContain('package.json#name');
    // Counted across package.json, README, TS and Python sources.
    expect(pkg?.count).toBeGreaterThanOrEqual(4);
    expect(pkg?.evidence.length).toBeLessThanOrEqual(5);

    // LexiconStore is only ever a symbol in source, so it is not proposed:
    // a name nothing outside the code mentions is something you type.
    expect(byName(candidates, 'LexiconStore')).toBeUndefined();
    // OpenClaw is the same shape but the README names it, so it survives, and
    // source still counts towards it.
    const claw = byName(candidates, 'OpenClaw');
    expect(claw?.count).toBeGreaterThanOrEqual(2);
    expect(claw?.evidence.some((e) => e.endsWith('claw.ts'))).toBe(true);

    const brand = byName(candidates, 'Ashlr.AI');
    expect(brand?.category).toBe('brand');
    expect(brand?.count).toBe(2);

    // README proper noun with count >= 2 (not at sentence start).
    expect(byName(candidates, 'Superwhisper')?.category).toBe('brand');

    // Scope of the package name.
    expect(byName(candidates, 'ashlr')?.category).toBe('brand');

    // Directory name always passes.
    expect(byName(candidates, 'openclaw-repo')?.category).toBe('product');

    // Dependency names only appear once in the manifest, so the default minCount hides them.
    expect(names).not.toContain('sdk');
    expect(byName(candidates, 'modelcontextprotocol')).toBeUndefined();
    expect(byName(candidates, 'fastest-levenshtein')).toBeUndefined();

    // Generic identifiers are filtered.
    expect(names).not.toContain('TypeError');
    expect(names).not.toContain('HTMLElement');
    // Single-hump PascalCase words are not identifiers.
    expect(byName(candidates, 'String')).toBeUndefined();

    if (hasGit) {
      const mason = byName(candidates, 'Mason Wyatt');
      expect(mason?.category).toBe('person');
      expect(mason?.source).toBe('harvest:git');
      expect(mason?.evidence).toEqual(['git log']);
      expect(mason?.count).toBe(1); // deduped
      expect(byName(candidates, 'Ada Lovelace')?.category).toBe('person');
    }

    for (const c of candidates) {
      expect(c.count).toBeGreaterThanOrEqual(1);
    }
  });

  it('only proposes names with evidence outside the source, unless symbols is set', async () => {
    const corroborated = await harvestRepo(repo, { minCount: 1 });
    expect(corroborated.map((c) => c.canonical)).not.toContain('LexiconStore');
    expect(corroborated.map((c) => c.canonical)).not.toContain('SnakeHelper');
    // First-seen spelling wins, and package.json comes before the README in the walk.
    expect(corroborated.map((c) => c.canonical)).toContain('openclaw');

    const withSymbols = await harvestRepo(repo, { minCount: 1, symbols: true });
    expect(byName(withSymbols, 'LexiconStore')?.category).toBe('identifier');
    expect(byName(withSymbols, 'LexiconStore')?.count).toBeGreaterThanOrEqual(2);
    expect(byName(withSymbols, 'SnakeHelper')?.count).toBe(1);
    // Still nothing generic, and still nothing out of node_modules.
    expect(byName(withSymbols, 'TypeError')).toBeUndefined();
    expect(byName(withSymbols, 'IgnoredVendorThing')).toBeUndefined();
  });

  it('never guesses a word boundary a name does not already have', async () => {
    const candidates = await harvestRepo(repo, { minCount: 1, symbols: true });

    // "Ashlr.AI" says where its words break, so the spaced spelling is the
    // user's own and speech-to-text really does write it that way.
    expect(byName(candidates, 'Ashlr.AI')?.suggestedAliases).toEqual(['Ashlr.AI spaced', 'Ashlr.AItight']);
    // "openclaw" does not, so a spaced alias would be our invention, and an
    // invented word boundary is what rewrites ordinary prose.
    expect(byName(candidates, 'openclaw')?.suggestedAliases).toEqual(['openclawtight']);
    // A code symbol gets no aliases at all, whatever its shape.
    expect(byName(candidates, 'LexiconStore')?.suggestedAliases).toEqual([]);
    expect(byName(candidates, 'fastest-levenshtein')?.suggestedAliases).toEqual([]);

    if (hasGit) {
      expect(byName(candidates, 'Mason Wyatt')?.suggestedAliases).toEqual(['Mason Wyatt spaced', 'Mason Wyatttight']);
    }
  });

  // Catches: only a fixed list of directories was skipped, so a repo's
  // gitignored build output was scanned and its names proposed.
  it('leaves out what .gitignore leaves out, in a git work tree', async () => {
    if (!hasGit) return;
    const dir = path.join(tmp, 'ignore-repo');
    await fs.mkdir(path.join(dir, 'out'), { recursive: true });
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, '.gitignore'), 'out/\n*.gen.md\n');
    await fs.writeFile(path.join(dir, 'out', 'notes.md'), 'Built with Hiddenbrand.io and Hiddenbrand.io again.\n');
    await fs.writeFile(path.join(dir, 'docs', 'api.gen.md'), 'See Genbrand.io and Genbrand.io.\n');
    await fs.writeFile(path.join(dir, 'docs', 'guide.md'), 'Deploy to Visiblebrand.io, then Visiblebrand.io.\n');
    git(['init', '-q'], dir);
    const found = (await harvestRepo(dir, { git: false, minCount: 1 })).map((c) => c.canonical);
    expect(found).toContain('Visiblebrand.io');
    expect(found).not.toContain('Hiddenbrand.io');
    expect(found).not.toContain('Genbrand.io');
    // Outside a work tree the walk still scans everything but its fixed list.
    await fs.rm(path.join(dir, '.git'), { recursive: true, force: true });
    const walked = (await harvestRepo(dir, { git: false, minCount: 1 })).map((c) => c.canonical);
    expect(walked).toContain('Hiddenbrand.io');
  });

  it('ignores node_modules', async () => {
    // Assert the fixture is really there before asserting it was skipped.
    // It lives under a `node_modules/` path, so a contributor's *global*
    // gitignore hid it from `git add` and it was never committed: CI cloned a
    // fixture with no vendored file, harvest had nothing to skip, and this
    // test passed without testing anything for as long as it has existed.
    // Now tracked (git add -f), and this check fails loudly if it goes again.
    const vendored = path.join(repo, 'node_modules', 'somepkg', 'index.js');
    const body = await fs.readFile(vendored, 'utf8');
    expect(body).toContain('IgnoredVendorThing');

    const candidates = await harvestRepo(repo, { minCount: 1, symbols: true });
    expect(byName(candidates, 'IgnoredVendorThing')).toBeUndefined();
    expect(byName(candidates, 'IgnoredVendorThing2')).toBeUndefined();
  });

  it('respects minCount=1 to surface single occurrences', async () => {
    const candidates = await harvestRepo(repo, { minCount: 1 });
    expect(byName(candidates, 'fastest-levenshtein')?.category).toBe('identifier');
    // Scoped dependency: generic bare name "sdk" is skipped, the scope is kept with evidence.
    expect(candidates.map((c) => c.canonical)).not.toContain('sdk');
    const scope = byName(candidates, 'modelcontextprotocol');
    expect(scope?.category).toBe('identifier');
    expect(scope?.evidence[0]).toBe('package.json#dependencies (@modelcontextprotocol/sdk)');
    expect(byName(candidates, 'zod')).toBeUndefined(); // shorter than 4 chars
  });

  it('sorts by count desc then canonical and respects limit', async () => {
    const all = await harvestRepo(repo, { minCount: 1, symbols: true });
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      expect(prev.count >= cur.count).toBe(true);
      if (prev.count === cur.count) {
        expect(prev.canonical.localeCompare(cur.canonical) <= 0).toBe(true);
      }
    }
    const limited = await harvestRepo(repo, { minCount: 1, limit: 2, symbols: true });
    expect(limited).toHaveLength(2);
    expect(limited).toEqual(all.slice(0, 2));
  });

  it('honours git/packages/identifiers switches and extra ignores', async () => {
    const noGit = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(byName(noGit, 'Mason Wyatt')).toBeUndefined();

    const noPkg = await harvestRepo(repo, { packages: false, minCount: 1 });
    expect(byName(noPkg, 'modelcontextprotocol')).toBeUndefined();

    // identifiers: false stops the source scan entirely, so symbols cannot even
    // corroborate a name: OpenClaw is left with its README and manifest count.
    const noIdent = await harvestRepo(repo, { identifiers: false, minCount: 1, symbols: true });
    expect(byName(noIdent, 'LexiconStore')).toBeUndefined();
    expect(byName(noIdent, 'OpenClaw')?.evidence.some((e) => e.endsWith('claw.ts'))).toBe(false);

    const ignored = await harvestRepo(repo, { ignore: ['scripts'], minCount: 1, symbols: true });
    expect(byName(ignored, 'SnakeHelper')).toBeUndefined();
  });

  it('skips git gracefully when the directory is not a repo', async () => {
    const plain = path.join(tmp, 'plain');
    await fs.mkdir(path.join(plain, 'src'), { recursive: true });
    await fs.writeFile(path.join(plain, 'src', 'a.ts'), 'class FooBarBaz {}\nnew FooBarBaz();\n');
    const candidates = await harvestRepo(plain, { symbols: true });
    expect(candidates.every((c) => c.category !== 'person')).toBe(true);
    expect(byName(candidates, 'FooBarBaz')?.count).toBe(2);
  });

  it('does not read module paths like ./Button.js as brands', async () => {
    const web = path.join(tmp, 'web-paths');
    await fs.mkdir(path.join(web, 'src'), { recursive: true });
    const imports = [
      "import { Button } from './components/Button.js';",
      "import { Toast } from '../ui/Toast.js';",
      "import { Dialog } from 'C:\\\\app\\\\Dialog.js';",
      '// Built on Next.js and Node.js, shipped by Ashlr.AI.',
    ].join('\n');
    for (const name of ['a.tsx', 'b.tsx']) await fs.writeFile(path.join(web, 'src', name), imports + '\n');
    const candidates = await harvestRepo(web, { minCount: 1 });
    expect(byName(candidates, 'Button.js')).toBeUndefined();
    expect(byName(candidates, 'Toast.js')).toBeUndefined();
    expect(byName(candidates, 'Dialog.js')).toBeUndefined();
    expect(byName(candidates, 'Next.js')?.category).toBe('brand');
    expect(byName(candidates, 'Node.js')?.count).toBe(2);
    expect(byName(candidates, 'Ashlr.AI')?.count).toBe(2);
  });

  it('holds back README labels: table cells, list items, bold and quoted spans, key chords', async () => {
    const docs = path.join(tmp, 'readme-labels');
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'README.md'), [
      'We deploy on Hetzner because the bill stays low and Hetzner is quick.',
      '| Action | Result |',
      '| --- | --- |',
      '| Choose | Opens the picker |',
      '- Closing the window hides it.',
      'Click **Open Anyway** on first launch, then wait for the "Finished" banner.',
      'Press ⌃⌥Space to focus the app.',
      'The bundle is assets/index-D2P1AJiD.js and it ships fast.',
    ].join('\n'));
    const candidates = await harvestRepo(docs, { minCount: 1 });
    expect(byName(candidates, 'Hetzner')?.count).toBe(2);
    for (const label of ['Choose', 'Closing', 'Anyway', 'Finished', 'Space', 'D2P1AJiD.js']) {
      expect(byName(candidates, label), label).toBeUndefined();
    }
  });

  it('skips everyday English words capitalised in a README, keeps names that double as words', async () => {
    const docs = path.join(tmp, 'readme-common');
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'README.md'), [
      'The app has a Leader view, a Resources tab and a Growth chart.',
      'Open the Leader view, then the Resources tab, then the Growth chart.',
      'We run Hetzner boxes and ship through Railway; Hetzner and Railway are cheap.',
      'It plans with ReAct loops, and ReAct keeps them short.',
    ].join('\n'));
    const candidates = await harvestRepo(docs, { minCount: 1 });
    for (const word of ['Leader', 'Resources', 'Growth']) expect(byName(candidates, word), word).toBeUndefined();
    expect(byName(candidates, 'Hetzner')?.count).toBe(2);
    expect(byName(candidates, 'Railway')?.count).toBe(2);
    expect(byName(candidates, 'ReAct')?.count).toBe(2);
  });

  it('throws for a missing directory', async () => {
    await expect(harvestRepo(path.join(tmp, 'missing'))).rejects.toThrow(/not a directory/);
  });

  it('exposes a stoplist of capitalized filler words', () => {
    expect(HARVEST_STOPLIST.has('The')).toBe(true);
    expect(HARVEST_STOPLIST.has('Install')).toBe(true);
    expect(HARVEST_STOPLIST.size).toBeGreaterThan(150);
  });
});

describe('directory-name candidate', () => {
  it('does not propose a one- or two-letter directory name like "w"', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-harvest-short-')));
    try {
      for (const name of ['w', 'x2', 'ab']) {
        const dir = path.join(base, name);
        await fs.mkdir(dir);
        const found = await harvestRepo(dir, { git: false });
        expect(found.map((c) => c.canonical)).not.toContain(name);
      }
      const named = path.join(base, 'Zed');
      await fs.mkdir(named);
      expect((await harvestRepo(named, { git: false })).map((c) => c.canonical)).toContain('Zed');
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('harvestReport', () => {
  // Catches: the walk stopped at 5000 files and set `truncated`, but nothing
  // reported it, so a large monorepo looked fully scanned on the CLI and MCP.
  it('reports a scan cut at HARVEST_MAX_FILES, on the CLI text, --full and MCP', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-harvest-cap-')));
    try {
      const dir = path.join(base, 'Bigrepo');
      await fs.mkdir(dir);
      await Promise.all(Array.from({ length: HARVEST_MAX_FILES + 1 }, (_, i) => fs.writeFile(path.join(dir, `n${String(i).padStart(5, '0')}.md`), 'x\n')));
      const report = await harvestReport(dir, { git: false });
      expect(report).toMatchObject({ truncated: true, filesScanned: HARVEST_MAX_FILES });

      const text = makeIO();
      expect(await runHarvest(dir, {}, text, { isInteractive: () => false })).toBe(0);
      expect(text.out).toContain(`warn: ${harvestTruncatedNote(dir)}`);
      expect(harvestTruncatedNote(dir)).toContain(`stopped after the first ${HARVEST_MAX_FILES} files under ${dir}`);

      const full = makeIO();
      expect(await runHarvest(dir, { full: true }, full, { isInteractive: () => false })).toBe(0);
      expect(JSON.parse(full.out)).toMatchObject({ ok: true, truncated: true, note: harvestTruncatedNote(dir) });

      const bare = makeIO();
      expect(await runHarvest(dir, { json: true }, bare, { isInteractive: () => false })).toBe(0);
      expect(Array.isArray(JSON.parse(bare.out))).toBe(true);
      expect(bare.err).toContain(harvestTruncatedNote(dir));

      const server = createServer({ cwd: dir });
      const client = new Client({ name: 'test', version: '0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const res = (await client.callTool({ name: 'harvest_repo', arguments: {} })) as { content: { text: string }[] };
        expect(JSON.parse(res.content[0].text)).toMatchObject({ truncated: true, note: harvestTruncatedNote(dir) });
      } finally {
        await client.close();
      }

      const small = await harvestReport(path.join(repo, 'src'), { git: false });
      expect(small.truncated).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 60_000);

  // Catches: gitAuthors ran `git log` in the root, which for a directory
  // below the top of a work tree read the whole enclosing repo's log, so a
  // subdirectory, or one git does not track, proposed every author of it.
  it.skipIf(!hasGitBinary())('names only the authors of commits that touch a subdirectory root', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-harvest-authors-')));
    try {
      const top = path.join(base, 'Monorepo');
      const sub = path.join(top, 'packages', 'widget');
      const plain = path.join(top, 'scratch');
      await fs.mkdir(sub, { recursive: true });
      await fs.mkdir(plain);
      const commit = (name: string, file: string): void => {
        git(['add', file], top);
        git(['-c', `user.name=${name}`, '-c', 'user.email=x@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', name], top);
      };
      git(['init', '-q'], top);
      await fs.writeFile(path.join(top, 'notes.txt'), 'top\n');
      commit('Mason Wyatt', 'notes.txt');
      await fs.writeFile(path.join(sub, 'index.ts'), 'export const a = 1;\n');
      commit('Ada Lovelace', path.join('packages', 'widget', 'index.ts'));
      await fs.writeFile(path.join(plain, 'notes.txt'), 'untracked\n');

      const people = async (root: string): Promise<string[]> =>
        (await harvestRepo(root)).filter((c) => c.source === 'harvest:git').map((c) => c.canonical).sort();
      expect(await people(top)).toEqual(['Ada Lovelace', 'Mason Wyatt']);
      expect(await people(sub)).toEqual(['Ada Lovelace']);
      expect(await people(plain)).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

function hasGitBinary(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
