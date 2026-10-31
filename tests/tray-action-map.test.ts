import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const map = readFileSync(new URL('../docs/tray-action-map.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('tray action map', () => {
  it('maps the issue actions to their contracts and distinguishes existing platform work', () => {
    expect(index).toContain('[tray-action-map.md](tray-action-map.md)');
    expect(map).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(map).toContain('CONTRACT.md#windows-and-linux-tray-proposal-issue-13');
    expect(map).toMatch(/voice --toggle --paste[\s\S]*first invocation starts[\s\S]*automatic paste is unsupported/);
    expect(map).toMatch(/daemon --once --paste[\s\S]*only sends a paste keystroke on macOS/);
    expect(map).toMatch(/Windows tray already has Fix clipboard now[\s\S]*local API client rather than the CLI/);
    expect(map).toMatch(/Windows has no tray push-to-talk and Linux has no tray app/);
    expect(map).toMatch(/desktop integration is unverified/);
  });

  it('preserves the operational distinctions a tray needs to handle', () => {
    expect(map).toMatch(/stop call uses its own options/);
    expect(map).toMatch(/Exit 0 alone does not mean a transcript is ready to\s+paste/);
    expect(map).toMatch(/Do not infer that a paste\s+occurred from exit 0/);
    expect(map).toMatch(/stale clipboard contents[\s\S]*changed focus/);
    expect(map).toMatch(/real desktop check[\s\S]*lexicon stats/);
  });
});
