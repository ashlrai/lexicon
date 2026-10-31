import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * docs/BENCH-DAEMON.md records the gap to the espanso baseline that issue #220
 * supplies: `match list` at 15.9 ms p50 and 34,016 kB peak RSS. Both figures
 * must stay stated there, beside the resident expander's own measurements.
 */
const doc = readFileSync(new URL('../docs/BENCH-DAEMON.md', import.meta.url), 'utf8');

describe('docs/BENCH-DAEMON.md espanso baseline (issue #220)', () => {
  it('states the espanso 15.9 ms p50 latency baseline', () => {
    expect(doc).toMatch(/espanso[^\n]*15\.9\s*ms\s*p50/i);
  });

  it('states the espanso 34,016 kB memory baseline', () => {
    expect(doc).toMatch(/espanso[^\n]*34,?016\s*kB/i);
  });

  it('attributes the baseline to issue #220', () => {
    expect(doc).toMatch(/#220/);
  });

  it('records the resident side of the gap on both figures', () => {
    // A gap needs two sides: the resident expander's own p50 and RSS in kB.
    expect(doc).toMatch(/resident[^\n]*\d+\.\d+\s*ms/i);
    expect(doc).toMatch(/resident[^\n]*\d[\d,]*\s*kB/i);
  });
});
