import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestReport, harvestRepo } from '../src/core/harvest.js';

// HACK marker contract, per docs/harvest-markers.md: the marker is one exact
// uppercase literal in the generic identifier set, and a comment that carries
// it is scanned like any other text. These tests pin the edges of that
// contract the dedicated HACK suites do not already cover: a name before the
// marker inside one comment, a dot-TLD brand written inside the comment, the
// git-author path the generic set does not ban, the belowMinCount report
// field at the default threshold, and a ticket-style `HACK-123` suffix.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-hack-around-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('HACK marker with surrounding text', () => {
  it('drops the marker but keeps the names before and after it in one comment', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '/* OrbitRelay HACK: see QuartzLoader */\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual([
        { canonical: 'OrbitRelay', category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['note.ts'] },
        { canonical: 'QuartzLoader', category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['note.ts'] },
      ]);
    });
  });

  it('still proposes a dot-TLD brand written inside a HACK comment', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// HACK: move this to Quasar.AI\n');
      await fs.writeFile(path.join(repo, 'note.py'), '# HACK: move this to Quasar.AI\n');

      // The brand scan does not consult comments, markers, `symbols` or
      // `minCount`: a brand inside a marker comment is a candidate under the
      // default options, and the bare marker still is not.
      const candidates = await harvestRepo(repo, { git: false });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        canonical: 'Quasar.AI', category: 'brand', source: 'harvest:repo',
        count: 2, evidence: ['note.py', 'note.ts'],
      });
    });
  });

  it('proposes a commit author literally named HACK, matching the manifest and directory paths', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// HACK: revisit QuasarWidget\n');
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
        execFileSync('git', ['add', 'note.ts'], { cwd: repo, stdio: 'ignore' });
        execFileSync('git', [
          '-c', 'user.name=HACK', '-c', 'user.email=hack@example.com',
          'commit', '-q', '-m', 'marker author',
        ], { cwd: repo, stdio: 'ignore' });
      } catch {
        return; // no git here, so the marker-as-author path cannot be exercised
      }

      // The generic identifier set gates the source and prose scanners only;
      // git authors keep their own path, so the marker spelled as a person is
      // harvested exactly like HACK spelled as a crate or a directory name.
      const candidates = await harvestRepo(repo, { minCount: 1, symbols: true });
      expect(candidates.find(({ canonical }) => canonical === 'HACK')).toMatchObject({
        category: 'person', source: 'harvest:git', count: 1, evidence: ['git log'],
      });
      expect(candidates.find(({ canonical }) => canonical === 'QuasarWidget')).toMatchObject({
        category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['note.ts'],
      });
    });
  });

  it('reports a once-seen HACK-adjacent name under belowMinCount at the default threshold', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// HACK: revisit QuasarWidget\n');

      const held = await harvestReport(repo, { git: false });
      expect(held.candidates).toEqual([]);
      expect(held.symbolsOnly).toBe(1);
      expect(held.belowMinCount).toBe(0);

      const visible = await harvestReport(repo, { git: false, symbols: true });
      expect(visible.candidates).toEqual([]);
      expect(visible.symbolsOnly).toBe(0);
      expect(visible.belowMinCount).toBe(1);

      await fs.writeFile(path.join(repo, 'other.ts'), '// HACK: revisit QuasarWidget\n');
      const met = await harvestReport(repo, { git: false, symbols: true });
      expect(met.belowMinCount).toBe(0);
      expect(met.candidates).toHaveLength(1);
      expect(met.candidates[0]).toMatchObject({
        canonical: 'QuasarWidget', category: 'identifier', source: 'harvest:repo',
        count: 2, evidence: ['note.ts', 'other.ts'],
      });
    });
  });

  it('keeps every name in a multi-name HACK comment and ignores ticket suffixes', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(
        path.join(repo, 'multi.ts'),
        '// HACK(JIRA-42): CometRouter and DuskIndexer; HACK-123 HACK!\n',
      );
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      const names = candidates.map((c) => c.canonical);
      expect(names).toEqual(expect.arrayContaining(['CometRouter', 'DuskIndexer']));
      for (const n of names) expect(n).not.toMatch(/^HACK/);
    });
  });
});
