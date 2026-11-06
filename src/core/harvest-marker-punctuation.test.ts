/**
 * Markers (TODO, FIXME, NOTE, HACK, XXX) standing next to punctuation. The
 * harvester meets them in three places that treat punctuation differently:
 *
 *   - pascalCaseIdentifiers() reads word boundaries: `TODO:QuasarWidget`
 *     yields the identifier, but `TODO_QuasarWidget` does not, because `_`
 *     is a word character and the match has no boundary to start at.
 *   - readmeProperNouns() strips punctuation only at a token's edges:
 *     `(ToDo)` reads as `ToDo`, while `ToDo's` keeps its apostrophe and
 *     fails the name pattern whole. `HACK:` also ends the "sentence", so
 *     the word after it is held back like a sentence start.
 *   - countDotTldBrands() does not know the marker list: `TODO.AI` is a
 *     dotted brand, so an all-caps marker prose drops outright is proposed
 *     the moment a listed TLD follows its dot.
 *
 * These tests pin the current behavior of each path.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harvestRepo, harvestReport } from './harvest.js';

const markers = [
  { marker: 'TODO' },
  { marker: 'FIXME' },
  { marker: 'NOTE' },
  { marker: 'HACK' },
  { marker: 'XXX' },
];

const MARKER_NAMES = markers.map((entry) => entry.marker);

/**
 * Separators between a marker and the name it introduces. All of them are
 * non-word characters, so each leaves a word boundary the identifier match
 * can start at.
 */
const separators = [
  { name: 'a colon', open: ':', close: '' },
  { name: 'a double colon', open: '::', close: '' },
  { name: 'a dot', open: '.', close: '' },
  { name: 'a double dot', open: '..', close: '' },
  { name: 'an exclamation mark', open: '!', close: '' },
  { name: 'a question mark', open: '?', close: '' },
  { name: 'a semicolon', open: ';', close: '' },
  { name: 'a comma', open: ',', close: '' },
  { name: 'an equals sign', open: '=', close: '' },
  { name: 'a hyphen', open: '-', close: '' },
  { name: 'a slash', open: '/', close: '' },
  { name: 'a pipe', open: '|', close: '' },
  { name: 'a plus sign', open: '+', close: '' },
  { name: 'a star', open: '*', close: '' },
  { name: 'a hash', open: '#', close: '' },
  { name: 'an at sign', open: '@', close: '' },
  { name: 'a tab', open: '\t', close: '' },
  // As an escape: tests/no-dashes scans every file under src/ for a literal dash.
  { name: 'an em dash', open: '\u2014', close: '' },
  { name: 'an ellipsis', open: '…', close: '' },
  { name: 'parentheses', open: '(', close: ')' },
  { name: 'angle brackets', open: '<', close: '>' },
  { name: 'square brackets', open: '[', close: ']' },
  { name: 'double quotes', open: '"', close: '"' },
  { name: 'single quotes', open: "'", close: "'" },
  { name: 'backticks', open: '`', close: '`' },
];

/** The marker itself wrapped in punctuation, with the name after it. */
const wrappers = [
  { name: 'parentheses', open: '(', close: ')' },
  { name: 'square brackets', open: '[', close: ']' },
  { name: 'stars', open: '*', close: '*' },
  { name: 'double quotes', open: '"', close: '"' },
  { name: 'single quotes', open: "'", close: "'" },
  { name: 'backticks', open: '`', close: '`' },
];

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-punct-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function canonicals(candidates: { canonical: string }[]): string[] {
  return candidates.map((candidate) => candidate.canonical);
}

