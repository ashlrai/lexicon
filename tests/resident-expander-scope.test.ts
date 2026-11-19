import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// docs/resident-expander-scope.md is the one issue #220 scope page. It absorbed
// daemon-scope.md, daemon-surface-scope.md and daemon-design-constraints.md,
// which restated the same request, boundary and open decisions.
const scope = readFileSync(new URL('../docs/resident-expander-scope.md', import.meta.url), 'utf8');
const section = (heading: string) => scope.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

describe('resident expander scope', () => {
  it('captures the requested surface and distinguishes the available server from a platform client', () => {
    expect(scope).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(scope).toMatch(/resident process[\s\S]*focused text field across applications, without an agent/);
    expect(scope).toMatch(/neither the core nor the server captures system-wide input or edits fields/);
    expect(scope).toMatch(/platform client[\s\S]*still needed/);
    expect(scope).toMatch(/System-wide expansion is not yet an\s+available feature/);
  });

  it('keeps platform decisions and the limits of the issue explicit', () => {
    expect(scope).toMatch(/macOS, Windows, and Linux, including X11 and different Wayland/);
    expect(scope).toMatch(/permissions[\s\S]*sensitive fields/i);
    expect(scope).toMatch(/focus changes[\s\S]*composition and IME input/);
    expect(scope).toMatch(/does not specify operating systems[\s\S]*performance targets, or acceptance tests/);
    expect(scope).toMatch(/not requirements attributed to the issue/);
  });

  it('puts the cited benchmark in context', () => {
    const requested = section('Requested behavior');
    expect(requested).toMatch(/`lexicon daemon` a start, not a completed system-wide expander/);
    expect(requested).toMatch(/was not part of that measurement/);
    expect(requested).toMatch(/figures are context,\s+not a target, a daemon measurement, or a guarantee for interactive expansion/);
    expect(requested).toContain('(BENCH-DAEMON.md)');
  });

  it('separates the existing daemon and server from the missing client', () => {
    const existing = section('Existing pieces and the missing boundary');
    expect(existing).toMatch(/By default it polls and corrects the clipboard/);
    expect(existing).toContain('`lexicon daemon --expander`');
    expect(existing).toMatch(/Nothing starts it automatically/);
    expect(existing).toMatch(/newline-delimited JSON over a local Unix socket or Windows named pipe/);
    expect(existing).toMatch(/grapheme-counted backspace action/);
    expect(existing).toMatch(/The server does not log typed text/);
    expect(existing).toMatch(/not clients of the expander socket/);
    expect(existing).toMatch(/does not use the previous cached view for that changed\s+state/);
    expect(existing).toContain('(DAEMON.md#resident-expander-opt-in)');
    expect(existing).toContain('(CONTRACT.md#separate-process-boundary-issue-220)');
    expect(existing).toContain('(expander-boundary-map.md)');
  });

  it('keeps every open question and decision area and links to the question lists', () => {
    const open = section('Open platform and product questions');
    for (const topic of ['Input and editing', 'Permissions and privacy', 'Correctness', 'Lifecycle and failure', 'Configuration and coexistence', 'Validation']) {
      expect(open).toContain(`**${topic}:**`);
    }
    expect(open).toContain('(expander-platform-questions.md)');
    expect(open).toContain('(daemon-surface-questions.md)');

    const decisions = section('Decisions and evidence needed');
    for (const area of ['Platform and input', 'Safe edits', 'Privacy and permissions', 'Lexicon and trust', 'Lifecycle and protocol', 'Verification and performance']) {
      expect(decisions).toContain(`| ${area} |`);
    }
    expect(decisions).toMatch(/without treating the\s+current protocol as proof of an end-to-end experience/);
    expect(decisions).toContain('(PLATFORMS.md)');
  });

  it('is the only scope page in the docs index', () => {
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[resident-expander-scope.md](resident-expander-scope.md)');
    for (const old of ['daemon-scope.md', 'daemon-surface-scope.md', 'daemon-design-constraints.md']) {
      expect(existsSync(new URL(`../docs/${old}`, import.meta.url))).toBe(false);
      expect(index).not.toContain(`(${old})`);
    }
  });
});
