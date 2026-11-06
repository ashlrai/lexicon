import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Expander } from '../src/daemon/expander.js';

const map = readFileSync(new URL('../docs/expander-boundary-map.md', import.meta.url), 'utf8');

describe('expander boundary map', () => {
  it('keeps the proposal separate from existing surfaces and links it from the index', () => {
    const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
    expect(index).toContain('[expander-boundary-map.md](expander-boundary-map.md)');
    expect(map).toContain('https://github.com/ashlrai/lexicon/issues/220');
    expect(map).toContain('(CONTRACT.md#separate-process-boundary-issue-220)');
    for (const surface of ['Core and CLI', 'Clipboard daemon', 'MCP and hook', 'Local API', 'browser extension', 'macOS app', 'Windows app', 'Resident server']) {
      expect(map).toContain(surface);
    }
    expect(map).toMatch(/system-wide expansion through\s+them is not yet available/);
    expect(map).toMatch(/neither captures input nor applies edits/);
    expect(map).toMatch(/platform client[\s\S]*not an implemented integration/);
    expect(map).toMatch(/Windows UI Automation path is unverified/);
    expect(map).toMatch(/CLI already attempts a resident `cli-read`/);
    for (const boundary of ['Capture and scope', 'Safe edits and undo', 'Privacy and permissions', 'State and trust', 'Lifecycle and transport', 'Product and validation']) {
      expect(map).toContain(boundary);
    }
  });

  it('shows an action produced by the current expansion core', () => {
    const example = /```json\n([^\n]+)\n```/.exec(map);
    expect(example).not.toBeNull();
    const expander = new Expander({ version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] });
    expect(JSON.parse(example![1]!)).toEqual(expander.type('Ashler '));
  });
});
