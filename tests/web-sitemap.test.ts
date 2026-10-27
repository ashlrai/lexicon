import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sitemapEntries } from '../web/lib/sitemap.js';
import { gitLastModified } from '../web/lib/git-lastmod.js';
import { SITE_URL } from '../web/lib/site.js';
import { useCases, useCasePath } from '../web/lib/use-cases.js';

const directories: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

function fixture(initialize = true): string {
  const root = mkdtempSync(join(tmpdir(), 'lexicon-sitemap-'));
  directories.push(root);
  if (initialize) git(root, ['init', '--quiet']);
  return root;
}

function git(root: string, args: string[], date?: string): void {
  execFileSync('git', args, {
    cwd: root,
    env: { ...gitEnv, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    stdio: 'ignore',
  });
}

function commit(root: string, file: string, date: string): void {
  writeFileSync(join(root, file), date);
  git(root, ['add', '--', file]);
  git(root, ['-c', 'user.name=Sitemap test', '-c', 'user.email=sitemap@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], date);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Git sitemap lastmod', () => {
  it('uses the latest relevant content commit, not build time or an unrelated commit', () => {
    const root = fixture();
    commit(root, 'first.md', '2025-01-01T10:00:00+00:00');
    commit(root, 'second.md', '2025-02-01T10:00:00+00:00');
    commit(root, 'unrelated.md', '2025-03-01T10:00:00+00:00');
    expect(new Date(gitLastModified(['first.md'], root)!).toISOString()).toBe('2025-01-01T10:00:00.000Z');
    expect(new Date(gitLastModified(['first.md', 'second.md'], root)!).toISOString()).toBe('2025-02-01T10:00:00.000Z');
  });

  it('resolves repository-relative dependencies from a web working directory', () => {
    const root = fixture();
    mkdirSync(join(root, 'web'));
    commit(root, 'guide.md', '2025-04-01T10:00:00-04:00');
    expect(gitLastModified(['guide.md'], join(root, 'web'))).toBe('2025-04-01T10:00:00-04:00');
  });

  it('treats dynamic route brackets as literal paths', () => {
    const root = fixture();
    commit(root, '[slug].md', '2025-01-01T10:00:00+00:00');
    commit(root, 's.md', '2025-02-01T10:00:00+00:00');
    expect(new Date(gitLastModified(['[slug].md'], root)!).toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });

  it('omits lastmod for archives, empty repositories, empty dependencies and untracked files', () => {
    expect(gitLastModified(['guide.md'], fixture(false))).toBeUndefined();
    const root = fixture();
    expect(gitLastModified(['guide.md'], root)).toBeUndefined();
    commit(root, 'other.md', '2025-01-01T10:00:00+00:00');
    writeFileSync(join(root, 'guide.md'), 'untracked');
    expect(gitLastModified(['guide.md'], root)).toBeUndefined();
    expect(gitLastModified([], root)).toBeUndefined();
  });
});

describe('indexable sitemap catalog', () => {
  it('contains exactly the homepage and every use-case canonical, without machine payloads', () => {
    const entries = sitemapEntries();
    expect(entries.map((entry) => entry.url)).toEqual([
      SITE_URL,
      ...useCases.map((page) => new URL(useCasePath(page.slug), SITE_URL).href),
    ]);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
    for (const entry of entries) {
      const url = new URL(entry.url);
      expect(url.protocol).toBe('https:');
      expect(url.origin).toBe(SITE_URL);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(entry.lastModified).toBeDefined();
      expect(Number.isNaN(new Date(entry.lastModified!).getTime())).toBe(false);
    }
  });
});
