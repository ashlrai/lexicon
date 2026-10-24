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
  conflictNote,
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

  // Catches: a number or time corrected in passing ("it's 2024 not 2023")
  // was taken for a spelling, flagged by the hook and queued, and once
  // learned rewrote every 2023 in a transcript to 2024.
  it('takes no correction whose meant has no letter in it', () => {
    for (const t of ["It's 2024 not 2023", "it's 3:30, not 3:15", 'I said 42 not 24', '"10" not "12"', '2023 -> 2024']) {
      expect(parseCorrection(t), t).toBeUndefined();
    }
    expect(parseCorrection("it's k8s not kates")).toEqual({ heard: 'kates', meant: 'k8s' });
    expect(parseCorrection("it's GPT-4 not GPT for")).toEqual({ heard: 'GPT for', meant: 'GPT-4' });
  });

  // LEAD writes the em dash as an escape (tests/no-dashes.test.ts); it still leads a correction.
  it('takes an em dash before the correction as a lead, as a comma is', () => {
    expect(parseCorrection("ok\u2014it's Ashlr.AI not Ashler")).toEqual(ashlr);
    expect(parseCorrection('ok\u2014replace Ashler with Ashlr.AI')).toEqual(ashlr);
  });

  // macOS and iOS smart punctuation (and dictation) write U+2019, not '.
  it('accepts the typographic apostrophe in "it\u2019s"', () => {
    expect(parseCorrection('it\u2019s Ashlr.AI not Ashler')).toEqual(ashlr);
    expect(parseCorrection('It\u2019s Ashlr.AI, not Ashler.')).toEqual(ashlr);
    expect(parseCorrection('it\u2019s \u201cAshlr.AI\u201d not \u201cAshler\u201d')).toEqual(ashlr);
    expect(parseCorrection('not Ashler, it\u2019s Ashlr.AI')).toEqual(ashlr);
  });

  // Speech-to-text often spells the contraction out, or drops its apostrophe.
  it('accepts "it is X not Y" spelled out, and "its X not Y" without the apostrophe', () => {
    expect(parseCorrection('it is Ashlr.AI not Ashler')).toEqual(ashlr);
    expect(parseCorrection('It is Ashlr.AI, not Ashler.')).toEqual(ashlr);
    expect(parseCorrection('no, it is spelled Ashlr.AI not Ashler')).toEqual(ashlr);
    expect(parseCorrection('it is "Ashlr.AI" not "Ashler"')).toEqual(ashlr);
    expect(parseCorrection('not Ashler, it is Ashlr.AI')).toEqual(ashlr);
    expect(parseCorrection('its Ashlr.AI not Ashler')).toEqual(ashlr);
    expect(parseCorrection('Its Ashlr.AI, not Ashler.')).toEqual(ashlr);
    // "it is" must be its own words: "edit is" or "split is" never leads one.
    expect(parseCorrection('the edit is Ashlr.AI not Ashler')).toBeUndefined();
  });

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

const untrustedLoaded = (trust: 'untrusted' | 'changed' = 'untrusted'): LoadedLexicon => {
  const globalOnly: Lexicon = { version: 1, terms: lexicon.terms.filter((t) => t.scope === 'global') };
  return {
    merged: globalOnly,
    global: { path: '/fake/global.yaml', scope: 'global', lexicon: globalOnly, exists: true },
    projectTrust: trust,
    skippedProject: {
      path: '/fake/repo/.lexicon.yaml',
      scope: 'project',
      lexicon: { version: 1, terms: [{ canonical: 'Hostile Name', aliases: ['Versel'] }, { canonical: 'Vercel', aliases: ['Versal'] }] },
      exists: true,
    },
  };
};

