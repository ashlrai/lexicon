import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-scope.md', import.meta.url), 'utf8');

describe('resident daemon scope', () => {
  it('distinguishes the issue request from existing surfaces', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toMatch(/resident process\s+expands text in the focused field across applications, without an agent/);
    expect(doc).toMatch(/watches and corrects the clipboard/);
    expect(doc).toMatch(/returns actions to a client; it does not capture system-wide input or edit fields/);
    expect(doc).toMatch(/system-wide expansion\s+is not yet available/);
    expect(doc).toMatch(/numbers are\s+context, not targets/);
  });

  it('keeps platform and lifecycle choices open and links to further details', () => {
    const open = doc.split('## Open decisions')[1] ?? '';
    for (const topic of ['Platforms and input', 'Privacy and permissions', 'Edit safety', 'Lifecycle', 'Configuration and coexistence', 'Validation']) {
      expect(open).toContain(`**${topic}:**`);
    }
    expect(open).toMatch(/questions for design and validation/);
    expect(open).toContain('(expander-platform-questions.md)');
    expect(open).toContain('(daemon-surface-questions.md)');
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-scope.md](daemon-scope.md)');
  });
});
