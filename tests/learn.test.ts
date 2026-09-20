import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lexicon, LoadedLexicon, Term } from '../src/core/types.js';

const store = vi.hoisted(() => ({
  loadLexicon: vi.fn(),
  addTerm: vi.fn(),
}));

// learn.ts talks to disk only through store.js; everything else (matcher, suggest) is real.
vi.mock('../src/core/store.js', () => store);

import {
  CORRECTION_EXAMPLES,
  learnCorrection,
  parseCorrection,
  suggestCanonicalFor,
} from '../src/core/learn.js';
import { correctionFromArgs, runLearn } from '../src/cli/cmd-learn.js';
import type { IO } from '../src/cli/commands.js';

const lexicon: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'], category: 'brand', scope: 'global' },
    { canonical: 'Kubernetes', aliases: ['cooper netties'], category: 'product', scope: 'project' },
    { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', scope: 'global' },
    { canonical: 'Zoë', aliases: [], category: 'person', scope: 'global' },
  ],
};

const loaded: LoadedLexicon = {
  merged: lexicon,
  global: { path: '/fake/global.yaml', scope: 'global', lexicon, exists: true },
  project: { path: '/fake/repo/.lexicon.yaml', scope: 'project', lexicon: { version: 1, terms: [] }, exists: true },
};

