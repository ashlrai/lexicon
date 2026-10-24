/** espanso match file: one word-bounded trigger per alias. */
import { stringify as stringifyYaml } from 'yaml';
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, sharedTriggerNote, uniqueTriggers } from './shared.js';
import type { ExportSink } from './shared.js';

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
 *
 * Two terms sharing an alias wrote the trigger twice, and espanso then
 * expands it to either. The term `uniqueTriggers` ranks first keeps it (a
 * trigger is matched as written, so `Ashler` and `ashler` are two); the
 * other is named in a note.
 *
 * Every string is written double-quoted. A plain scalar is read by type:
 * `yes`, `no`, `on`, `off` (YAML 1.1 booleans), `null`, `~`, `0o7`, `1_000`
 * or `1:20` (a 1.1 sexagesimal) would come back as a boolean, null or number
 * under one YAML version or another, so a trigger or name like that no
 * longer types as written.
 */
export function exportEspanso(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const leftOut: string[] = [];
  const matches = [];
  const { kept, dropped } = uniqueTriggers(aliasPairs(lexicon));
  const shared = sharedTriggerNote(dropped, 'trigger');
  if (shared) sink?.notes.push(shared);
  for (const { alias, canonical } of kept) {
    const replace = espansoEscape(canonical);
    const typed = espansoRenders(replace);
    if (typed !== canonical) {
      const as = typed === undefined ? 'read a variable in it' : `type it as ${JSON.stringify(typed)}`;
      leftOut.push(`# left out ${JSON.stringify(alias)} -> ${JSON.stringify(canonical)}: espanso would ${as}`);
      continue;
    }
    matches.push({ trigger: alias, replace, word: true, propagate_case: false });
  }
  if (sink) sink.rows = matches.length;
  const body = stringifyYaml({ matches }, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return leftOut.length > 0 ? `${leftOut.join('\n')}\n${body}` : body;
}
