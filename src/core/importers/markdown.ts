/**
 * Markdown: read back what `lexicon export claude-md` and `lexicon export
 * markdown` write, so a lexicon kept by hand in CLAUDE.md / AGENTS.md (or
 * pasted into a teammate's file) can come back in without retyping.
 *
 * Two shapes are recognised:
 *
 *   | Canonical | Sounds like / STT writes | Note |      (claude-md table)
 *   | --- | --- | --- |
 *   | Ashlr.AI | Ashler, Ashley AI | company (ASH-ler) |
 *
 *   - **Ashlr.AI** (company): Ashler, Ashley AI           (markdown bullets)
 *
 * Only tables whose header starts with a `Canonical` cell are read, so other
 * tables in the same file are left alone. When the file has a
 * `## Voice lexicon` heading, only that section is read, so the rest of a
 * CLAUDE.md (build commands, conventions, `- **Build**: ...` bullets) is
 * ignored. Anything that is not one of the two shapes is ignored rather than
 * reported; a row inside a lexicon table that cannot be a term is skipped with
 * its 1-based line number.
 */
import { CLAUDE_MD_HEADING } from '../exporters/claudeMd.js';
import { parseCategoryCell, rowFor } from './shared.js';
import type { RawImport } from './shared.js';
import type { TermCategory } from '../types.js';

const BULLET = /^[-*+]\s+\*\*(.+?)\*\*(?:\s+\(([^)]*)\))?\s*(?::\s*(.*))?$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Split a markdown table row into trimmed cells, honouring `\|` escapes. */
export function splitTableRow(line: string): string[] | undefined {
  const text = line.trim();
  if (!text.startsWith('|')) return undefined;
  const cells: string[] = [];
  let cell = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  // A row without a closing pipe still has a final cell.
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

function splitAliases(cell: string | undefined): string[] {
  return (cell ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * The claude-md note cell is `category notes (phonetic)`, each part optional.
 * Take a leading category word and a trailing parenthesised hint; the rest is
 * the free-text note.
 */
export function parseNoteCell(cell: string | undefined): {
  category?: TermCategory;
  phonetic?: string;
  notes?: string;
} {
  let rest = (cell ?? '').trim();
  const out: { category?: TermCategory; phonetic?: string; notes?: string } = {};
  const hint = /\(([^()]*)\)$/.exec(rest);
  if (hint) {
    out.phonetic = hint[1].trim() || undefined;
    rest = rest.slice(0, hint.index).trim();
  }
  const [first, ...more] = rest.split(/\s+/);
  const category = parseCategoryCell(first);
  if (category) {
    out.category = category;
    rest = more.join(' ');
  }
  if (rest.trim()) out.notes = rest.trim();
  return out;
}

/** Restrict to the `## Voice lexicon` section when the file has one. */
function sectionLines(lines: readonly string[]): { start: number; end: number } {
  const heading = CLAUDE_MD_HEADING.replace(/^#+\s*/, '').toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i].trim());
    if (!m || m[2].toLowerCase() !== heading) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING.exec(lines[j].trim());
      if (next && next[1].length <= level) {
        end = j;
        break;
      }
    }
    return { start: i + 1, end };
  }
  return { start: 0, end: lines.length };
}

function isLexiconTableHeader(cells: readonly string[] | undefined): boolean {
  return !!cells && cells.length >= 2 && cells[0].toLowerCase() === 'canonical';
}

export function looksLikeMarkdown(content: string): boolean {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const heading = CLAUDE_MD_HEADING.toLowerCase();
  if (lines.some((l) => l.trim().toLowerCase() === heading)) return true;
  if (lines.some((l) => isLexiconTableHeader(splitTableRow(l)))) return true;
  // A bare `lexicon export markdown`: every non-blank line is a bold bullet.
  const nonBlank = lines.map((l) => l.trim()).filter(Boolean);
  return nonBlank.length > 0 && nonBlank.every((l) => BULLET.test(l));
}

export function parseMarkdownImport(content: string): RawImport {
  const out: RawImport = { rows: [], skipped: [] };
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const { start, end } = sectionLines(lines);
  let inTable = false;

  for (let i = start; i < end; i++) {
    const lineNo = i + 1;
    const text = lines[i].trim();
    const cells = splitTableRow(text);

    if (cells) {
      if (isLexiconTableHeader(cells)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue; // some other table
      if (cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c))) continue;
      if (cells.length < 2) {
        out.skipped.push({ line: lineNo, reason: 'table row needs a canonical and an aliases cell' });
        continue;
      }
      const { row, skip } = rowFor(lineNo, cells[0], splitAliases(cells[1]), parseNoteCell(cells[2]));
      if (row) out.rows.push(row);
      if (skip) out.skipped.push(skip);
      continue;
    }
    inTable = false;

    const bullet = BULLET.exec(text);
    if (!bullet) continue;
    // `(brand)` is a category; any other parenthetical is kept as a note
    // rather than dropping a hand-written term.
    const category = parseCategoryCell(bullet[2]);
    const extra = category ? { category } : bullet[2]?.trim() ? { notes: bullet[2] } : {};
    const { row, skip } = rowFor(lineNo, bullet[1], splitAliases(bullet[3]), extra);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  }
  return out;
}
