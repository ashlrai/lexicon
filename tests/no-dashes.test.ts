/**
 * CLAUDE.md: "No em-dashes in docs or user-facing strings." This holds the
 * whole of docs/ and src/ to it (comments included, which is simpler to keep
 * than telling a comment from a string), so a dash cannot creep back in.
 * tests/macos-messages.test.ts does the same for the LexiconBar Swift strings.
 *
 * Left out, because they are owned elsewhere: src/core/matcher.ts and
 * src/core/importers/. A regex that has to match a dash in user text writes
 * it as `—`, as src/core/learn.ts does. docs/assets/*.cast is a recorded
 * terminal session (real output), and binary media is not text.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEXT = new Set(['.md', '.ts', '.mts', '.mjs', '.js', '.json', '.yaml', '.yml', '.svg', '.txt']);
const OWNED_ELSEWHERE = ['src/core/matcher.ts', 'src/core/importers/'];
const DASH = /[–—]/;

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return TEXT.has(path.extname(entry.name)) ? [rel] : [];
  });
}

const files = [...walk('docs'), ...walk('src')].filter((f) => !OWNED_ELSEWHERE.some((o) => (o.endsWith('/') ? f.startsWith(o) : f === o)));

describe('no en or em dashes in docs/ and src/', () => {
  it('scans the files', () => {
    expect(files).toContain('docs/CONTRACT.md');
    expect(files).toContain('src/core/learn.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  // Catches: em dashes left in docs/WINDOWS-APP.md, docs/assets/MANIFEST.md
  // and nine src/ files after the rule was written down.
  it('finds none', () => {
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(path.join(ROOT, file), 'utf8')
        .split('\n')
        .forEach((text, i) => {
          if (DASH.test(text)) hits.push(`${file}:${i + 1}: ${text.trim().slice(0, 100)}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
