/**
 * Plain text, one term per line, sorted by canonical. Round-trips through the
 * text importer:
 *
 *   Canonical: alias1, alias2
 *   Canonical = alias1 | alias2   (when the canonical has a colon or an alias a comma)
 *   Canonical                     (no aliases)
 *   Canonical =                   (no aliases, and the canonical has a colon)
 */
import type { ExportOptions, Lexicon } from '../types.js';

export function exportText(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const terms = [...lexicon.terms].sort((a, b) => a.canonical.localeCompare(b.canonical));
  const lines = terms.map((t) => {
    const aliases = t.aliases.map((a) => a.trim()).filter(Boolean);
    // A bare `Re:Invent` would come back as canonical "Re" with alias "Invent".
    if (aliases.length === 0) return t.canonical.includes(':') ? `${t.canonical} =` : t.canonical;
    const needsEquals = t.canonical.includes(':') || aliases.some((a) => a.includes(','));
    return needsEquals ? `${t.canonical} = ${aliases.join(' | ')}` : `${t.canonical}: ${aliases.join(', ')}`;
  });
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
