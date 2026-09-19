/**
 * espanso match file (`matches:` YAML). `trigger` (or each of `triggers`) is
 * the alias, `replace` the canonical. Entries with `vars`, `regex` triggers or
 * multi-line replacements are templates, not dictionary words: skipped.
 */
import { LineCounter, parseDocument, isSeq, isMap } from 'yaml';
import { isRecord, rowFor } from './shared.js';
import type { RawImport } from './shared.js';

export function looksLikeEspanso(content: string): boolean {
  return /^matches\s*:/m.test(content.replace(/^﻿/, ''));
}

export function parseEspansoImport(content: string): RawImport {
  const text = content.replace(/^﻿/, '');
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    throw new Error(`espanso: invalid YAML (${doc.errors[0].message.split('\n')[0]})`);
  }
  const root = doc.contents;
  const matches = isMap(root) ? root.get('matches', true) : undefined;
  if (!isSeq(matches)) {
    throw new Error('espanso: expected a top-level `matches:` list');
  }
  const out: RawImport = { rows: [], skipped: [] };
  matches.items.forEach((node, i) => {
    const offset = isMap(node) && node.range ? node.range[0] : undefined;
    const line = offset === undefined ? i + 1 : lineCounter.linePos(offset).line;
    const entry: unknown = isMap(node) ? node.toJSON() : node;
    if (!isRecord(entry)) {
      out.skipped.push({ line, reason: 'match is not a mapping' });
      return;
    }
    if (entry.vars !== undefined) {
      out.skipped.push({ line, reason: 'match uses vars (template, not a word)' });
      return;
    }
    if (typeof entry.replace !== 'string') {
      out.skipped.push({ line, reason: 'match has no string `replace`' });
      return;
    }
    if (/[\r\n]/.test(entry.replace)) {
      out.skipped.push({ line, reason: 'multi-line replace (template, not a word)' });
      return;
    }
    const triggers: string[] = [];
    if (typeof entry.trigger === 'string') triggers.push(entry.trigger);
    if (Array.isArray(entry.triggers)) {
      for (const t of entry.triggers) if (typeof t === 'string') triggers.push(t);
    }
    if (triggers.length === 0) {
      out.skipped.push({ line, reason: 'match has no trigger (regex matches are skipped)' });
      return;
    }
    // espanso triggers are often prefixed with ':' or ';' to avoid firing on
    // ordinary typing; those prefixes are not what STT writes.
    const aliases = triggers.map((t) => t.replace(/^[:;]+/, ''));
    const { row, skip } = rowFor(line, entry.replace, aliases);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  });
  return out;
}
