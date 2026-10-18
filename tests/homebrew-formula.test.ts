/**
 * packaging/homebrew/lexicon.rb is published to ashlrai/homebrew-tap and no
 * test here runs brew, so hold its dependency names to the ones the voice
 * pipeline tells a macOS user to `brew install`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_HINTS } from '../src/voice/process.js';

const formula = readFileSync(fileURLToPath(new URL('../packaging/homebrew/lexicon.rb', import.meta.url)), 'utf8');

describe('Homebrew formula', () => {
  // Catches: `depends_on "whisper.cpp"`, a name Homebrew has no formula for
  // (it is whisper-cpp), so `brew install ashlrai/tap/lexicon` could not
  // resolve the recommended dependency.
  it('depends on the formulae the voice install hint names', () => {
    const deps = Array.from(formula.matchAll(/^\s*depends_on "([^"]+)"/gm), (m) => m[1]);
    const hinted = INSTALL_HINTS.darwin.replace(/^brew install /, '').split(/\s+/);
    expect(deps).toEqual(['node', ...hinted]);
  });
});