describe('markers next to punctuation in source', () => {
  it.each(separators)('harvests the identifier a marker introduces through $name', async ({ open, close }) => {
    const lines = markers.map(({ marker }) => `// ${marker}${open}QuasarWidget${close}`);
    await fs.writeFile(path.join(repo, 'marker.ts'), `${lines.join('\n')}\n`);

    const candidates = await harvestRepo(repo, { git: false, symbols: true });
    expect(candidates.find((candidate) => candidate.canonical === 'QuasarWidget')).toMatchObject({
      category: 'identifier', source: 'harvest:repo', count: markers.length, evidence: ['marker.ts'],
    });
    for (const marker of MARKER_NAMES) {
      expect(canonicals(candidates)).not.toContain(marker);
    }
  });

  it.each(wrappers)('harvests the identifier after a marker wrapped in $name', async ({ open, close }) => {
    const lines = markers.map(({ marker }) => `// ${open}${marker}${close} QuasarWidget`);
    await fs.writeFile(path.join(repo, 'marker.ts'), `${lines.join('\n')}\n`);

    const candidates = await harvestRepo(repo, { git: false, symbols: true });
    expect(candidates.find((candidate) => candidate.canonical === 'QuasarWidget')).toMatchObject({
      category: 'identifier', source: 'harvest:repo', count: markers.length, evidence: ['marker.ts'],
    });
    for (const marker of MARKER_NAMES) {
      expect(canonicals(candidates)).not.toContain(marker);
    }
  });

  it.each(markers)('harvests nothing when $marker is glued to the name by a word character', async ({ marker }) => {
    // `_` and digits are word characters: there is no boundary between the
    // marker and the name, so the identifier match cannot start.
    await fs.writeFile(path.join(repo, 'marker.ts'),
      `// ${marker}_QuasarWidget\n// ${marker}7QuasarWidget\n`);

    const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
    expect(candidates).toEqual([]);
  });

  it("keeps an identifier a marker introduces when it carries a possessive 's", async () => {
    await fs.writeFile(path.join(repo, 'marker.ts'),
      `// TODO: QuasarWidget's fallback\n// FIXME: QuasarWidget's fallback\n`);

    const candidates = await harvestRepo(repo, { git: false, symbols: true });
    expect(candidates.find((candidate) => candidate.canonical === 'QuasarWidget')).toMatchObject({
      category: 'identifier', count: 2, evidence: ['marker.ts'],
    });
  });

  it('harvests no marker that punctuation decorates with no name after it', async () => {
    await fs.writeFile(path.join(repo, 'marker.ts'),
      '// TODO: fix\n// FIXME: fix\n// (NOTE) later\n// HACK! wow\n// XXX? huh\n');

    const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
    expect(candidates).toEqual([]);
  });
});

