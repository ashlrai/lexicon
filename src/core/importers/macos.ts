/**
 * Apple Text Replacement plist (drag entries out of System Settings > Keyboard
 * > Text Replacements onto the Desktop). An array of dicts with `phrase` (what
 * gets typed, the canonical) and `shortcut` (what you type, the alias).
 *
 * Parsed with a linear indexOf scanner rather than regexes: the input is an
 * arbitrary user file, and lazy `[\s\S]*?` patterns over many unclosed
 * `<dict>` / `<key>` tags backtrack quadratically. No XML dependency; entities
 * decoded.
 */
import { rowFor } from './shared.js';
import type { RawImport } from './shared.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function looksLikePlist(content: string): boolean {
  const head = content.replace(/^﻿/, '').trimStart().slice(0, 400);
  return head.startsWith('<?xml') || head.startsWith('<!DOCTYPE plist') || head.startsWith('<plist');
}

// ---------------------------------------------------------------------------
// Tag scanner
// ---------------------------------------------------------------------------

interface Tag {
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
  selfClosing: boolean;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Find `<name>` (or `<name/>`), tolerating whitespace before the `>`, at or
 * after `from`. `name` may start with `/` for a closing tag. A prefix match
 * such as `<keyboard>` when looking for `<key>` is skipped, so the scan is a
 * plain forward walk: every indexOf resumes past the previous candidate.
 */
function findTag(text: string, name: string, from: number): Tag | undefined {
  const needle = `<${name}`;
  let at = from;
  for (;;) {
    const start = text.indexOf(needle, at);
    if (start === -1) return undefined;
    let i = start + needle.length;
    while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
    if (text[i] === '>') return { start, end: i + 1, selfClosing: false };
    if (text[i] === '/' && text[i + 1] === '>') return { start, end: i + 2, selfClosing: true };
    at = start + 1;
  }
}

/**
 * Extract `<key>k</key><string>v</string>` pairs from one dict body. A key
 * whose value is not a `<string>` (integer, true, nested dict, ...) maps to
 * undefined; a self-closing `<string/>` maps to ''. Whitespace and newlines
 * between the tags are tolerated. An unterminated tag ends the scan.
 */
function scanPairs(body: string): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  let pos = 0;
  for (;;) {
    const keyOpen = findTag(body, 'key', pos);
    if (!keyOpen || keyOpen.selfClosing) break;
    const keyClose = findTag(body, '/key', keyOpen.end);
    if (!keyClose) break;
    const key = xmlUnescape(body.slice(keyOpen.end, keyClose.start).trim());
    pos = keyClose.end;

    // The value is whatever tag comes next; only <string> carries a value here.
    let next = pos;
    while (next < body.length && isSpace(body.charCodeAt(next))) next += 1;
    const str = findTag(body, 'string', next);
    if (!str || str.start !== next) {
      values[key] = undefined;
      continue;
    }
    if (str.selfClosing) {
      values[key] = '';
      pos = str.end;
      continue;
    }
    const strClose = findTag(body, '/string', str.end);
    if (!strClose) {
      values[key] = undefined;
      break;
    }
    values[key] = xmlUnescape(body.slice(str.end, strClose.start));
    pos = strClose.end;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMacosImport(content: string): RawImport {
  const text = content.replace(/^﻿/, '');
  if (!/<plist|<array|<dict/.test(text)) {
    throw new Error('macos: expected an Apple Text Replacement plist (XML)');
  }
  const out: RawImport = { rows: [], skipped: [] };

  // Line numbers are counted incrementally so a file with many dicts stays linear.
  let line = 1;
  let lineScanned = 0;
  const lineOf = (offset: number): number => {
    for (; lineScanned < offset; lineScanned += 1) {
      if (text.charCodeAt(lineScanned) === 10) line += 1;
    }
    return line;
  };

  let pos = 0;
  for (;;) {
    const open = findTag(text, 'dict', pos);
    if (!open) break;
    if (open.selfClosing) {
      pos = open.end;
      continue;
    }
    const close = findTag(text, '/dict', open.end);
    // Unterminated dict: nothing after it can be a complete entry.
    if (!close) break;
    pos = close.end;

    const dictLine = lineOf(open.start);
    const values = scanPairs(text.slice(open.end, close.start));
    if (!('phrase' in values) && !('shortcut' in values)) {
      out.skipped.push({ line: dictLine, reason: 'dict has no phrase/shortcut keys' });
      continue;
    }
    const shortcut = values.shortcut ?? '';
    const { row, skip } = rowFor(dictLine, values.phrase ?? '', shortcut ? [shortcut] : []);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  }
  return out;
}
