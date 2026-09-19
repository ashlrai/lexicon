import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_FORMATS,
  IMPORT_FORMAT_INFO,
  detectImportFormat,
  importLexicon,
  isImportFormat,
} from '../src/core/importers/index.js';
import { parseCsv } from '../src/core/importers/csv-parse.js';
import { exportLexicon } from '../src/core/exporters/index.js';
import type { Lexicon, Term } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures (inline: realistic exports from each app)
// ---------------------------------------------------------------------------

const WISPR_CSV =
  '﻿word,replacement\r\n' +
  'Ashler,Ashlr.AI\r\n' +
  'Ashlar,Ashlr.AI\r\n' +
  '"Ashley, our AI",Ashlr.AI\r\n' +
  'Mason Wyeth,Mason Wyatt\r\n' +
  '"Open ""Claw""",OpenClaw\r\n' +
  'kubectl,\r\n' +
  ',Nothing\r\n' +
  'ashlr.ai,Ashlr.AI\r\n' +
  '\r\n';

const MACOS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>phrase</key>
		<string>A&amp;B &lt;Corp&gt;</string>
		<key>shortcut</key>
		<string>a and b&apos;s</string>
	</dict>
	<dict>
		<key>phrase</key>
		<string>Ashlr.AI</string>
		<key>shortcut</key>
		<string>Ashler</string>
	</dict>
	<dict>
		<key>phrase</key>
		<string>Ashlr.AI</string>
		<key>shortcut</key>
		<string>Ashlar</string>
	</dict>
	<dict>
		<key>phrase</key>
		<string>caf&#233; &#x2603;</string>
		<key>shortcut</key>
		<string>cafe snowman</string>
	</dict>
	<dict>
		<key>phrase</key>
		<string></string>
		<key>shortcut</key>
		<string>orphan</string>
	</dict>
	<dict>
		<key>something</key>
		<integer>1</integer>
	</dict>
</array>
</plist>
`;

const SUPERWHISPER_JSON = JSON.stringify(
  [
    { original: 'Ashler', replacement: 'Ashlr.AI' },
    { original: 'ashlar', replacement: 'ashlr.ai' },
    { original: 'Mason Wyeth', replacement: 'Mason Wyatt' },
    { original: 'x', replacement: '' },
    'not an object',
  ],
  null,
  2,
);

const ESPANSO_YAML = `# espanso match file
matches:
  - trigger: ":ashler"
    replace: Ashlr.AI
    word: true
  - trigger: Ashlar
    replace: Ashlr.AI
    propagate_case: false
  - triggers: [":mw", "Mason Wyeth"]
    replace: Mason Wyatt
  - trigger: ":date"
    replace: "{{today}}"
    vars:
      - name: today
        type: date
  - trigger: ":sig"
    replace: |
      Mason
      Ashlr.AI
  - regex: "hey(?P<n>.*)"
    replace: "hi $n"
`;

const TEXT_FILE = `# names STT gets wrong
Ashlr.AI: Ashler, Ashlar
Mason Wyatt = Mason Wyeth | Mason White
kubectl
Ashlr.AI: ashler, Ashley our AI
Ashlr:AI = ashlr colon ai
: no canonical