describe('markers next to punctuation in README prose', () => {
  it.each(markers)('drops $marker wherever punctuation attaches to it', async ({ marker }) => {
    await fs.writeFile(path.join(repo, 'README.md'),
      `The ${marker}: and (${marker}) and "${marker}" show up as ${marker}, ${marker}! and ${marker}?\n`);

    const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(candidates).toEqual([]);
  });

  it('drops the stoplisted sentence-case markers while Hack and Fixme count as brands', async () => {
    // `Todo` and `Note` are on the harvest stoplist and `Xxx` is under the
    // four-letter minimum; `Hack` and `Fixme` are on neither list, so their
    // capitalized forms are proposed like any other capitalized word.
    await fs.writeFile(path.join(repo, 'README.md'),
      'The Todo: and Note. are skipped, as Xxx? is. The Hack. and Fixme, return as Hack; Fixme.\n');

    const candidates = await harvestRepo(repo, { git: false });
    for (const canonical of ['Hack', 'Fixme']) {
      expect(candidates.find((candidate) => candidate.canonical === canonical)).toMatchObject({
        category: 'brand', count: 2, evidence: ['README.md'],
      });
    }
    for (const dropped of ['Todo', 'Note', 'Xxx']) {
      expect(canonicals(candidates)).not.toContain(dropped);
    }
  });

  it('holds a single Hack. below the count threshold instead of dropping it', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), 'The Hack. appears once here.\n');

    const report = await harvestReport(repo, { git: false });
    expect(report.candidates).toEqual([]);
    expect(report.belowMinCount).toBe(1);
  });

  it('harvests a mixed-case marker stripped of edge punctuation but none of the glued forms', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      "We use (ToDo) and ToDo, and FixMe. plus FixMe, but ToDo's and ToDo-List stay words.\n");

    const candidates = await harvestRepo(repo, { git: false });
    for (const canonical of ['ToDo', 'FixMe']) {
      expect(candidates.find((candidate) => candidate.canonical === canonical)).toMatchObject({
        category: 'brand', count: 2, evidence: ['README.md'],
      });
    }
    for (const glued of ["ToDo's", 'ToDo-List']) {
      expect(canonicals(candidates)).not.toContain(glued);
    }
  });

  it('does not propose a marker form seen only inside quotes or emphasis', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'The "ToDo" label and *FixMe* and _ToDo_ marks. Another "ToDo" label.\n');

    const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(candidates).toEqual([]);
  });

  it('counts the quoted and emphasised sightings once a plain one exists', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'The "ToDo" label and *FixMe* marks. We use ToDo and FixMe daily.\n');

    const candidates = await harvestRepo(repo, { git: false });
    for (const canonical of ['ToDo', 'FixMe']) {
      expect(candidates.find((candidate) => candidate.canonical === canonical)).toMatchObject({
        category: 'brand', count: 2, evidence: ['README.md'],
      });
    }
  });

  it('treats the word after a marker colon as a sentence start', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'HACK: Quasarbrand works. NOTE: Quasarbrand again.\n');

    const initialOnly = await harvestRepo(repo, { git: false });
    expect(canonicals(initialOnly)).not.toContain('Quasarbrand');

    // Once the name also appears mid-sentence, the held-back sightings merge in.
    await fs.writeFile(path.join(repo, 'README.md'),
      'HACK: Quasarbrand works. NOTE: Quasarbrand again. We use Quasarbrand daily.\n');

    const candidates = await harvestRepo(repo, { git: false });
    expect(candidates.find((candidate) => candidate.canonical === 'Quasarbrand')).toMatchObject({
      category: 'brand', count: 3, evidence: ['README.md'],
    });
  });

  it('drops a marker glued to a name by punctuation instead of splitting it', async () => {
    // README tokens are only stripped at their edges: `HACK:QuasarWidget`
    // and `NOTE(QuasarWidget)` keep their inner punctuation, fail the name
    // pattern and contribute nothing, unlike the same strings in source.
    await fs.writeFile(path.join(repo, 'README.md'),
      'The HACK:QuasarWidget and NOTE(QuasarWidget) forms. We use QuasarWidget and QuasarWidget daily.\n');

    const candidates = await harvestRepo(repo, { git: false });
    expect(candidates.find((candidate) => candidate.canonical === 'QuasarWidget')).toMatchObject({
      category: 'brand', count: 2, evidence: ['README.md'],
    });
  });
});

describe('markers wearing a dot-TLD', () => {
  const dotted = [
    { marker: 'TODO', brand: 'TODO.AI' },
    { marker: 'FIXME', brand: 'FIXME.io' },
    { marker: 'NOTE', brand: 'NOTE.me' },
    { marker: 'HACK', brand: 'HACK.sh' },
    { marker: 'XXX', brand: 'XXX.gg' },
  ];

  it.each(dotted)('proposes $brand as a brand although $marker alone is dropped', async ({ brand }) => {
    await fs.writeFile(path.join(repo, 'marker.ts'), `// ${brand} is ours\n`);

    const candidates = await harvestRepo(repo, { git: false });
    // One sighting is enough: dot-TLD brands bypass the count threshold.
    expect(candidates.find((candidate) => candidate.canonical === brand)).toMatchObject({
      category: 'brand', count: 1, evidence: ['marker.ts'],
    });
  });

  it('proposes each marker dot-brand from README prose at a count of one', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'See TODO.AI and FIXME.io. Also NOTE.me, HACK.sh and XXX.gg.\n');

    const candidates = await harvestRepo(repo, { git: false });
    for (const { brand } of dotted) {
      expect(candidates.find((candidate) => candidate.canonical === brand)).toMatchObject({
        category: 'brand', count: 1, evidence: ['README.md'],
      });
    }
  });

  it('only takes the TLDs the pattern lists, in their listed case', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'See XXX.GG and FIXME.Io and TODO.TXT and NOTE.Me here.\n');

    const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(candidates).toEqual([]);
  });

  it('skips a marker dot-brand in a path or carrying a dotted version suffix', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'Link src/TODO.AI and TODO.AI/x and TODO.AI.Beta here.\n');

    const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(candidates).toEqual([]);
  });
});
