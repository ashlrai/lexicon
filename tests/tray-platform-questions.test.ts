import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/tray-platform-questions.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
const windows = doc.split('## Windows surface')[1]?.split('## Linux surface')[0] ?? '';
const linux = doc.split('## Linux surface')[1]?.split('## Evidence and remaining decisions')[0] ?? '';

describe('tray platform questions (issue #13)', () => {
  it('connects the request to its issue, shared commands and docs index', () => {
    expect(index).toContain('[tray-platform-questions.md](tray-platform-questions.md)');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/13');
    for (const item of ['lexicon daemon --once --paste', 'lexicon voice --toggle --paste', 'Open lexicon', 'Preferences', 'Quit']) {
      expect(doc).toContain(item);
    }
    expect(doc).toMatch(/automatic paste is unsupported/);
    expect(doc).toMatch(/argument arrays[\s\S]*trust gate/);
  });

  it('distinguishes Windows suggestions, existing work and open choices', () => {
    expect(windows).toMatch(/NotifyIcon[\s\S]*pystray[\s\S]*RegisterHotKey[\s\S]*SendInput/);
    expect(windows).toMatch(/local API client[\s\S]*does not offer tray push-to-talk/);
    expect(windows).toMatch(/not been\s+verified on a real Windows desktop/);
    expect(windows).toMatch(/Open questions:[\s\S]*registration conflict[\s\S]*elevated target/);
  });

  it('separates Linux tray and desktop shortcut questions', () => {
    expect(linux).toMatch(/libappindicator[\s\S]*StatusNotifierItem[\s\S]*desktop environment/);
    expect(linux).toMatch(/currently no Linux tray app/);
    expect(linux).toMatch(/Open questions:[\s\S]*GNOME and KDE[\s\S]*X11 and Wayland/);
    expect(linux).toMatch(/wl-clipboard[\s\S]*xclip[\s\S]*xsel/);
    expect(doc).toMatch(/lexicon stats[\s\S]*Headless tests alone cannot verify/);
  });
});
