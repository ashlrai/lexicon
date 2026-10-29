import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('proposed system-wide daemon contract', () => {
  const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const boundary = contract.split('### Separate-process boundary (issue #220)')[1]?.split('## src/serve')[0] ?? '';

  it('distinguishes the resident process, its intended behavior, and the existing surfaces', () => {
    expect(boundary).toMatch(/separate,\s+long-lived process/);
    expect(boundary).toMatch(/focused text field across applications, without an agent in the loop/);
    expect(boundary).toMatch(/observe text input, match completed words against the\s+lexicon, and apply the resulting replacement/);
    expect(boundary).toMatch(/clipboard watcher corrects copied text/);
    expect(boundary).toMatch(/socket server has no global input capture or text-field editing\s+client/);
    expect(boundary).toMatch(/proposal, not an implemented or available\s+feature/);
  });

  it('leaves platform and operational decisions open', () => {
    expect(boundary).toMatch(/Platform choices remain open/);
    expect(boundary).toMatch(/macOS and Windows[\s\S]*Linux across X11 and\s+Wayland/);
    expect(boundary).toMatch(/permissions, sensitive-field exclusions/);
    expect(boundary).toMatch(/startup and supervision/);
    expect(boundary).toMatch(/does not settle those choices or promise support in\s+every application/);
  });
});
