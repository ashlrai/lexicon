import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'todo-marker-attributed',
);

describe('harvest TODO marker, attributed and lower-case forms', () => {
  it('harvests the names beside TODO(owner), TODO(#n) and todo: and never the marker or its tag', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    const canonicals = candidates.map((c) => c.canonical);
    expect(canonicals.map((c) => c.toLowerCase())).not.toContain('todo');
    expect(canonicals).not.toContain('mason');

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      HelixRouter: ['owner.ts'],
      OrbitCache: ['issue.ts'],
      VortexQueue: ['lower.ts'],
    });
  });
});
