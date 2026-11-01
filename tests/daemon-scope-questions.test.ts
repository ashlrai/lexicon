import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-scope-questions.md', import.meta.url), 'utf8');

describe('daemon scope questions', () => {
  it('grounds the proposal in issue 220 and distinguishes the current boundary', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toMatch(/resident process[\s\S]*focused fields across\s+applications without an agent/);
    expect(doc).toMatch(/default `lexicon daemon` watches the\s+clipboard/);
    expect(doc).toMatch(/Neither supplies the platform client[\s\S]*System-wide expansion is not\s+available today/);
    expect(doc).toMatch(/open product and integration questions, not a specification/);
  });

  it('covers lifetime, configuration, and coexistence as questions', () => {
    const sections = doc.split(/^## /m);
    const lifetime = sections.find((section) => section.startsWith('Process lifetime')) ?? '';
    const config = sections.find((section) => section.startsWith('Configuration and state')) ?? '';
    const surfaces = sections.find((section) => section.startsWith('Interaction with existing surfaces')) ?? '';
    expect(lifetime).toMatch(/starts and stops[\s\S]*crash, restart[\s\S]*disconnects/);
    expect(config).toMatch(/defaults, precedence[\s\S]*project[\s\S]*trust[\s\S]*permissions/);
    expect(surfaces).toMatch(/clipboard watching[\s\S]*browser extension[\s\S]*lexicon serve[\s\S]*CLI edits/);
    for (const section of [lifetime, config, surfaces]) {
      expect((section.match(/\?/g) ?? []).length).toBeGreaterThanOrEqual(5);
    }
    expect(doc).toMatch(/do not assert that the proposed client, startup integration,\s+or cross-surface coordination has been implemented/);
  });

  it('is discoverable from the docs index', () => {
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-scope-questions.md](daemon-scope-questions.md)');
  });
});
