import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'todo-marker');

describe('harvest TODO marker fixture', () => {
  it('recognizes TODO comments in line, block and hash styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    expect(candidates.map((c) => c.canonical)).not.toContain('TODO');

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      QuasarLoader: ['line.ts'],
      NimbusPlanner: ['block.ts'],
      PrismBridge: ['hash.py'],
    });
  });
});
