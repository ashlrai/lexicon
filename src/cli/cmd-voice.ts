/**
 * `lexicon voice`: local push-to-talk dictation (ffmpeg -> whisper.cpp ->
 * lexicon). Only commander wiring lives here; the behaviour is in
 * ../voice/voice.ts so it can be tested without a microphone.
 */
import { Command, InvalidArgumentError } from 'commander';
import { runVoice, runVoiceListDevices, runVoiceStatus, runVoiceToggle } from '../voice/voice.js';
import type { VoiceOptions } from '../voice/voice.js';
import type { IO } from './io.js';

interface VoiceCliOptions {
  toggle?: boolean;
  status?: boolean;
  listDevices?: boolean;
  seconds?: number;
  device?: string;
  model: string;
  lang: string;
  translate?: boolean;
  /** commander's `--no-prompt` sets this to false. */
  prompt: boolean;
  /** commander's `--no-history` sets this to false. */
  history: boolean;
  copy?: boolean;
  paste?: boolean;
  json?: boolean;
  quiet?: boolean;
}

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number of seconds');
  return n;
}

export function registerVoiceCommands(program: Command, io: IO): void {
  program
    .command('voice')
    .description('dictate locally: record the microphone, transcribe with whisper.cpp, correct with the lexicon')
    .option('--toggle', 'hotkey mode: first call starts recording in the background, second call stops and transcribes')
    .option('--status', 'print "recording since <time>" (exit 0) or "idle" (exit 1)')
    .option('--list-devices', 'print the audio input devices ffmpeg can see')
    .option('--seconds <n>', 'stop recording after n seconds instead of waiting for Enter', positiveNumber)
    .option('--device <name|index>', 'input device (default: the system default microphone)')
    .option('--model <name|path>', 'whisper model: a name like base.en or small.en (auto-downloaded) or a ggml file', 'base.en')
    .option('--lang <code>', 'spoken language', 'en')
    .option('--translate', 'translate to English (whisper -tr)')
    .option('--no-prompt', 'do not pass the lexicon canonicals as the whisper initial prompt')
    .option('--no-history', 'do not append to voice/history.jsonl')
    .option('--copy', 'also put the corrected text on the clipboard')
    .option('--paste', 'copy and paste into the frontmost app (macOS; needs Accessibility permission)')
    .option('--json', 'print { raw, output, replacements, summary, model, seconds, ms } as JSON')
    .option('--quiet', 'no status lines on stderr')
    .action(async (opts: VoiceCliOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const voiceOpts: VoiceOptions = {
        ...(cwd ? { cwd } : {}),
        ...(opts.seconds !== undefined ? { seconds: opts.seconds } : {}),
        ...(opts.device !== undefined ? { device: opts.device } : {}),
        model: opts.model,
        lang: opts.lang,
        translate: opts.translate ?? false,
        prompt: opts.prompt,
        history: opts.history,
        copy: opts.copy ?? false,
        paste: opts.paste ?? false,
        json: opts.json ?? false,
        quiet: opts.quiet ?? false,
      };
      let code: number;
      if (opts.listDevices) code = await runVoiceListDevices(voiceOpts, io);
      else if (opts.status) code = await runVoiceStatus(voiceOpts, io);
      else if (opts.toggle) code = await runVoiceToggle(voiceOpts, io);
      else code = await runVoice(voiceOpts, io);
      if (code !== 0) process.exitCode = code;
    });
}
