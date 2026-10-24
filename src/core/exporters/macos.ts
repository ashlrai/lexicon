/**
 * Apple Text Replacement plist: the format produced by dragging entries out of
 * System Settings > Keyboard > Text Replacements. One dict per alias
 * (shortcut = alias, phrase = canonical).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, xmlEscape } from './shared.js';

/**
 * Code units XML 1.0 cannot hold, not even as a character reference: U+FFFE,
 * U+FFFF and a surrogate that is not half of a pair (which no UTF-8 file can
 * hold either). The schema rejects the C0 controls; these pass it.
 */
const NOT_XML_RE = /[\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * One dict per alias. A pair with a character XML cannot hold (NOT_XML_RE) is
 * left out: written, it made the whole plist unreadable, and every other
 * replacement with it.
 */
export function exportMacos(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
  ];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
    if (NOT_XML_RE.test(alias) || NOT_XML_RE.test(canonical)) continue;
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
