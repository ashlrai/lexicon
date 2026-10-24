/**
 * Apple Text Replacement plist: the format produced by dragging entries out of
 * System Settings > Keyboard > Text Replacements. One dict per alias
 * (shortcut = alias, phrase = canonical).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { findUnencodableChar } from '../schema.js';
import { aliasPairs, xmlEscape } from './shared.js';

/**
 * One dict per alias. A pair with a character XML 1.0 cannot hold, not even
 * as a character reference (U+FFFE, U+FFFF or an unpaired surrogate, what
 * the schema's findUnencodableChar finds), is left out: written, it made the
 * whole plist unreadable, and every other replacement with it. The schema
 * refuses these in a lexicon file; a lexicon built in memory can still hold one.
 */
export function exportMacos(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
  ];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
    if (findUnencodableChar(alias) !== undefined || findUnencodableChar(canonical) !== undefined) continue;
    lines.push('\t<dict>');
    lines.push('\t\t<key>phrase</key>');
    lines.push(`\t\t<string>${xmlEscape(canonical)}</string>`);
    lines.push('\t\t<key>shortcut</key>');
    lines.push(`\t\t<string>${xmlEscape(alias)}</string>`);
    lines.push('\t</dict>');
  }
  lines.push('</array>', '</plist>');
  return lines.join('\n') + '\n';
}
