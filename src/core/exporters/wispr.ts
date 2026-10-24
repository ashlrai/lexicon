/**
 * Wispr Flow dictionary import: CSV `word,replacement`, one row per alias.
 *
 * Wispr Flow reads each cell as the dictionary entry itself, so the
 * spreadsheet escape (a leading `'`) would be typed into every transcript.
 * A pair whose alias or canonical a spreadsheet would run as a formula
 * (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) is left out
 * instead, with a note naming it, so the file is safe to open in a
 * spreadsheet and every row it holds imports as written. Such a name is
 * never what speech-to-text writes; add it in Wispr Flow by hand. Lines end
 * in LF and there is no byte order mark, as before (lexicon's own wispr
 * importer takes either; what Wispr Flow requires is not confirmed offline).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, csvField, isFormulaCell, quotedNames } from './shared.js';
import type { ExportSink } from './shared.js';

export function exportWispr(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const lines = ['word,replacement'];
  const leftOut: string[] = [];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
    if (isFormulaCell(alias) || isFormulaCell(canonical)) {
      leftOut.push(`${alias} -> ${canonical}`);
      continue;
    }
    lines.push(`${csvField(alias)},${csvField(canonical)}`);
  }
  if (leftOut.length > 0) {
    sink?.notes.push(
      `left out ${leftOut.length} pair${leftOut.length === 1 ? '' : 's'} a spreadsheet would run as a formula (a cell starting with = + - @, a tab or a carriage return): ${quotedNames(leftOut)}`,
    );
  }
  if (sink) sink.rows = lines.length - 1;
  return lines.join('\n') + '\n';
}
