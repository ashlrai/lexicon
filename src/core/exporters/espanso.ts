/** espanso match file: one word-bounded trigger per alias. */
import { stringify as stringifyYaml } from 'yaml';
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs } from './shared.js';

export function exportEspanso(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const matches = aliasPairs(lexicon).map(({ alias, canonical }) => ({
    trigger: alias,
    replace: canonical,
    word: true,
    propagate_case: false,
  }));
  return stringifyYaml({ matches }, { lineWidth: 0 });
}
