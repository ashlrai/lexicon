/**
 * Whisper `initial_prompt`: a single line of comma-separated proper nouns.
 * Whisper biases toward spellings it sees in the prompt, so we list canonicals
 * only (never aliases). Capped at opts.limit ?? 100 names, and at what fits in
 * the part of the prompt Whisper reads (below); extra terms are dropped, the
 * least important first, with a note naming them.
 *
 * Whisper keeps only the last 224 tokens of a prompt (openai-whisper slices
 * `prompt_tokens[-(n_text_ctx // 2 - 1):]`, 223 tokens; whisper.cpp keeps
 * `n_text_ctx / 2`; OpenAI's transcription docs say 224). The names are
 * written most important first, so a line over that window lost exactly the
 * names that mattered most. The tokenizer (a byte-level BPE) is not bundled,
 * so the cap uses `estimateWhisperTokens`, a deliberately high offline
 * estimate, and keeps names, most important first, only while the whole line
 * stays within WHISPER_PROMPT_TOKEN_BUDGET.
 *
 * The `, ` join is not a delimiter Whisper parses: the prompt is read as text
 * already heard, so a canonical holding `, ` biases the same spelling either
 * way, and nothing reads the line back. Left as is and documented in
 * docs/EXPORTS.md rather than switching separators for every lexicon.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, quotedNames, sortByImportance } from './shared.js';
import type { ExportSink } from './shared.js';

export const WHISPER_PROMPT_DEFAULT_LIMIT = 100;

/** The prompt tokens Whisper reads: openai-whisper's 223 (`448 / 2 - 1`), the smallest of the implementations. */
export const WHISPER_PROMPT_TOKEN_BUDGET = 223;

/**
 * A high estimate of the Whisper (GPT-2 style byte-level BPE) tokens in
 * `text`, made offline without the vocabulary: a run of ASCII letters counts
 * one token per two letters, rounded up (English words are usually one token
 * and proper nouns about three letters a token); each digit, each ASCII
 * punctuation mark and each space not followed by a word one token; each
 * character outside ASCII one token per UTF-8 byte (byte-level BPE never needs
 * more). Not exact: a run of rare letters can take one token per letter. It
 * errs high so a line it lets through fits the window.
 */
export function estimateWhisperTokens(text: string): number {
  let tokens = 0;
  for (const m of text.matchAll(/ ?[A-Za-z]+|[0-9]|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]| |[^\x00-\x7f]/gu)) {
    const piece = m[0];
    if (/[A-Za-z]/.test(piece)) tokens += Math.ceil(piece.trimStart().length / 2);
    else if (/[^\x00-\x7f]/u.test(piece)) tokens += Buffer.byteLength(piece, 'utf8');
    else tokens += 1;
  }
  return tokens;
}

export function exportWhisperPrompt(lexicon: Lexicon, opts: ExportOptions = {}, sink?: ExportSink): string {
  const limit = opts.limit ?? WHISPER_PROMPT_DEFAULT_LIMIT;
  const names = canonicalList(sortByImportance(lexicon.terms))
    .slice(0, Math.max(0, limit))
    .map((c) => c.canonical.replace(/\s+/g, ' ').trim());
  const kept: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const name of names) {
    // `, ` before every name but the first: the comma is a token, the space joins the word.
    const cost = estimateWhisperTokens(kept.length > 0 ? `, ${name}` : name);
    if (dropped.length === 0 && used + cost <= WHISPER_PROMPT_TOKEN_BUDGET) {
      kept.push(name);
      used += cost;
    } else {
      dropped.push(name);
    }
  }
  if (dropped.length > 0) {
    sink?.notes.push(
      `left out ${dropped.length} name${dropped.length === 1 ? '' : 's'} past the ${WHISPER_PROMPT_TOKEN_BUDGET} prompt tokens Whisper reads (an offline estimate): ${quotedNames(dropped)}`,
    );
  }
  return kept.join(', ');
}
