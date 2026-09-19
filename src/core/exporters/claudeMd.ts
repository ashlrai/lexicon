/**
 * Markdown snippet for CLAUDE.md / a system prompt: tells the agent which
 * garbled spellings map to which canonical term.
 */
import type { ExportOptions, Lexicon, Term } from '../types.js';
import { mdCell, sortByCategory } from './shared.js';

export const CLAUDE_MD_HEADING = '## Voice lexicon';

export function exportClaudeMd(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = [
    CLAUDE_MD_HEADING,
    '',
    'The user dictates with speech-to-text. When a transcript contains one of these spellings, they mean the canonical term. Always write the canonical form.',
    '',
    '| Canonical | Sounds like / STT writes | Note |',
    '| --- | --- | --- |',
  ];
  for (const term of sortByCategory(lexicon.terms)) {
    lines.push(
      `| ${mdCell(term.canonical)} | ${mdCell(term.aliases.join(', '))} | ${mdCell(noteFor(term))} |`,
    );
  }
  lines.push('', 'If a word looks like a garbled proper noun and is not listed, ask rather than guess.');
  return lines.join('\n') + '\n';
}

function noteFor(term: Term): string {
  const parts: string[] = [];
  if (term.category) parts.push(term.category);
  if (term.notes?.trim()) parts.push(term.notes.trim());
  if (term.phonetic?.trim()) parts.push(`(${term.phonetic.trim()})`);
  return parts.join(' ');
}
