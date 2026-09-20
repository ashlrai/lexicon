/**
 * suggestTerms(): the four suggestion kinds mined from a fabricated voice
 * history, ranking, dedupe, evidence sanitization, empty inputs, the
 * performance budget, and `lexicon suggest` (runSuggest) against mocked
 * collaborators.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSuggest } from '../src/cli/cmd-suggest.js';
import type { SuggestDeps } from '../src/cli/cmd-suggest.js';
import type { PromptChoice, Prompter } from '../src/cli/prompt.js';
import { makeIO } from './helpers.js';
import {
  AUTO_APPLY_CONFIDENCE,
  ProjectTrustError,
  STALE_AFTER_DAYS,
  loadVoiceHistory,
  normalize,
  suggestTerms,
  voiceHistoryPath,
} from '../src/core/index.js';
import type {
  Lexicon,
  LoadedLexicon,
  SuggestInput,
  Term,
  TermSuggestion,
  VoiceHistoryEntry,
} from '../src/core/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const OLD = new Date(NOW - 90 * DAY).toISOString();
const FRESH = new Date(NOW - 2 * DAY).toISOString();

function makeLexicon(extra: Term[] = [], locusNever: string[] = []): Lexicon {
  return {
    version: 1,
    terms: [
      { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'], category: 'brand', hits: 5, createdAt: OLD, scope: 'global' },
      { canonical: 'Vercel', aliases: [], hits: 2, createdAt: OLD, scope: 'global' },
      { canonical: 'Locus', aliases: [], hits: 1, createdAt: OLD, never: locusNever, scope: 'global' },
      { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', hits: 4, createdAt: OLD, scope: 'global' },
      // Old, never hit, never dictated: stale.
      { canonical: 'Zebrafish Labs', aliases: ['zebra fish labs'], hits: 0, createdAt: OLD, scope: 'global' },
      // Old, never hit, but dictated: not stale.
      { canonical: 'Quokka', aliases: [], hits: 0, createdAt: OLD, scope: 'global' },
      // Never hit but young: not stale.
      { canonical: 'Newling', aliases: [], hits: 0, createdAt: FRESH, scope: 'global' },
      ...extra,
    ],
  };
}

function load(lexicon: Lexicon, globalPath = '/tmp/lexicon-suggest-test/lexicon.yaml'): LoadedLexicon {
  return { merged: lexicon, global: { path: globalPath, scope: 'global', lexicon, exists: true } };
}

/** A history entry; `output` defaults to `raw` (nothing was corrected when it was recorded). */
function entry(raw: string, output = raw): VoiceHistoryEntry {
  return { at: '2026-09-10T00:00:00.000Z', raw, output, model: 'base.en', ms: { record: 1, transcribe: 2, normalize: 3 } };
}

/** The spec's history: one line per signal, repeated as the thresholds require. */
function makeHistory(): VoiceHistoryEntry[] {
  return [
    // Uncorrected garble, twice: alias suggestion.
    entry('ping ashlur about it'),
    entry('did ashlur reply yet'),
    // Corrected by a phonetic guess three times: promote to an exact alias.
    entry('deploy to versal', 'deploy to Vercel'),
    entry('deploy to versal now', 'deploy to Vercel now'),
    entry('deploy to versal tonight', 'deploy to Vercel tonight'),
    // A new name, three times, mid-sentence: term suggestion.
    entry('talk to Siobhan Reilly'),
    entry('talk to Siobhan Reilly about the launch'),
    entry('i pinged Siobhan Reilly again'),
    // An ordinary word rewritten under an older rule (the current matcher leaves "lacks" alone): never.
    entry('the process lacks locks', 'the process Locus locks'),
    // Known term dictated correctly: keeps Quokka from going stale, proposes nothing.
    entry('ask Quokka about the quokka photos'),
    // Part of an existing multi-word canonical: not a new term.
    entry('mason wyeth is here', 'Mason Wyatt is here'),
    entry('tell Mason first'),
    entry('tell Mason first'),
    entry('tell Mason first'),
  ];
}

function find(list: readonly TermSuggestion[], kind: TermSuggestion['kind'], canonical: string, alias?: string): TermSuggestion | undefined {
  return list.find(
    (s) => s.kind === kind && s.canonical.toLowerCase() === canonical.toLowerCase() && (alias === undefined || s.alias?.toLowerCase() === alias.toLowerCase()),
  );
}

