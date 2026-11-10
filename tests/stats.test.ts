import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEVER_HIT_CAP, TOP_TERMS, computeStats } from '../src/core/stats.js';
import { renderStats, runStats } from '../src/cli/cmd-learn.js';
import { recordHits, trustProject } from '../src/core/index.js';
import type { IO } from '../src/cli/commands.js';
import type { Lexicon, LoadedLexicon, Term } from '../src/core/types.js';

function loadedOf(terms: Term[], withProject = true): LoadedLexicon {
  const merged: Lexicon = { version: 1, terms };
  const globalTerms = terms.filter((t) => t.scope !== 'project');
  const projectTerms = terms.filter((t) => t.scope === 'project');
  const base: LoadedLexicon = {
    merged,
    global: { path: '/fake/global.yaml', scope: 'global', lexicon: { version: 1, terms: globalTerms }, exists: true },
  };
  return withProject
    ? { ...base, project: { path: '/fake/repo/.lexicon.yaml', scope: 'project', lexicon: { version: 1, terms: projectTerms }, exists: true } }
    : base;
}

const sample: Term[] = [
  { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'], category: 'brand', source: 'user', hits: 12, scope: 'global' },
  { canonical: 'Kubernetes', aliases: ['cooper netties'], category: 'product', source: 'harvest:package', hits: 3, scope: 'project' },
  { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', source: 'learned', scope: 'global' },
  { canonical: 'Zoë', aliases: [], scope: 'global' },
];

describe('computeStats', () => {
  it('returns the same statistics on repeated calls regardless of other calls', () => {
    const first = loadedOf(structuredClone(sample));
    const second = loadedOf([{ canonical: 'Other', aliases: ['another'], hits: 5 }], false);
    const firstBefore = structuredClone(first);
    const secondBefore = structuredClone(second);

    const firstResult = computeStats(first);
    const secondResult = computeStats(second);
    expect(computeStats(second)).toEqual(secondResult);
    expect(computeStats(first)).toEqual(firstResult);
    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);

    // Results own their collections: modifying one must not affect later calls.
    firstResult.topTerms[0]!.hits = 999;
    firstResult.neverHit.push('Added');
    firstResult.byCategory.brand = 999;
    firstResult.files[0]!.terms = 999;
    expect(computeStats(first)).toEqual(computeStats(firstBefore));
  });

  it('counts every alias of a single term without counting extra terms', () => {
    const stats = computeStats(loadedOf([{ canonical: 'Kubernetes', aliases: ['kuber netties', 'cooper netties', 'kube ernetes'] }], false));
    expect(stats.termCount).toBe(1);
    expect(stats.aliasCount).toBe(3);
  });

  it('counts terms, aliases and hits and groups by category/source', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.termCount).toBe(4);
    expect(stats.aliasCount).toBe(4);
    expect(stats.totalHits).toBe(15);
    expect(stats.byCategory).toEqual({ brand: 1, product: 1, person: 1, uncategorized: 1 });
    expect(stats.bySource).toEqual({ user: 1, 'harvest:package': 1, learned: 1, unknown: 1 });
  });

  it('counts missing category and source independently in their fallback buckets', () => {
    const stats = computeStats(loadedOf([
      { canonical: 'Neither', aliases: [] },
      { canonical: 'Neither again', aliases: [] },
      { canonical: 'Category only', aliases: [], category: 'other' },
      { canonical: 'Source only', aliases: [], source: 'user' },
      { canonical: 'Both', aliases: [], category: 'brand', source: 'user' },
    ]));

    expect(stats.byCategory).toEqual({ uncategorized: 3, other: 1, brand: 1 });
    expect(stats.bySource).toEqual({ unknown: 3, user: 2 });
    expect(Object.values(stats.byCategory).reduce((sum, count) => sum + count, 0)).toBe(stats.termCount);
    expect(Object.values(stats.bySource).reduce((sum, count) => sum + count, 0)).toBe(stats.termCount);
  });

  it('lists top terms by hits and the never-hit canonicals', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.topTerms).toEqual([
      { canonical: 'Ashlr.AI', hits: 12 },
      { canonical: 'Kubernetes', hits: 3 },
    ]);
    expect(stats.neverHit).toEqual(['Mason Wyatt', 'Zoë']);
  });

  it('sums mixed hit counts and lists only terms with no hits', () => {
    const terms: Term[] = [
      { canonical: 'First', aliases: [], hits: 2 },
      { canonical: 'Unset', aliases: [] },
      { canonical: 'Second', aliases: [], hits: 7 },
      { canonical: 'Zero', aliases: [], hits: 0 },
      { canonical: 'Third', aliases: [], hits: 1 },
    ];
    const stats = computeStats(loadedOf(terms));
    expect(stats.totalHits).toBe(10);
    expect(stats.neverHit).toEqual(['Unset', 'Zero']);
    expect(stats.neverHitCount).toBe(2);
  });

  it('reports each file with its own term count', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.files).toEqual([
      { path: '/fake/global.yaml', scope: 'global', terms: 3 },
      { path: '/fake/repo/.lexicon.yaml', scope: 'project', terms: 1 },
    ]);
    expect(computeStats(loadedOf(sample, false)).files).toHaveLength(1);
  });

  it('counts project-only terms without adding global terms', () => {
    const terms: Term[] = [
      { canonical: 'Kubernetes', aliases: ['cooper netties'], scope: 'project' },
      { canonical: 'Kubectl', aliases: ['cube control', 'kube control'], scope: 'project' },
    ];
    const stats = computeStats(loadedOf(terms));

    expect(stats.termCount).toBe(2);
    expect(stats.aliasCount).toBe(3);
    expect(stats.files).toEqual([
      { path: '/fake/global.yaml', scope: 'global', terms: 0 },
      { path: '/fake/repo/.lexicon.yaml', scope: 'project', terms: 2 },
    ]);
  });

  it('caps topTerms and neverHit', () => {
    const many: Term[] = [];
    for (let i = 0; i < 30; i++) many.push({ canonical: `Hit${i}`, aliases: [], hits: 100 - i });
    for (let i = 0; i < 30; i++) many.push({ canonical: `Cold${i}`, aliases: [] });
    const stats = computeStats(loadedOf(many));
    expect(stats.topTerms).toHaveLength(TOP_TERMS);
    expect(stats.topTerms[0]).toEqual({ canonical: 'Hit0', hits: 100 });
    expect(stats.neverHit).toHaveLength(NEVER_HIT_CAP);
    expect(stats.neverHit[0]).toBe('Cold0');
    // The cap hides how many there are; the count does not.
    expect(stats.neverHitCount).toBe(30);
  });

  it('keeps the highest-hit terms when more than the limit have hits', () => {
    // Put the least-used terms first so truncating before sorting fails.
    const terms: Term[] = Array.from({ length: TOP_TERMS + 3 }, (_, i) => ({
      canonical: `Term${i + 1}`,
      aliases: [],
      hits: i + 1,
    }));
    const topTerms = computeStats(loadedOf(terms)).topTerms;

    expect(topTerms).toHaveLength(TOP_TERMS);
    expect(topTerms).toEqual(
      terms.slice(3).reverse().map(({ canonical, hits }) => ({ canonical, hits })),
    );
    for (const excluded of terms.slice(0, 3)) {
      expect(topTerms.every((term) => term.hits > excluded.hits!)).toBe(true);
    }
  });

  it('handles an empty lexicon', () => {
    const stats = computeStats(loadedOf([], false));
    expect(stats).toEqual({
      termCount: 0,
      aliasCount: 0,
      totalHits: 0,
      topTerms: [],
      neverHit: [],
      neverHitCount: 0,
      byCategory: {},
      bySource: {},
      files: [{ path: '/fake/global.yaml', scope: 'global', terms: 0 }],
    });
  });

  it('counts terms with no aliases', () => {
    const stats = computeStats(loadedOf([
      { canonical: 'First', aliases: [] },
      { canonical: 'Second', aliases: [] },
    ]));
    expect(stats.termCount).toBe(2);
    expect(stats.aliasCount).toBe(0);
  });

  it('sums populated alias lists while empty lists contribute zero', () => {
    const stats = computeStats(loadedOf([
      { canonical: 'Empty first', aliases: [] },
      { canonical: 'Two aliases', aliases: ['first', 'second'] },
      { canonical: 'Empty middle', aliases: [] },
      { canonical: 'Three aliases', aliases: ['third', 'fourth', 'fifth'] },
      { canonical: 'Empty last', aliases: [] },
    ]));
    expect(stats.termCount).toBe(5);
    expect(stats.aliasCount).toBe(5);
  });
});

