/**
 * `lexicon pack` community commands: search, add (preview + confirm), update,
 * remove, show and validate, against a fixture registry index in a temp dir.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  runPackAdd,
  runPackList,
  runPackRemove,
  runPackSearch,
  runPackShow,
  runPackUpdate,
  runPackValidate,
} from '../src/cli/cmd-pack.js';
import { sha256Hex } from '../src/core/index.js';
import { makeIO, scripted } from './helpers.js';

const PACK = `name: cardiology
title: Cardiology terms
description: Heart words.
version: 1
author: example
homepage: https://example.com/cardiology
terms:
  - canonical: Metoprolol
    aliases: [metoprolol, metropolol]
    category: brand
`;

let dir: string;
let globalPath: string;
let indexPath: string;

function writeIndex(version: string, packText: string = PACK): string {
  const file = path.join(dir, 'cardiology.yaml');
  writeFileSync(file, packText);
  const p = path.join(dir, 'index.yaml');
  writeFileSync(
    p,
    `version: 1
packs:
  - author: example
    name: cardiology
    title: Cardiology terms
    description: Heart words.
    homepage: https://example.com/cardiology
    version: "${version}"
    terms: 1
    aliases: 2
    checksum: ${sha256Hex(Buffer.from(packText))}
    url: ./cardiology.yaml
`,
  );
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lexicon-pack-cli-test-'));
  globalPath = path.join(dir, 'lexicon.yaml');
  indexPath = writeIndex('1');
});

const baseOpts = () => ({ globalPath, registry: indexPath });

describe('pack search', () => {
  it('needs --registry', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', { globalPath }, io)).toBe(1);
    expect(io.err).toContain('--registry');
  });

  it('finds the pack and prints install help', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', baseOpts(), io)).toBe(0);
    expect(io.out).toContain('example/cardiology');
    expect(io.out).toContain('lexicon pack add');
  });

  it('prints JSON with --json', async () => {
    const io = makeIO();
    expect(await runPackSearch('cardio', { ...baseOpts(), json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.packs[0].ref).toBe('example/cardiology');
    expect(parsed.packs[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pack add (community)', () => {
  it('needs --registry for a ref', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { globalPath }, io)).toBe(1);
    expect(io.err).toContain('--registry');
  });

  it('previews without writing when --json and no --yes', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), json: true }, io)).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.preview).toBe(true);
    expect(parsed.ref).toBe('example/cardiology');
    expect(parsed.terms[0].canonical).toBe('Metoprolol');
    const { existsSync } = await import('node:fs');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('asks on a terminal and declines by default', async () => {
    const io = makeIO();
    const p = scripted(['n']); // confirm: no
    const code = await runPackAdd(['example/cardiology'], baseOpts(), io, {
      createPrompter: () => p,
      isInteractive: () => true,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('declined; nothing written.');
    const { existsSync } = await import('node:fs');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('--yes installs after the preview', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    expect(io.out).toContain('installed example/cardiology');
    expect(io.out).toContain('1 added');
  });

  it('rejects an unknown ref with the index contents', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/neurology'], { ...baseOpts(), yes: true }, io)).toBe(1);
    expect(io.err).toContain('example/cardiology');
  });
});

describe('pack update', () => {
  it('reports current when the index is unchanged', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackUpdate([], { ...baseOpts(), yes: true }, io2)).toBe(0);
    expect(io2.out).toContain('already current');
  });

  it('previews the diff and applies with --yes', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const v2 = `${PACK}  - canonical: Stent\n    aliases: [stent]\n    category: product\n`;
    const index2 = writeIndex('2', v2);
    const io2 = makeIO();
    expect(await runPackUpdate(['example/cardiology'], { globalPath, registry: index2, yes: true }, io2)).toBe(0);
    expect(io2.out).toContain('update available');
    expect(io2.out).toContain('Stent');
    expect(io2.out).toContain('updated example/cardiology');
  });

  it('asks per update on a terminal', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const v2 = `${PACK}  - canonical: Stent\n    aliases: [stent]\n    category: product\n`;
    const index2 = writeIndex('2', v2);
    const io2 = makeIO();
    const p = scripted(['n']); // decline the update
    const code = await runPackUpdate(['example/cardiology'], { globalPath, registry: index2 }, io2, {
      createPrompter: () => p,
      isInteractive: () => true,
    });
    expect(code).toBe(0);
    expect(io2.out).toContain('skipped; nothing written.');
  });
});

describe('pack remove (community)', () => {
  it('removes via the cache without --registry', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackRemove('example/cardiology', { globalPath }, io2)).toBe(0);
    expect(io2.out).toContain('removed 1 term');
  });
});

describe('pack show (community)', () => {
  it('downloads through --registry into a temp dir', async () => {
    const io = makeIO();
    expect(await runPackShow('example/cardiology', baseOpts(), io)).toBe(0);
    expect(io.out).toContain('example/cardiology');
    expect(io.out).toContain('Metoprolol');
  });
});

describe('pack validate', () => {
  it('accepts the example pack', async () => {
    const io = makeIO();
    expect(await runPackValidate(path.join(dir, 'cardiology.yaml'), { globalPath }, io)).toBe(0);
    expect(io.out).toContain('valid');
  });

  it('fails on an ordinary-word canonical', async () => {
    const bad = path.join(dir, 'badpack.yaml');
    writeFileSync(bad, 'name: badpack\ntitle: Bad\ndescription: x\nversion: 1\nterms:\n  - canonical: Sauce\n    aliases: [sawce]\n');
    const io = makeIO();
    expect(await runPackValidate(bad, { globalPath }, io)).toBe(1);
    expect(io.out).toContain('error:');
    expect(io.out).toContain('ordinary English word');
  });
});

describe('pack list', () => {
  it('shows installed community packs', async () => {
    const io = makeIO();
    expect(await runPackAdd(['example/cardiology'], { ...baseOpts(), yes: true }, io)).toBe(0);
    const io2 = makeIO();
    expect(await runPackList({ globalPath }, io2)).toBe(0);
    expect(io2.out).toContain('community packs installed:');
    expect(io2.out).toContain('example/cardiology');
  });
});
