import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// A fixture containing a NOTE comment produces the expected harvest in every
// scanned source language: the marker is recognized and never proposed, and
// the name beside it is harvested with the comment and the declaration each
// counted once. tests/fixtures/note-marker covers .ts and .py; these are the
// rest of SOURCE_EXTENSIONS (the JS dialects share the .ts comment styles).
describe('harvest NOTE marker across languages', () => {
  it.each([
    { file: 'marker.rs', name: 'ZenithRouter', text: '// NOTE: port ZenithRouter to async\nstruct ZenithRouter;\n' },
    { file: 'marker.go', name: 'PulsarEngine', text: '/* NOTE: swap PulsarEngine */\ntype PulsarEngine struct{}\n' },
    { file: 'marker.java', name: 'OrbitLedger', text: '// NOTE: audit OrbitLedger\nclass OrbitLedger {}\n' },
    { file: 'marker.rb', name: 'NebulaSocket', text: '# NOTE: tune NebulaSocket\nclass NebulaSocket; end\n' },
    { file: 'marker.swift', name: 'VectorScheduler', text: '// NOTE: pin VectorScheduler\nclass VectorScheduler {}\n' },
    { file: 'marker.kt', name: 'CinderQueue', text: '// NOTE: keep CinderQueue warm\nclass CinderQueue\n' },
    { file: 'marker.cs', name: 'EmberCache', text: '// NOTE: drain EmberCache\nclass EmberCache {}\n' },
  ])('produces the expected harvest for a NOTE comment in $file', async ({ file, name, text }) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-note-lang-'));
    dirs.push(base);
    // `repo` is a generic root name, so only the file's contents are proposed.
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo);
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
