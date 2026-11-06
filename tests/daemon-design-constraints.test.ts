import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-design-constraints.md', import.meta.url), 'utf8');
const section = (heading: string) => doc.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

describe('resident expander design constraints', () => {
  it('separates the issue request from the current implementation', () => {
    const requested = section('Requested surface');
    const existing = section('Existing boundary');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(requested).toMatch(/resident system-wide expander[\s\S]*focused field[\s\S]*without an agent/);
    expect(requested).toMatch(/figures are context, not[\s\S]*latency target/);
    expect(existing).toMatch(/does not capture system input or\s+apply edits/);
    expect(existing).toMatch(/surface is not yet available/);
    expect(existing).toContain('(CONTRACT.md#separate-process-boundary-issue-220)');
  });

  it('keeps implementation choices open and discoverable', () => {
    const open = section('Open design decisions');
    expect(open).toContain('The issue does not decide');
    for (const area of ['Platform and input', 'Safe edits', 'Privacy and permissions', 'Lexicon and trust', 'Lifecycle and protocol', 'Verification and performance']) {
      expect(open).toContain(area);
    }
    expect(open).toContain('(daemon-surface-questions.md)');
    expect(open).toContain('(expander-platform-questions.md)');
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-design-constraints.md](daemon-design-constraints.md)');
  });
});
