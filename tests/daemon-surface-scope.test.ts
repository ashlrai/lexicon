import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-surface-scope.md', import.meta.url), 'utf8');

describe('daemon surface scope', () => {
  it('identifies the requested experience and puts the benchmark in context', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toMatch(/resident\s+process expands text in the focused field across applications, without an\s+agent/);
    expect(doc).toMatch(/did\s+not measure the Lexicon daemon/i);
    expect(doc).toMatch(/not a target or an end-to-end expansion guarantee/);
  });

  it('separates the existing daemon and server from the missing client', () => {
    expect(doc).toMatch(/By default it polls and corrects the clipboard/);
    expect(doc).toContain('`lexicon daemon --expander`');
    expect(doc).toMatch(/Nothing starts it automatically/);
    expect(doc).toMatch(/Neither the core nor the server captures system-wide input or edits a field/);
    expect(doc).toMatch(/not yet an available\s+feature/);
    expect(doc).toMatch(/questions for design and validation, not requirements settled by\s+the issue/);
  });

  it('is discoverable and links to the current protocol and open questions', () => {
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-surface-scope.md](daemon-surface-scope.md)');
    expect(doc).toContain('[DAEMON.md](DAEMON.md#resident-expander-opt-in)');
    expect(doc).toContain('[daemon-surface-questions.md](daemon-surface-questions.md)');
    expect(doc).toContain('[expander-platform-questions.md](expander-platform-questions.md)');
  });
});
