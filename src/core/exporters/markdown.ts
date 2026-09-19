/** Markdown bullet list for READMEs and wikis: `- **Canonical** (category): alias1, alias2`. */
import type { ExportOptions, Lexicon } from '../types.js';
import { sortByCategory } from './shared.js';

export function exportMarkdown(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = sortByCategory(lexicon.terms).map((t) => {
    const aliases = t.aliases.map((a) => a.trim()).filter(Boolean);
    const head = `- **${t.canonical}**${t.category ? ` (${t.category})` : ''}`;
    return aliases.length > 0 ? `${head}: ${aliases.join(', ')}` : head;
  });
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
