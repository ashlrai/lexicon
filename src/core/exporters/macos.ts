/**
 * Apple Text Replacement plist: the format produced by dragging entries out of
 * System Settings > Keyboard > Text Replacements. One dict per alias
 * (shortcut = alias, phrase = canonical).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { findUnencodableChar } from '../schema.js';
import { aliasPairs, quotedNames, sharedTriggerNote, uniqueTriggers, xmlEscape } from './shared.js';
import type { AliasPair, ExportSink } from './shared.js';

/**
 * One dict per alias. A pair with a character XML 1.0 cannot hold, not even
 * as a character reference (U+FFFE, U+FFFF or an unpaired surrogate, what
 * the schema's findUnencodableChar finds), is left out: written, it made the
 * whole plist unreadable, and every other replacement with it. A note names
 * it. The schema refuses these in a lexicon file; a lexicon built in memory
 * can still hold one.
 *
 * Two terms sharing an alias wrote two entries with one shortcut, and macOS
 * then replaces it with either. The term `uniqueTriggers` ranks first keeps
 * it; shortcuts are compared ignoring case, since Text Replacement matches
 * them that way as far as known (not confirmed offline, so the cautious
 * reading is taken). The other is named in a note.
 */
/**
 * `value` without the C0 control characters XML 1.0 cannot hold, even as a
 * character reference (all of U+0000 to U+001F but tab, LF and CR). The
 * schema refuses control characters in a lexicon file; a lexicon built in
 * memory can still hold one, and written as is it made the whole plist
 * unreadable.
 */
function stripXmlControls(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export function exportMacos(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
  ];
  // Controls removed first, so two shortcuts that differ only by one are one shortcut.
  let stripped = 0;
  const unencodable: AliasPair[] = [];
  const pairs: AliasPair[] = [];
  for (const pair of aliasPairs(lexicon)) {
    if (findUnencodableChar(pair.alias) !== undefined || findUnencodableChar(pair.canonical) !== undefined) {
      unencodable.push(pair);
      continue;
    }
    const alias = stripXmlControls(pair.alias).trim();
    const canonical = stripXmlControls(pair.canonical);
    if (alias !== pair.alias || canonical !== pair.canonical) stripped += 1;
    if (alias === '' || canonical.trim() === '') continue;
    pairs.push({ ...pair, alias, canonical });
  }
  if (unencodable.length > 0) {
    sink?.notes.push(
      `left out ${unencodable.length} pair${unencodable.length === 1 ? '' : 's'} holding a character XML cannot hold even as a reference (U+FFFE, U+FFFF or an unpaired surrogate): ${quotedNames(unencodable.map((p) => `${p.alias} -> ${p.canonical}`))}`,
    );
  }
  const { kept, dropped } = uniqueTriggers(pairs, (a) => a.toLowerCase());
  const shared = sharedTriggerNote(dropped, 'shortcut');
  if (shared) sink?.notes.push(shared);
  let rows = 0;
  for (const { alias, canonical } of kept) {
    lines.push('\t<dict>');
    lines.push('\t\t<key>phrase</key>');
    lines.push(`\t\t<string>${xmlEscape(canonical)}</string>`);
    lines.push('\t\t<key>shortcut</key>');
    lines.push(`\t\t<string>${xmlEscape(alias)}</string>`);
    lines.push('\t</dict>');
    rows += 1;
  }
  if (sink) sink.rows = rows;
  if (stripped > 0) {
    sink?.notes.push(`removed control characters XML cannot hold from ${stripped} entr${stripped === 1 ? 'y' : 'ies'} (a pair left with an empty shortcut or phrase is not written)`);
  }
  lines.push('</array>', '</plist>');
  return lines.join('\n') + '\n';
}
