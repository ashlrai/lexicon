/**
 * `lexicon voice`: local push-to-talk dictation (ffmpeg -> whisper.cpp ->
 * lexicon). Only commander wiring lives here; the behaviour is in
 * ../voice/voice.ts so it can be tested without a microphone.
 */
import type { Command } from 'commander';
import { EXIT_ERROR, runVoice, runVoiceListDevices, runVoiceStatus, runVoiceToggle } from '../voice/voice.js';
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

/** The flag that selects each mode other than plain dictation. */
const MODE_FLAGS = { toggle: '--toggle', status: '--status', listDevices: '--list-devices' } as const;

/**
 * The flags only a recording reads (plain dictation and `--toggle`), by
 * commander attribute name. `--status` and `--list-devices` record nothing,
 * so one of these given with them was dropped without a word.
 */
const RECORDING_FLAGS = {
  seconds: '--seconds',
  device: '--device',
  model: '--model',
  lang: '--lang',
  translate: '--translate',
  prompt: '--no-prompt',
  history: '--no-history',
  copy: '--copy',
  paste: '--paste',
} as const;

/** Commander action for `lexicon voice`. Loaded only when that command runs. */
export async function runVoiceCli(program: Command, io: IO, opts: VoiceCliOptions, cmd: Command): Promise<void> {
      // One mode per call: `--status --toggle` answered the status and dropped
      // the toggle without a word, so a hotkey script never recorded.
      const modes = (['toggle', 'status', 'listDevices'] as const).filter((m) => opts[m] === true).map((m) => MODE_FLAGS[m]);
      if (modes.length > 1) {
        const error = `${modes.join(' and ')} cannot be combined`;
        const nextStep = 'pass one of --toggle, --status or --list-devices (see lexicon voice --help)';
        io.stderr(`lexicon voice: ${error}\n  ${nextStep}\n`);
        if (opts.json) io.stdout(`${JSON.stringify({ ok: false, error, nextStep, code: EXIT_ERROR })}\n`);
        process.exitCode = EXIT_ERROR;
        return;
      }
      // `--status --seconds 5` answered the status and ignored the recording
      // flag; refuse it, naming the flag, so a script learns it did nothing.
      const mode = opts.status ? MODE_FLAGS.status : opts.listDevices ? MODE_FLAGS.listDevices : undefined;
      if (mode !== undefined) {
        const ignored = (Object.keys(RECORDING_FLAGS) as (keyof typeof RECORDING_FLAGS)[])
          .filter((k) => cmd.getOptionValueSource(k) === 'cli')
          .map((k) => RECORDING_FLAGS[k]);
        if (ignored.length > 0) {
          const error = `${ignored.join(', ')} ${ignored.length === 1 ? 'only applies' : 'only apply'} to a recording; ${mode} records nothing`;
          const nextStep = `drop ${ignored.join(', ')}, or run lexicon voice without ${mode} to record`;
          io.stderr(`lexicon voice: ${error}\n  ${nextStep}\n`);
          if (opts.json) io.stdout(`${JSON.stringify({ ok: false, error, nextStep, code: EXIT_ERROR })}\n`);
          process.exitCode = EXIT_ERROR;
          return;
        }
      }
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
}

export { registerVoiceCommands } from './program.js';