beforeEach(() => {
  store.loadLexicon.mockResolvedValue(loaded);
  store.addTerm.mockImplementation(async (term: Term, opts?: { scope?: string }) => {
    const scope = opts?.scope ?? 'global';
    return {
      file: { path: scope === 'project' ? '/fake/repo/.lexicon.yaml' : '/fake/global.yaml', scope, lexicon, exists: true },
      term: { ...term, scope },
      created: !lexicon.terms.some((t) => t.canonical.toLowerCase() === term.canonical.toLowerCase()),
    };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseCorrection
// ---------------------------------------------------------------------------

describe('parseCorrection', () => {
  const ashlr = { heard: 'Ashler', meant: 'Ashlr.AI' };

  it.each([
    ["it's Ashlr.AI not Ashler", ashlr],
    ["it's Ashlr.AI, not Ashler", ashlr],
    ["It's Ashlr.AI, not Ashler.", ashlr],
    ["no, it's Ashlr.AI not Ashler!", ashlr],
    ["it's spelled Ashlr.AI not Ashler", ashlr],
    ['I said Ashlr.AI not Ashler', ashlr],
    ['I meant Ashlr.AI, not Ashler', ashlr],
    ['"Ashlr.AI" not "Ashler"', ashlr],
    ['`Ashlr.AI` not `Ashler`', ashlr],
    ['“Mason Wyatt” not “Mason Wyeth”', { heard: 'Mason Wyeth', meant: 'Mason Wyatt' }],
    ['not Ashler, Ashlr.AI', ashlr],
    ["not Ashler, it's Ashlr.AI", ashlr],
    ['replace Ashler with Ashlr.AI', ashlr],
    ['please replace Ashler with Ashlr.AI', ashlr],
    ['Ashler -> Ashlr.AI', ashlr],
    ['Ashler => Ashlr.AI', ashlr],
    ['Ashler → Ashlr.AI', ashlr],
    ['Ashler should be Ashlr.AI', ashlr],
    ["it's Mason Wyatt not Mason Wyeth", { heard: 'Mason Wyeth', meant: 'Mason Wyatt' }],
    // A sentence after the correction is ignored; a period ends a bare word unless something follows it directly.
    ["it's Ashlr.AI not Ashlur. remember that.", { heard: 'Ashlur', meant: 'Ashlr.AI' }],
    ["no, it's Ashlr.AI not Ashler. Now deploy it to Vercel.", ashlr],
    ["it's Ashlr.AI not Ashlur! save it", { heard: 'Ashlur', meant: 'Ashlr.AI' }],
    ["it's Entire.io not entire i o", { heard: 'entire i o', meant: 'Entire.io' }],
    ["it's README.md not read me", { heard: 'read me', meant: 'README.md' }],
    // Bare "replace X with Y" / "X should be Y" need one side to look like a name...
    ['replace ashler with Ashlr.AI', { heard: 'ashler', meant: 'Ashlr.AI' }],
    ['replace the ashler with the Ashlr team', { heard: 'the ashler', meant: 'the Ashlr team' }],
    ['replace cube control with k8s', { heard: 'cube control', meant: 'k8s' }],
    ['replace icon with logo', { heard: 'icon', meant: 'logo' }],
    ['ashler should be ashlr', { heard: 'ashler', meant: 'ashlr' }],
    ['the ashler should be re-frame', { heard: 'the ashler', meant: 're-frame' }],
    // ...unless a side is quoted, which is explicit.
    ['replace "the icon" with "the new logo"', { heard: 'the icon', meant: 'the new logo' }],
    ['replace the icon with `the new logo`', { heard: 'the icon', meant: 'the new logo' }],
    ['“the icon” should be “the new logo”', { heard: 'the icon', meant: 'the new logo' }],
  ])('parses %j', (text, expected) => {
    expect(parseCorrection(text)).toEqual(expected);
  });

  it.each([
    'replace the icon with the new logo',
    'please replace the old header with the new banner',
    'the icon should be the new logo',
    'the old header should read the new banner',
  ])('rejects the edit request %j (no name-like token on either bare side)', (text) => {
    expect(parseCorrection(text)).toBeUndefined();
  });

  it.each([
    ['spelled Zoë', 'Zoë'],
    ["it's spelled Zoë", 'Zoë'],
    ['spell it Zoë', 'Zoë'],
    ['that should be Ashlr.AI', 'Ashlr.AI'],
  ])('%j names only the intended spelling (heard left empty for the caller)', (text, meant) => {
    expect(parseCorrection(text)).toEqual({ heard: '', meant });
  });

  it.each([
    "not sure it's ready",
    'I said hello',
    'please deploy the thing today',
    "it's not ready",
    "it's not ready, not done",
    'Ashlr.AI not Ashler', // bare "X not Y" is only accepted when quoted
    "it's Ashlr.AI not Ashler, please remember", // a comma clause after the heard side is not a sentence boundary
    'the file is not README.md. open it', // no correction verb
    "it's Ashlr.AI not Ashler not really",
    "it's Ashlr.AI not ashlr.ai", // heard equals meant (case-insensitive)
    `it's ${'x'.repeat(61)} not y`, // > 60 chars
    "it's",
    '',
    '   ',
  ])('rejects %j', (text) => {
    expect(parseCorrection(text)).toBeUndefined();
  });

  it('strips trailing punctuation and collapses whitespace', () => {
    expect(parseCorrection("it's   Ashlr.AI   not   Ashler...")).toEqual(ashlr);
    expect(parseCorrection('Ashler ->  Ashlr.AI?')).toEqual(ashlr);
  });

  it('ships one example per pattern', () => {
    expect(CORRECTION_EXAMPLES.length).toBeGreaterThanOrEqual(10);
    for (const example of CORRECTION_EXAMPLES) {
      expect(parseCorrection(example)?.meant).toBe('Ashlr.AI');
    }
  });
});

// ---------------------------------------------------------------------------
// learnCorrection
// ---------------------------------------------------------------------------

describe('learnCorrection', () => {
  it('adds heard as an alias of an existing canonical (in its own scope)', async () => {
    const result = await learnCorrection({ heard: 'Ashlur', meant: 'ashlr.ai' }, { cwd: '/fake/repo' });
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashlur'], source: 'learned' },
      // path.resolve, because runLearn resolves the cwd it is handed and
      // '/fake/repo' becomes 'D:\\fake\\repo' on a Windows runner.
      { cwd: path.resolve('/fake/repo'), scope: 'global' },
    );
    expect(result.created).toBe(false);
    expect(result.aliasAdded).toBe(true);
    expect(result.term.canonical).toBe('Ashlr.AI');
  });

  it('follows the term into the project scope when it lives there', async () => {
    await learnCorrection({ heard: 'kubernetties', meant: 'Kubernetes' }, { cwd: '/fake/repo' });
    expect(store.addTerm).toHaveBeenCalledWith(expect.anything(), { cwd: path.resolve('/fake/repo'), scope: 'project' });
  });

  it('an explicit scope overrides the term scope', async () => {
    await learnCorrection({ heard: 'Ashlur', meant: 'Ashlr.AI' }, { cwd: '/fake/repo', scope: 'project' });
    expect(store.addTerm).toHaveBeenCalledWith(expect.anything(), { cwd: '/fake/repo', scope: 'project' });
  });

  it('resolves meant through an existing alias', async () => {
    const result = await learnCorrection({ heard: 'Mason Wyatte', meant: 'Mason Wyeth' });
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Mason Wyatt', aliases: ['Mason Wyatte'], source: 'learned' },
      { scope: 'global' },
    );
    expect(result.aliasAdded).toBe(true);
  });

  it('reports aliasAdded:false when heard is already known', async () => {
    const result = await learnCorrection({ heard: 'ashler', meant: 'Ashlr.AI' });
    expect(result.aliasAdded).toBe(false);
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: [], source: 'learned' },
      { scope: 'global' },
    );
  });

  it('creates a new learned term with heard first, then suggested aliases', async () => {
    const result = await learnCorrection({ heard: 'open klaw', meant: 'OpenClaw' }, { cwd: '/fake/repo' });
    expect(result.created).toBe(true);
    expect(result.aliasAdded).toBe(true);
    const [term, opts] = store.addTerm.mock.calls[0] as [Term, { scope: string }];
    expect(term.canonical).toBe('OpenClaw');
    expect(term.source).toBe('learned');
    expect(term.aliases[0]).toBe('open klaw');
    expect(term.aliases).toContain('Open Claw');
    expect(term.aliases.map((a) => a.toLowerCase())).not.toContain('openclaw');
    expect(new Set(term.aliases.map((a) => a.toLowerCase())).size).toBe(term.aliases.length);
    expect(opts).toEqual({ cwd: '/fake/repo', scope: 'global' });
  });

  it.each([
    [{ heard: '', meant: 'Ashlr.AI' }, /nothing to learn/],
    [{ heard: '   ', meant: 'Ashlr.AI' }, /nothing to learn/],
    [{ heard: 'Ashler', meant: '' }, /must not be empty/],
    [{ heard: 'Ashler', meant: 'ashler' }, /same spelling/],
    [{ heard: 'x'.repeat(61), meant: 'Ashlr.AI' }, /60 characters/],
  ])('refuses %j', async (correction, message) => {
    await expect(learnCorrection(correction)).rejects.toThrow(message);
    expect(store.addTerm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// suggestCanonicalFor
// ---------------------------------------------------------------------------

describe('suggestCanonicalFor', () => {
  it('ranks phonetic and near-spelling matches, best first', () => {
    const hits = suggestCanonicalFor('ashlur', lexicon);
    expect(hits[0]?.term.canonical).toBe('Ashlr.AI');
    expect(hits[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches via aliases and multi-word phrases', () => {
    expect(suggestCanonicalFor('mason wyat', lexicon)[0]?.term.canonical).toBe('Mason Wyatt');
    expect(suggestCanonicalFor('cubernetes', lexicon)[0]?.term.canonical).toBe('Kubernetes');
  });

  it('returns confidence 1 for an exact alias regardless of case', () => {
    expect(suggestCanonicalFor('ASHLER', lexicon)[0]).toMatchObject({ confidence: 1 });
  });

  it('drops candidates below 0.6 and caps at three', () => {
    expect(suggestCanonicalFor('banana', lexicon)).toEqual([]);
    expect(suggestCanonicalFor('', lexicon)).toEqual([]);
    const crowded: Lexicon = {
      version: 1,
      terms: ['Ashlr.AI', 'Ashlar', 'Ashley', 'Ashlee', 'Ashlyn'].map((c) => ({ canonical: c, aliases: [] })),
    };
    const hits = suggestCanonicalFor('ashler', crowded);
    expect(hits.length).toBe(3);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].confidence).toBeGreaterThanOrEqual(hits[i].confidence);
  });
});

// ---------------------------------------------------------------------------
// CLI: lexicon learn
// ---------------------------------------------------------------------------

function captureIO(): { io: IO; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('lexicon learn (CLI)', () => {
  it('correctionFromArgs treats two words as heard/meant and anything else as a sentence', () => {
    expect(correctionFromArgs(['Ashler', 'Ashlr.AI'], undefined)).toEqual({ heard: 'Ashler', meant: 'Ashlr.AI' });
    expect(correctionFromArgs(['Ashler', '->', 'Ashlr.AI'], undefined)).toEqual({ heard: 'Ashler', meant: 'Ashlr.AI' });
    expect(correctionFromArgs(['ignored'], "it's Ashlr.AI not Ashler")).toEqual({ heard: 'Ashler', meant: 'Ashlr.AI' });
    expect(correctionFromArgs([], undefined)).toBeUndefined();
  });

  it('--from learns a parsed correction', async () => {
    const { io, out } = captureIO();
    const code = await runLearn([], { from: "it's Ashlr.AI not Ashlur", cwd: '/fake/repo' }, io);
    expect(code).toBe(0);
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashlur'], source: 'learned' },
      { cwd: '/fake/repo', scope: 'global' },
    );
    expect(out()).toContain('learned Ashlur -> Ashlr.AI (alias added)');
  });

  it('--project writes to the project lexicon', async () => {
    const { io } = captureIO();
    await runLearn(['Ashlur', 'Ashlr.AI'], { project: true, cwd: '/fake/repo' }, io);
    expect(store.addTerm).toHaveBeenCalledWith(expect.anything(), { cwd: '/fake/repo', scope: 'project' });
  });

  it('prints the supported forms when nothing matched', async () => {
    const { io, out, err } = captureIO();
    const code = await runLearn([], { from: 'not sure it\'s ready' }, io);
    expect(code).toBe(1);
    expect(err()).toContain('could not find a correction');
    expect(out()).toContain("it's Ashlr.AI, not Ashler");
    expect(out()).toContain('Ashler -> Ashlr.AI');
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it('asks for the heard form when the sentence only names the spelling', async () => {
    const { io, out, err } = captureIO();
    const code = await runLearn([], { from: 'spelled Zoë' }, io);
    expect(code).toBe(1);
    expect(err()).toContain('not what was heard');
    expect(out()).toContain('lexicon learn <heard> "Zoë"');
  });

  it('--json prints the result', async () => {
    const { io, out } = captureIO();
    const code = await runLearn(['Ashlur', 'Ashlr.AI'], { json: true }, io);
    expect(code).toBe(0);
    const payload = JSON.parse(out()) as { heard: string; meant: string; aliasAdded: boolean };
    expect(payload).toMatchObject({ heard: 'Ashlur', meant: 'Ashlr.AI', aliasAdded: true });
  });
});
