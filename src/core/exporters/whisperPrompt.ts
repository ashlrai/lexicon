/**
 * Whisper `initial_prompt`: a single line of comma-separated proper nouns.
 * Whisper biases toward spellings it sees in the prompt, so we list canonicals
 * only (never aliases). Capped at opts.limit ?? 100; extra terms are dropped.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { sortByImportance } from './shared.js';

export const WHISPER_PROMPT_DEFAULT_LIMIT = 100;

export function exportWhisperPrompt(lexicon: Lexicon, opts: ExportOptions = {}): string {
  const limit = opts.limit ?? WHISPER_PROMPT_DEFAULT_LIMIT;
  const terms = sortByImportance(lexicon.terms).slice(0, Math.max(0, limit));
  return terms.map((t) => t.canonical.replace(/\s+/g, ' ').trim()).join(', ');
}