describe('lexicon stats (CLI)', () => {
  it('renders a compact report', () => {
    const text = renderStats(computeStats(loadedOf(sample)));
    expect(text).toContain('terms: 4   aliases: 4   hits: 15');
    expect(text).toContain('by category: brand 1, person 1, product 1, uncategorized 1');
    expect(text).toMatch(/canonical\s+hits\n-+\s+-+\nAshlr\.AI\s+12\nKubernetes\s+3/);
    expect(text).toContain('never hit (2)\n  Mason Wyatt, Zoë');
    expect(text).toMatch(/global\s+\/fake\/global\.yaml\s+3 terms/);
    expect(text).toMatch(/project\s+\/fake\/repo\/\.lexicon\.yaml\s+1 term\n/);
  });

  it('gives the full never-hit count past the cap', () => {
    const cold: Term[] = Array.from({ length: 30 }, (_, i) => ({ canonical: `Cold${i}`, aliases: [] }));
    const text = renderStats(computeStats(loadedOf(cold)));
    expect(text).toContain('never hit (30)\n  Cold0, ');
    expect(text).toContain('Cold19, and 10 more');
  });

  // Catches: the never-hit list was joined and then cut at the 200-character
  // display cap, so with longer names the last ones shown were cut off with
  // an ellipsis while `and N more` counted only the ones past NEVER_HIT_CAP.
  it('lists every never-hit name it counts as shown, however long the list', () => {
    const cold: Term[] = Array.from({ length: 25 }, (_, i) => ({ canonical: `Rarely Dictated Name ${String(i).padStart(2, '0')}`, aliases: [] }));
    const text = renderStats(computeStats(loadedOf(cold)));
    for (let i = 0; i < NEVER_HIT_CAP; i += 1) expect(text).toContain(`Rarely Dictated Name ${String(i).padStart(2, '0')}`);
    expect(text).toContain(`Rarely Dictated Name ${String(NEVER_HIT_CAP - 1).padStart(2, '0')}, and 5 more`);
    expect(text).not.toContain('\u2026');
  });

  // Catches: the files table cut each cell at 200 characters from the end, so
  // a deep project path lost its `.lexicon.yaml` to an ellipsis.
  it('prints a deep lexicon file path whole in the files table', () => {
    const deep = `/home/u/${'very-deep-directory/'.repeat(15)}.lexicon.yaml`;
    const loaded = loadedOf(sample);
    const text = renderStats(computeStats({ ...loaded, project: { ...loaded.project!, path: deep } }));
    expect(text).toContain(deep);
  });

  it('says so when no hits were recorded', () => {
    const text = renderStats(computeStats(loadedOf([{ canonical: 'Zoë', aliases: [] }])));
    expect(text).toContain('no hits yet');
    // Catches: the hint named normalize_transcript, an MCP tool a person at a shell cannot call.
    // Catches: it then named `lexicon normalize`, which records no hits, so a
    // user who tried it saw the counts never move.
    expect(text).toContain('counted when the prompt hook, the MCP server, lexicon voice, the clipboard daemon or lexicon serve fixes something; lexicon normalize does not count');
    expect(text).not.toContain('normalize_transcript');
  });

  // Catches: `lexicon stats` on a lexicon with no terms printed a report of
  // zeros with no step, in text and under --json alike.
  it('runStats names the next step when the lexicon has no terms', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-stats-empty-')));
    const prev = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = path.join(tmp, 'config', 'lexicon.yaml');
    const note = 'The lexicon has no terms yet, so nothing is corrected or counted; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.';
    try {
      const text: string[] = [];
      expect(await runStats({ cwd: tmp }, { stdout: (s) => void text.push(s), stderr: () => undefined })).toBe(0);
      expect(text.join('')).toMatch(/^terms: 0 {3}aliases: 0 {3}hits: 0\nThe lexicon has no terms yet, so nothing is corrected or counted; run `lexicon setup`/);
      const json: string[] = [];
      const errors: string[] = [];
      expect(await runStats({ cwd: tmp, json: true }, { stdout: (s) => void json.push(s), stderr: (s) => void errors.push(s) })).toBe(0);
      expect(JSON.parse(json.join(''))).toMatchObject({
        ok: true,
        termCount: 0,
        aliasCount: 0,
        totalHits: 0,
        neverHitCount: 0,
        topTerms: [],
        neverHit: [],
        byCategory: {},
        bySource: {},
        files: [{ path: path.join(tmp, 'config', 'lexicon.yaml'), scope: 'global', terms: 0 }],
        note,
      });
      expect(errors).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = prev;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('totals a project term across the committed file and this user\'s sidecar', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-stats-split-')));
    const globalPath = path.join(tmp, 'config', 'lexicon.yaml');
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    // A project lexicon as one is committed today: a counter already in git.
    const projectPath = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(
      projectPath,
      'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n    hits: 10\n  - canonical: Cold\n    aliases: [kohld]\n',
    );
    await trustProject(projectPath, { globalPath });
    await recordHits(['Ashlr.AI', 'Ashlr.AI'], { cwd: repo, globalPath });

    const out: string[] = [];
    const io: IO = { stdout: (s) => void out.push(s), stderr: () => undefined };
    const prev = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    try {
      expect(await runStats({ cwd: repo, json: true }, io)).toBe(0);
      const stats = JSON.parse(out.join('')) as { totalHits: number; topTerms: unknown[]; neverHit: string[] };
      // 10 committed plus 2 of this user's own, presented as one number.
      expect(stats.totalHits).toBe(12);
      expect(stats.topTerms).toEqual([{ canonical: 'Ashlr.AI', hits: 12 }]);
      expect(stats.neverHit).toEqual(['Cold']);
      // ...and the committed file still says exactly what it said.
      expect(await fs.readFile(projectPath, 'utf8')).toContain('hits: 10');
    } finally {
      if (prev === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = prev;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // Catches: lexicon_stats named a skipped project file, `lexicon stats` said nothing.
  it('runStats reports an untrusted project lexicon it left out, on stderr and in --json', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-stats-skipped-')));
    const globalPath = path.join(tmp, 'config', 'lexicon.yaml');
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const projectPath = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    const prev = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io: IO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) };
      expect(await runStats({ cwd: repo, json: true }, io)).toBe(0);
      const stats = JSON.parse(out.join('')) as { termCount: number; skippedProject?: string; projectTrust?: string };
      expect(stats.termCount).toBe(0);
      expect(stats.skippedProject).toBe(projectPath);
      expect(stats.projectTrust).toBe('untrusted');
      expect(err.join('')).toContain(`untrusted project lexicon skipped: ${projectPath}`);

      const text: string[] = [];
      const textErr: string[] = [];
      expect(await runStats({ cwd: repo }, { stdout: (s) => void text.push(s), stderr: (s) => void textErr.push(s) })).toBe(0);
      expect(text.join('')).not.toContain('Kubectl');
      expect(textErr.join('')).toContain('run: lexicon trust');

      // No project file: the JSON has no such keys.
      const plain: string[] = [];
      expect(await runStats({ cwd: tmp, json: true }, { stdout: (s) => void plain.push(s), stderr: () => undefined })).toBe(0);
      expect(JSON.parse(plain.join(''))).not.toHaveProperty('skippedProject');
    } finally {
      if (prev === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = prev;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('runStats --json reads the real lexicon files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-stats-'));
    const globalPath = path.join(tmp, 'global.yaml');
    await fs.writeFile(
      globalPath,
      'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n    hits: 2\n  - canonical: Zoë\n    aliases: []\n',
    );
    const out: string[] = [];
    const io: IO = { stdout: (s) => void out.push(s), stderr: () => undefined };
    const prev = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    try {
      const code = await runStats({ cwd: tmp, json: true }, io);
      expect(code).toBe(0);
      const stats = JSON.parse(out.join('')) as { termCount: number; aliasCount: number; topTerms: unknown[]; neverHit: string[]; files: { path: string }[] };
      expect(stats.termCount).toBe(2);
      expect(stats.aliasCount).toBe(1);
      expect(stats.topTerms).toEqual([{ canonical: 'Ashlr.AI', hits: 2 }]);
      expect(stats.neverHit).toEqual(['Zoë']);
      expect(stats.files[0]?.path).toBe(globalPath);
    } finally {
      if (prev === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = prev;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
