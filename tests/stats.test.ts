import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEVER_HIT_CAP, TOP_TERMS, computeStats } from '../src/core/stats.js';
import { renderStats, runStats } from '../src/cli/cmd-learn.js';
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
  it('counts terms, aliases and hits and groups by category/source', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.termCount).toBe(4);
    expect(stats.aliasCount).toBe(4);
    expect(stats.totalHits).toBe(15);
    expect(stats.byCategory).toEqual({ brand: 1, product: 1, person: 1, uncategorized: 1 });
    expect(stats.bySource).toEqual({ user: 1, 'harvest:package': 1, learned: 1, unknown: 1 });
  });

  it('lists top terms by hits and the never-hit canonicals', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.topTerms).toEqual([
      { canonical: 'Ashlr.AI', hits: 12 },
      { canonical: 'Kubernetes', hits: 3 },
    ]);
    expect(stats.neverHit).toEqual(['Mason Wyatt', 'Zoë']);
  });

  it('reports each file with its own term count', () => {
    const stats = computeStats(loadedOf(sample));
    expect(stats.files).toEqual([
      { path: '/fake/global.yaml', scope: 'global', terms: 3 },
      { path: '/fake/repo/.lexicon.yaml', scope: 'project', terms: 1 },
    ]);
    expect(computeStats(loadedOf(sample, false)).files).toHaveLength(1);
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
  });

  it('handles an empty lexicon', () => {
    const stats = computeStats(loadedOf([], false));
    expect(stats).toMatchObject({ termCount: 0, aliasCount: 0, totalHits: 0, topTerms: [], neverHit: [] });
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

  it('says so when no hits were recorded', () => {
    const text = renderStats(computeStats(loadedOf([{ canonical: 'Zoë', aliases: [] }])));
    expect(text).toContain('no hits yet');
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
      const stats = JSON.parse(out.join('')) as { termCount: number; topTerms: unknown[]; neverHit: string[]; files: { path: string }[] };
      expect(stats.termCount).toBe(2);
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
