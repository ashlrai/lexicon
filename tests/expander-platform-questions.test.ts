import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/expander-platform-questions.md', import.meta.url), 'utf8');

describe('expander platform questions (issue #220)', () => {
  it('grounds the list in the issue and the existing boundary docs', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toContain('[resident-expander-scope.md](resident-expander-scope.md)');
    expect(doc).toContain('[CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220)');
    expect(doc).toContain('[DAEMON.md](DAEMON.md#resident-expander-opt-in)');
    expect(doc).toMatch(/a list of questions, not a plan or a spec/);
    expect(doc).toMatch(/rather than requirements attributed to the issue/);
  });

  it('asks questions per platform, including the Linux split', () => {
    expect(doc).toMatch(/^## macOS$/m);
    expect(doc).toMatch(/^## Windows$/m);
    expect(doc).toMatch(/^## Linux$/m);
    expect(doc).toMatch(/^### X11$/m);
    expect(doc).toMatch(/^### Wayland$/m);
    expect(doc).toMatch(/^## Questions every platform has to answer$/m);
    expect(doc).toMatch(/^## What would count as supported$/m);
  });

  it('names the real platform mechanisms rather than abstract risks', () => {
    for (const mechanism of [
      'CGEvent', 'AXObserver', 'AXSelectedText', 'Accessibility',
      'WH_KEYBOARD_LL', 'SendInput', 'UI Automation', 'UIPI', 'IsPassword',
      'XRecord', 'XInput2', 'XTest', 'AT-SPI', 'input-method', 'virtual-keyboard',
    ]) {
      expect(doc).toContain(mechanism);
    }
  });

  it('labels every open item undecided and keeps decided behavior separate', () => {
    const undecided = doc.match(/\*\*Undecided\.\*\*/g) ?? [];
    const decided = doc.match(/\*\*Decided\.\*\*/g) ?? [];
    expect(undecided.length).toBeGreaterThanOrEqual(30);
    expect(decided.length).toBeGreaterThanOrEqual(5);
    // The marks are defined up front so "undecided" cannot read as "planned".
    expect(doc).toMatch(/\*\*Decided\.\*\* Behavior that exists in the repository today/);
    expect(doc).toMatch(/\*\*Undecided\.\*\* Genuinely open/);
    expect(doc).toMatch(/Undecided here means undecided, not a decision waiting to be announced/);
  });

  it('does not present the client or its guarantees as existing', () => {
    expect(doc).toMatch(/the platform client that would feed keystrokes to that core and\s+apply its actions does not exist/);
    expect(doc).not.toMatch(/the client (is|will be) (built|shipped|released)/i);
  });
});
