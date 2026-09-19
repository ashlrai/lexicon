/**
 * Apple Text Replacement plist: the format produced by dragging entries out of
 * System Settings > Keyboard > Text Replacements. One dict per alias
 * (shortcut = alias, phrase = canonical).
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, xmlEscape } from './shared.js';

export function exportMacos(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
  ];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
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
