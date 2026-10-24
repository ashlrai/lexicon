/**
 * Apple Text Replacement plist: the format produced by dragging entries out of
 * System Settings > Keyboard > Text Replacements. One dict per alias
 * (shortcut = alias, phrase = canonical).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { findUnencodableChar } from '../schema.js';
import { aliasPairs, sharedTriggerNote, uniqueTriggers, xmlEscape } from './shared.js';
import type { ExportSink } from './shared.js';

/**
 * One dict per alias. A pair with a character XML 1.0 cannot hold, not even
 * as a character reference (U+FFFE, U+FFFF or an unpaired surrogate, what
 * the schema's findUnencodableChar finds), is left out: written, it made the
 * whole plist unreadable, and every other replacement with it. The schema
 * refuses these in a lexicon file; a lexicon built in memory can still hold one.
 *
 * Two terms sharing an alias wrote two entries with one shortcut, and macOS
 * then replaces it with either. The term `uniqueTriggers` ranks first keeps
 * it; shortcuts are compared ignoring case, since Text Replacement matches
 * them that way as far as known (not confirmed offline, so the cautious
 * reading is taken). The other is named in a note.
 */
export function exportMacos(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
  ];
  const { kept, dropped } = uniqueTriggers(aliasPairs(lexicon), (a) => a.toLowerCase());
  const shared = sharedTriggerNote(dropped, 'shortcut');
  if (shared) sink?.notes.push(shared);
  let rows = 0;
  for (const { alias, canonical } of kept) {
    if (findUnencodableChar(alias) !== undefined || findUnencodableChar(canonical) !== undefined) continue;
    lines.push('\t<dict>');
    lines.push('\t\t<key>phrase</key>');
    lines.push(`\t\t<string>${xmlEscape(canonical)}</string>`);
    lines.push('\t\t<key>shortcut</key>');
    lines.push(`\t\t<string>${xmlEscape(alias)}</string>`);
    lines.push('\t</dict>');
    rows += 1;
  }
  if (sink) sink.rows = rows;
  lines.push('</array>', '</plist>');
  return lines.join('\n') + '\n';
}
