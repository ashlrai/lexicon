import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows and Linux tray proposal contract', () => {
  const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const section = contract.split('## Windows and Linux tray proposal (issue #13)')[1]?.split('\n## ')[0] ?? '';

  it('records the proposed workflows and their unimplemented parity', () => {
    expect(section).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(section).toMatch(/proposes tray access on Windows and Linux/);
    expect(section).toMatch(/push-to-talk and clipboard repair workflows/);
    expect(section).toMatch(/proposed capabilities/);
    expect(section).toMatch(/Windows and Linux tray support is unimplemented/);
  });

  it('distinguishes existing Windows and CLI work from the proposal', () => {
    expect(section).toMatch(/Linux has no tray app/);
    expect(section).toMatch(/Windows has a separate tray app[\s\S]*with clipboard repair, but no tray push-to-talk/);
    expect(section).toMatch(/clipboard actions, has not been verified on a real Windows desktop/);
    expect(section).toMatch(/CLI voice and clipboard commands are distinct from tray integration/);
  });
});
