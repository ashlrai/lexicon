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

import { harvestRepo, HARVEST_STOPLIST } from '../src/core/harvest.js';
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

  it('throws for a missing directory', async () => {
    await expect(harvestRepo(path.join(tmp, 'missing'))).rejects.toThrow(/not a directory/);
  });

  it('exposes a stoplist of capitalized filler words', () => {
    expect(HARVEST_STOPLIST.has('The')).toBe(true);
    expect(HARVEST_STOPLIST.has('Install')).toBe(true);
    expect(HARVEST_STOPLIST.size).toBeGreaterThan(150);
  });
});
