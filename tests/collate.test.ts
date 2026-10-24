/**
 * The learning pipeline orders text the same way whatever the user's locale.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareText } from '../src/core/collate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('compareText', () => {
  it('is a fixed collation, then code units', () => {
    expect(['Zeta', 'Äpple', 'apple'].sort(compareText)).toEqual(['apple', 'Äpple', 'Zeta']);
    expect(compareText('Café', 'Café')).not.toBe(0);
  });

  // Catches: stats, suggest_canonical, harvest and suggest_terms broke ties
  // with localeCompare and no locale, so under LC_ALL=sv_SE.UTF-8 `Äpple`
  // sorted after `Zeta` and the same lexicon listed in another order.
  it('stats and suggestCanonicalFor order ties the same under a Swedish locale', () => {
    const script = [
      "const core = await import('./src/core/index.ts');",
      "const terms = [{ canonical: 'Zeta', aliases: ['Zeda'], hits: 3 }, { canonical: 'Äpple', aliases: ['Zeda'], hits: 3 }];",
      "const lexicon = { version: 1, terms };",
      "const loaded = { merged: lexicon, global: { path: 'g', scope: 'global', lexicon, exists: true } };",
      "const top = core.computeStats(loaded).topTerms.map((t) => t.canonical);",
      "const near = core.suggestCanonicalFor('Zeda', lexicon).map((s) => s.term.canonical);",
      'console.log(JSON.stringify({ top, near }));',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      env: { ...process.env, LC_ALL: 'sv_SE.UTF-8', LANG: 'sv_SE.UTF-8' },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ top: ['Äpple', 'Zeta'], near: ['Äpple', 'Zeta'] });
  }, 30_000);

  // Catches: the trust list, the registry index and registry search sorted
  // with localeCompare and no locale, so under LC_ALL=lt_LT.UTF-8 (where `y`
  // sorts before `j`) or sv_SE (`Ä` after `Z`) the same files and packs
  // listed in another order.
  it('trust list, registry index and registry search order the same under Lithuanian and Swedish locales', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lexicon-collate-'));
    try {
      const lexiconPath = path.join(dir, 'lexicon.yaml');
      const zeta = path.join(dir, 'Zeta', '.lexicon.yaml');
      const apple = path.join(dir, 'Äpple', '.lexicon.yaml');
      const entry = { sha256: '0'.repeat(64), trustedAt: '2026-01-01T00:00:00.000Z' };
      writeFileSync(path.join(dir, 'trust.json'), JSON.stringify({ version: 1, trusted: { [zeta]: entry, [apple]: entry } }));
      const pack = (name: string): string => `  - { author: acme, name: ${name}, title: ${name}, terms: 1, aliases: 0, checksum: ${'a'.repeat(64)}, url: ${name}.yaml }`;
      const indexPath = path.join(dir, 'index.yaml');
      writeFileSync(indexPath, ['version: 1', 'packs:', pack('yak'), pack('jam')].join('\n') + '\n');
      const script = [
        "const core = await import('./src/core/index.ts');",
        `const trusted = (await core.listTrusted({ globalPath: ${JSON.stringify(lexiconPath)} })).map((e) => e.path);`,
        `const { index } = await core.loadRegistryIndex(${JSON.stringify(indexPath)});`,
        'const refs = index.packs.map((p) => p.ref);',
        "const found = core.searchRegistryIndex(index, 'acme').map((p) => p.ref);",
        'console.log(JSON.stringify({ trusted, refs, found }));',
      ].join('\n');
      const expected = { trusted: [apple, zeta], refs: ['acme/jam', 'acme/yak'], found: ['acme/jam', 'acme/yak'] };
      for (const locale of ['lt_LT.UTF-8', 'sv_SE.UTF-8']) {
        const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: repoRoot,
          env: { ...process.env, LC_ALL: locale, LANG: locale },
          encoding: 'utf8',
        });
        expect(run.status, run.stderr).toBe(0);
        expect(JSON.parse(run.stdout.trim()), locale).toEqual(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
