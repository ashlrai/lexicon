/**
 * Our own lexicon file (`lexicon export json`, or a `.lexicon.yaml` — JSON is
 * YAML, so both parse). Validated with parseLexicon. Bookkeeping fields
 * (scope, createdAt, hits) are dropped: the destination store owns those.
 */
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from '../schema.js';
import type { Term } from '../types.js';
import { isRecord } from './shared.js';
import type { RawImport } from './shared.js';

export function looksLikeLexiconJson(value: unknown): boolean {
  return isRecord(value) && (Array.isArray(value.terms) || 'version' in value);
}

export function parseJsonImport(content: string): RawImport {
  let raw: unknown;
  try {
    raw = parseYaml(content.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`json: invalid JSON/YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  const lexicon = parseLexicon(raw);
  const rows = lexicon.terms.map((t, i) => {
    const { scope: _scope, createdAt: _createdAt, hits: _hits, ...rest } = t;
    const term: Term = { ...rest };
    return { line: i + 1, term };
  });
  return { rows, skipped: [] };
}
