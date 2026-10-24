/**
 * The learning pipeline orders text the same way whatever the user's locale.
 */
import { spawnSync } from 'node:child_process';
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
});
