/**
 * Plain text, one term per line, sorted by canonical. Round-trips through the
 * text importer:
 *
 *   Canonical: alias1, alias2
 *   Canonical = alias1 | alias2   (when the canonical has a colon or an alias a comma)
 *   Canonical                     (no aliases)
 *   Canonical =                   (no aliases, and the canonical has a colon)
 *   \#Canonical: alias            (a canonical that starts with `#`, escaped so it is no comment)
 */
import type { ExportOptions, Lexicon } from '../types.js';

export function exportText(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const terms = [...lexicon.terms].sort((a, b) => a.canonical.localeCompare(b.canonical));
  const lines = terms.map((t) => {
    const aliases = t.aliases.map((a) => a.trim()).filter(Boolean);
    // A leading `#` would make the line a comment, and the term would be lost
    // on import: escape it as `\#` (and `\#` as `\\#`), which the importer reads back.
    const canonical = /^\\*#/.test(t.canonical) ? `\\${t.canonical}` : t.canonical;
    // A bare `Re:Invent` would come back as canonical "Re" with alias "Invent".
    if (aliases.length === 0) return canonical.includes(':') ? `${canonical} =` : canonical;
    const needsEquals = canonical.includes(':') || aliases.some((a) => a.includes(','));
    return needsEquals ? `${canonical} = ${aliases.join(' | ')}` : `${canonical}: ${aliases.join(', ')}`;
  });
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
