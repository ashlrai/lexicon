import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// The edges of NOTE recognition the dedicated suites do not pin. The marker
// is only a word the identifier and prose scans never match, so whether it
// is "recognized" depends on where text is scanned at all:
//
//   - the JS dialects of SOURCE_EXTENSIONS (.js, .jsx, .mjs, .tsx) behave
//     exactly like .ts, a JSX {/* */} comment included;
//   - README prose runs only after stripMarkdownNoise drops fenced and
//     inline code, so a NOTE inside a code span is never seen, while a NOTE
//     inside an HTML comment is scanned like any other prose line;
//   - the colon in `NOTE:` ends the sentence for the prose scan, so a name
//     directly after the colon is sentence-initial and held back, unlike a
//     `// NOTE:` comment in source, which suppresses nothing;
//   - non-README markdown is searched only for dot-TLD brands, so a plain
//     PascalCase name beside a NOTE there is not a candidate at all.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-note-edges-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('harvest NOTE marker in the JS dialects', () => {
  it.each([
    { file: 'marker.js', name: 'EmberCache', text: '/* NOTE: drain EmberCache */\nclass EmberCache {}\n' },
    { file: 'marker.jsx', name: 'SolarBridge', text: '// NOTE: pin SolarBridge\nexport function SolarBridge() { return null; }\n' },
    { file: 'marker.mjs', name: 'MeridianStore', text: '// NOTE: tune MeridianStore\nexport class MeridianStore {}\n' },
    { file: 'marker.tsx', name: 'QuasarWidget', text: '{/* NOTE: mount QuasarWidget last */}\nexport const QuasarWidget = () => null;\n' },
  ])('recognizes the NOTE comment in $file without proposing it', async ({ file, name, text }) => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, file), text);
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates).toEqual([
        expect.objectContaining({
          canonical: name,
          category: 'identifier',
          source: 'harvest:repo',
          count: 2,
          evidence: [file],
          suggestedAliases: [],
        }),
      ]);
    });
  });
});

describe('harvest NOTE marker in markdown forms', () => {
  it('never sees a NOTE inside fenced or inline code: the spans are stripped first', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), [
        '# Guide',
        '',
        'We use NebulaWidget in production.',
        '',
        '```ts',
        '// NOTE: QuasarWidget is deprecated',
        '```',
        '',
        'Inline `NOTE: PulsarWidget` here.',
      ].join('\n'));

      // Unlike a prose NOTE line, which keeps the rest of its sentence, the
      // marker and the names beside it inside code spans are removed before
      // the scan: only the real prose name is proposed.
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates).toEqual([
        expect.objectContaining({
          canonical: 'NebulaWidget',
          category: 'brand',
          source: 'harvest:repo',
          count: 1,
          evidence: ['README.md'],
        }),
      ]);
    });
  });

  it('scans a NOTE inside an HTML comment as prose', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'),
        '# Guide\n\n<!-- NOTE: keep QuasarWidget fast. -->\n');

      // stripMarkdownNoise removes code spans, links and headings, not HTML
      // comments, so the name inside the comment counts mid-sentence while
      // the marker still fails the capitalization pattern.
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates).toEqual([
        expect.objectContaining({
          canonical: 'QuasarWidget',
          category: 'brand',
          source: 'harvest:repo',
          count: 1,
          evidence: ['README.md'],
        }),
      ]);
    });
  });

  it('holds back a name directly after `NOTE:` in prose, unlike in a source comment', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'),
        'NOTE: QuasarWidget ships today.\nNOTE: keep PulsarWidget fast.\n');

      // The colon ends the sentence for the prose scan, so the name directly
      // after it is sentence-initial and held back; one word later the same
      // form counts. A `// NOTE:` comment in source suppresses nothing.
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates.map(({ canonical }) => canonical)).toEqual(['PulsarWidget']);
    });
  });

  it('searches non-README markdown for dot-TLD brands only', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'NOTES.md'),
        'NOTE: tune NebulaQueue. NOTE: try Quasar.AI today.\n');

      // A NOTES.md is not prose-scanned (only files matching /^readme/i are)
      // and markdown is not a source extension, so the plain PascalCase name
      // beside the marker is never seen; the dot-TLD brand is.
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates.map(({ canonical }) => canonical)).toEqual(['Quasar.AI']);
    });
  });
});
