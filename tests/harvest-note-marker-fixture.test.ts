import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'note-marker');

describe('harvest NOTE marker fixture', () => {
  it('recognizes NOTE comments in line, block, hash and trailing styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    expect(candidates.map((c) => c.canonical)).not.toContain('NOTE');

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      OrbitBridge: ['line.ts'],
      PulsarLoader: ['block.ts'],
      VectorPlanner: ['hash.py'],
      QuartzRouter: ['trail.ts'],
    });
  });
});
