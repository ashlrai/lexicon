import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const agents = readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');
const section = agents.split(/^## Hot files/m)[1]?.split(/^## /m)[0] ?? '';

describe('AGENTS.md hot-file rule', () => {
  it('has a hot files section', () => {
    expect(section).not.toBe('');
  });

  it('names both hot files', () => {
    expect(section).toContain('`docs/README.md`');
    expect(section).toContain('`docs/CONTRACT.md`');
  });

  it('forbids a new doc from editing them', () => {
    expect(section).toMatch(/A new doc does not edit `docs\/README\.md` or `docs\/CONTRACT\.md`/);
  });

  it('forbids a new test from requiring a line there', () => {
    expect(section).toMatch(/A new test must not require a line in `docs\/README\.md` or `docs\/CONTRACT\.md`/);
  });
});
