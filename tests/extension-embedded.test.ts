/**
 * The extension's embedded engine (extension/src/embedded.ts) as a matcher
 * client: one index per lexicon content, and a time budget per call.
 *
 * Catches: the engine calling normalize(text, lexicon), which rebuilds the
 * matcher index (phonetic keys for every alias) on every message from a
 * content script, and matching with no budget, so a huge paste against a
 * large lexicon held the background worker for as long as it took.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/core/matcher.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/matcher.js')>();
  return {
    ...real,
    buildIndex: (...args: Parameters<typeof real.buildIndex>) => {
      builds.count += 1;
      return real.buildIndex(...args);
    },
  };
});

const { createEmbedded, EMBEDDED_MATCH_BUDGET_MS } = await import('../extension/src/embedded.js');

const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');
const SMALL = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [ashler]\n';

describe('embedded engine index cache', () => {
  it('builds the index once per lexicon content, not once per call', () => {
    builds.count = 0;
    const e = createEmbedded(EXAMPLE_YAML);
    for (let i = 0; i < 5; i++) expect(e.normalize('ping ashler').output).toBe('ping Ashlr.AI');
    expect(builds.count).toBe(1);

    // Same text again: still cached.
    e.load(EXAMPLE_YAML);
    e.normalize('ping ashler');
    expect(builds.count).toBe(1);

    // New content: one rebuild, and the new term matches.
    e.load(`${SMALL}  - canonical: Entire.io\n    aliases: [entire dot io]\n`);
    expect(e.error()).toBeNull();
    expect(e.normalize('open entire dot io').output).toBe('open Entire.io');
    e.normalize('open entire dot io');
    expect(builds.count).toBe(2);
  });

  it('stops matching once the budget is spent and returns what it found so far', () => {
    let clock = 0;
    const e = createEmbedded(EXAMPLE_YAML, { budgetMs: 50, now: () => (clock += 20) });
    const text = Array.from({ length: 200 }, () => 'ping ashler').join(' ');
    const r = e.normalize(text);
    expect(r.replacements.length).toBeGreaterThan(0);
    expect(r.replacements.length).toBeLessThan(200);
    expect(r.output.startsWith('ping Ashlr.AI')).toBe(true);
    // Says it stopped early, as MCP normalize_transcript and serve do.
    expect(r.incomplete).toMatchObject({ reasons: ['time'], totalChars: text.length });
    expect(r.incomplete?.note).toMatch(/50 ms/);

    const unbounded = createEmbedded(EXAMPLE_YAML).normalize(text);
    expect(unbounded.replacements.length).toBe(200);
    expect(unbounded.incomplete).toBeUndefined();
    expect(EMBEDDED_MATCH_BUDGET_MS).toBeGreaterThan(0);
  });
});
