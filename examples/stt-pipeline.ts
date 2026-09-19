/**
 * Embedding the lexicon in your own speech-to-text pipeline:
 *
 *   mic -> STT (Whisper, Deepgram, ...) -> normalize() -> your LLM
 *
 * The STT call is faked below so the file runs anywhere:
 *   node --import tsx examples/stt-pipeline.ts
 *
 * Swap `transcribe()` for a real provider (comments show where) and the rest
 * stays the same. In your project the import is from '@ashlr/lexicon'.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportLexicon, loadLexicon, normalize } from '../src/core/index.js';
import type { Lexicon } from '../src/core/index.js';

// Use the example lexicon unless the caller already points LEXICON_PATH somewhere.
process.env.LEXICON_PATH ??= path.join(path.dirname(fileURLToPath(import.meta.url)), 'lexicon.example.yaml');

/** Stand-in for the STT provider. Returns what a real model tends to write for these names. */
async function transcribe(audio: Uint8Array, lexicon: Lexicon): Promise<string> {
  // Whisper / OpenAI: bias the model with the lexicon before it guesses.
  //   const r = await openai.audio.transcriptions.create({
  //     file, model: 'whisper-1', prompt: exportLexicon(lexicon, 'whisper-prompt'),
  //   });
  //   return r.text;
  //
  // Deepgram: pass the keyword boosts the exporter builds.
  //   const { result } = await deepgram.listen.prerecorded.transcribeFile(audio, {
  //     model: 'nova-3', keywords: JSON.parse(exportLexicon(lexicon, 'deepgram')),
  //   });
  //   return result.results.channels[0].alternatives[0].transcript;
  void audio;
  void exportLexicon(lexicon, 'whisper-prompt'); // what you would hand to the provider
  return 'ask ashler to move the post gress cluster to head sner and ping mason wyat';
}

/** Stand-in for your LLM call. */
async function askAgent(prompt: string): Promise<void> {
  console.log('-> LLM receives:', prompt);
}

// The pipeline: six lines that matter.
const { merged: lexicon } = await loadLexicon();
const heard = await transcribe(new Uint8Array(), lexicon);
const fixed = normalize(heard, lexicon);
console.log('STT wrote:     ', heard);
console.log('lexicon fixed: ', fixed.replacements.map((r) => `${r.original} -> ${r.replacement}`).join(', '));
await askAgent(fixed.output);
