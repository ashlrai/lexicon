import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestReport, harvestRepo } from '../src/core/harvest.js';

// Focused recognition checks for the `NOTE` marker in a source comment, per
// docs/harvest-marker-examples.md: the comment is scanned like any other
// text, so the name beside the marker is harvested and the marker itself is
// never a candidate in any casing. These pin the edges the dedicated NOTE
// suites do not already cover: the single documented line on its own, a
// dot-TLD brand inside the comment under default options, the belowMinCount
// report field at the default threshold, a CRLF file, and the git-author
// path the generic identifier set does not consult.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-note-recog-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('harvest NOTE marker recognition in a source comment', () => {
  it('harvests the documented example: CometWidget once, the marker never', async () => {
    await withRepo(async (repo) => {
      // The `// NOTE: CometWidget` row of docs/harvest-marker-examples.md.
      await fs.writeFile(path.join(repo, 'markers.ts'), '// NOTE: CometWidget\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        canonical: 'CometWidget',
        category: 'identifier',
        source: 'harvest:repo',
        count: 1,
        evidence: ['markers.ts'],
        suggestedAliases: [],
      });
    });
  });

  it('still proposes a dot-TLD brand written inside a NOTE comment', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// NOTE: move this to Quasar.AI\n');

      // The brand scan does not consult the marker set, `symbols` or
      // `minCount`: a brand inside a marker comment is a candidate under the
      // default options, and the bare marker still is not.
      const candidates = await harvestRepo(repo, { git: false });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        canonical: 'Quasar.AI', category: 'brand', source: 'harvest:repo',
        count: 1, evidence: ['note.ts'],
      });
    });
  });

  it('reports a once-seen NOTE-adjacent name under belowMinCount at the default threshold', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// NOTE: revisit QuasarWidget\n');

      const held = await harvestReport(repo, { git: false });
      expect(held.candidates).toEqual([]);
      expect(held.symbolsOnly).toBe(1);
      expect(held.belowMinCount).toBe(0);

      const visible = await harvestReport(repo, { git: false, symbols: true });
      expect(visible.candidates).toEqual([]);
      expect(visible.symbolsOnly).toBe(0);
      expect(visible.belowMinCount).toBe(1);

      await fs.writeFile(path.join(repo, 'more.ts'), '// NOTE: revisit QuasarWidget\n');
      const met = await harvestReport(repo, { git: false, symbols: true });
      expect(met.belowMinCount).toBe(0);
      expect(met.candidates).toHaveLength(1);
      expect(met.candidates[0]).toMatchObject({
        canonical: 'QuasarWidget', category: 'identifier', source: 'harvest:repo',
        count: 2, evidence: ['more.ts', 'note.ts'],
      });
    });
  });

  it('recognizes the marker in a CRLF source file', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'crlf.ts'), '// NOTE: retry PulsarGate\r\nexport const a = 1;\r\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates.map((c) => c.canonical)).toEqual(['PulsarGate']);
    });
  });

  it('proposes a commit author literally named NOTE, matching the manifest and directory paths', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// NOTE: revisit QuasarWidget\n');
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
        execFileSync('git', ['add', 'note.ts'], { cwd: repo, stdio: 'ignore' });
        execFileSync('git', [
          '-c', 'user.name=NOTE', '-c', 'user.email=note@example.com',
          'commit', '-q', '-m', 'marker author',
        ], { cwd: repo, stdio: 'ignore' });
      } catch {
        return; // no git here, so the marker-as-author path cannot be exercised
      }

      // The generic identifier set gates the source and prose scanners only;
      // git authors keep their own path, so the marker spelled as a person is
      // harvested exactly like NOTE spelled as a crate or a directory name.
      const candidates = await harvestRepo(repo, { minCount: 1, symbols: true });
      expect(candidates.find(({ canonical }) => canonical === 'NOTE')).toMatchObject({
        category: 'person', source: 'harvest:git', count: 1, evidence: ['git log'],
      });
      expect(candidates.find(({ canonical }) => canonical === 'QuasarWidget')).toMatchObject({
        category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['note.ts'],
      });
    });
  });
});
