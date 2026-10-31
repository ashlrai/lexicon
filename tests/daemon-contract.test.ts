import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('proposed system-wide daemon contract', () => {
  const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const boundary = contract.split('### Separate-process boundary (issue #220)')[1]?.split('## src/serve')[0] ?? '';

  it('distinguishes the resident process, its intended behavior, and the existing surfaces', () => {
    expect(boundary).toMatch(/separate,\s+long-lived process/);
    expect(boundary).toMatch(/focused text field across applications, without an agent in the loop/);
    expect(boundary).toMatch(/observe text input, match completed words against the\s+lexicon, and apply the resulting replacement/);
    expect(boundary).toMatch(/clipboard watcher corrects copied text/);
    expect(boundary).toMatch(/socket server has no global input capture or text-field editing\s+client/);
    expect(boundary).toMatch(/proposal, not an implemented or available\s+feature/);
  });

  it('separates the existing CLI and opt-in server from proposed client lifecycle', () => {
    expect(boundary).toMatch(/`lexicon normalize` as a\s+subprocess with text as arguments or on stdin and read corrected text from stdout/);
    expect(boundary).toMatch(/client handles the exit status and stderr/);
    expect(boundary).toMatch(/Each invocation starts a new\s+process and exits; it does not require a resident service/);
    expect(boundary).toMatch(/`lexicon\s+daemon` watches the clipboard by default/);
    expect(boundary).toMatch(/opt-in `lexicon daemon --expander` already starts a separate/);
    expect(boundary).toMatch(/automatic startup, supervision,\s+reconnects and fallback to the CLI are proposed behavior, not guarantees/);
    expect(boundary).toMatch(/client would own those lifecycle decisions/);
    expect(boundary).toMatch(/Neither the\s+issue nor the socket protocol establishes a latency or memory guarantee/);
  });

  it('leaves platform and operational decisions open', () => {
    expect(boundary).toMatch(/Platform choices remain open/);
    expect(boundary).toMatch(/macOS and Windows[\s\S]*Linux across X11 and\s+Wayland/);
    expect(boundary).toMatch(/permissions, sensitive-field exclusions/);
    expect(boundary).toMatch(/startup and supervision/);
    expect(boundary).toMatch(/does not settle those choices or promise support in\s+every application/);
  });

  it('keeps the proposed client distinct from each existing integration surface', () => {
    expect(boundary).toMatch(/CLI `normalize`[^\n]*does not observe or edit a field/);
    expect(boundary).toMatch(/Clipboard daemon[^\n]*separate clipboard workflow, not continuous field editing/);
    expect(boundary).toMatch(/Agent integrations[^\n]*hook adds context rather than rewriting the prompt/);
    expect(boundary).toMatch(/Local HTTP API and browser extension[^\n]*Neither makes the proposed expander available across applications/);
    expect(boundary).toMatch(/Opt-in expander server[^\n]*does not capture input or apply actions/);
    expect(boundary).toMatch(/Proposed platform client[^\n]*not supplied by installing the CLI or starting the server/);
    expect(boundary).toMatch(/starts or discovers the server[\s\S]*reconnects or falls back after failure remains open/);
    expect(boundary).toMatch(/focus\s+changes, stale or partial edits, composition input, secure fields and permission\s+denial/);
  });
});
