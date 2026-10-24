/**
 * A cheap look at the part of a global lexicon file a hand edit changed,
 * for the prompt hook's stale path (see LoadOptions.staleGlobal in store.ts).
 *
 * The stale path serves the previous parse while a background process parses
 * the new text, so an edit that broke the file was reported only from the
 * prompt after that refresh: the first prompt said nothing was wrong. Parsing
 * the whole file to find out is what the stale path exists to avoid (about
 * 350 ms at 5000 terms), but an edit is usually a few lines inside the
 * `terms:` list. This parses only the list items the edit touched, wrapped in
 * a `terms:` key, and validates them with the schema: a few milliseconds.
 *
 * It answers only when the answer is cheap and safe to give. Anything it
 * cannot place (an edit outside the `terms:` list, anchors or aliases, a
 * second document, an edited region over EDIT_CHECK_MAX_CHARS) is undefined,
 * as is a region that parses and validates: the background refresh still
 * decides. A problem it does report is hedged by the caller ("looks broken"),
 * because a part of a file is not the file: a check of the whole text in the
 * background confirms it.
 */
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from './schema.js';

/** Largest edited region (characters, whole list items) the check parses; a bigger edit is left to the background refresh. */
export const EDIT_CHECK_MAX_CHARS = 32 * 1024;

/** Offset of the start of the line holding `at`. */
function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

/** 1-based line number of offset `at`. */
function lineNumber(text: string, at: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/**
 * Why the list items an edit from `before` to `after` touched do not parse or
 * validate, naming the line in `after` (`line 812: ...`), or undefined when
 * they do or the check cannot tell cheaply (see the module comment). Never
 * throws. Exported for tests.
 */
export function checkLexiconEdit(before: string, after: string): string | undefined {
  try {
    return check(before, after);
  } catch {
    return undefined;
  }
}

function check(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p += 1;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s += 1;
  // [p, changedEnd) is what the edit wrote into `after` (empty for a deletion).
  const changedEnd = Math.max(p, after.length - s);

  const termsKey = /^terms:[ \t]*(?:#[^\n]*)?$/m.exec(after);
  if (!termsKey) return undefined;
  const listStart = termsKey.index + termsKey[0].length + 1;
  if (p < listStart) return undefined;
  // The first item fixes the list's indent; `terms: []` and friends have none.
  const firstItem = /^( *)- /m.exec(after.slice(listStart));
  if (!firstItem) return undefined;
  const indent = firstItem[1];
  const itemRe = new RegExp(`^${indent}- `, 'gm');
  // A top-level key (or document marker) after the list ends it.
  const topLevelRe = /^(?:[^\s#-]|---|\.\.\.)/gm;
  topLevelRe.lastIndex = listStart;
  const nextTop = topLevelRe.exec(after);
  const listEnd = nextTop ? nextTop.index : after.length;
  if (changedEnd > listEnd) return undefined;

  // Widen the region to whole items: from the start of the item holding p to
  // the start of the first item after the edit.
  let regionStart = -1;
  itemRe.lastIndex = listStart;
  const editLine = lineStart(after, p);
  for (let m = itemRe.exec(after); m && m.index <= editLine; m = itemRe.exec(after)) regionStart = m.index;
  if (regionStart === -1) return undefined;
  itemRe.lastIndex = Math.max(changedEnd, editLine + 1);
  const next = itemRe.exec(after);
  const regionEnd = next && next.index < listEnd ? next.index : listEnd;
  if (regionEnd - regionStart > EDIT_CHECK_MAX_CHARS) return undefined;
  const region = after.slice(regionStart, regionEnd);
  // Anchors, aliases and merge keys can point outside the region.
  if (/(?:^|[\s[{,])[&*][^\s]|<<\s*:/.test(region)) return undefined;

  const header = 'terms:\n';
  const firstLine = lineNumber(after, regionStart);
  const at = (offset: number): number => firstLine + lineNumber(region, Math.max(0, offset - header.length)) - 1;
  let raw: unknown;
  try {
    raw = parseYaml(header + region, { prettyErrors: false });
  } catch (err) {
    const pos = (err as { pos?: unknown }).pos;
    const offset = Array.isArray(pos) && typeof pos[0] === 'number' ? pos[0] : header.length;
    return `line ${at(offset)}: ${firstSentence(err)}`;
  }
  const terms = (raw as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(terms)) return undefined;
  // Where each item starts, for naming the line of a schema problem.
  const itemLines: number[] = [];
  const localRe = new RegExp(`^${indent}- `, 'gm');
  for (let m = localRe.exec(region); m; m = localRe.exec(region)) itemLines.push(firstLine + lineNumber(region, m.index) - 1);
  try {
    parseLexicon({ version: 1, terms });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const issue = message.split('\n').find((l) => l.trim().startsWith('- ')) ?? message;
    return issue
      .trim()
      .replace(/^- /, '')
      .replace(/^terms\[(\d+)\]\.?/, (m, k: string) => `the term at line ${itemLines[Number(k)] ?? firstLine}${m.endsWith('.') ? ': ' : ''}`);
  }
  return undefined;
}

/** The YAML library's message up to its first line break (no source excerpt). */
function firstSentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].trim();
}
