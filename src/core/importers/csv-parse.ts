/**
 * Minimal RFC 4180 CSV reader shared by the Wispr and generic CSV importers.
 * Handles quoted fields, doubled-quote escapes, embedded newlines, CRLF and a
 * leading BOM. No dependency; dictionary exports are small.
 */

export interface CsvRecord {
  /** 1-based line number where the record starts (after BOM stripping). */
  line: number;
  fields: string[];
}

export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Parse CSV text into records. Blank lines are dropped. */
export function parseCsv(content: string): CsvRecord[] {
  const text = stripBom(content);
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawQuote = false;

  const endField = (): void => {
    fields.push(field);
    field = '';
    sawQuote = false;
  };
  const endRecord = (): void => {
    endField();
    const blank = fields.length === 1 && fields[0] === '';
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !sawQuote) {
      inQuotes = true;
      sawQuote = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      // CRLF or lone CR both end the record.
      if (text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== '' || fields.length > 0 || sawQuote) endRecord();
  return records;
}
