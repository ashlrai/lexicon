import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-design-questions.md', import.meta.url), 'utf8');
const section = (heading: string) => doc.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

describe('resident expander design questions', () => {
  it('distinguishes the requested surface from the existing server', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toMatch(/resident system-wide expander[\s\S]*focused field[\s\S]*without an\s+agent/);
    expect(doc).toMatch(/not an implementation plan or a promise of support/);
    expect(section('What exists today')).toMatch(/Neither the server nor the core\s+captures system input or applies edits[\s\S]*client is not implemented/);
  });

  it('keeps lifecycle, trust and platform choices open and discoverable', () => {
    expect(section('Lifecycle')).toMatch(/installs[\s\S]*stops[\s\S]*crash/);
    expect(section('Configuration and trust')).toMatch(/project lexicon[\s\S]*trust gate[\s\S]*sensitive/);
    expect(section('Platform support and safe editing')).toMatch(/macOS, Windows, Linux X11 and Wayland[\s\S]*IME[\s\S]*undo[\s\S]*support claim/);
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-design-questions.md](daemon-design-questions.md)');
  });
});
