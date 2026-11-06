import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// Extra XXX marker shapes beyond tests/fixtures/xxx-marker: CRLF files,
// other languages' comment styles, ticket-style `XXX-123` and several names in
// one marker comment. In every shape the marker is never proposed and the
// names beside it are.

async function harvestFiles(files: Record<string, string>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-xxx-extras-')));
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(repo, name), text);
    return await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('harvest XXX marker extra shapes', () => {
  it('reads names from XXX comments in CRLF files', async () => {
    const found = await harvestFiles({ 'crlf.ts': '// XXX: PulsarGate\r\nexport const a = 1;\r\n' });
    expect(found.map((c) => c.canonical)).toEqual(['PulsarGate']);
  });

  it('reads names from XXX comments in other languages', async () => {
    const found = await harvestFiles({
      'a.rs': '// XXX: RustyForge\nfn main() {}\n',
      'b.go': '// XXX: GopherHub\npackage main\n',
      'c.swift': '/* XXX: SwiftLoom */\n',
    });
    const names = found.map((c) => c.canonical).sort();
    expect(names).toEqual(expect.arrayContaining(['GopherHub', 'RustyForge', 'SwiftLoom']));
    expect(names).not.toContain('XXX');
  });

  it('keeps every name in a multi-name XXX comment and ignores ticket suffixes', async () => {
    const found = await harvestFiles({
      'multi.ts': '// XXX(JIRA-42): CometRouter and DuskIndexer; XXX-123 XXX!\n',
    });
    const names = found.map((c) => c.canonical);
    expect(names).toEqual(expect.arrayContaining(['CometRouter', 'DuskIndexer']));
    for (const n of names) expect(n).not.toMatch(/^XXX/);
  });
});
