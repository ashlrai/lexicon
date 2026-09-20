/**
 * The live demonstration: the thing a stranger actually judges the product by.
 *
 * Two promises are load-bearing and easy to break by accident, so they are
 * tested rather than assumed: a demonstration never ends in "no changes"
 * (whatever state the lexicon is in), and `lexicon normalize` with an empty
 * lexicon still shows the product working when a human typed the text, while
 * leaving a piped stream byte-exact.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_LEXICON, buildDemonstration, demonstrate, isEmptyLexicon } from '../src/core/demo.js';
import type { Lexicon } from '../src/core/types.js';
import { runNormalize } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

const lex = (terms: Lexicon['terms']): Lexicon => ({ version: 1, terms });

describe('buildDemonstration', () => {
  it('uses the user\'s own terms, and prefers a real mishearing over a spacing variant', () => {
    const demo = buildDemonstration(
      lex([
        // "Ashlr AI" and "Ashlr" are the same letters as the canonical; "Ashler" is
        // what a speech engine actually produces, and is the only convincing demo.
        { canonical: 'Ashlr.AI', aliases: ['Ashlr AI', 'Ashlr', 'Ashler'], category: 'brand' },
      ]),
    );
    expect(demo?.heard).toContain('Ashler');
    expect(demo?.heard).not.toContain('Ashlr.AI');
    expect(demo?.corrected).toContain('Ashlr.AI');
    expect(demo?.usedExample).toBe(false);
  });

  it('puts a person and a thing in one sentence, in that order', () => {
    const demo = buildDemonstration(
      lex([
        { canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' },
        { canonical: 'Mason Wyatt', aliases: ['Mason Wiatt'], category: 'person' },
      ]),
    );
    expect(demo?.heard).toBe('can you ask Mason Wiatt where the Ashler migration landed');
    expect(demo?.corrected).toBe('can you ask Mason Wyatt where the Ashlr.AI migration landed');
    expect(demo?.terms).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });

  it('honours `prefer`, so setup shows the name it just seeded rather than a pack term', () => {
    const l = lex([
      { canonical: 'Kubernetes', aliases: ['Cooper Netties'], category: 'product' },
      { canonical: 'Hetzner', aliases: ['head sner'], category: 'brand' },
    ]);
    expect(buildDemonstration(l)?.terms).toEqual(['Kubernetes']);
    expect(buildDemonstration(l, { prefer: ['Hetzner'] })?.terms).toEqual(['Hetzner']);
  });

  it('returns undefined rather than a demonstration in which nothing happens', () => {
    expect(buildDemonstration(lex([]))).toBeUndefined();
    // A term with no aliases cannot be misheard into anything.
    expect(buildDemonstration(lex([{ canonical: 'Acme', aliases: [] }]))).toBeUndefined();
    // An "alias" equal to the canonical would splice in a sentence that is already correct.
    expect(buildDemonstration(lex([{ canonical: 'Acme', aliases: ['acme', 'ACME'] }]))).toBeUndefined();
  });
});

describe('demonstrate', () => {
  it.each([
    ['an empty lexicon', lex([])],
    ['terms with no aliases', lex([{ canonical: 'Acme', aliases: [] }])],
  ])('always shows a real correction, falling back to the example for %s', (_label, l) => {
    const demo = demonstrate(l);
    expect(demo.usedExample).toBe(true);
    expect(demo.corrected).not.toBe(demo.heard);
    expect(demo.result.changed).toBe(true);
    expect(demo.terms.length).toBeGreaterThan(0);
  });

  it('does not claim the example was used when the user has real terms', () => {
    const demo = demonstrate(lex([{ canonical: 'Pydantic', aliases: ['pie dentic'] }]));
    expect(demo.usedExample).toBe(false);
    expect(demo.corrected).toContain('Pydantic');
  });

  it('DEMO_LEXICON can always demonstrate itself (the fallback has no fallback)', () => {
    expect(buildDemonstration(DEMO_LEXICON)).toBeDefined();
    expect(isEmptyLexicon(DEMO_LEXICON)).toBe(false);
  });
});

describe('lexicon normalize with nothing set up', () => {
  let cwd: string;
  let prevHome: string | undefined;
  let prevLexiconPath: string | undefined;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-demo-cwd-'));
    prevHome = process.env.HOME;
    prevLexiconPath = process.env.LEXICON_PATH;
    // Point the store at a file that does not exist, so "no lexicon at all" is the state.
    process.env.LEXICON_PATH = path.join(cwd, 'nope', 'lexicon.yaml');
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevLexiconPath === undefined) delete process.env.LEXICON_PATH;
    else process.env.LEXICON_PATH = prevLexiconPath;
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('stands in the example terms for text typed as arguments, and says so on stderr', async () => {
    const io = makeIO();
    const code = await runNormalize(['ping', 'ashler'], { cwd }, io);
    expect(code).toBe(0);
    expect(io.out).toBe('ping Ashlr.AI\n');
    expect(io.err).toContain('no terms yet');
    expect(io.err).toContain('built-in example');
    expect(io.err).toContain('lexicon setup');
    // An example is a demonstration, never a write.
    expect(io.err).toContain('nothing was written');
  });

  it('leaves piped input byte-exact: a pipeline must not be rewritten by terms the user never chose', async () => {
    const io = makeIO();
    const code = await runNormalize([], { cwd }, io, async () => 'ping ashler and pass the sass');
    expect(code).toBe(0);
    expect(io.out).toBe('ping ashler and pass the sass');
    expect(io.err).toBe('');
  });
});

/**
 * The starter-pack default, pinned because it is a deliberate product
 * decision rather than an accident of the prompt helper: on a terminal the
 * recommended packs are already ticked, so pressing Enter installs them, and
 * declining is one keystroke (`n`). Without a terminal nothing is installed.
 */
describe('starter packs default on in the interactive flow', () => {
  it('a multi-choice checklist starts fully selected, so Enter accepts the recommendation', async () => {
    const { PassThrough } = await import('node:stream');
    const { createPrompter } = await import('../src/cli/prompt.js');
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createPrompter({ input, output });
    const answer = prompter.choose(
      'add starter packs',
      [
        { label: 'developer', value: 'developer' },
        { label: 'ai', value: 'ai' },
        { label: 'voice-tools', value: 'voice-tools' },
      ],
      { multi: true },
    );
    input.write('\n'); // Enter, changing nothing
    expect(await answer).toEqual(['developer', 'ai', 'voice-tools']);
    prompter.close();
  });

  it('typing `n` unticks everything, so declining stays one keystroke', async () => {
    const { PassThrough } = await import('node:stream');
    const { createPrompter } = await import('../src/cli/prompt.js');
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createPrompter({ input, output });
    const answer = prompter.choose('add starter packs', [{ label: 'developer', value: 'developer' }], { multi: true });
    input.write('n\n');
    input.write('\n');
    expect(await answer).toEqual([]);
    prompter.close();
  });
});
