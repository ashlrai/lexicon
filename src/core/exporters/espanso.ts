/** espanso match file: one word-bounded trigger per alias. */
import { stringify as stringifyYaml } from 'yaml';
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs } from './shared.js';

/**
 * What espanso's renderer does with a `replace` body (espanso-render,
 * renderer/mod.rs and util.rs): a body that matches its VAR_REGEX is a
 * variable injection, and every body then has `\{\{` and `\}\}` unescaped to
 * `{{` and `}}`. Undefined when espanso would read a variable.
 */
const ESPANSO_VAR_RE = /\{\{\s*(\w+)(\.(\w+))?\s*\}\}/;
function espansoRenders(body: string): string | undefined {
  if (ESPANSO_VAR_RE.test(body)) return undefined;
  return body.replaceAll('\\{\\{', '{{').replaceAll('\\}\\}', '}}');
}

/**
 * `canonical` as a `replace` body espanso types as written: each run of two
 * or more `{` is written as `\{\{` pairs (espanso's documented escape), with
 * the odd one out first, so no `{{` is left for espanso to read as a
 * variable. `}` needs no escape once no `{{` opens a variable.
 */
function espansoEscape(canonical: string): string {
  return canonical.replace(/\{{2,}/g, (run) => (run.length % 2 === 1 ? '{' : '') + '\\{\\{'.repeat(Math.floor(run.length / 2)));
}

/**
 * One match per alias, `replace` escaped by `espansoEscape`. A pair whose
 * canonical espanso cannot be made to type as written (it holds a literal
 * `\{\{` or `\}\}`, which espanso always unescapes) is left out, with a YAML
 * comment at the top naming it, rather than written to type something else.
 */
export function exportEspanso(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const leftOut: string[] = [];
  const matches = [];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
    const replace = espansoEscape(canonical);
    const typed = espansoRenders(replace);
    if (typed !== canonical) {
      const as = typed === undefined ? 'read a variable in it' : `type it as ${JSON.stringify(typed)}`;
      leftOut.push(`# left out ${JSON.stringify(alias)} -> ${JSON.stringify(canonical)}: espanso would ${as}`);
      continue;
    }
    matches.push({ trigger: alias, replace, word: true, propagate_case: false });
  }
  const body = stringifyYaml({ matches }, { lineWidth: 0 });
  return leftOut.length > 0 ? `${leftOut.join('\n')}\n${body}` : body;
}
