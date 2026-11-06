import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scope = readFileSync(new URL('../docs/tray-app-scope.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('tray app scope', () => {
  it('records the issue and requested actions', () => {
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(scope).toMatch(/Windows or\s+Linux tray app/);
    expect(scope).toContain('lexicon voice --toggle --paste');
    expect(scope).toContain('lexicon daemon --once --paste');
    expect(scope).toMatch(/global hotkey/);
    expect(scope).toMatch(/one platform and one action\s+as a complete contribution/);
    expect(index).toContain('[tray-app-scope.md](tray-app-scope.md)');
  });

  it('distinguishes current behavior, open decisions and desktop verification', () => {
    expect(scope).toMatch(/Windows tray already offers Fix clipboard[\s\S]*no tray push-to-talk/);
    expect(scope).toContain('Linux has no tray app');
    expect(scope).toMatch(/`--paste` copies the result rather than\s+sending a paste keystroke/);
    expect(scope).toContain('## Unresolved implementation decisions');
    expect(scope).toMatch(/toolkit[\s\S]*clipboard backends[\s\S]*native paste[\s\S]*shortcut conflicts[\s\S]*packaging/);
    expect(scope).toMatch(/successful copy from a verified paste/);
    expect(scope).toContain('lexicon stats');
  });
});
