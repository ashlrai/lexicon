import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { anchorsOf, linksIn } from '../scripts/check-links.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportPath = path.join(root, 'SUPPORT.md');
const support = readFileSync(supportPath, 'utf8');

/** Relative links only: no scheme (https:, mailto:), no protocol-relative, no bare anchor. */
const relativeLinks = linksIn(support).filter(({ target }) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target));

describe('SUPPORT.md', () => {
  it('exists at the repo root and is not empty', () => {
    expect(existsSync(supportPath)).toBe(true);
    expect(support.trim().length).toBeGreaterThan(0);
  });

  it('has a section for questions, bug reports and security reports', () => {
    expect(support).toMatch(/^## Ask a question$/m);
    expect(support).toMatch(/^## Report a bug$/m);
    expect(support).toMatch(/^## Report a security issue$/m);
  });

  it('links to SECURITY.md and CONTRIBUTING.md', () => {
    const targets = relativeLinks.map(({ target }) => target.split('#')[0]);
    expect(targets).toContain('SECURITY.md');
    expect(targets).toContain('CONTRIBUTING.md');
  });

  it('has at least one relative link, so the link check below is not vacuous', () => {
    expect(relativeLinks.length).toBeGreaterThan(0);
  });

  it.each(relativeLinks.map((link): [string, number] => [link.target, link.line]))('relative link %s (line %i) resolves', (target, line) => {
    const [file, fragment] = target.split('#');
    const abs = path.resolve(root, decodeURI(file));
    const rel = path.relative(root, abs);

    expect(rel.startsWith('..'), `${target} escapes the repo`).toBe(false);
    expect(existsSync(abs), `line ${line}: ${target} does not exist`).toBe(true);
    expect(statSync(abs).isFile(), `line ${line}: ${target} is not a file`).toBe(true);

    if (fragment !== undefined && fragment !== '') {
      expect(/\.md$/i.test(abs), `line ${line}: #${fragment} points into a non-markdown file`).toBe(true);
      expect(anchorsOf(abs).has(fragment.toLowerCase()), `line ${line}: no heading #${fragment} in ${file}`).toBe(true);
    }
  });
});
