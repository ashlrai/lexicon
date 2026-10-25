/**
 * Speechmatics custom dictionary: `{ "additional_vocab": [...] }`, one entry
 * per canonical as `{ "content": "<canonical>", "sounds_like": [aliases] }`.
 * `sounds_like` is the term's aliases (trimmed, once each, never the
 * canonical itself); a term with none emits `content` only, never an empty
 * `sounds_like`. Paste the array into a job's
 * `transcription_config.additional_vocab`.
 *
 * Speechmatics documents up to SPEECHMATICS_VOCAB_MAX entries (as last read,
 * not confirmed offline), so the most important canonicals
 * (sortByImportance) are kept and the rest are named in a note.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, quotedNames, sortByImportance } from './shared.js';
import type { ExportSink } from './shared.js';

export const SPEECHMATICS_VOCAB_MAX = 1000;

interface VocabEntry {
  content: string;
  sounds_like?: string[];
}

export function exportSpeechmatics(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const additional_vocab: VocabEntry[] = [];
  const overCap: string[] = [];
  for (const { term, canonical } of canonicalList(sortByImportance(lexicon.terms))) {
    const content = canonical.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    if (additional_vocab.length >= SPEECHMATICS_VOCAB_MAX) {
      overCap.push(canonical);
      continue;
    }
    const sounds: string[] = [];
    for (const alias of term.aliases) {
      const a = alias.normalize('NFC').replace(/\s+/g, ' ').trim();
      if (a && a !== content && !sounds.includes(a)) sounds.push(a);
    }
    additional_vocab.push(sounds.length > 0 ? { content, sounds_like: sounds } : { content });
  }
  if (overCap.length > 0) {
    sink?.notes.push(
      `left out ${overCap.length} term${overCap.length === 1 ? '' : 's'} past Speechmatics' ${SPEECHMATICS_VOCAB_MAX} additional_vocab entries (the most used kept): ${quotedNames(overCap)}`,
    );
  }
  return JSON.stringify({ additional_vocab }, null, 2) + '\n';
}