describe('learnCorrection: an untrusted project lexicon that claims heard', () => {
  it('names the skipped file and its trust state, never its terms', async () => {
    store.loadLexicon.mockResolvedValue(untrustedLoaded());
    const result = await learnCorrection({ heard: 'Versel', meant: 'Vercel' }, { cwd: '/fake/repo' });
    // Still written globally, and the untrusted term is not merged or reported as a conflict.
    expect(store.addTerm).toHaveBeenCalledWith(expect.objectContaining({ canonical: 'Vercel' }), { cwd: '/fake/repo', scope: 'global' });
    expect(result.conflict).toBeUndefined();
    expect(result.untrustedProject).toEqual({ path: '/fake/repo/.lexicon.yaml', trust: 'untrusted' });
    expect(JSON.stringify(result)).not.toContain('Hostile Name');

    store.loadLexicon.mockResolvedValue(untrustedLoaded('changed'));
    expect((await learnCorrection({ heard: 'Versel', meant: 'Vercel' }, { cwd: '/fake/repo' })).untrustedProject?.trust).toBe('changed');
  });

  it('says nothing when the skipped file does not claim heard, or claims it for the same term', async () => {
    store.loadLexicon.mockResolvedValue(untrustedLoaded());
    expect((await learnCorrection({ heard: 'Verzel', meant: 'Vercel' }, { cwd: '/fake/repo' })).untrustedProject).toBeUndefined();
    expect((await learnCorrection({ heard: 'Versal', meant: 'Vercel' }, { cwd: '/fake/repo' })).untrustedProject).toBeUndefined();
  });

  it('the CLI prints a warn line that names the file and lexicon trust', async () => {
    store.loadLexicon.mockResolvedValue(untrustedLoaded());
    const { io, out } = captureIO();
    expect(await runLearn(['Versel', 'Vercel'], { cwd: '/fake/repo' }, io)).toBe(0);
    expect(out()).toContain('warn: the untrusted project lexicon /fake/repo/.lexicon.yaml also claims Versel for another term');
    expect(out()).toContain('lexicon trust');
    expect(out()).not.toContain('Hostile Name');
  });
});

