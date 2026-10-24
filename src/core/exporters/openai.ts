/**
 * OpenAI transcription (`whisper-1`, `gpt-4o-transcribe`) `prompt` field: the
 * same comma-joined canonical list as whisper-prompt, capped at 100 terms and
 * at the 224-token window OpenAI documents for whisper-1's prompt (estimated
 * offline, see whisperPrompt.ts). The newer models' own prompt limit is not
 * confirmed here, so the smaller Whisper window is kept for them too.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import type { ExportSink } from './shared.js';
import { exportWhisperPrompt } from './whisperPrompt.js';

export function exportOpenai(lexicon: Lexicon, opts: ExportOptions = {}, sink?: ExportSink): string {
  return exportWhisperPrompt(lexicon, opts, sink);
}
