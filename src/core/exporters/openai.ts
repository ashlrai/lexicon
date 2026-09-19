/**
 * OpenAI transcription (`whisper-1`, `gpt-4o-transcribe`) `prompt` field: the
 * same comma-joined canonical list as whisper-prompt, capped at 100 terms.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { exportWhisperPrompt } from './whisperPrompt.js';

export function exportOpenai(lexicon: Lexicon, opts: ExportOptions = {}): string {
  return exportWhisperPrompt(lexicon, opts);
}
