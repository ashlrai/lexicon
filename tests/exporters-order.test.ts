/**
 * Export order is the same on every machine: the exporters sort with a fixed
 * collation, not the user's locale. A child process under a Swedish locale
 * (where `Ä` sorts after `Z`) must write what this process writes.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS, exportLexicon } from '../src/core/exporters/index.js';
import { parseCsv } from '../src/core/importers/csv-parse.js';
import type { ExportFormat, Lexicon } from '../src/core/types.js';

const lexicon: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Zeta', aliases: ['zetta', 'zeta spelling'], category: 'brand' },
    { canonical: 'Äpple', aliases: ['epple'], category: 'brand' },
    { canonical: 'Örebro', aliases: ['orebro'], category: 'place' },
    { canonical: 'Café', aliases: ['kaffay'], category: 'brand' },
    { canonical: 'Café', aliases: ['kafay'], category: 'brand' },
    { canonical: 'apple', aliases: ['appel'], category: 'brand' },
    { canonical: 'Apple', aliases: ['appul'], category: 'brand' },
  ],
};

function exportIn(locale: string, input: Lexicon): Record<string, string> {
  const mod = pathToFileURL(resolve(process.cwd(), 'src/core/exporters/index.ts')).href;
  const script = `const m = await import(${JSON.stringify(mod)}); const lex = JSON.parse(process.env.LEX); const out = {}; for (const f of m.EXPORT_FORMATS) out[f] = m.exportLexicon(lex, f); out.limit = m.exportLexicon(lex, 'csv', { limit: 2 }); process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, LEX: JSON.stringify(input), LC_ALL: locale, LANG: locale },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, string>;
}

describe('export order', () => {
  it('exports an empty collection deterministically in every format', () => {
    const input: Lexicon = { version: 1, terms: [] };
    const expected: Record<ExportFormat, string> = {
      wispr: 'word,replacement\n',
      superwhisper: '[]\n',
      'whisper-prompt': '',
      macos: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n</array>\n</plist>\n',
      'claude-md': '## Voice lexicon\n\nThe user dictates with speech-to-text. When a transcript contains one of these spellings, they mean the canonical term. Always write the canonical form.\n\n| Canonical | Sounds like / STT writes | Note |\n| --- | --- | --- |\n\nIf a word looks like a garbled proper noun and is not listed, ask rather than guess.\n',
      csv: 'canonical,alias,category,phonetic\n',
      json: '{\n  "version": 1,\n  "terms": []\n}\n',
      deepgram: '{\n  "keyterm": [],\n  "keywords": []\n}\n',
      espanso: 'matches: []\n',
      assemblyai: '{\n  "word_boost": [],\n  "boost_param": "high"\n}\n',
      speechmatics: '{\n  "additional_vocab": []\n}\n',
      azure: '{\n  "phraseList": []\n}\n',
      google: '{\n  "adaptation": {\n    "phraseSets": [\n      {\n        "phrases": []\n      }\n    ]\n  }\n}\n',
      openai: '',
      text: '',
      markdown: '',
    };

    for (const format of EXPORT_FORMATS) {
      expect(exportLexicon(input, format), format).toBe(expected[format]);
      expect(exportLexicon(input, format, { limit: 2 }), `${format} with limit`).toBe(expected[format]);
      expect(exportLexicon(input, format), `${format} repeated`).toBe(expected[format]);
    }
    expect(input).toEqual({ version: 1, terms: [] });
    expect(exportIn('sv_SE.UTF-8', input)).toEqual({ ...expected, limit: expected.csv });
  });

  it('round-trips CSV fields containing commas and quotes', () => {
    const input: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Acme, "North"', aliases: ['acme, north', 'acme "north"'], category: 'brand', phonetic: 'ak, "mee"' },
        { canonical: '"Quoted"', aliases: ['a, "quoted" alias'], phonetic: 'say "quote"' },
      ],
    };

    const rows = parseCsv(exportLexicon(input, 'csv')).map((record) => record.fields);
    expect(rows).toEqual([
      ['canonical', 'alias', 'category', 'phonetic'],
      ['Acme, "North"', 'acme, north', 'brand', 'ak, "mee"'],
      ['Acme, "North"', 'acme "north"', 'brand', 'ak, "mee"'],
      ['"Quoted"', 'a, "quoted" alias', '', 'say "quote"'],
    ]);
  });

  it('produces identical output on repeated exports without changing the terms', () => {
    const input: Lexicon = structuredClone(lexicon);
    const original = structuredClone(input);

    for (const format of EXPORT_FORMATS) {
      for (const options of [{}, { limit: 2 }]) {
        const label = `${format} ${JSON.stringify(options)}`;
        const first = exportLexicon(input, format, options);
        expect(input, `${label} must preserve the input after the first export`).toEqual(original);
        const second = exportLexicon(input, format, options);
        expect(input, `${label} must preserve the input after the second export`).toEqual(original);
        expect(second, label).toBe(first);
      }
    }
  });

  // Catches: sortByImportance, sortByCategory and the text exporter used
  // localeCompare without a locale, so under LANG=sv_SE.UTF-8 the same
  // lexicon exported in another order and --limit kept other terms.
  it('does not depend on the locale', () => {
    const here: Record<string, string> = {};
    for (const f of EXPORT_FORMATS) here[f] = exportLexicon(lexicon, f);
    here.limit = exportLexicon(lexicon, 'csv', { limit: 2 });
    expect(here.text.split('\n').slice(0, 2)).toEqual(['apple: appel', 'Apple: appul']);
    expect(here.text.indexOf('Äpple')).toBeLessThan(here.text.indexOf('Zeta'));
    expect(exportIn('sv_SE.UTF-8', lexicon)).toEqual(here);
  });

  // Spellings the collation calls equal (one canonical in two Unicode forms)
  // still come out in one order whatever order the file lists them in.
  it('orders spellings the collation calls equal by their code units', () => {
    const reversed: Lexicon = { ...lexicon, terms: [...lexicon.terms].reverse() };
    for (const f of ['text', 'claude-md', 'markdown', 'whisper-prompt', 'deepgram', 'google'] as const) {
      expect(exportLexicon(reversed, f), f).toBe(exportLexicon(lexicon, f));
    }
  });

  it('writes the same sorted exports and limited selection for every term order', () => {
    const terms: Lexicon['terms'] = [
      { canonical: 'Zebra', aliases: ['zeebra'], category: 'brand', hits: 2 },
      { canonical: 'Alpha', aliases: ['alfa'], category: 'place', hits: 2 },
      { canonical: 'Beta', aliases: ['beeta'], category: 'person', hits: 2 },
      { canonical: 'Delta', aliases: ['deltta'], category: 'identifier', hits: 5 },
    ];
    const formats = ['text', 'claude-md', 'markdown', 'whisper-prompt', 'openai',
      'deepgram', 'assemblyai', 'speechmatics', 'azure', 'google'] as const;
    const baseline: Lexicon = { version: 1, terms };
    const expected = formats.map((format) => [
      exportLexicon(baseline, format),
      exportLexicon(baseline, format, { limit: 2 }),
    ]);

    // Pin the three distinct orderings, including the tie at the limit.
    expect(expected[0]?.[0]).toBe('Alpha: alfa\nBeta: beeta\nDelta: deltta\nZebra: zeebra\n');
    expect(expected[0]?.[1]).toBe('Beta: beeta\nDelta: deltta\n');
    expect(expected[2]?.[0]).toBe('- **Zebra** (brand): zeebra\n- **Beta** (person): beeta\n- **Delta** (identifier): deltta\n- **Alpha** (place): alfa\n');
    expect(expected[2]?.[1]).toBe('- **Beta** (person): beeta\n- **Delta** (identifier): deltta\n');
    expect(expected[3]).toEqual(['Delta, Beta, Zebra, Alpha', 'Delta, Beta']);

    for (const a of terms) for (const b of terms) for (const c of terms) for (const d of terms) {
      const permutation = [a, b, c, d];
      if (new Set(permutation).size !== terms.length) continue;
      const originalOrder = [...permutation];
      const input: Lexicon = { version: 1, terms: permutation };
      for (const [i, format] of formats.entries()) {
        expect(exportLexicon(input, format), `${format}: ${permutation.map((t) => t.canonical).join(', ')}`).toBe(expected[i]?.[0]);
        expect(exportLexicon(input, format, { limit: 2 }), `${format} with limit`).toBe(expected[i]?.[1]);
      }
      expect(input.terms).toEqual(originalOrder);
    }
  });

  it('keeps input order in JSON and alias-row formats, even after limiting', () => {
    const terms: Lexicon['terms'] = [
      { canonical: 'Alpha', aliases: ['alfa'], hits: 3 },
      { canonical: 'Beta', aliases: ['beeta'], hits: 1 },
      { canonical: 'Gamma', aliases: ['gama'], hits: 2 },
    ];
    const formats = ['json', 'csv', 'wispr', 'superwhisper', 'macos', 'espanso'] as const;

    for (const ordered of [terms, [...terms].reverse()]) {
      const input: Lexicon = { version: 1, terms: ordered };
      for (const format of formats) {
        const output = exportLexicon(input, format);
        const limited = exportLexicon(input, format, { limit: 2 });
        const expected = ordered.map((term) => term.canonical);
        const selected = expected.filter((name) => name !== 'Beta');
        for (const name of expected) expect(output, format).toContain(name);
        expect(output.indexOf(expected[0]), format).toBeLessThan(output.indexOf(expected[1]));
        expect(output.indexOf(expected[1]), format).toBeLessThan(output.indexOf(expected[2]));
        expect(limited).not.toContain('Beta');
        expect(limited.indexOf(selected[0])).toBeGreaterThanOrEqual(0);
        expect(limited.indexOf(selected[0])).toBeLessThan(limited.indexOf(selected[1]));
      }
    }
  });
});