describe('learnCorrection', () => {
  it('adds heard as an alias of an existing canonical (in its own scope)', async () => {
    const result = await learnCorrection({ heard: 'Ashlur', meant: 'ashlr.ai' }, { cwd: '/fake/repo' });
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashlur'], source: 'learned' },
      { cwd: '/fake/repo', scope: 'global' },
    );
    expect(result.created).toBe(false);
    expect(result.aliasAdded).toBe(true);
    expect(result.term.canonical).toBe('Ashlr.AI');
  });

  it('follows the term into the project scope when it lives there', async () => {
    await learnCorrection({ heard: 'kubernetties', meant: 'Kubernetes' }, { cwd: '/fake/repo' });
    expect(store.addTerm).toHaveBeenCalledWith(expect.anything(), { cwd: '/fake/repo', scope: 'project' });
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

  // Catches: learning a known correction again rewrote the lexicon file
  // (same bytes, new timestamp and inode), and with --project wrote a hollow
  // copy of the global term into the project file (created, no alias).
  it('reports aliasAdded:false and writes nothing when heard is already known', async () => {
    const result = await learnCorrection({ heard: 'ashler', meant: 'Ashlr.AI' });
    expect(result).toMatchObject({ created: false, aliasAdded: false, file: { path: '/fake/global.yaml' } });
    expect(result.term.canonical).toBe('Ashlr.AI');
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it('a known correction learned into another scope writes heard there, never a term without it', async () => {
    const result = await learnCorrection({ heard: 'Ashler', meant: 'Ashlr.AI' }, { cwd: '/fake/repo', scope: 'project' });
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashler'], source: 'learned' },
      { cwd: '/fake/repo', scope: 'project' },
    );
    expect(result.aliasAdded).toBe(true);
    // Already in that file too: nothing written.
    const project: Lexicon = { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'], scope: 'project' }] };
    store.loadLexicon.mockResolvedValueOnce({ ...loaded, project: { ...loaded.project!, lexicon: project } });
    store.addTerm.mockClear();
    const again = await learnCorrection({ heard: 'Ashler', meant: 'Ashlr.AI' }, { cwd: '/fake/repo', scope: 'project' });
    expect(store.addTerm).not.toHaveBeenCalled();
    expect(again).toMatchObject({ created: false, aliasAdded: false, file: { path: '/fake/repo/.lexicon.yaml' } });
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

  describe('a case-only correction', () => {
    it('creates the term when none exists, so every casing is rewritten to it', async () => {
      const result = await learnCorrection({ heard: 'ashlr', meant: 'Ashlr' }, { cwd: '/fake/repo' });
      expect(result).toMatchObject({ created: true, aliasAdded: true });
      const [term, opts] = store.addTerm.mock.calls[0] as [Term, { scope: string }];
      expect(term.canonical).toBe('Ashlr');
      expect(term.source).toBe('learned');
      expect(term.aliases.map((a) => a.toLowerCase())).not.toContain('ashlr');
      expect(opts).toEqual({ cwd: '/fake/repo', scope: 'global' });
    });

    it('recases an existing canonical in its own file, keeping its aliases and history', async () => {
      const zoe: Term = { canonical: 'zoë', aliases: ['zoey'], category: 'person', scope: 'global', createdAt: '2026-01-01T00:00:00.000Z' };
      const lex: Lexicon = { version: 1, terms: [zoe] };
      store.loadLexicon.mockResolvedValueOnce({ merged: { version: 1, terms: [{ ...zoe, hits: 9 }] }, global: { path: '/fake/global.yaml', scope: 'global', lexicon: lex, exists: true } });
      const result = await learnCorrection({ heard: 'zoë', meant: 'Zoë' }, { scope: 'project' });
      expect(store.addTerm).toHaveBeenCalledWith(
        { canonical: 'Zoë', aliases: ['zoey'], category: 'person', scope: 'global', createdAt: '2026-01-01T00:00:00.000Z' },
        { scope: 'global', merge: false },
      );
      expect(result).toMatchObject({ created: false, aliasAdded: true });
    });

    // Catches: `Zoe` plus U+0308 (as pasted from a macOS file name) is the
    // canonical `Zoë` the store holds, but compared as written it recased the
    // term to itself, rewrote the file and reported the alias added.
    it('writes nothing when meant is the canonical in another Unicode form', async () => {
      const result = await learnCorrection({ heard: 'zoe\u0308', meant: 'Zoe\u0308' });
      expect(store.addTerm).not.toHaveBeenCalled();
      expect(result).toMatchObject({ created: false, aliasAdded: false });
    });

    it('writes nothing when the canonical is already spelled that way', async () => {
      const result = await learnCorrection({ heard: 'zoë', meant: 'Zoë' });
      expect(store.addTerm).not.toHaveBeenCalled();
      expect(result).toMatchObject({ created: false, aliasAdded: false, file: { path: '/fake/global.yaml' } });
      expect(result.term.canonical).toBe('Zoë');
    });

    it('reports another term that also holds the spelling as an alias', async () => {
      const lex: Lexicon = {
        version: 1,
        terms: [
          { canonical: 'ashlr', aliases: [], scope: 'global' },
          { canonical: 'Ashlr.AI', aliases: ['Ashlr'], scope: 'global' },
        ],
      };
      store.loadLexicon.mockResolvedValueOnce({ merged: lex, global: { path: '/fake/global.yaml', scope: 'global', lexicon: lex, exists: true } });
      const result = await learnCorrection({ heard: 'ashlr', meant: 'Ashlr' });
      expect(result.conflict).toEqual({ canonical: 'Ashlr.AI', scope: 'global', as: 'alias', spelling: 'Ashlr' });
    });

    it('names an untrusted project lexicon that claims the spelling for another term', async () => {
      const base = untrustedLoaded();
      store.loadLexicon.mockResolvedValue({
        ...base,
        skippedProject: { ...base.skippedProject!, lexicon: { version: 1, terms: [{ canonical: 'Hostile Name', aliases: ['ashlr', 'zoë'] }] } },
      });
      const created = await learnCorrection({ heard: 'ashlr', meant: 'Ashlr' }, { cwd: '/fake/repo' });
      expect(created.untrustedProject).toEqual({ path: '/fake/repo/.lexicon.yaml', trust: 'untrusted' });
      expect(JSON.stringify(created)).not.toContain('Hostile Name');
      // Already spelled that way: nothing is written, the warning still comes back.
      const known = await learnCorrection({ heard: 'zoë', meant: 'Zoë' }, { cwd: '/fake/repo' });
      expect(store.addTerm).toHaveBeenCalledTimes(1);
      expect(known.untrustedProject).toEqual({ path: '/fake/repo/.lexicon.yaml', trust: 'untrusted' });
    });
  });

  it.each([
    [{ heard: '', meant: 'Ashlr.AI' }, /nothing to learn/],
    [{ heard: '   ', meant: 'Ashlr.AI' }, /nothing to learn/],
    [{ heard: 'Ashler', meant: '' }, /must not be empty/],
    [{ heard: 'Ashler', meant: 'Ashler' }, /same spelling/],
    // Case-only, but "ashler" already belongs to another term: the user has to pick.
    [{ heard: 'Ashler', meant: 'ashler' }, /"ashler" is an alias of "Ashlr\.AI"/],
    [{ heard: 'x'.repeat(61), meant: 'Ashlr.AI' }, /60 characters/],
  ])('refuses %j', async (correction, message) => {
    await expect(learnCorrection(correction)).rejects.toThrow(message);
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it.each([
    [{ heard: '', meant: 'Ashlr.AI' }],
    [{ heard: 'Ashler', meant: '' }],
    [{ heard: 'Ashler', meant: 'Ashler' }],
    [{ heard: 'Ashler', meant: 'ashler' }],
    [{ heard: 'x'.repeat(61), meant: 'Ashlr.AI' }],
  ])('refuses %j without an internal function name or CLI syntax an MCP/HTTP caller cannot run', async (correction) => {
    const err = await learnCorrection(correction).then(
      () => new Error('expected a refusal'),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toBe('expected a refusal');
    expect(err.message).not.toMatch(/learnCorrection/);
    expect(err.message).not.toMatch(/\blearn Ashler\b|lexicon remove/);
  });
});

// ---------------------------------------------------------------------------
// suggestCanonicalFor
// ---------------------------------------------------------------------------

// The one note builder CLI `learn --json`/`add --json`, MCP `add_term` and
// serve `POST /learn` share, so the three cannot drift apart.
describe('conflictNote', () => {
  const alias = { canonical: 'Ashlr.AI', scope: 'global' as const, as: 'alias' as const, spelling: 'Ashler' };
  const own = { canonical: 'Ashley', scope: 'project' as const, as: 'canonical' as const, spelling: 'Ashley' };

  it('names the scoped lexicon remove command for an alias by default', () => {
    expect(conflictNote([alias])).toBe(
      '"Ashler" is also an alias of "Ashlr.AI" (global), so it may still be corrected to that; if the user agrees, drop it with: lexicon remove "Ashlr.AI" --alias "Ashler" --global',
    );
  });

  it('names the remove_term call for the mcp audience', () => {
    expect(conflictNote([alias], 'mcp')).toBe(
      '"Ashler" is also an alias of "Ashlr.AI" (global), so it may still be corrected to that; if the user agrees, call remove_term with canonical "Ashlr.AI", alias "Ashler", scope "global".',
    );
  });

  // Catches: a canonical conflict said the spelling may be kept as written and
  // stopped there, with no way out, while an alias conflict names the remove.
  it('says a canonical conflict keeps the spelling as written and how to remove that term, one sentence per conflict', () => {
    expect(conflictNote([own, alias])).toMatch(
      /^"Ashley" is its own term \(project\), so it may still be kept as written; if the user never means it as its own term, drop it with: lexicon remove "Ashley" --project "Ashler" is also/,
    );
    expect(conflictNote([own], 'mcp')).toBe(
      '"Ashley" is its own term (project), so it may still be kept as written; if the user never means it as its own term, call remove_term with canonical "Ashley", scope "project".',
    );
  });
});

describe('suggestCanonicalFor', () => {
  // Catches: a decomposed accent (as pasted from a macOS file name) scored
  // 0.9 against the precomposed canonical it spells exactly.
  it('scores a spelling in another Unicode form as exact', () => {
    const lex: Lexicon = { version: 1, terms: [{ canonical: 'Caf\u00e9 Noir', aliases: ['Kaf\u00e9'] }] };
    expect(suggestCanonicalFor('Cafe\u0301 Noir', lex)[0]?.confidence).toBe(1);
    expect(suggestCanonicalFor('Kafe\u0301', lex)[0]?.confidence).toBe(1);
  });

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

  // Catches: `learn --json` with no correction printed only the usage on stderr, leaving stdout empty.
  it('--json prints { ok: false, error, nextStep } when there is nothing to learn', async () => {
    const { io, out } = captureIO();
    expect(await runLearn(['just', 'some', 'words'], { json: true, cwd: '/fake/repo' }, io)).toBe(1);
    expect(JSON.parse(out())).toEqual({
      ok: false,
      error: 'could not find a correction in "just some words"',
      nextStep: expect.stringContaining('lexicon learn <heard> <meant>'),
    });
    const meantOnly = captureIO();
    expect(await runLearn([], { json: true, from: 'that should be Ashlr.AI', cwd: '/fake/repo' }, meantOnly.io)).toBe(1);
    expect(JSON.parse(meantOnly.out())).toEqual({
      ok: false,
      error: '"that should be Ashlr.AI" names the intended spelling (Ashlr.AI) but not what was heard',
      nextStep: 'run: lexicon learn <heard> Ashlr.AI',
    });
  });

  // Catches: learn allows unknown options (so a bare `->` is a word), and
  // `lexicon learn --dry-run Ashlr.AI` saved "--dry-run" as an alias of Ashlr.AI.
  it('refuses a word that reads as an option and writes nothing', async () => {
    for (const words of [['--dry-run', 'Ashlr.AI'], ['--scope=project', 'Ashlr.AI'], ['-n', 'Ashler', 'Ashlr.AI']]) {
      const { io, out, err } = captureIO();
      expect(await runLearn(words, { json: true, cwd: '/fake/repo' }, io), words.join(' ')).toBe(1);
      expect(JSON.parse(out())).toEqual({
        ok: false,
        error: `unknown option '${words[0]}'; nothing was learned`,
        nextStep: expect.stringContaining('lexicon learn --help'),
      });
      expect(err()).toContain(`lexicon: unknown option '${words[0]}'`);
    }
    // An option-like word next to --from is refused too, not ignored.
    expect(await runLearn(['--yes'], { from: "it's Ashlr.AI not Ashlur", cwd: '/fake/repo' }, captureIO().io)).toBe(1);
    expect(store.addTerm).not.toHaveBeenCalled();
    // The arrows are still words.
    expect(await runLearn(['Ashlur', '->', 'Ashlr.AI'], { cwd: '/fake/repo' }, captureIO().io)).toBe(0);
    expect(await runLearn(['Ashlur', '=>', 'Ashlr.AI'], { cwd: '/fake/repo' }, captureIO().io)).toBe(0);
  });

  it('--from learns a parsed correction', async () => {
    const { io, out } = captureIO();
    const code = await runLearn([], { from: "it's Ashlr.AI not Ashlur", cwd: '/fake/repo' }, io);
    expect(code).toBe(0);
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashlur'], source: 'learned' },
      // path.resolve: unlike learnCorrection, the CLI resolves the --cwd it is
      // given, so '/fake/repo' is 'D:\\fake\\repo' on a Windows runner.
      { cwd: path.resolve('/fake/repo'), scope: 'global' },
    );
    expect(out()).toContain('learned Ashlur -> Ashlr.AI (alias added)');
  });

  it('warns when another term already claims the heard spelling', async () => {
    // "Ashler" is an alias of Ashlr.AI in the fixture, so learning it for
    // another name leaves two terms claiming it.
    const { io, out } = captureIO();
    expect(await runLearn(['ashler', 'Ashley'], { cwd: '/fake/repo' }, io)).toBe(0);
    expect(out()).toContain('warn: Ashler is also an alias of Ashlr.AI (global), so it may still be corrected to that');
    expect(out()).toContain('lexicon remove Ashlr.AI --alias Ashler --global');

    const ownTerm = captureIO();
    await runLearn(['Kubernetes', 'Kubectl'], { cwd: '/fake/repo' }, ownTerm.io);
    expect(ownTerm.out()).toContain('warn: Kubernetes is its own term (project), so it may still be kept as written; to drop that term: lexicon remove Kubernetes --project');

    const json = captureIO();
    await runLearn(['Kubernetes', 'Kubectl'], { cwd: '/fake/repo', json: true }, json.io);
    expect(JSON.parse(json.out())).toMatchObject({ conflict: { canonical: 'Kubernetes', scope: 'project', as: 'canonical', spelling: 'Kubernetes' } });
    expect(JSON.parse(json.out()).note).toBe(
      '"Kubernetes" is its own term (project), so it may still be kept as written; if the user never means it as its own term, drop it with: lexicon remove "Kubernetes" --project',
    );

    // Regression: `learn --json` had the conflict and no remove command, while
    // `add --json` pairs its conflicts with a `note` naming the scoped one.
    const alias = captureIO();
    expect(await runLearn(['ashler', 'Ashley'], { cwd: '/fake/repo', json: true }, alias.io)).toBe(0);
    expect(JSON.parse(alias.out()).note).toBe(
      '"Ashler" is also an alias of "Ashlr.AI" (global), so it may still be corrected to that; ' +
        'if the user agrees, drop it with: lexicon remove "Ashlr.AI" --alias "Ashler" --global',
    );

    // No conflict: no note.
    const plain = captureIO();
    expect(await runLearn(['Versel', 'Vercel'], { cwd: '/fake/repo', json: true }, plain.io)).toBe(0);
    expect(JSON.parse(plain.out())).not.toHaveProperty('note');
  });

  it('--project writes to the project lexicon', async () => {
    const { io } = captureIO();
    await runLearn(['Ashlur', 'Ashlr.AI'], { project: true, cwd: '/fake/repo' }, io);
    expect(store.addTerm).toHaveBeenCalledWith(expect.anything(), { cwd: path.resolve('/fake/repo'), scope: 'project' });
  });

  // Catches: `lexicon learn Ashler` said `could not find a correction in "Ashler"`
  // and printed the whole usage block, though one word is one spelling.
  it('says only one spelling was given and names the command with it, without the usage', async () => {
    const { io, out, err } = captureIO();
    expect(await runLearn(['Ashler'], { cwd: '/fake/repo' }, io)).toBe(1);
    expect(err()).toBe(
      'lexicon: only one spelling was given ("Ashler"); learn needs the spelling STT wrote and the one you meant, so nothing was learned\n' +
        'lexicon: run: lexicon learn Ashler <meant>, where <meant> is the spelling you want\n',
    );
    expect(out()).toBe('');
    const json = captureIO();
    expect(await runLearn(['Mason White'], { json: true, cwd: '/fake/repo' }, json.io)).toBe(1);
    expect(JSON.parse(json.out())).toEqual({
      ok: false,
      error: 'only one spelling was given ("Mason White"); learn needs the spelling STT wrote and the one you meant, so nothing was learned',
      // Quoted for the shell: single quotes on POSIX and in PowerShell alike.
      nextStep: "run: lexicon learn 'Mason White' <meant>, where <meant> is the spelling you want",
    });
    expect(json.err()).not.toContain('usage:');
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it('prints the supported forms when nothing matched', async () => {
    const { io, out, err } = captureIO();
    const code = await runLearn([], { from: 'not sure it\'s ready' }, io);
    expect(code).toBe(1);
    expect(err()).toContain('could not find a correction');
    expect(err()).toContain("it's Ashlr.AI, not Ashler");
    expect(err()).toContain('Ashler -> Ashlr.AI');
    expect(out()).toBe('');
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  // Catches: `learn X X --json` printed only `error`, with no nextStep like every other learn refusal.
  it('--json names the next step when heard and meant are the same spelling', async () => {
    for (const words of [['Ashlr.AI', 'Ashlr.AI'], ['Ashlr.AI ', ' Ashlr.AI']]) {
      const { io, out, err } = captureIO();
      expect(await runLearn(words, { json: true, cwd: '/fake/repo' }, io)).toBe(1);
      expect(JSON.parse(out())).toEqual({
        ok: false,
        error: '"Ashlr.AI" and "Ashlr.AI" are the same spelling; nothing to learn',
        nextStep: 'run: lexicon learn <heard> Ashlr.AI, where <heard> is the misspelling STT wrote',
      });
      expect(err()).toContain('lexicon: run: lexicon learn <heard> Ashlr.AI');
    }
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it('asks for the heard form when the sentence only names the spelling', async () => {
    const { io, out, err } = captureIO();
    const code = await runLearn([], { from: 'spelled Zoë' }, io);
    expect(code).toBe(1);
    expect(err()).toContain('not what was heard');
    expect(err()).toContain("lexicon learn <heard> 'Zoë'");
    expect(out()).toBe('');
    // Catches: JSON quoting ("Z$oe") left a `$` for a POSIX shell to expand.
    const dollar = captureIO();
    expect(await runLearn([], { from: 'spelled Z$oe' }, dollar.io)).toBe(1);
    expect(dollar.err()).toContain("lexicon learn <heard> 'Z$oe'");
  });

  it('--json prints only the error object on stdout when there is nothing to learn (usage goes to stderr)', async () => {
    const { io, out, err } = captureIO();
    expect(await runLearn([], { json: true }, io)).toBe(1);
    expect(JSON.parse(out())).toEqual({ ok: false, error: 'nothing to learn', nextStep: expect.any(String) });
    expect(out()).not.toContain('usage:');
    expect(err()).toContain('usage: lexicon learn');
  });

  it('--json prints the result', async () => {
    const { io, out } = captureIO();
    const code = await runLearn(['Ashlur', 'Ashlr.AI'], { json: true }, io);
    expect(code).toBe(0);
    const payload = JSON.parse(out()) as { heard: string; meant: string; aliasAdded: boolean };
    expect(payload).toMatchObject({ heard: 'Ashlur', meant: 'Ashlr.AI', aliasAdded: true });
  });

  // Catches: a spelling the term already held printed "learned Ashler ->
  // Ashlr.AI (already known)", which reads as a write, and `--json` had no
  // `unchanged`, unlike serve POST /learn.
  it('says nothing was added when heard is already an alias, in text and --json', async () => {
    const text = captureIO();
    expect(await runLearn(['Ashler', 'Ashlr.AI'], { cwd: '/fake/repo' }, text.io)).toBe(0);
    expect(text.out().split('\n')[0]).toBe('Nothing was added: "Ashler" was already an alias of "Ashlr.AI". (global: /fake/global.yaml)');
    expect(text.out()).not.toContain('learned');

    const json = captureIO();
    expect(await runLearn(['Ashler', 'Ashlr.AI'], { cwd: '/fake/repo', json: true }, json.io)).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({
      ok: true,
      created: false,
      aliasAdded: false,
      unchanged: true,
      note: 'Nothing was added: "Ashler" was already an alias of "Ashlr.AI".',
    });
  });

  // Catches: --json dumped the whole lexicon file (every term in it) under `file` and had no `path`, unlike learn_correction.
  it('--json gives path and the file path/scope only, not the file\'s terms', async () => {
    const { io, out } = captureIO();
    expect(await runLearn(['Ashlur', 'Ashlr.AI'], { json: true }, io)).toBe(0);
    const payload = JSON.parse(out()) as Record<string, unknown>;
    expect(payload.path).toBe('/fake/global.yaml');
    expect(payload.file).toEqual({ path: '/fake/global.yaml', scope: 'global' });
    expect(out()).not.toContain('Mason Wyatt');
    expect(Object.keys(payload).sort()).toEqual(['aliasAdded', 'created', 'file', 'heard', 'meant', 'ok', 'path', 'term']);
    expect(Object.keys(payload)[0]).toBe('ok');
  });
});