function rankOf(s: TermSuggestion): number {
  return s.confidence * Math.log(1 + Math.max(s.count, 1));
}

// ---------------------------------------------------------------------------
// suggestTerms
// ---------------------------------------------------------------------------

describe('suggestTerms: kinds', () => {
  let out: TermSuggestion[];
  beforeAll(async () => {
    out = await suggestTerms({ loaded: load(makeLexicon()), history: makeHistory(), now: NOW });
  });

  it('the fixture matcher leaves "lacks" and "ashlur" alone, so the history is consistent with the current rules', () => {
    expect(normalize('the process lacks locks', makeLexicon()).changed).toBe(false);
    expect(normalize('deploy to versal', makeLexicon()).replacements[0]).toMatchObject({ canonical: 'Vercel', reason: 'phonetic' });
  });

  it('proposes an uncorrected recurring garble as an alias of the term it sounds like', () => {
    const s = find(out, 'alias', 'Ashlr.AI', 'ashlur');
    expect(s).toBeDefined();
    expect(s?.count).toBe(2);
    expect(s?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(s?.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
    expect(s?.evidence).toEqual(['ping ashlur about it', 'did ashlur reply yet']);
    expect(s?.reason).toMatch(/uncorrected 2 times/);
  });

  it('proposes promoting a repeated phonetic guess to an exact alias', () => {
    const s = find(out, 'alias', 'Vercel', 'versal');
    expect(s).toBeDefined();
    expect(s?.count).toBe(3);
    expect(s?.reason).toBe('the matcher would guess this as Vercel (3 times in history); make it an exact alias');
    expect(s?.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
    expect(s?.evidence).toHaveLength(3);
  });

  it('proposes a recurring capitalized name that is not in the lexicon as a new term, with aliases', () => {
    const s = find(out, 'term', 'Siobhan Reilly');
    expect(s).toBeDefined();
    expect(s?.count).toBe(3);
    expect(s?.aliases?.length).toBeGreaterThan(0);
    expect(s?.aliases).not.toContain('Siobhan Reilly');
    expect(s?.evidence[0]).toBe('talk to Siobhan Reilly');
  });

  it('proposes protecting an ordinary word that an older rule rewrote to a term', () => {
    const s = find(out, 'never', 'Locus', 'lacks');
    expect(s).toBeDefined();
    expect(s?.count).toBe(1);
    expect(s?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(s?.confidence).toBeLessThanOrEqual(0.7);
    expect(s?.reason).toMatch(/^ordinary word rewritten by guess/);
    expect(s?.evidence).toEqual(['the process lacks locks']);
  });

  it('flags an old never-hit term whose spellings never occur in the history as stale', () => {
    const s = find(out, 'stale', 'Zebrafish Labs');
    expect(s).toBeDefined();
    expect(s?.confidence).toBe(0.3);
    expect(s?.count).toBe(0);
    expect(s?.reason).toBe('never matched in 90 days');
    expect(find(out, 'stale', 'Quokka')).toBeUndefined();
    expect(find(out, 'stale', 'Newling')).toBeUndefined();
    expect(find(out, 'stale', 'Ashlr.AI')).toBeUndefined();
  });

  it('never proposes an ordinary word as an alias, nor a lexicon word or a part of one as a new term', () => {
    expect(find(out, 'alias', 'Locus', 'lacks')).toBeUndefined();
    expect(find(out, 'term', 'Quokka')).toBeUndefined();
    expect(find(out, 'term', 'Mason')).toBeUndefined();
    expect(find(out, 'term', 'Mason Wyatt')).toBeUndefined();
    expect(out.filter((s) => s.kind === 'term').map((s) => s.canonical)).toEqual(['Siobhan Reilly']);
  });

  it('ranks by confidence * log(1 + count), descending', () => {
    for (let i = 1; i < out.length; i++) expect(rankOf(out[i - 1])).toBeGreaterThanOrEqual(rankOf(out[i]));
    expect(out[out.length - 1].kind).toBe('stale');
  });

  it('skips a never-word the term already protects', async () => {
    const list = await suggestTerms({ loaded: load(makeLexicon([], ['lacks'])), history: makeHistory(), now: NOW });
    expect(find(list, 'never', 'Locus', 'lacks')).toBeUndefined();
    expect(find(list, 'alias', 'Vercel', 'versal')).toBeDefined();
  });
});

describe('suggestTerms: dedupe, evidence, limits, empty input', () => {
  it('reports one alias suggestion per (canonical, alias) even when several signals cite it', async () => {
    const history = [
      ...makeHistory(),
      // The same garble, guessed by the current matcher when recorded (promotion signal) and left alone elsewhere.
      entry('ashlur is down', 'Ashlr.AI is down'),
      entry('ashlur is down', 'Ashlr.AI is down'),
      entry('ashlur is down', 'Ashlr.AI is down'),
    ];
    const out = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW });
    const ashlur = out.filter((s) => s.kind === 'alias' && s.alias?.toLowerCase() === 'ashlur');
    expect(ashlur).toHaveLength(1);
    // The current matcher guesses "ashlur" on all five lines (the two that were recorded uncorrected
    // came from an older lexicon), so the promotion signal wins and the count is not 2 + 5.
    expect(ashlur[0].count).toBe(5);
    expect(ashlur[0].confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
    expect(ashlur[0].reason).toBe('the matcher would guess this as Ashlr.AI (5 times in history); make it an exact alias');
    expect(ashlur[0].evidence).toContain('ping ashlur about it');
    expect(ashlur[0].evidence).toContain('ashlur is down');
    expect(ashlur[0].evidence.length).toBeLessThanOrEqual(5);
  });

  it('sanitizes evidence: no control characters, at most 120 characters, at most 5 snippets', async () => {
    const long = `${'blah '.repeat(60)}ashlur ${'more '.repeat(40)}`;
    const history = [
      entry('ping ashlur \x1b[31mabout\x1b[0m it\x07\n'),
      entry(long),
      ...[1, 2, 3, 4, 5, 6].map((i) => entry(`note ${i} ashlur`)),
    ];
    const out = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW });
    const s = find(out, 'alias', 'Ashlr.AI', 'ashlur');
    expect(s).toBeDefined();
    expect(s?.count).toBe(8);
    expect(s?.evidence.length).toBeLessThanOrEqual(5);
    for (const e of s?.evidence ?? []) {
      expect(e).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(Array.from(e).length).toBeLessThanOrEqual(120);
    }
    expect(s?.evidence[0]).toBe('ping ashlur about it');
    expect(s?.evidence[1]).toContain('ashlur');
    expect(s?.evidence[1]?.length).toBeLessThanOrEqual(120);
  });

  it('caps the list at `limit` (default 20)', async () => {
    const history: VoiceHistoryEntry[] = [];
    for (let i = 0; i < 30; i++) for (let k = 0; k < 3; k++) history.push(entry(`talk to Person${i}name Surname${i}x`));
    const all = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW, limit: 100 });
    expect(all.length).toBeGreaterThan(20);
    const capped = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW });
    expect(capped).toHaveLength(20);
    const five = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW, limit: 5 });
    expect(five).toHaveLength(5);
    expect(five).toEqual(all.slice(0, 5));
  });

  it('returns nothing for an empty lexicon and empty history', async () => {
    expect(await suggestTerms({ loaded: load({ version: 1, terms: [] }), history: [], now: NOW })).toEqual([]);
  });

  it('with no history only the stale check can fire', async () => {
    const out = await suggestTerms({ loaded: load(makeLexicon()), history: [], now: NOW });
    expect(out.map((s) => s.kind)).toEqual(['stale', 'stale']);
    expect(out.map((s) => s.canonical).sort()).toEqual(['Quokka', 'Zebrafish Labs']);
  });

  it('ignores malformed history entries', async () => {
    const bad = [{ at: 'x' }, { raw: 1, output: 'y' }, entry('   ')] as unknown as VoiceHistoryEntry[];
    const out = await suggestTerms({ loaded: load(makeLexicon()), history: bad, now: NOW });
    expect(out.every((s) => s.kind === 'stale')).toBe(true);
  });

  it('does not propose a lone capitalized word at a sentence start, but does mid-sentence', async () => {
    const start = [1, 2, 3].map(() => entry('Zorblax needs a review'));
    const mid = [1, 2, 3].map(() => entry('the Zorblax needs a review'));
    const a = await suggestTerms({ loaded: load(makeLexicon()), history: start, now: NOW });
    expect(find(a, 'term', 'Zorblax')).toBeUndefined();
    const b = await suggestTerms({ loaded: load(makeLexicon()), history: mid, now: NOW });
    expect(find(b, 'term', 'Zorblax')).toBeDefined();
  });

  it('does not propose something that sounds like an existing term as a new term', async () => {
    const history = [1, 2, 3].map(() => entry('deploy to Versell please'));
    const out = await suggestTerms({ loaded: load(makeLexicon()), history, now: NOW });
    expect(find(out, 'term', 'Versell')).toBeUndefined();
  });
});

