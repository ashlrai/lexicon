/**
 * Markdown snippet for CLAUDE.md / a system prompt: tells the agent which
 * garbled spellings map to which canonical term.
 */
import type { ExportOptions, Lexicon, Term } from '../types.js';
import { joinAliasList, mdCell, sortByCategory, sortByImportance } from './shared.js';

export const CLAUDE_MD_HEADING = '## Voice lexicon';

export function exportClaudeMd(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  return renderClaudeMd(sortByCategory(lexicon.terms).map(claudeMdRow));
}

/** The table, its header and its footer around `rows`, with `more` (when given) as the line after the last row. */
function renderClaudeMd(rows: readonly string[], more?: string): string {
  const lines = [
    CLAUDE_MD_HEADING,
    '',
    'The user dictates with speech-to-text. When a transcript contains one of these spellings, they mean the canonical term. Always write the canonical form.',
    '',
    '| Canonical | Sounds like / STT writes | Note |',
    '| --- | --- | --- |',
  ];
  lines.push(...rows);
  if (more !== undefined) lines.push(more);
  lines.push('', 'If a word looks like a garbled proper noun and is not listed, ask rather than guess.');
  return lines.join('\n') + '\n';
}

function claudeMdRow(term: Term): string {
  return `| ${mdCell(term.canonical)} | ${mdCell(joinAliasList(term.aliases))} | ${mdCell(noteFor(term))} |`;
}

/** What `exportClaudeMdWithin` returns: the text, and how many terms' rows it left out. */
export interface CappedClaudeMd {
  text: string;
  omitted: number;
}

/**
 * The claude-md export of `lexicon` in at most `maxChars` characters, for
 * text read into model context whole (the MCP `lexicon://me` resource and
 * `voice-context` prompt). When the whole export fits it is returned as is.
 * Otherwise rows are taken in `sortByImportance` order (hits, highest first;
 * then brand, person and product terms; then canonical A to Z), as
 * `ExportOptions.limit` keeps them, and a row that does not fit in what is
 * left is skipped while later, shorter rows still count (as the SessionStart
 * hook's `truncateSessionContext` does). The kept rows are written in the
 * export's own order, followed by the line `more(omitted)` (which should say
 * how to get the rest) and the usual footer. Header and footer always
 * survive; when they alone exceed `maxChars` the text is cut there.
 */
export function exportClaudeMdWithin(lexicon: Lexicon, maxChars: number, more: (omitted: number) => string): CappedClaudeMd {
  const full = exportClaudeMd(lexicon);
  if (full.length <= maxChars) return { text: full, omitted: 0 };
  const total = lexicon.terms.length;
  // Room for the frame and the longest `more` line it can need, plus its newline.
  let used = renderClaudeMd([]).length + more(total).length + 1;
  const keep = new Set<Term>();
  for (const term of sortByImportance(lexicon.terms)) {
    const cost = claudeMdRow(term).length + 1;
    if (used + cost > maxChars) continue;
    used += cost;
    keep.add(term);
  }
  const rows = sortByCategory(lexicon.terms.filter((t) => keep.has(t))).map(claudeMdRow);
  const omitted = total - keep.size;
  const text = renderClaudeMd(rows, more(omitted));
  return { text: text.length <= maxChars ? text : cutWithin(text, maxChars), omitted };
}

/**
 * `text` cut to `maxChars` with `...` and a newline at the end. The cut never
 * falls inside a surrogate pair: half an emoji or a CJK extension character
 * is an unpaired surrogate, which is not valid UTF-8 and was written to the
 * model context as U+FFFD (or refused by a strict encoder).
 */
function cutWithin(text: string, maxChars: number): string {
  const tail = '...\n';
  if (maxChars <= tail.length) return tail.slice(0, Math.max(0, maxChars));
  let end = maxChars - tail.length;
  const before = text.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${tail}`;
}

/**
 * The note cell, `category notes (phonetic)`. The markdown importer reads a
 * trailing parenthesis as the phonetic hint, so a note ending in one with no
 * phonetic of its own ("the CLI (not the app)") gets an empty `()` after it,
 * which the importer reads as no phonetic, leaving the note whole.
 */
function noteFor(term: Term): string {
  const parts: string[] = [];
  if (term.category) parts.push(term.category);
  if (term.notes?.trim()) parts.push(term.notes.trim());
  if (term.phonetic?.trim()) parts.push(`(${term.phonetic.trim()})`);
  else if (term.notes?.trim().endsWith(')')) parts.push('()');
  return parts.join(' ');
}
