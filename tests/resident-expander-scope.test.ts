import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scope = readFileSync(new URL('../docs/resident-expander-scope.md', import.meta.url), 'utf8');

describe('resident expander scope', () => {
  it('captures the requested surface and distinguishes the available server from a platform client', () => {
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(scope).toMatch(/resident process[\s\S]*focused text field across applications, without an agent/);
    expect(scope).toMatch(/neither the core nor the server captures system-wide input or edits fields/);
    expect(scope).toMatch(/platform client[\s\S]*still needed/);
    expect(scope).toMatch(/System-wide expansion is not yet an\s+available feature/);
  });

  it('keeps platform decisions and the limits of the issue explicit', () => {
    expect(scope).toMatch(/macOS, Windows, and Linux, including X11 and different Wayland/);
    expect(scope).toMatch(/permissions[\s\S]*sensitive fields/i);
    expect(scope).toMatch(/focus changes[\s\S]*composition and IME input/);
    expect(scope).toMatch(/does not specify operating systems[\s\S]*performance targets, or acceptance tests/);
    expect(scope).toMatch(/not requirements attributed to the issue/);
  });
});
