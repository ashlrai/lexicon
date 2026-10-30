/**
 * Regression coverage for the Sonar findings of RQ-LEXSONAR7Q8:
 *
 * - S2871: every `.sort()` the findings named now passes an explicit
 *   comparator. `compareText` (src/core/collate.ts) orders UTF-16 code units
 *   after a fixed `en` collation, so the result is the same on every machine;
 *   the plain scripts spell the same order out inline.
 * - S2189: the yaml lexer bundled into plugin/hook-main.mjs looped on
 *   parameters nothing in the loop wrote (`incomplete`, `allowTabs`).
 *   hookBundleFixes rewrites both loops in the build; these tests pin the
 *   bundle's new shape and that it still parses.
 * - S5852: the two harvest regexes folded an unbounded `(?:[A-Z][a-zA-Z0-9]*)`
 *   inside an unbounded group; a run of capitals backtracked exponentially.
 *   The rewritten regexes match the same language linearly.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harvestRepo } from '../src/core/harvest.js';
import { importPreviewDigest } from '../src/core/import-preview.js';
import { listPacks } from '../src/core/packs.js';
import { REGISTRIES_ENV, installedRegistryPacks, userRegistrySources, writeRegistryState } from '../src/core/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp: string;

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-sonar-q8-')));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('explicit sort comparators (S2871)', () => {
  it('listPacks returns packs in comparator order, not readdir order', async () => {
    const dir = path.join(tmp, 'packs');
    await fs.mkdir(dir, { recursive: true });
    for (const name of ['zeta', 'mango', 'alpha']) {
      await fs.writeFile(
        path.join(dir, `${name}.yaml`),
        `name: ${name}\ntitle: ${name}\nterms:\n  - canonical: ${name}Tool\n    aliases: [${name} tool]\n`,
      );
    }
    const packs = await listPacks({ dir });
    expect(packs.map((p) => p.name)).toEqual(['alpha', 'mango', 'zeta']);
  });

  it('installedRegistryPacks returns refs sorted by the explicit comparator', async () => {
    const home = path.join(tmp, 'home-reg');
    const installed = { checksum: 'a'.repeat(64), version: '1.0.0', indexSource: 'https://index.example/i.json', installedAt: '2026-01-01T00:00:00Z' };
    await writeRegistryState(
      { packs: { 'zeta/tool': installed, 'alpha/tool': installed, 'mango/tool': installed } },
      { home },
    );
    expect(await installedRegistryPacks({ home })).toEqual(['alpha/tool', 'mango/tool', 'zeta/tool']);
  });

  it('userRegistrySources canonicalises, dedupes and orders sources', async () => {
    const home = path.join(tmp, 'home-src');
    const env = {
      [REGISTRIES_ENV]: 'https://b.example/x.json, https://z.example, https://a.example/x.json\nhttps://b.example/x.json',
    };
    expect(await userRegistrySources({ home, env })).toEqual([
      'https://a.example/x.json',
      'https://b.example/x.json',
      'https://z.example/',
    ]);
  });

  it('importPreviewDigest does not depend on the order the sources were passed in', () => {
    const forward = importPreviewDigest(['b-src', 'a-src'], [], 'global');
    const backward = importPreviewDigest(['a-src', 'b-src'], [], 'global');
    const duplicated = importPreviewDigest(['a-src', 'a-src', 'b-src'], [], 'global');
    expect(forward).toBe(backward);
    expect(duplicated).toBe(forward);
    expect(importPreviewDigest(['a-src'], [], 'global')).not.toBe(forward);
  });

  it('the files the findings named keep no implicit alphabetical sort', async () => {
    const files = [
      'scripts/check-facts.mjs',
      'scripts/check-crypto.mjs',
      'src/cli/cmd-review.ts',
      'src/core/import-preview.ts',
      'src/core/packs.ts',
      'src/core/registry.ts',
      'src/mcp/tools/packs.ts',
      'web/scripts/check-seo.mjs',
    ];
    for (const rel of files) {
      const src = await fs.readFile(path.join(root, rel), 'utf8');
      expect(src, `${rel} calls .sort() with no comparator`).not.toMatch(/\.sort\(\s*\)/);
    }
  });
});

describe('bundled lexer loop conditions (S2189)', () => {
  it('plugin/hook-main.mjs no longer loops on a variable the loop never writes', async () => {
    const bundle = await fs.readFile(path.join(root, 'plugin/hook-main.mjs'), 'utf8');
    expect(bundle).not.toMatch(/while \(next && \(incomplete \|\| this\.hasChars\(1\)\)\)/);
    expect(bundle).not.toMatch(/\} while \(ch === ["'] ["'] \|\| \(allowTabs && ch === ["']\t["']\)\)/);
    expect(bundle).toMatch(/while \(next\) \{\s+if \(!incomplete && !this\.hasChars\(1\)\)/);
  });

  it('the patched lexer still parses the lexicon end to end', async () => {
    const home = path.join(tmp, 'hook-home');
    const lexicon = path.join(home, 'lexicon.yaml');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(lexicon, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
    // SessionStart reads and parses the lexicon into the claude-md table. A
    // UserPromptSubmit run would also work, but its 100 ms match budget is
    // wall-clock and can expire while the rest of the suite saturates the box.
    const out = execFileSync(process.execPath, [path.join(root, 'plugin/hook-main.mjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: home }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, LEXICON_PATH: lexicon },
    });
    expect(out).toMatch(/Ashlr\.AI/);
  });
});

describe('harvest regexes (S5852)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(tmp, 'regex-repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(
      path.join(repo, 'identifiers.ts'),
      [
        'class LexiconStore {}',
        'const Te2T3x = 1;',
        'let QuadEftAxon;',
        'WexaCorpOne(); RroVarKex();',
        // One hump only, and a name with no word boundary before its capital:
        // neither ever matched, and neither may match now.
        'class Lexicon {}',
        'const getLexiconStore = 0;',
        // A run of capitals backtracked exponentially on the old nested
        // quantifiers; it must stay a cheap non-match.
        `const bait = "Aa${'A'.repeat(4000)}_";`,
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(repo, 'README.md'),
      '# notes\nThe QuadEftAxon tool wraps OpenClawName; QuadEftAxon again.\n',
    );
  });

  it('PascalCase identifiers are still found, in linear time', async () => {
    const candidates = await harvestRepo(repo, { minCount: 1, symbols: true, git: false });
    const names = candidates.map((c) => c.canonical);
    expect(names).toEqual(expect.arrayContaining(['LexiconStore', 'Te2T3x', 'QuadEftAxon', 'WexaCorpOne', 'RroVarKex']));
    expect(names).not.toContain('Lexicon');
    expect(names).not.toContain('getLexiconStore');
    expect(names).not.toContain('bait');
  });

  it('README proper nouns still see inner capitals across humps', async () => {
    const candidates = await harvestRepo(repo, { minCount: 1, git: false });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('OpenClawName');
    // Seen in the README and in source: the two bumps share one candidate.
    expect(candidates.find((c) => c.canonical === 'QuadEftAxon')?.count).toBeGreaterThanOrEqual(3);
  });
});
