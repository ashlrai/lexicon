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
 * An edit outside the `terms:` list (the `version:` line, `settings:`) is
 * checked the same way on the file with the list items left out, and a file
 * without a block `terms:` list is parsed whole when it is small. A term the
 * edit added or renamed whose canonical another term of the file already
 * holds is reported too (`lexicon doctor` fails a canonical defined twice in
 * one lexicon): the rest of the list is scanned line by line for its
 * `canonical:` keys, which costs far less than a parse.
 *
 * It answers only when the answer is cheap and safe to give. Anything it
 * cannot place (anchors or aliases, a second document, an edit over
 * EDIT_CHECK_MAX_CHARS) is undefined, as is a region that parses and
 * validates: the background refresh still decides. A problem it does report
 * is hedged by the caller ("looks broken"), because a part of a file is not
 * the file: a check of the whole text in the background confirms it. A
 * problem never quotes the file's text: a line number and a reason only.
 */
import { parse as parseYaml } from 'yaml';
import { parseLexicon } from './schema.js';
import type { Lexicon, Term } from './types.js';

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
  // No block `terms:` list (`terms: []`, a flow list, the key gone): only a small file is cheap to read whole.
  if (!termsKey) return checkWhole(after);
  const listStart = termsKey.index + termsKey[0].length + 1;
  // A top-level key (or document marker) after the list ends it.
  const topLevelRe = /^(?:[^\s#-]|---|\.\.\.)/gm;
  topLevelRe.lastIndex = listStart;
  const nextTop = topLevelRe.exec(after);
  const listEnd = nextTop ? nextTop.index : after.length;
  // An edit wholly outside the list items: check the file without them.
  if (changedEnd <= listStart || p >= listEnd) return checkOutsideList(after, termsKey.index, listStart, listEnd);
  if (p < listStart || changedEnd > listEnd) return checkWhole(after);
  // The first item fixes the list's indent; an empty block list has none.
  const firstItem = /^( *)- /m.exec(after.slice(listStart));
  if (!firstItem) return checkWhole(after);
  const indent = firstItem[1];
  const itemRe = new RegExp(`^${indent}- `, 'gm');

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
  if (hasAnchors(region)) return undefined;

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
  let parsed: Lexicon;
  try {
    parsed = parseLexicon({ version: 1, terms });
  } catch (err) {
    return schemaIssue(err, (k) => `term at line ${itemLines[k] ?? firstLine}`);
  }
  return duplicateCanonical(after, parsed.terms, (k) => itemLines[k] ?? firstLine, indent, listStart, listEnd, regionStart, regionEnd);
}

/** Anchors, aliases or merge keys, which can point at text the check does not read. */
function hasAnchors(text: string): boolean {
  return /(?:^|[\s[{,])[&*][^\s]|<<\s*:/.test(text);
}

/** A document marker other than one `---` that opens the file: a second document. */
function hasSecondDocument(text: string): boolean {
  const re = /^(?:---|\.\.\.)(?:[ \t]|$)/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) if (m.index !== 0) return true;
  return false;
}

/** The first schema problem of `err`, a term named by `termName(k)` for `terms[k]` (`term at line 12`). */
function schemaIssue(err: unknown, termName: (k: number) => string): string {
  const message = err instanceof Error ? err.message : String(err);
  const issue = message.split('\n').find((l) => l.trim().startsWith('- ')) ?? message;
  return issue
    .trim()
    .replace(/^- /, '')
    .replace(/^terms\[(\d+)\]\.?/, (m, k: string) => `the ${termName(Number(k))}${m.endsWith('.') ? ': ' : ''}`);
}

/**
 * An edit before or after the list items (`version:`, `settings:`, a comment):
 * the file with the items left out (`terms: []` in their place) is parsed and
 * validated, which is as small as the rest of the file.
 */
function checkOutsideList(after: string, termsAt: number, listStart: number, listEnd: number): string | undefined {
  const head = `${after.slice(0, termsAt)}terms: []\n`;
  const skeleton = head + after.slice(listEnd);
  if (skeleton.length > EDIT_CHECK_MAX_CHARS || hasAnchors(skeleton) || hasSecondDocument(skeleton)) return undefined;
  // An offset in the skeleton, as a line of `after`: the head keeps its lines, the tail moved up.
  const lineOf = (offset: number): number => (offset < head.length ? lineNumber(skeleton, offset) : lineNumber(after, listEnd + offset - head.length));
  return checkText(skeleton, lineOf);
}

/** A small file read whole (no block `terms:` list to cut it down by). */
function checkWhole(after: string): string | undefined {
  if (after.length > EDIT_CHECK_MAX_CHARS || hasAnchors(after) || hasSecondDocument(after)) return undefined;
  return checkText(after, (offset) => lineNumber(after, offset));
}

/** Parse and validate `text` as a whole lexicon, naming a YAML error's line through `lineOf` and a term by its place in the list. */
function checkText(text: string, lineOf: (offset: number) => number): string | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    const pos = (err as { pos?: unknown }).pos;
    const offset = Array.isArray(pos) && typeof pos[0] === 'number' ? pos[0] : 0;
    return `line ${lineOf(offset)}: ${firstSentence(err)}`;
  }
  if (raw === null || raw === undefined) return undefined;
  let parsed: Lexicon;
  try {
    parsed = parseLexicon(raw);
  } catch (err) {
    return schemaIssue(err, (k) => `term #${k + 1}`);
  }
  // Two terms with one canonical in a small file: name both by item order.
  const seen = new Map<string, number>();
  for (const [k, t] of parsed.terms.entries()) {
    const key = foldCanonical(t.canonical);
    const first = seen.get(key);
    if (first !== undefined) return `the term #${k + 1}: ${sameCanonicalNote(`term #${first + 1}`)}`;
    seen.set(key, k);
  }
  return undefined;
}

