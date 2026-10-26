/**
 * OpenAI transcription (`whisper-1`, `gpt-4o-transcribe`) `prompt` field: the
 * same comma-joined canonical list as whisper-prompt (a name holding a comma
 * written in double quotes), capped at 100 terms and
 * at the 224-token window OpenAI documents for whisper-1's prompt (estimated
 * offline, see whisperPrompt.ts). The newer models' own prompt limit is not
 * confirmed here, so the smaller Whisper window is kept for them too.
 */
export { exportWhisperPrompt as exportOpenai } from './whisperPrompt.js';
