import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docsUrl = new URL('../docs/', import.meta.url);
const doc = readFileSync(new URL('daemon-acceptance-criteria.md', docsUrl), 'utf8');

const observable = doc.split('## Observable today')[1]?.split('## Unresolved operating-system integration decisions')[0] ?? '';
const unresolved = doc.split('## Unresolved operating-system integration decisions')[1]?.split('## What done means')[0] ?? '';
const done = doc.split('## What done means')[1] ?? '';

const slug = (heading: string): string =>
  heading.trim().replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ +/g, '-');

const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const linked = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]);

describe('daemon acceptance criteria (issue #220)', () => {
  it('is linked from the docs index', () => {
    const index = readFileSync(new URL('README.md', docsUrl), 'utf8');
    expect(index).toContain('[daemon-acceptance-criteria.md](daemon-acceptance-criteria.md)');
  });

  it('keeps the implemented surface separate from the proposed one', () => {
    expect(observable).not.toBe('');
    expect(unresolved).not.toBe('');
    expect(done).not.toBe('');
    expect(doc).toMatch(/system-wide surface is not implemented/);
    expect(doc).toMatch(/resident,\s+system-wide\s+text expander as a separate surface/);
    expect(doc).toMatch(/focused text field across\s+applications, without an agent in the loop/);
    expect(doc).toMatch(/Nothing\s+here presents a design as shipped code/);
    expect(unresolved).toMatch(/None of them has shipped code/);
    expect(done).toMatch(/Until then "the expander" means the opt-in socket server and\s+nothing else/);
    expect(done).toMatch(/validated on\s+the platform it claims and documented without promising support in every\s+application/);
  });

  it('names every socket op among the observable behavior', () => {
    for (const op of ['ping', 'normalize', 'type', 'key', 'reset', 'clipboard', 'cli-read']) {
      expect(observable).toContain(`\`${op}\``);
    }
  });

  it('lists the platform and operational decisions the issue leaves open', () => {
    for (const word of ['macOS', 'Windows', 'Linux', 'X11', 'Wayland']) {
      expect(unresolved).toContain(word);
    }
    expect(unresolved).toMatch(/permission is denied or revoked/);
    expect(unresolved).toMatch(/secure-input fields must never be observed or rewritten/);
    expect(unresolved).toMatch(/Focus changes mid-word, IME and composition input/);
    expect(unresolved).toMatch(/startup, supervision, discovery of an existing instance,\s+reconnects and fallback/);
    expect(unresolved).toMatch(/guarantee for the end-to-end loop/);
    expect(unresolved).toMatch(/support in every application is not promised/);
  });

  it('resolves every relative link, including heading anchors', () => {
    const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      if (/^[a-z]+:/i.test(link)) continue;
      const [file, fragment] = link.split('#');
      const target = new URL(file, docsUrl);
      expect(existsSync(target), link).toBe(true);
      if (fragment) {
        const text = readFileSync(target, 'utf8');
        const headings = [...text.matchAll(/^#+ +(.+)$/gm)].map((m) => slug(m[1]));
        expect(headings, `${link} (no such heading)`).toContain(fragment);
      }
    }
  });

  it('resolves every code-quoted repository path', () => {
    const paths = ticks(doc).filter((t) => /^(?:src|tests|docs|bench)\/[^`\s]+$/.test(t));
    for (const p of paths) {
      expect(existsSync(new URL(`../${p}`, docsUrl)), p).toBe(true);
    }
  });

  it('cites only test titles and source symbols that exist in the files it names', () => {
    const testLink = /\]\((\.\.\/(?:tests|bench)\/[^)#]+?\.(?:test\.ts|mjs))\)/g;
    const srcLink = /\]\((\.\.\/src\/[^)#]+)\)/g;
    for (const line of doc.split('\n')) {
      const cells = line.split('|').slice(1, -1);
      if (line.startsWith('|') && cells.length >= 3) {
        // Table row: last cell names the proof, the one before it the files.
        const [fileCell, proofCell] = [cells[cells.length - 2], cells[cells.length - 1]];
        const testFiles = linked(proofCell, testLink);
        if (testFiles.length) {
          const sources = testFiles.map((f) => readFileSync(new URL(f, docsUrl), 'utf8')).join('\n');
          for (const title of ticks(proofCell)) {
            expect(sources, `test title "${title}"`).toContain(title);
          }
        }
        const srcFiles = linked(fileCell, srcLink);
        if (srcFiles.length) {
          const sources = srcFiles.map((f) => readFileSync(new URL(f, docsUrl), 'utf8')).join('\n');
          for (const symbol of ticks(fileCell).filter((t) => /^[A-Za-z_$][\w$]*(\(\))?$/.test(t))) {
            expect(sources, `source symbol "${symbol}"`).toContain(symbol.replace(/\(\)$/, ''));
          }
        }
      }
    }
    // Prose blocks citing a test file: every quoted title must be in one of them.
    for (const block of doc.split(/\n\n+/)) {
      if (block.startsWith('|')) continue;
      const testFiles = linked(block, testLink);
      if (!testFiles.length) continue;
      const sources = testFiles.map((f) => readFileSync(new URL(f, docsUrl), 'utf8')).join('\n');
      for (const title of ticks(block).filter((t) => t.includes(' '))) {
        expect(sources, `test title "${title}"`).toContain(title);
      }
    }
  });
});