OpenClaw: OpenClaw
`;

const OUR_CSV =
  'canonical,alias,category,phonetic\n' +
  'Ashlr.AI,Ashler,brand,ASH-ler\n' +
  'Ashlr.AI,Ashlar,brand,ASH-ler\n' +
  'Mason Wyatt,Mason Wyeth,person,\n' +
  'kubectl,cube control,NotACategory,\n' +
  ',orphan,brand,\n';

const OUR_JSON = JSON.stringify({
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand', scope: 'project', hits: 7, createdAt: '2024-01-01T00:00:00Z' },
    { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', source: 'user' },
  ],
});

function byCanonical(terms: readonly Term[]): Record<string, Term> {
  return Object.fromEntries(terms.map((t) => [t.canonical, t]));
}

// ---------------------------------------------------------------------------
// csv-parse
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\n\nlast,');
    expect(rows.map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
      ['last', ''],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 6]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\r\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-format importers
// ---------------------------------------------------------------------------

describe('importLexicon', () => {
  it('lists every format with info', () => {
    expect(IMPORT_FORMATS).toContain('auto');
    for (const f of IMPORT_FORMATS) {
      expect(IMPORT_FORMAT_INFO[f].description).toBeTruthy();
      expect(isImportFormat(f)).toBe(true);
    }
    expect(isImportFormat('nope')).toBe(false);
    expect(() => importLexicon('x', 'nope' as never)).toThrow(/Unknown import format/);
  });

  it('wispr: merges rows by canonical, tolerates BOM/CRLF/quotes, keeps words without replacement', () => {
    const result = importLexicon(WISPR_CSV, 'wispr');
    expect(result.format).toBe('wispr');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['Ashlr.AI', 'Mason Wyatt', 'Nothing', 'OpenClaw', 'kubectl']);
    expect(terms['Ashlr.AI'].aliases).toEqual(['Ashler', 'Ashlar', 'Ashley, our AI']);
    expect(terms['OpenClaw'].aliases).toEqual(['Open "Claw"']);
    expect(terms['kubectl'].aliases).toEqual([]);
    expect(terms['Nothing'].aliases).toEqual([]);
    expect(result.terms.every((t) => t.source === 'import')).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it('wispr: works without a header', () => {
    const result = importLexicon('Ashler,Ashlr.AI\nAshlar,Ashlr.AI\n', 'wispr');
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0].aliases).toEqual(['Ashler', 'Ashlar']);
  });

  it('macos: shortcut is the alias, phrase the canonical, entities decoded', () => {
    const result = importLexicon(MACOS_PLIST, 'macos');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['A&B <Corp>', 'Ashlr.AI', 'café ☃']);
    expect(terms['A&B <Corp>'].aliases).toEqual(["a and b's"]);
    expect(terms['Ashlr.AI'].aliases).toEqual(['Ashler', 'Ashlar']);
    expect(terms['café ☃'].aliases).toEqual(['cafe snowman']);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toEqual({ line: 29, reason: 'empty canonical' });
    expect(result.skipped[1].reason).toMatch(/no phrase\/shortcut/);
  });

  it('macos: rejects non-plist input', () => {
    expect(() => importLexicon('word,replacement\n', 'macos')).toThrow(/plist/);
  });

  it('macos: tolerates whitespace and newlines between tags, and non-string values', () => {
    const plist = [
      '<plist version="1.0"><array>',
      '<dict >',
      '  <key >phrase</key >',
      '',
      '  <string >Ashlr.AI</string >',
      '  <key>shortcut</key>',
      '  <string>Ashler</string>',
      '  <key>weight</key><integer>3</integer>',
      '  <key>flag</key><true/>',
      '</dict >',
      '<dict><key>phrase</key><string/><key>shortcut</key><string>x</string></dict>',
      '<dict><key>phrase</key><string>Open</string><key>shortcut</key>',
      '</array></plist>',
    ].join('\n');
    const result = importLexicon(plist, 'macos');
    expect(byCanonical(result.terms)['Ashlr.AI'].aliases).toEqual(['Ashler']);
    expect(result.terms).toHaveLength(1);
    expect(result.skipped).toEqual([{ line: 11, reason: 'empty canonical' }]);
  });

  it('macos: a 2 MB adversarial plist (unclosed <dict>/<key> tags) parses in linear time', () => {
    const chunk = '<dict>'.repeat(64) + '<key>'.repeat(64);
    const adversarial = `<plist><array>${chunk.repeat(Math.ceil((2 * 1024 * 1024) / chunk.length))}`;
    expect(adversarial.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const started = performance.now();
    const result = importLexicon(adversarial, 'macos');
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.terms).toEqual([]);

    // Closed dicts full of unclosed keys, and the reverse, are just as cheap.
    const closedDicts = `<plist><array>${`<dict>${'<key>'.repeat(200)}</dict>`.repeat(2000)}`;
    const t2 = performance.now();
    expect(importLexicon(closedDicts, 'macos').skipped).toHaveLength(2000);
    expect(performance.now() - t2).toBeLessThan(500);
  });

  it('superwhisper: reads the array form and the { replacements } form', () => {
    const result = importLexicon(SUPERWHISPER_JSON, 'superwhisper');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['Ashlr.AI', 'Mason Wyatt']);
    // case-insensitive canonical merge keeps the first spelling and dedupes aliases
    expect(terms['Ashlr.AI'].aliases).toEqual(['Ashler', 'ashlar']);
    expect(result.skipped).toEqual([
      { line: 4, reason: 'empty canonical' },
      { line: 5, reason: 'entry is not an object' },
    ]);

    const wrapped = importLexicon(JSON.stringify({ replacements: [{ original: 'a', replacement: 'B' }] }), 'superwhisper');
    expect(wrapped.terms).toEqual([{ canonical: 'B', aliases: ['a'], source: 'import' }]);
    expect(() => importLexicon('{"nope": 1}', 'superwhisper')).toThrow(/expected a JSON array/);
    expect(() => importLexicon('not json', 'superwhisper')).toThrow(/invalid JSON/);
  });

  it('espanso: trigger -> alias, replace -> canonical; skips vars, multiline and regex matches', () => {
    const result = importLexicon(ESPANSO_YAML, 'espanso');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['Ashlr.AI', 'Mason Wyatt']);
    expect(terms['Ashlr.AI'].aliases).toEqual(['ashler', 'Ashlar']);
    expect(terms['Mason Wyatt'].aliases).toEqual(['mw', 'Mason Wyeth']);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/vars/),
      expect.stringMatching(/multi-line/),
      expect.stringMatching(/no trigger/),
    ]);
    expect(result.skipped.map((s) => s.line)).toEqual([11, 16, 20]);
    expect(() => importLexicon('foo: bar\n', 'espanso')).toThrow(/matches/);
    expect(() => importLexicon('matches: [\n', 'espanso')).toThrow(/invalid YAML/);
  });

  it('text: all three line shapes, comments, merging, and an alias equal to the canonical dropped', () => {
    const result = importLexicon(TEXT_FILE, 'text');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['Ashlr.AI', 'Ashlr:AI', 'Mason Wyatt', 'OpenClaw', 'kubectl']);
    expect(terms['Ashlr.AI'].aliases).toEqual(['Ashler', 'Ashlar', 'Ashley our AI']);
    expect(terms['Mason Wyatt'].aliases).toEqual(['Mason Wyeth', 'Mason White']);
    expect(terms['Ashlr:AI'].aliases).toEqual(['ashlr colon ai']);
    expect(terms['kubectl'].aliases).toEqual([]);
    expect(terms['OpenClaw'].aliases).toEqual([]);
    expect(result.skipped).toEqual([{ line: 7, reason: 'empty canonical' }]);
  });

  it('csv: our own header, category validated, unknown category dropped', () => {
    const result = importLexicon(OUR_CSV, 'csv');
    const terms = byCanonical(result.terms);
    expect(Object.keys(terms).sort()).toEqual(['Ashlr.AI', 'Mason Wyatt', 'kubectl']);
    expect(terms['Ashlr.AI']).toMatchObject({ aliases: ['Ashler', 'Ashlar'], category: 'brand', phonetic: 'ASH-ler' });
    expect(terms['Mason Wyatt']).toMatchObject({ aliases: ['Mason Wyeth'], category: 'person' });
    expect(terms['Mason Wyatt'].phonetic).toBeUndefined();
    expect(terms['kubectl'].category).toBeUndefined();
    expect(result.skipped).toEqual([{ line: 6, reason: 'empty canonical' }]);
  });

  it('csv: columns can be reordered via the header', () => {
    const result = importLexicon('alias,category,canonical\nAshler,brand,Ashlr.AI\n', 'csv');
    expect(result.terms[0]).toMatchObject({ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' });
  });

  it('json: parses our own lexicon and drops scope/hits/createdAt', () => {
    const result = importLexicon(OUR_JSON, 'json');
    expect(result.terms).toEqual([
      { canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand', source: 'import' },
      { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', source: 'user' },
    ]);
    expect(() => importLexicon('{"terms": [{"canonical": ""}]}', 'json')).toThrow(/Invalid lexicon/);
  });

  it('applies opts.source to every term', () => {
    const result = importLexicon(OUR_JSON, 'json', { source: 'learned' });
    expect(result.terms.every((t) => t.source === 'learned')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // auto-detect
  // -------------------------------------------------------------------------

  it('auto: detects every format from content', () => {
    expect(detectImportFormat(MACOS_PLIST)).toBe('macos');
    expect(detectImportFormat(SUPERWHISPER_JSON)).toBe('superwhisper');
    expect(detectImportFormat('{"replacements": []}')).toBe('superwhisper');
    expect(detectImportFormat(OUR_JSON)).toBe('json');
    expect(detectImportFormat('version: 1\nterms:\n  - canonical: X\n')).toBe('json');
    expect(detectImportFormat(ESPANSO_YAML)).toBe('espanso');
    expect(detectImportFormat(WISPR_CSV)).toBe('wispr');
    expect(detectImportFormat(OUR_CSV)).toBe('csv');
    expect(detectImportFormat(TEXT_FILE)).toBe('text');
  });

  it('auto: uses the filename extension to break ties for header-less files', () => {
    expect(detectImportFormat('Ashler,Ashlr.AI\n', 'wispr-dictionary.csv')).toBe('wispr');
    expect(detectImportFormat('Ashler,Ashlr.AI\n')).toBe('text');
    expect(detectImportFormat('<array></array>', 'stuff.plist')).toBe('macos');
  });

  it('auto: importLexicon reports the resolved format', () => {
    for (const [content, format] of [
      [WISPR_CSV, 'wispr'],
      [MACOS_PLIST, 'macos'],
      [SUPERWHISPER_JSON, 'superwhisper'],
      [ESPANSO_YAML, 'espanso'],
      [TEXT_FILE, 'text'],
      [OUR_CSV, 'csv'],
      [OUR_JSON, 'json'],
    ] as const) {
      const result = importLexicon(content, 'auto');
      expect(result.format).toBe(format);
      expect(result.terms.length).toBeGreaterThan(0);
    }
  });

  it('auto: unknown JSON shape asks for --format', () => {
    expect(() => importLexicon('{"foo": 1}', 'auto')).toThrow(/could not detect/);
  });

  // -------------------------------------------------------------------------
  // round trips
  // -------------------------------------------------------------------------

  const lexicon: Lexicon = {
    version: 1,
    terms: [
      { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashley, our AI'], category: 'brand' },
      { canonical: 'OpenClaw', aliases: ['open claw', 'Open "Claw"'], category: 'product' },
      { canonical: 'A&B <Corp>', aliases: ["a and b's"], category: 'brand' },
      { canonical: 'kubectl', aliases: [] },
      { canonical: 'Ashlr:AI', aliases: ['ashlr colon ai'] },
    ],
  };
  const expectedPairs = lexicon.terms.map((t) => [t.canonical, t.aliases] as const).sort((a, b) => a[0].localeCompare(b[0]));
  const pairsOf = (terms: readonly Term[]): (readonly [string, string[]])[] =>
    terms.map((t) => [t.canonical, t.aliases] as const).sort((a, b) => a[0].localeCompare(b[0]));

  it('round-trips text export -> import', () => {
    const text = exportLexicon(lexicon, 'text');
    const result = importLexicon(text, 'auto');
    expect(result.format).toBe('text');
    expect(pairsOf(result.terms)).toEqual(expectedPairs);
    expect(result.skipped).toEqual([]);
  });

  it('round-trips macos export -> import (terms with aliases)', () => {
    const plist = exportLexicon(lexicon, 'macos');
    const result = importLexicon(plist, 'auto');
    expect(result.format).toBe('macos');
    // the plist has one entry per alias, so alias-less terms cannot survive
    expect(pairsOf(result.terms)).toEqual(expectedPairs.filter(([, aliases]) => aliases.length > 0));
  });

  it('round-trips wispr, superwhisper, espanso, csv and json exports', () => {
    for (const format of ['wispr', 'superwhisper', 'espanso', 'csv'] as const) {
      const result = importLexicon(exportLexicon(lexicon, format), 'auto');
      expect(result.format, format).toBe(format);
      expect(pairsOf(result.terms), format).toEqual(expectedPairs.filter(([, aliases]) => aliases.length > 0));
    }
    const json = importLexicon(exportLexicon(lexicon, 'json'), 'auto');
    expect(json.format).toBe('json');
    expect(pairsOf(json.terms)).toEqual(expectedPairs);
  });
});

// ---------------------------------------------------------------------------
// CLI: runImport (store mocked)
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  existing: new Set<string>(),
  addTerm: vi.fn(),
}));

vi.mock('../src/core/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/store.js')>();
  return {
    ...actual,
    addTerm: store.addTerm,
    resolvePaths: vi.fn(() => ({ global: '/tmp/lexicon-import-test/global.yaml' })),
    readLexiconFile: vi.fn(async (p: string, scope: 'global' | 'project') => ({
      path: p,
      scope,
      exists: true,
      lexicon: { version: 1, terms: [...store.existing].map((c) => ({ canonical: c, aliases: [] })) },
    })),
  };
});

import { MAX_IMPORT_BYTES, runImport } from '../src/cli/cmd-import.js';
import type { IO } from '../src/cli/commands.js';

function makeIO(): IO & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(s: string) {
      sink.out += s;
    },
    stderr(s: string) {
      sink.err += s;
    },
  };
  return sink;
}

describe('runImport', () => {
  beforeEach(() => {
    store.existing = new Set(['Mason Wyatt']);
    store.addTerm.mockImplementation(async (term: Term, opts?: { scope?: string }) => ({
      file: { path: opts?.scope === 'project' ? '/tmp/proj/.lexicon.yaml' : '/tmp/lexicon-import-test/global.yaml', scope: opts?.scope ?? 'global', lexicon: { version: 1, terms: [] }, exists: true },
      term,
      created: !store.existing.has(term.canonical),
    }));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const read = (content: string) => async (): Promise<string> => content;

  it('imports a wispr CSV, prints a table and the summary line', async () => {
    const io = makeIO();
    const code = await runImport('wispr-dictionary.csv', {}, io, read(WISPR_CSV));
    expect(code).toBe(0);
    expect(store.addTerm).toHaveBeenCalledTimes(5);
    expect(store.addTerm.mock.calls[0][0]).toMatchObject({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashley, our AI'], source: 'import' });
    expect(store.addTerm.mock.calls[0][1]).toMatchObject({ scope: 'global' });
    expect(io.out).toContain('canonical');
    expect(io.out).toMatch(/Ashlr\.AI\s+Ashler, Ashlar, Ashley, our AI\s+new/);
    expect(io.out).toMatch(/Mason Wyatt\s+Mason Wyeth\s+merged/);
    expect(io.out).toContain('imported 5 terms (4 new, 1 merged, 0 skipped)');
    expect(io.out).toContain('[wispr]');
    expect(io.err).toBe('');
  });

  it('--dry-run does not write, still reports new vs merged', async () => {
    const io = makeIO();
    const code = await runImport('names.txt', { dryRun: true, format: 'text' }, io, read(TEXT_FILE));
    expect(code).toBe(0);
    expect(store.addTerm).not.toHaveBeenCalled();
    expect(io.out).toContain('dry run (text): would have imported 5 terms (4 new, 1 merged, 1 skipped)');
    expect(io.out).toMatch(/Mason Wyatt\s+Mason Wyeth, Mason White\s+merged/);
    expect(io.err).toBe('lexicon: skipped line 7: empty canonical\n');
  });

  it('--project, --category and --source are forwarded to addTerm', async () => {
    const io = makeIO();
    await runImport('-', { project: true, category: 'brand', source: 'learned' }, io, read('Ashlr.AI: Ashler\n'));
    expect(store.addTerm).toHaveBeenCalledWith(
      { canonical: 'Ashlr.AI', aliases: ['Ashler'], source: 'learned', category: 'brand' },
      expect.objectContaining({ scope: 'project' }),
    );
    expect(io.out).toContain('into project lexicon /tmp/proj/.lexicon.yaml');
  });

  it('--category does not override a category from the file', async () => {
    const io = makeIO();
    await runImport('x.csv', { category: 'person' }, io, read(OUR_CSV));
    const categories = store.addTerm.mock.calls.map((c) => {
      const term = c[0] as Term;
      return [term.canonical, term.category];
    });
    expect(categories).toEqual([
      ['Ashlr.AI', 'brand'],
      ['Mason Wyatt', 'person'],
      ['kubectl', 'person'],
    ]);
  });

  it('--json prints a report', async () => {
    const io = makeIO();
    await runImport('x.json', { json: true }, io, read(SUPERWHISPER_JSON));
    const report = JSON.parse(io.out) as { format: string; counts: Record<string, number>; terms: unknown[]; skipped: unknown[] };
    expect(report.format).toBe('superwhisper');
    expect(report.counts).toEqual({ total: 2, created: 1, merged: 1, skipped: 2 });
    expect(report.terms).toHaveLength(2);
    expect(report.skipped).toHaveLength(2);
  });

  it('unknown format lists the formats and exits 1', async () => {
    const io = makeIO();
    const code = await runImport('x', { format: 'bogus' }, io, read(''));
    expect(code).toBe(1);
    expect(io.err).toContain('unknown import format "bogus"');
    expect(io.err).toContain('superwhisper');
    expect(store.addTerm).not.toHaveBeenCalled();
  });

  it('rejects an unknown --category or --source', async () => {
    await expect(runImport('x', { category: 'nope' }, makeIO(), read('A\n'))).rejects.toThrow(/unknown category/);
    await expect(runImport('x', { source: 'nope' }, makeIO(), read('A\n'))).rejects.toThrow(/unknown source/);
  });

  it('refuses input over MAX_IMPORT_BYTES before parsing it', async () => {
    const io = makeIO();
    const huge = 'Ashlr.AI: Ashler\n'.repeat(Math.ceil((MAX_IMPORT_BYTES + 1) / 'Ashlr.AI: Ashler\n'.length));
    await expect(runImport('big.txt', { format: 'text' }, io, read(huge))).rejects.toThrow(
      `big.txt is ${Buffer.byteLength(huge)} bytes, over the ${MAX_IMPORT_BYTES} byte (8 MB) import limit`,
    );
    expect(store.addTerm).not.toHaveBeenCalled();
    expect(MAX_IMPORT_BYTES).toBe(8 * 1024 * 1024);
  });

  it('empty input imports nothing and exits 0', async () => {
    const io = makeIO();
    const code = await runImport('x.txt', { format: 'text' }, io, read('# only a comment\n'));
    expect(code).toBe(0);
    expect(io.out).toContain('nothing to import (text)');
    expect(store.addTerm).not.toHaveBeenCalled();
  });
});
