import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scope = readFileSync(new URL('../docs/tray-platform-scope.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('tray platform scope (issue #13)', () => {
  it('identifies the requested platforms and the reference platform', () => {
    expect(index).toContain('[tray-platform-scope.md](tray-platform-scope.md)');
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(scope).toMatch(/Windows and Linux are the requested platforms/);
    expect(scope).toMatch(/macOS is the specification, not a target/);
    expect(scope).toMatch(/one platform, with one action, is a complete\s+and mergeable contribution/);
  });

  it('lists the stated actions and behavioral requirements', () => {
    for (const action of [
      'lexicon daemon --once --paste',
      'lexicon voice --toggle --paste',
      'Open lexicon',
      'Preferences',
      'Quit',
    ]) {
      expect(scope).toContain(action);
    }
    expect(scope).toMatch(/global hotkey for Fix clipboard/);
    expect(scope).toMatch(/disables everything except Preferences/);
    expect(scope).toMatch(/no logic of its own[\s\S]*argument array[\s\S]*stdout/);
    expect(scope).toMatch(/No Electron dependency/);
    expect(scope).toMatch(/`apps\/windows\/` or `apps\/linux\/`/);
    expect(scope).toMatch(/dictate into an application[\s\S]*`lexicon stats` counted the\s+hits/);
  });

  it('marks stated requirements and open questions distinctly', () => {
    const stated = scope.match(/\*\*Stated\.\*\*/g) ?? [];
    const open = scope.match(/\*\*Open\.\*\*/g) ?? [];
    expect(stated.length).toBeGreaterThanOrEqual(10);
    expect(open.length).toBeGreaterThanOrEqual(7);
    // The marks are defined up front so "open" cannot read as "planned".
    expect(scope).toMatch(/\*\*Stated\.\*\* The issue requires or explicitly requests it/);
    expect(scope).toMatch(/\*\*Open\.\*\* The issue names the need and leaves the decision/);
    expect(scope).toMatch(/Open here means open, not a\s+decision waiting to be announced/);
  });

  it('keeps existing platform work distinct from the request', () => {
    expect(scope).toMatch(/`apps\/windows\/`[\s\S]*no\s+tray push-to-talk/);
    expect(scope).toMatch(/never run on a real\s+Windows desktop/);
    expect(scope).toMatch(/Linux has no tray app/);
    expect(scope).toMatch(/paste keystroke only on macOS/);
    expect(scope).toMatch(/does not mention the existing\s+app/);
    expect(scope).toContain('[tray-action-map.md](tray-action-map.md)');
    expect(scope).toContain('CONTRACT.md#windows-and-linux-tray-proposal-issue-13');
  });
});
