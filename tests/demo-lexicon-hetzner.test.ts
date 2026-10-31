/**
 * Issue #217: Hetzner belongs in DEMO_LEXICON, so the cheapest demo of the
 * product -- `npx @ashlr/lexicon normalize "deploy on head sner"` with no
 * lexicon at all -- corrects a name the docs and the example file have always
 * used as the hosting brand STT garbles.
 *
 * The guardrails around it stay where they were: the example fires on
 * argument text only when the merged lexicon is empty, it announces itself on
 * stderr, it never writes, and it never touches a piped stream.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_LEXICON } from '../src/core/demo.js';
import { normalize } from '../src/core/normalize.js';
import { runNormalize } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

describe('DEMO_LEXICON Hetzner term (issue #217)', () => {
  it('carries Hetzner with head sner among its aliases', () => {
    const hetzner = DEMO_LEXICON.terms.find((t) => t.canonical === 'Hetzner');
    expect(hetzner).toBeDefined();
    expect(hetzner?.aliases).toContain('head sner');
  });

  it('turns head sner into Hetzner as an exact alias match', () => {
    const result = normalize('deploy on head sner', DEMO_LEXICON);
    expect(result.output).toBe('deploy on Hetzner');
    expect(result.changed).toBe(true);
    expect(result.replacements).toEqual([
      expect.objectContaining({ original: 'head sner', replacement: 'Hetzner', reason: 'alias' }),
    ]);
  });
});

describe('lexicon normalize "deploy on head sner" with nothing set up', () => {
  let cwd: string;
  let prevLexiconPath: string | undefined;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-demo-hetzner-'));
    prevLexiconPath = process.env.LEXICON_PATH;
    // Point the store at a file that does not exist, so "no lexicon at all" is the state.
    process.env.LEXICON_PATH = path.join(cwd, 'nope', 'lexicon.yaml');
  });

  afterEach(async () => {
    if (prevLexiconPath === undefined) delete process.env.LEXICON_PATH;
    else process.env.LEXICON_PATH = prevLexiconPath;
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('prints deploy on Hetzner and announces the example on stderr', async () => {
    const io = makeIO();
    const code = await runNormalize(['deploy on head sner'], { cwd }, io);
    expect(code).toBe(0);
    expect(io.out).toBe('deploy on Hetzner\n');
    expect(io.err).toContain('no terms yet');
    expect(io.err).toContain('built-in example');
    expect(io.err).toContain('nothing was written');
    // An example is a demonstration, never a write.
    expect(await fs.stat(process.env.LEXICON_PATH as string).catch(() => null)).toBeNull();
  });

  it('names every example term in the notice, Hetzner included', async () => {
    const io = makeIO();
    await runNormalize(['deploy on head sner'], { cwd }, io);
    expect(io.err).toContain(`(${DEMO_LEXICON.terms.map((t) => t.canonical).join(', ')})`);
    expect(io.err).toContain('Hetzner');
  });

  it('reports the correction under --diff as an alias hit', async () => {
    const io = makeIO();
    const code = await runNormalize(['deploy on head sner'], { cwd, diff: true }, io);
    expect(code).toBe(0);
    expect(io.out).toBe('deploy on Hetzner\n');
    expect(io.err).toContain('"head sner" -> "Hetzner" (alias, 1.00)');
  });

  it('leaves the same words byte-exact on stdin: a pipeline is never rewritten by example terms', async () => {
    const io = makeIO();
    const code = await runNormalize([], { cwd }, io, async () => 'deploy on head sner');
    expect(code).toBe(0);
    expect(io.out).toBe('deploy on head sner');
    expect(io.err).toBe('');
  });
});