describe('suggestTerms: harvest (cwd)', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-suggest-repo-'));
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'src', 'widget.ts'),
      [
        'export class ZorbleWidget {}',
        'export function makeZorble(): ZorbleWidget { return new ZorbleWidget(); }',
        'const a: ZorbleWidget = makeZorble();',
        'const b: ZorbleWidget = makeZorble();',
        'const c: ZorbleWidget = makeZorble();',
        'const d: ZorbleWidget = makeZorble();',
        'export const all = [a, b, c, d];',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('adds harvest candidates as term suggestions below the auto-apply line, with the harvester aliases', async () => {
    const out = await suggestTerms({ loaded: load(makeLexicon()), history: [], now: NOW, cwd: repo });
    const s = find(out, 'term', 'ZorbleWidget');
    expect(s).toBeDefined();
    expect(s?.count).toBeGreaterThanOrEqual(5);
    expect(s?.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
    expect(s?.reason).toMatch(/^seen \d+ times in .* \(harvest/);
    expect(s?.aliases).toContain('Zorble Widget');
    expect(s?.category).toBe('identifier');
    expect(s?.evidence.every((e) => e.length <= 120)).toBe(true);
  });

  it('skips harvest candidates already in the lexicon', async () => {
    const lexicon = makeLexicon([{ canonical: 'ZorbleWidget', aliases: [], hits: 1, scope: 'global' }]);
    const out = await suggestTerms({ loaded: load(lexicon), history: [], now: NOW, cwd: repo });
    expect(find(out, 'term', 'ZorbleWidget')).toBeUndefined();
  });

  it('without cwd nothing is harvested', async () => {
    const out = await suggestTerms({ loaded: load(makeLexicon()), history: [], now: NOW });
    expect(find(out, 'term', 'ZorbleWidget')).toBeUndefined();
  });
});

describe('suggestTerms: performance', () => {
  it('handles 1000 history lines and 200 terms in under 100 ms', async () => {
    const terms: Term[] = [];
    for (let i = 0; i < 200; i++) {
      terms.push({ canonical: `Brand${i}corp`, aliases: [`brand ${i} corp`, `brandcorp${i}`], hits: i % 3, createdAt: OLD });
    }
    const lexicon: Lexicon = { version: 1, terms };
    const vocabulary =
      'please deploy the new build to versal tonight and ping ashlur about the process which lacks locks then talk to Siobhan Reilly before the standup so we can ship the release notes and update the changelog for brand7corp customers'.split(' ');
    const history: VoiceHistoryEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      const n = 6 + (i % 14);
      const words: string[] = [];
      for (let j = 0; j < n; j++) words.push(vocabulary[(i * 7 + j * 3) % vocabulary.length]);
      const raw = words.join(' ');
      // Every third line was corrected when it was recorded.
      history.push(entry(raw, i % 3 === 0 ? normalize(raw, lexicon).output : raw));
    }
    const input: SuggestInput = { loaded: load(lexicon), history, now: NOW };
    await suggestTerms(input); // warm up the JIT once, as a long-running MCP server would be
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const out = await suggestTerms(input);
      best = Math.min(best, performance.now() - t0);
      expect(out.length).toBeGreaterThan(0);
    }
    expect(best).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// loadVoiceHistory
// ---------------------------------------------------------------------------

describe('loadVoiceHistory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-suggest-history-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('reads <config dir>/voice/history.jsonl next to the global lexicon and skips malformed lines', async () => {
    const globalPath = path.join(dir, 'lexicon.yaml');
    const file = voiceHistoryPath(globalPath);
    expect(file).toBe(path.join(dir, 'voice', 'history.jsonl'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        JSON.stringify(entry('one', 'One')),
        'not json',
        JSON.stringify({ at: 'x', raw: 42, output: 'no' }),
        '',
        JSON.stringify({ at: 'y', raw: 'two', output: 'two' }),
      ].join('\n'),
    );
    const entries = await loadVoiceHistory(globalPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ raw: 'one', output: 'One', model: 'base.en', ms: { record: 1, transcribe: 2, normalize: 3 } });
    expect(entries[1]).toEqual({ at: 'y', raw: 'two', output: 'two' });
  });

  it('returns [] when the file is missing', async () => {
    expect(await loadVoiceHistory(path.join(dir, 'nowhere', 'lexicon.yaml'))).toEqual([]);
  });

  it('keeps only the newest 1000 entries', async () => {
    const globalPath = path.join(dir, 'big', 'lexicon.yaml');
    const file = voiceHistoryPath(globalPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 1100; i++) lines.push(JSON.stringify({ at: 't', raw: `line ${i}`, output: `line ${i}` }));
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    const entries = await loadVoiceHistory(globalPath);
    expect(entries).toHaveLength(1000);
    expect(entries[0].raw).toBe('line 100');
    expect(entries[999].raw).toBe('line 1099');
  });

  it('honours LEXICON_PATH when no path is given', async () => {
    const globalPath = path.join(dir, 'env', 'lexicon.yaml');
    const file = voiceHistoryPath(globalPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(entry('via env'))}\n`);
    const saved = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    try {
      expect((await loadVoiceHistory()).map((e) => e.raw)).toEqual(['via env']);
    } finally {
      if (saved === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// runSuggest (CLI) against mocked collaborators
// ---------------------------------------------------------------------------


/**
 * A deliberately more forgiving prompter than the shared `scripted`: running
 * out of answers returns the default instead of throwing, and `choose` always
 * takes the first option. These suites drive `--apply` loops whose prompt count
 * depends on the suggestions, so they cannot script an exact sequence.
 */
function lenientPrompter(answers: string[]): Prompter & { asked: string[]; closed: boolean } {
  const queue = [...answers];
  const fake = {
    asked: [] as string[],
    closed: false,
    async ask(question: string, opts?: { default?: string }): Promise<string> {
      fake.asked.push(question);
      if (queue.length === 0) throw new Error(`no scripted answer for: ${question}`);
      const a = queue.shift() as string;
      return a === '' && opts?.default !== undefined ? opts.default : a;
    },
    async confirm(question: string, def = false): Promise<boolean> {
      fake.asked.push(question);
      const a = (queue.shift() ?? '').toLowerCase();
      return a === '' ? def : a.startsWith('y');
    },
    async choose<T>(_question: string, choices: PromptChoice<T>[]): Promise<T[]> {
      return [choices[0].value];
    },
    close(): void {
      fake.closed = true;
    },
  };
  return fake;
}

const FIXED: TermSuggestion[] = [
  { kind: 'alias', canonical: 'Vercel', alias: 'versal', reason: 'the matcher would guess this as Vercel (3 times in history); make it an exact alias', confidence: 0.9, evidence: ['deploy to versal'], count: 3 },
  { kind: 'term', canonical: 'Siobhan Reilly', reason: 'capitalized name seen 5 times in transcripts and not in the lexicon', confidence: 0.85, evidence: ['talk to Siobhan Reilly'], count: 5, aliases: ['Siobhan Reilli'] },
  { kind: 'alias', canonical: 'Ashlr.AI', alias: 'ashlur', reason: '"ashlur" was left uncorrected 2 times and sounds like Ashlr.AI', confidence: 0.78, evidence: ['ping \x1b[31mashlur'], count: 2 },
  { kind: 'never', canonical: 'Locus', alias: 'lacks', reason: 'ordinary word rewritten by guess 1 time under earlier rules', confidence: 0.55, evidence: ['the process lacks locks'], count: 1 },
  { kind: 'stale', canonical: 'Zebrafish Labs', reason: 'never matched in 90 days', confidence: 0.3, evidence: [], count: 0 },
];

interface MockStore {
  deps: SuggestDeps;
  added: Array<{ term: Term; scope: string | undefined }>;
  removed: Array<{ canonical: string; scope: string | undefined }>;
  inputs: SuggestInput[];
}

function mockStore(suggestions: TermSuggestion[] = FIXED, lexicon = makeLexicon()): MockStore {
  const store: MockStore = { added: [], removed: [], inputs: [], deps: {} };
  const loaded = load(lexicon, '/tmp/mock/lexicon.yaml');
  store.deps = {
    loadLexicon: async () => loaded,
    suggest: async (input) => {
      store.inputs.push(input);
      return suggestions;
    },
    addTerm: async (term, opts) => {
      store.added.push({ term, scope: opts?.scope });
      return { file: loaded.global, term: { ...term, scope: opts?.scope ?? 'global' }, created: term.canonical === 'Siobhan Reilly' };
    },
    removeTerm: async (canonical, opts) => {
      store.removed.push({ canonical, scope: opts?.scope });
      return true;
    },
    now: NOW,
  };
  return store;
}

describe('runSuggest', () => {
  it('prints a table by default, sanitized, with the kind/canonical/alias/count/confidence/reason columns', async () => {
    const store = mockStore();
    const io = makeIO();
    expect(await runSuggest({}, io, store.deps)).toBe(0);
    const lines = io.out.split('\n');
    expect(lines[0]).toMatch(/^kind\s+canonical\s+alias\s+count\s+confidence\s+reason$/);
    expect(lines[2]).toMatch(/^alias\s+Vercel\s+versal\s+3\s+0\.90\s+the matcher would guess this as Vercel \(3 times in history\); make it an exact alias$/);
    expect(io.out).toContain('stale  Zebrafish Labs');
    expect(io.out).toContain('5 suggestions.');
    expect(io.out).not.toContain('\x1b');
    expect(store.added).toEqual([]);
    expect(store.removed).toEqual([]);
    // No --cwd: nothing is harvested, the history comes from the store's global path.
    expect(store.inputs[0].cwd).toBeUndefined();
    expect(store.inputs[0].loaded.global.path).toBe('/tmp/mock/lexicon.yaml');
    expect(store.inputs[0].now).toBe(NOW);
  });

  it('--json prints the suggestions as JSON and applies nothing', async () => {
    const store = mockStore();
    const io = makeIO();
    expect(await runSuggest({ json: true }, io, store.deps)).toBe(0);
    expect(JSON.parse(io.out)).toEqual(FIXED);
    expect(store.added).toEqual([]);
  });

  it('--limit and --cwd reach the engine (an explicit cwd turns the harvest on)', async () => {
    const store = mockStore();
    const io = makeIO();
    const cwd = path.join(os.tmpdir(), 'lexicon-suggest-cwd');
    expect(await runSuggest({ json: true, limit: 7, cwd }, io, store.deps)).toBe(0);
    expect(store.inputs[0].limit).toBe(7);
    expect(store.inputs[0].cwd).toBe(path.resolve(cwd));
  });

  it('--harvest without a directory harvests the cwd; with one, that directory', async () => {
    const store = mockStore();
    expect(await runSuggest({ json: true, harvest: true }, makeIO(), store.deps)).toBe(0);
    expect(store.inputs[0].cwd).toBe(process.cwd());
    expect(await runSuggest({ json: true, harvest: '/tmp/other-repo' }, makeIO(), store.deps)).toBe(0);
    expect(store.inputs[1].cwd).toBe(path.resolve('/tmp/other-repo'));
  });

  it('--yes applies every suggestion at or above 0.80 through the store and never removes a term', async () => {
    const store = mockStore();
    const io = makeIO();
    expect(await runSuggest({ yes: true }, io, store.deps)).toBe(0);
    expect(store.added.map((a) => [a.term.canonical, a.term.aliases, a.scope])).toEqual([
      ['Vercel', ['versal'], 'global'],
      ['Siobhan Reilly', ['Siobhan Reilli'], 'global'],
    ]);
    expect(store.added[1].term.source).toBe('learned');
    expect(store.removed).toEqual([]);
    expect(io.out).toContain('alias versal -> Vercel in /tmp/mock/lexicon.yaml');
    expect(io.out).toContain('added Siobhan Reilly');
    expect(io.out).toContain('applied 2 suggestions, skipped 3 below 0.80');
  });

  it('--yes --project writes new terms to the project lexicon and aliases to the term\'s own file', async () => {
    const lexicon = makeLexicon();
    lexicon.terms[1].scope = 'project';
    const store = mockStore(FIXED, lexicon);
    expect(await runSuggest({ yes: true, project: true }, makeIO(), store.deps)).toBe(0);
    expect(store.added.map((a) => [a.term.canonical, a.scope])).toEqual([
      ['Vercel', 'project'],
      ['Siobhan Reilly', 'project'],
    ]);
  });

  it('--apply walks the suggestions with y/n/a/q and applies each kind through the right store call', async () => {
    const store = mockStore();
    const io = makeIO();
    // versal: y, Siobhan: n, ashlur: a (applies it and the never), stale: asked separately -> y
    const prompter = lenientPrompter(['y', 'n', 'a', 'y']);
    expect(await runSuggest({ apply: true }, io, { ...store.deps, prompter })).toBe(0);
    expect(store.added.map((a) => [a.term.canonical, a.term.aliases, a.term.never])).toEqual([
      ['Vercel', ['versal'], undefined],
      ['Ashlr.AI', ['ashlur'], undefined],
      ['Locus', [], ['lacks']],
    ]);
    expect(store.removed).toEqual([{ canonical: 'Zebrafish Labs', scope: 'global' }]);
    expect(prompter.asked).toHaveLength(4);
    expect(io.out).toContain('[1/5]');
    expect(io.out).toContain('never lacks for Locus');
    expect(io.out).toContain('removed Zebrafish Labs');
    expect(io.out).toContain('applied 4 suggestions, skipped 1');
    expect(io.out).not.toContain('\x1b[31m');
    // A prompter passed in is the caller's to close.
    expect(prompter.closed).toBe(false);
  });

  it('--apply: q stops, Enter keeps a term (default n for stale) and applies the rest (default y)', async () => {
    const store = mockStore();
    const io = makeIO();
    const prompter = lenientPrompter(['', 'q']);
    expect(await runSuggest({ apply: true }, io, { ...store.deps, prompter })).toBe(0);
    expect(store.added.map((a) => a.term.canonical)).toEqual(['Vercel']);
    expect(io.out).toContain('applied 1 suggestion, skipped 4');

    const store2 = mockStore([FIXED[4]]);
    const io2 = makeIO();
    expect(await runSuggest({ apply: true }, io2, { ...store2.deps, prompter: lenientPrompter(['']) })).toBe(0);
    expect(store2.removed).toEqual([]);
    expect(io2.out).toContain('applied 0 suggestions, skipped 1');
  });

  it('--apply without a terminal or a prompter fails with a hint; --apply and --yes are exclusive', async () => {
    const store = mockStore();
    const io = makeIO();
    expect(await runSuggest({ apply: true }, io, store.deps)).toBe(1);
    expect(io.err).toContain('needs a terminal');
    expect(io.err).toContain('--yes');
    const io2 = makeIO();
    expect(await runSuggest({ apply: true, yes: true }, io2, store.deps)).toBe(1);
    expect(io2.err).toContain('mutually exclusive');
  });

  it('prints a note and returns 0 when there is nothing to suggest', async () => {
    const store = mockStore([]);
    const io = makeIO();
    expect(await runSuggest({}, io, store.deps)).toBe(0);
    expect(io.out).toContain('no suggestions');
    const io2 = makeIO();
    expect(await runSuggest({ json: true }, io2, store.deps)).toBe(0);
    expect(JSON.parse(io2.out)).toEqual([]);
  });

  it('reports a store error and returns 1; an untrusted project write stops the run', async () => {
    const store = mockStore();
    store.deps.loadLexicon = async () => {
      throw new Error('bad yaml \x1b[2J');
    };
    const io = makeIO();
    expect(await runSuggest({}, io, store.deps)).toBe(1);
    expect(io.err).toBe('lexicon: bad yaml \n');

    const store2 = mockStore();
    store2.deps.addTerm = async () => {
      throw new ProjectTrustError('/tmp/proj/.lexicon.yaml', 'untrusted');
    };
    const io2 = makeIO();
    expect(await runSuggest({ yes: true }, io2, store2.deps)).toBe(1);
    expect(io2.err).toContain('/tmp/proj/.lexicon.yaml');
  });

  it('warns about a skipped untrusted project lexicon on stderr', async () => {
    const store = mockStore();
    const loaded = load(makeLexicon(), '/tmp/mock/lexicon.yaml');
    store.deps.loadLexicon = async () => ({
      ...loaded,
      projectTrust: 'untrusted',
      skippedProject: { path: '/tmp/proj/.lexicon.yaml', scope: 'project', lexicon: { version: 1, terms: [] }, exists: true },
    });
    const io = makeIO();
    expect(await runSuggest({ json: true }, io, store.deps)).toBe(0);
    expect(io.err).toContain('untrusted project lexicon skipped: /tmp/proj/.lexicon.yaml');
  });
});

describe('constants', () => {
  it('exposes the thresholds other surfaces code against', () => {
    expect(AUTO_APPLY_CONFIDENCE).toBe(0.8);
    expect(STALE_AFTER_DAYS).toBe(30);
  });
});
