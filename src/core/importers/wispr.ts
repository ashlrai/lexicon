/**
 * Wispr Flow dictionary export: CSV `word,replacement`. A row whose
 * replacement is empty (or a one-column row) is a plain dictionary word, i.e.
 * a canonical with no alias. The header is optional; BOM and CRLF tolerated.
 */
import { parseCsv } from './csv-parse.js';
import { rowFor } from './shared.js';
import type { RawImport } from './shared.js';

export function isWisprHeader(fields: readonly string[]): boolean {
  return fields.length >= 1 && fields[0].trim().toLowerCase() === 'word' &&
    (fields.length === 1 || fields[1].trim().toLowerCase() === 'replacement');
}

export function parseWisprImport(content: string): RawImport {
  const out: RawImport = { rows: [], skipped: [] };
  const records = parseCsv(content);
  const start = records.length > 0 && isWisprHeader(records[0].fields) ? 1 : 0;
  for (const { line, fields } of records.slice(start)) {
    const word = (fields[0] ?? '').trim();
    const replacement = (fields[1] ?? '').trim();
    const { row, skip } = replacement ? rowFor(line, replacement, [word]) : rowFor(line, word, []);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  }
  return out;
}
