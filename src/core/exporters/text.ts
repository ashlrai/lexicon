/**
 * Plain text, one term per line, sorted by canonical. Round-trips through the
 * text importer:
 *
 *   Canonical: alias1, alias2
 *   Canonical = alias1 | alias2   (when the canonical has a colon or an alias a comma)
 *   Canonical                     (no aliases)
 *   Canonical =                   (no aliases, and the canonical has a colon)
 *   \#Canonical: alias            (a canonical that starts with `#`, escaped so it is no comment)
 *
 * Inside a field a backslash escapes what would otherwise separate: an `=`
 * at the start of a field or after whitespace (`A \= B` is the canonical
 * "A = B"), a `|` in an alias of the `=` form, a `,` in an alias of the `:`
 * form, and a backslash that comes before one of `\ | , : =` or ends the
 * field. The importer reads each `\x` back as `x`, so every line is exact
 * both ways.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { compareCanonical } from './shared.js';

/** What the text importer unescapes after a backslash. */
const ESCAPABLE = '\\|,:=';

/**
 * Escape `field` for one position of a line: `separators` are escaped
 * everywhere in it, an `=` where it could start ` = ` or end ` =`, and a
 * backslash where the importer would otherwise read it as an escape (or as
 * escaping the separator that follows the field).
 */
function escapeField(field: string, separators: string): string {
  let out = '';
  for (let i = 0; i < field.length; i++) {
    const c = field[i] as string;
    const next = field[i + 1];
    if (separators.includes(c)) out += `\\${c}`;
    else if (c === '=' && (i === 0 || /\s/.test(field[i - 1] as string))) out += '\\=';
    else if (c === '\\' && (next === undefined || ESCAPABLE.includes(next))) out += '\\\\';
    else out += c;
  }
  return out;
}

export function exportText(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const terms = [...lexicon.terms].sort((a, b) => compareCanonical(a.canonical, b.canonical));
  const lines = terms.map((t) => {
    const aliases = t.aliases.map((a) => a.trim()).filter(Boolean);
    const needsEquals = t.canonical.includes(':') || aliases.some((a) => a.includes(','));
    let canonical = escapeField(t.canonical, '');
    // A leading `#` would make the line a comment, and the term would be lost
    // on import: escape it as `\#` (and `\#` as `\\#`), which the importer reads back.
    if (/^\\*#/.test(canonical)) canonical = `\\${canonical}`;
    // A bare `Re:Invent` would come back as canonical "Re" with alias "Invent".
    if (aliases.length === 0) return t.canonical.includes(':') ? `${canonical} =` : canonical;
    return needsEquals
      ? `${canonical} = ${aliases.map((a) => escapeField(a, '|')).join(' | ')}`
      : `${canonical}: ${aliases.map((a) => escapeField(a, ',')).join(', ')}`;
  });
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
