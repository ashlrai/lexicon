/**
 * The lexicon as pretty-printed JSON: what the lexicon files hold, for
 * scripts and backups (`lexicon import` reads it back).
 *
 * `scope` and `hits` on a term are not in any lexicon file: `loadLexicon`
 * adds them to the merged view (which file a term came from, and this
 * user's counts from hits.json beside the global file). Written into the
 * export they made a backup differ after every corrected prompt, and an
 * import elsewhere carried this machine's counts into the other file. They
 * are left out; `lexicon list --json` and `lexicon stats --json` report
 * them, and the MCP `lexicon://json` resource keeps the merged view whole.
 */
import type { ExportOptions, Lexicon } from '../types.js';

export function exportJson(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const terms = lexicon.terms.map(({ scope: _scope, hits: _hits, ...rest }) => rest);
  return JSON.stringify({ ...lexicon, terms }, null, 2) + '\n';
}
