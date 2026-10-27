import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS, exportLexiconWithNotes } from '../src/core/exporters/index.js';
import type { ExportOptions, Lexicon } from '../src/core/types.js';

// Deliberately unsorted: freeze ordering, escaping, alias expansion and metadata
// handling against the same vocabulary for every format. Keep dates fixed.
const vocabulary: Lexicon = {
  version: 1,
  settings: { protectedWords: ['ordinary'], minConfidence: 0.9 },
  terms: [
    { canonical: 'Uncategorized', aliases: ['un categorised'] },
    { canonical: 'kubectl', aliases: ['cube control', 'kube cuddle'], category: 'identifier', hits: 12 },
    {
      canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashley, our AI'], category: 'brand',
      phonetic: 'ASH-ler', notes: 'My company (voice tools)', hits: 5,
      scope: 'global', source: 'user', createdAt: '2026-01-02T03:04:05.000Z', never: ['ash'],
    },
    { canonical: 'Zoë Martin', aliases: ['Zoe Martin'], category: 'person', hits: 5, scope: 'project' },
    { canonical: 'A&B <Tools>', aliases: ['A and B', 'A "bee"'], category: 'product', hits: 5 },
    { canonical: 'NoAliases', aliases: [], category: 'acronym', hits: 20 },
    { canonical: 'Path\\|Kit', aliases: ['path|kit', '{{path}}'], category: 'other', notes: 'Keep the pipe | and slash \\', caseSensitive: true },
    { canonical: '=SUM(1,2)', aliases: ['+sum'], category: 'other' },
  ],
};

const scenarios: { name: string; lexicon: Lexicon; options: ExportOptions }[] = [
  { name: 'complete vocabulary', lexicon: vocabulary, options: {} },
  { name: 'category filter and importance limit', lexicon: vocabulary, options: { categories: ['brand', 'person', 'product', 'other'], limit: 3 } },
  { name: 'empty vocabulary', lexicon: { version: 1, terms: [] }, options: {} },
];

// Derive cases from the registry so adding a format requires reviewed snapshots.
// Snapshot the raw string, including whitespace, plus user-visible drop notes
// and row/name counts. Parsing JSON/YAML here would hide serialization drift.
describe.each(EXPORT_FORMATS)('%s export snapshots', (format) => {
  it.each(scenarios)('$name', ({ lexicon, options }) => {
    const input = structuredClone(lexicon);
    expect(exportLexiconWithNotes(input, format, options)).toMatchSnapshot();
    expect(input).toEqual(lexicon);
  });
});
