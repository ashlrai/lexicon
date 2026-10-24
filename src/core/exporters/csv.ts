/**
 * Generic CSV: canonical,alias,category,phonetic, one row per alias.
 *
 * Written for "anything else", which is usually a spreadsheet, so a cell a
 * spreadsheet would run as a formula (a name starting with `=`, `+`, `-`,
 * `@`, a tab or a carriage return) is written as text with a leading `'`
 * (csvTextField), and a note counts them: `lexicon import` reads the `'`
 * back as part of the name. Lines end in LF and there is no byte order
 * mark: scripts and `lexicon import` read it as is, and a BOM would end up in
 * the first header name for a plain CSV reader.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, csvTextField, isFormulaCell, quotedNames } from './shared.js';
import type { ExportSink } from './shared.js';

export function exportCsv(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const lines = ['canonical,alias,category,phonetic'];
  const guarded = new Set<string>();
  for (const { alias, canonical, term } of aliasPairs(lexicon)) {
    const cells = [canonical, alias, term.category ?? '', term.phonetic ?? ''];
    for (const c of cells) if (isFormulaCell(c)) guarded.add(c);
    lines.push(cells.map(csvTextField).join(','));
  }
  if (guarded.size > 0) {
    sink?.notes.push(
      `wrote ${guarded.size} value${guarded.size === 1 ? '' : 's'} a spreadsheet would run as a formula with a leading ' so it shows as text (lexicon import keeps the '): ${quotedNames([...guarded])}`,
    );
  }
  if (sink) sink.rows = lines.length - 1;
  return lines.join('\n') + '\n';
}
