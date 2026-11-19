import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// tray-scope.md is the single scope page for issue #13. It absorbed
// tray-request-scope.md, tray-app-scope.md and tray-platform-scope.md, so the
// assertions those pages' tests made now run against this one.
const scope = readFileSync(new URL('../docs/tray-scope.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

function section(heading: string): string {
  const start = scope.indexOf(`\n## ${heading}\n`);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = scope.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('tray scope (issue #13)', () => {
  it('is indexed and tied to the issue', () => {
    expect(index).toContain('[tray-scope.md](tray-scope.md)');
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(scope).toMatch(/Windows or\s+Linux tray app/);
    expect(scope).toContain('## Where the detail lives');
  });

  it('replaces the three folded scope pages', () => {
    for (const page of ['tray-request-scope.md', 'tray-app-scope.md', 'tray-platform-scope.md']) {
      expect(existsSync(new URL(`../docs/${page}`, import.meta.url)), page).toBe(false);
      expect(index).not.toContain(`(${page})`);
      expect(scope).not.toContain(`(${page})`);
    }
  });

  it('identifies push-to-talk and fix-clipboard as proposed capabilities, not shipped ones', () => {
    const proposed = section('Proposed capabilities');
    expect(proposed).toMatch(/Push-to-talk \(Dictate\):\*\* run `lexicon voice --toggle --paste`/);
    expect(proposed).toMatch(/Fix clipboard:\*\* run `lexicon daemon --once --paste`/);
    expect(proposed).toMatch(/global shortcut/);
    expect(proposed).toMatch(/Open lexicon, Preferences and Quit/);
    expect(proposed).toContain('PATH');
    expect(scope).toMatch(/Both are proposed, and neither has shipped/);
    expect(scope).toMatch(/nothing on\s+this page is a shipped feature or a release commitment/);
    expect(scope).toMatch(/complete proposed support is unimplemented/);
  });

  it('records the issue contract and the partial-contribution rule', () => {
    expect(scope).toMatch(/one platform, with one action, is a complete\s+and mergeable contribution/);
    expect(scope).toMatch(/One platform and one action is a complete contribution/);
    expect(scope).toMatch(/no\s+logic of its own[\s\S]*argument array[\s\S]*stdout/);
    expect(scope).toMatch(/No Electron dependency/);
    expect(scope).toMatch(/`apps\/windows\/` or `apps\/linux\/`/);
    expect(scope).toMatch(/disable everything except\s+Preferences/);
    expect(scope).toMatch(/disables everything except Preferences/);
    expect(scope).toMatch(/hotkeys are the\s+desktop environment's job/);
    expect(scope).toMatch(/global hotkey for Fix clipboard/);
    expect(scope).toMatch(/Windows and Linux are the requested platforms/);
    expect(scope).toMatch(/macOS is the specification, not a target/);
  });

  it('marks stated requirements and open questions distinctly', () => {
    const marked = section('Stated requirements and open decisions');
    const stated = marked.match(/\*\*Stated\.\*\*/g) ?? [];
    const open = marked.match(/\*\*Open\.\*\*/g) ?? [];
    expect(stated.length).toBeGreaterThanOrEqual(10);
    expect(open.length).toBeGreaterThanOrEqual(7);
    // The marks are defined up front so "open" cannot read as "planned".
    expect(marked).toMatch(/\*\*Stated\.\*\* The issue requires or explicitly requests it/);
    expect(marked).toMatch(/\*\*Open\.\*\* The issue names the need and leaves the decision/);
    expect(marked).toMatch(/Open here means open, not a\s+decision waiting to be announced/);
    for (const action of [
      'lexicon daemon --once --paste',
      'lexicon voice --toggle --paste',
      'Open lexicon',
      'Preferences',
      'Quit',
    ]) {
      expect(marked).toContain(action);
    }
  });

  it('labels every unresolved implementation decision as open', () => {
    const openBullets = scope
      .split(/\n- /)
      .filter((bullet) => bullet.startsWith('**Open.**'))
      .join('\n');
    for (const decision of [
      /toolkit/,
      /clipboard backends/,
      /X11 and Wayland/,
      /native paste/,
      /shortcut conflicts/,
      /CLI discovery/,
      /no-change and failure states/,
      /Packaging, signing and release distribution/,
      /does not mention the existing app/,
    ]) {
      expect(openBullets).toMatch(decision);
    }
  });

  it('keeps existing platform work distinct from the proposal', () => {
    const today = section('What exists today');
    expect(today).toMatch(/Windows tray already offers Fix clipboard[\s\S]*no tray push-to-talk/);
    expect(today).toMatch(/local API client rather than the CLI/);
    expect(today).toMatch(/not been\s+verified on a real Windows desktop/);
    expect(today).toContain('Linux has no tray app');
    expect(scope).toMatch(/local API client rather than the proposed CLI path/);
    expect(scope).toMatch(/copies the corrected text back to the\s+clipboard rather than sending a paste keystroke/);
    expect(scope).toMatch(/paste keystroke only on macOS/);
    expect(scope).toMatch(/`--paste` copies the result rather than\s+sending a paste keystroke/);
  });

  it('asks for real desktop verification that tells a copy from a paste', () => {
    const verify = section('Verification the issue asks for');
    expect(verify).toMatch(/dictate into an application[\s\S]*`lexicon stats`\s+counted the hits/);
    expect(verify).toMatch(/successful copy from a verified paste/);
    expect(verify).toMatch(/records what remains untested/);
  });

  it('links every companion document', () => {
    for (const link of [
      'tray-action-map.md',
      'tray-interaction-questions.md',
      'tray-platform-questions.md',
      'CONTRACT.md#windows-and-linux-tray-proposal-issue-13',
      'MACOS-APP.md',
      'WINDOWS-APP.md#what-is-verified-and-what-is-not',
      'PLATFORMS.md',
      'VOICE.md#hotkey-mode---toggle',
      'DAEMON.md#linux-gnome-custom-shortcut',
    ]) {
      expect(scope).toContain(link);
    }
  });
});
