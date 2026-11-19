import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// docs/daemon-design-questions.md also holds the questions that used to live in
// docs/daemon-scope-questions.md; this file keeps that page's assertions.
const doc = readFileSync(new URL('../docs/daemon-design-questions.md', import.meta.url), 'utf8');
const section = (heading: string) => doc.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('resident expander design questions', () => {
  it('distinguishes the requested surface from the existing server', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toMatch(/resident system-wide expander[\s\S]*focused field[\s\S]*without an\s+agent/);
    expect(doc).toMatch(/not an\s+implementation plan or a promise of support/);
    expect(doc).toMatch(/open product and integration questions/);
    expect(doc).toMatch(/default `lexicon daemon` watches the\s+clipboard/);
    expect(section('What exists today')).toMatch(/Neither the server nor the core\s+captures system input or applies edits[\s\S]*client is not implemented/);
  });

  it('keeps lifecycle, trust and platform choices open and discoverable', () => {
    expect(section('Lifecycle')).toMatch(/installs[\s\S]*stops[\s\S]*crash/);
    expect(section('Configuration and trust')).toMatch(/project lexicon[\s\S]*trust gate[\s\S]*sensitive/);
    expect(section('Platform support and safe editing')).toMatch(/macOS, Windows, Linux X11 and Wayland[\s\S]*IME[\s\S]*undo[\s\S]*support claim/);
    expect(index).toContain('[daemon-design-questions.md](daemon-design-questions.md)');
  });

  it('covers lifetime, configuration, and coexistence as questions', () => {
    const lifetime = section('Lifecycle');
    const config = section('Configuration and trust');
    const surfaces = section('Interaction with existing surfaces');
    expect(lifetime).toMatch(/starts[\s\S]*stops[\s\S]*crash, disconnect, restart[\s\S]*unavailable/);
    expect(lifetime).toMatch(/verify that it stopped/);
    expect(config).toMatch(/defaults, precedence[\s\S]*project[\s\S]*trust[\s\S]*permissions/);
    expect(surfaces).toMatch(/clipboard watching[\s\S]*browser extension[\s\S]*lexicon serve[\s\S]*CLI edits/);
    for (const part of [lifetime, config, surfaces]) {
      expect((part.match(/\?/g) ?? []).length).toBeGreaterThanOrEqual(5);
    }
    expect(doc).toMatch(/do not assert that the proposed client, startup integration,\s+or cross-surface coordination has been implemented/);
  });

  it('replaces the folded daemon-scope-questions page', () => {
    expect(existsSync(new URL('../docs/daemon-scope-questions.md', import.meta.url))).toBe(false);
    expect(index).not.toContain('daemon-scope-questions.md');
  });
});
