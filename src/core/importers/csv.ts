/**
 * Our own generic CSV (`lexicon export csv`): `canonical,alias,category,phonetic`.
 * Columns are matched by header name when a header is present, else by
 * position. Unknown categories are dropped rather than failing the row.
 */
import { parseCsv } from './csv-parse.js';
import { parseCategoryCell, rowFor } from './shared.js';
import type { RawImport } from './shared.js';

const KNOWN_HEADERS = ['canonical', 'alias', 'category', 'phonetic', 'notes'] as const;
type Header = (typeof KNOWN_HEADERS)[number];

export function isLexiconCsvHeader(fields: readonly string[]): boolean {
  return fields.some((f) => f.trim().toLowerCase() === 'canonical');
}

export function parseCsvImport(content: string): RawImport {
  const out: RawImport = { rows: [], skipped: [] };
  const records = parseCsv(content);
  if (records.length === 0) return out;

  let columns: Partial<Record<Header, number>> = { canonical: 0, alias: 1, category: 2, phonetic: 3 };
  let start = 0;
  if (isLexiconCsvHeader(records[0].fields)) {
    columns = {};
    records[0].fields.forEach((name, i) => {
      const key = name.trim().toLowerCase();
      if ((KNOWN_HEADERS as readonly string[]).includes(key)) columns[key as Header] = i;
    });
    start = 1;
  }
  const cell = (fields: readonly string[], key: Header): string | undefined => {
    const idx = columns[key];
    return idx === undefined ? undefined : fields[idx];
  };

  for (const { line, fields } of records.slice(start)) {
    const alias = cell(fields, 'alias')?.trim();
    const { row, skip } = rowFor(line, cell(fields, 'canonical') ?? '', alias ? [alias] : [], {
      category: parseCategoryCell(cell(fields, 'category')),
      phonetic: cell(fields, 'phonetic'),
      notes: cell(fields, 'notes'),
    });
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  }
  return out;
}
