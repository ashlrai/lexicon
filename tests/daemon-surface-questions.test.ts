import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/daemon-surface-questions.md', import.meta.url), 'utf8');

describe('daemon surface questions (issue #220)', () => {
  it('grounds the list in the issue and the sibling docs', () => {
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(doc).toContain('[resident-expander-scope.md](resident-expander-scope.md)');
    expect(doc).toContain('[expander-platform-questions.md](expander-platform-questions.md)');
    expect(doc).toContain('[expander-boundary-map.md](expander-boundary-map.md)');
    expect(doc).toContain('[CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220)');
    expect(doc).toContain('[DAEMON.md](DAEMON.md#resident-expander-opt-in)');
    expect(doc).toContain('[BENCH-DAEMON.md](BENCH-DAEMON.md)');
    expect(doc).toMatch(/a list of questions, not a plan or a spec/);
    expect(doc).toMatch(/rather than requirements attributed to the issue/);
  });

  it('lists the requested resident-expander surface', () => {
    expect(doc).toMatch(/^## The surface the issue requests$/m);
    expect(doc).toMatch(/resident process[\s\S]*Node cold start/);
    expect(doc).toMatch(/focused text field across applications[\s\S]*no agent in\s+the loop/);
    expect(doc).toMatch(/distinct from the CLI and the agent integrations/);
    expect(doc).toMatch(/espanso `list` figures it quotes \(15\.9 ms p50, 34,016 kB\) are context/);
  });

  it('names the real daemon surface rather than abstract components', () => {
    for (const name of [
      '`ping`', '`normalize`', '`type`', '`key`', '`reset`', '`clipboard`', '`cli-read`',
      'lexicon daemon --expander', 'lexicon serve --install', 'named pipe',
      'trust.json', 'lexicon stats',
    ]) {
      expect(doc).toContain(name);
    }
    expect(doc).toMatch(/^### Command shape and lifecycle$/m);
    expect(doc).toMatch(/^### Protocol and ops$/m);
    expect(doc).toMatch(/^### Lexicon context and state$/m);
    expect(doc).toMatch(/^### Measurement and support$/m);
  });

  it('labels every open item undecided and keeps decided behavior separate', () => {
    const undecided = doc.match(/\*\*Undecided\.\*\*/g) ?? [];
    const decided = doc.match(/\*\*Decided\.\*\*/g) ?? [];
    expect(undecided.length).toBeGreaterThanOrEqual(15);
    expect(decided.length).toBeGreaterThanOrEqual(9);
    // The marks are defined up front so "undecided" cannot read as "planned".
    expect(doc).toMatch(/\*\*Decided\.\*\* Behavior that exists in the repository today/);
    expect(doc).toMatch(/\*\*Undecided\.\*\* Genuinely open/);
    expect(doc).toMatch(/Undecided here means undecided, not a decision waiting to be announced/);
  });

  it('does not present proposed behavior as shipped', () => {
    expect(doc).toMatch(/None of the undecided lines describes behavior that exists/);
    expect(doc).toMatch(/proposed, not\s+implemented or shipped/);
    expect(doc).not.toMatch(/the client (is|will be) (built|shipped|released)/i);
    expect(doc).not.toMatch(/expansion is (now )?available/i);
  });

  it('is linked from the docs index', () => {
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[daemon-surface-questions.md](daemon-surface-questions.md)');
  });
});
