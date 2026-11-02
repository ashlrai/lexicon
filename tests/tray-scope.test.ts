import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scope = readFileSync(new URL('../docs/tray-scope.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('tray scope (issue #13)', () => {
  it('is indexed and tied to the issue', () => {
    expect(index).toContain('[tray-scope.md](tray-scope.md)');
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(scope).toContain('## Where the detail lives');
  });

  it('identifies push-to-talk and fix-clipboard as proposed capabilities, not shipped ones', () => {
    expect(scope).toContain('## Proposed capabilities');
    expect(scope).toMatch(/Push-to-talk \(Dictate\):\*\* run `lexicon voice --toggle --paste`/);
    expect(scope).toMatch(/Fix clipboard:\*\* run `lexicon daemon --once --paste`/);
    expect(scope).toMatch(/Both are proposed, and neither has shipped/);
    expect(scope).toMatch(/nothing on\s+this page is a shipped feature or a release commitment/);
    expect(scope).toMatch(/complete proposed support is unimplemented/);
  });

  it('records the issue contract and the partial-contribution rule', () => {
    expect(scope).toMatch(/one platform, with one action, is a complete\s+and mergeable contribution/);
    expect(scope).toMatch(/no\s+logic of its own[\s\S]*argument array[\s\S]*stdout/);
    expect(scope).toMatch(/No Electron dependency/);
    expect(scope).toMatch(/`apps\/windows\/` or `apps\/linux\/`/);
    expect(scope).toMatch(/disable everything except\s+Preferences/);
    expect(scope).toMatch(/hotkeys are the desktop environment's job/);
  });

  it('keeps existing platform work distinct from the proposal', () => {
    expect(scope).toMatch(/local API client rather than the proposed CLI path/);
    expect(scope).toMatch(/no tray\s+push-to-talk/);
    expect(scope).toMatch(/Linux has no\s+tray app/);
    expect(scope).toMatch(/copies the corrected text back to the\s+clipboard rather than sending a paste keystroke/);
    expect(scope).toMatch(/not been verified on a real\s+Windows desktop/);
  });

  it('links every companion document', () => {
    for (const link of [
      'tray-request-scope.md',
      'tray-app-scope.md',
      'tray-platform-scope.md',
      'tray-action-map.md',
      'tray-interaction-questions.md',
      'tray-platform-questions.md',
      'CONTRACT.md#windows-and-linux-tray-proposal-issue-13',
      'MACOS-APP.md',
      'WINDOWS-APP.md#what-is-verified-and-what-is-not',
      'PLATFORMS.md',
    ]) {
      expect(scope).toContain(link);
    }
  });
});