/** How the store compares canonicals (store.ts foldKey): trimmed, lowercased, NFC. */
function foldCanonical(canonical: string): string {
  return canonical.trim().toLowerCase().normalize('NFC');
}

function sameCanonicalNote(other: string): string {
  return `its canonical is already the canonical of the ${other} (a canonical may be defined once per file: merge the two terms or remove one)`;
}

/**
 * A term in the edited items whose canonical another term holds, within the
 * items or elsewhere in the list. The rest of the list is not parsed: each
 * item's `canonical:` key (on its `- ` line or at the item's key column) is
 * read off its line, so a 5000-term file costs a regular expression pass.
 */
function duplicateCanonical(
  after: string,
  terms: readonly Term[],
  termLine: (k: number) => number,
  indent: string,
  listStart: number,
  listEnd: number,
  regionStart: number,
  regionEnd: number,
): string | undefined {
  const edited = new Map<string, number>();
  for (const [k, t] of terms.entries()) {
    const key = foldCanonical(t.canonical);
    const first = edited.get(key);
    if (first !== undefined) return `the term at line ${termLine(k)}: ${sameCanonicalNote(`term at line ${termLine(first)}`)}`;
    edited.set(key, k);
  }
  const keyRe = new RegExp(`^${indent}(?:- |  )canonical:[ \\t]*(.*)$`, 'gm');
  for (const [from, to] of [
    [listStart, regionStart],
    [regionEnd, listEnd],
  ] as const) {
    keyRe.lastIndex = from;
    for (let m = keyRe.exec(after); m && m.index < to; m = keyRe.exec(after)) {
      const value = scalarValue(m[1]);
      if (value === undefined) continue;
      const k = edited.get(foldCanonical(value));
      if (k !== undefined) return `the term at line ${termLine(k)}: ${sameCanonicalNote(`term at line ${lineNumber(after, m.index)}`)}`;
    }
  }
  return undefined;
}

/** The string a one-line YAML scalar (`Foo`, `"Foo"`, `'Foo'`, with a comment) stands for, or undefined when it is not one. */
function scalarValue(text: string): string | undefined {
  const t = text.trim();
  if (!t || /^[|>&*!{[]/.test(t)) return undefined;
  if (t.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(t);
    return m ? m[1].replace(/''/g, "'") : undefined;
  }
  if (t.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(t);
    if (!m) return undefined;
    try {
      const v: unknown = JSON.parse(m[1]);
      return typeof v === 'string' ? v : undefined;
    } catch {
      // A YAML escape JSON lacks (\x41, \_): ask the YAML library about this one line.
      try {
        const v: unknown = parseYaml(m[1]);
        return typeof v === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return t.replace(/\s+#.*$/, '').trim();
}

/** The YAML library's message up to its first line break (no source excerpt). */
function firstSentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].trim();
}
