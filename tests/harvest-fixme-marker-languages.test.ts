import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// A fixture containing a FIXME comment produces the expected harvest in every
// scanned source language: the marker is recognized and never proposed, and
// the name beside it is harvested with the comment and the declaration each
// counted once. tests/fixtures/fixme-marker covers .ts and .py; these are the
// rest of SOURCE_EXTENSIONS.
describe('harvest FIXME marker across languages', () => {
  it.each([
    { file: 'marker.tsx', name: 'ZenithPanel', text: '// FIXME: rework ZenithPanel\nconst ZenithPanel = () => null;\n' },
    { file: 'marker.js', name: 'PulsarCache', text: '// FIXME: swap PulsarCache\nclass PulsarCache {}\n' },
    { file: 'marker.jsx', name: 'OrbitDrawer', text: '/* FIXME: tune OrbitDrawer */\nconst OrbitDrawer = () => null;\n' },
    { file: 'marker.mjs', name: 'NebulaStream', text: '// FIXME: drain NebulaStream\nexport class NebulaStream {}\n' },
    { file: 'marker.rs', name: 'VectorBroker', text: '// FIXME: pin VectorBroker\nstruct VectorBroker;\n' },
    { file: 'marker.go', name: 'CinderQueue', text: '// FIXME: keep CinderQueue warm\ntype CinderQueue struct{}\n' },
    { file: 'marker.java', name: 'EmberLedger', text: '// FIXME: audit EmberLedger\nclass EmberLedger {}\n' },
    { file: 'marker.rb', name: 'QuartzSocket', text: '# FIXME: patch QuartzSocket\nclass QuartzSocket; end\n' },
    { file: 'marker.swift', name: 'LumenDriver', text: '// FIXME: keep LumenDriver ready\nclass LumenDriver {}\n' },
    { file: 'marker.kt', name: 'RiftBuffer', text: '// FIXME: warm RiftBuffer\nclass RiftBuffer\n' },
    { file: 'marker.cs', name: 'OnyxSession', text: '// FIXME: drain OnyxSession\nclass OnyxSession {}\n' },
  ])('produces the expected harvest for a FIXME comment in $file', async ({ file, name, text }) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-fixme-lang-'));
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
