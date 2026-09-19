/**
 * Microphone capture with ffmpeg (16 kHz mono s16 WAV, what whisper.cpp
 * wants) and the `--toggle` state file that lets a hotkey start a recording
 * in one process and stop it in the next.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listAudioDevices, pickDevice } from './devices.js';
import type { AudioDevice } from './devices.js';
import type { ChildHandle, VoiceExec, VoiceSpawn } from './process.js';

/** A forgotten `--toggle` must not fill the disk: ffmpeg stops on its own after this. */
export const MAX_TOGGLE_SECONDS = 600;
/** How long `stopRecorder` waits for ffmpeg to finalize the WAV after SIGINT. */
export const STOP_GRACE_MS = 3000;

export interface RecordingState {
  pid: number;
  wav: string;
  startedAt: string;
}

/** `<dirname(globalPath)>/voice`: state file, history and in-flight recordings. */
export function voiceDir(globalPath: string): string {
  return path.join(path.dirname(globalPath), 'voice');
}

export function stateFilePath(globalPath: string): string {
  return path.join(voiceDir(globalPath), 'recording.json');
}

export async function readState(globalPath: string): Promise<RecordingState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFilePath(globalPath), 'utf8')) as Partial<RecordingState>;
    if (typeof parsed.pid === 'number' && typeof parsed.wav === 'string' && typeof parsed.startedAt === 'string') {
      return { pid: parsed.pid, wav: parsed.wav, startedAt: parsed.startedAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(globalPath: string, state: RecordingState): Promise<void> {
  const file = stateFilePath(globalPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export async function clearState(globalPath: string): Promise<void> {
  await fs.rm(stateFilePath(globalPath), { force: true });
}

export interface InputSpec {
  /** ffmpeg `-f` demuxer. */
  format: 'avfoundation' | 'pulse' | 'alsa' | 'dshow';
  /** ffmpeg `-i` value. */
  input: string;
}

export interface ResolveInputOptions {
  platform: NodeJS.Platform;
  ffmpeg: string;
  exec: VoiceExec;
  /** `--device <name|index>`. */
  device?: string;
  /** Pre-fetched device list (avoids a second ffmpeg run). */
  devices?: readonly AudioDevice[];
}

/**
 * Decide the ffmpeg input for this platform and `--device`.
 * - darwin: avfoundation `:default` (or `:N` / `:Name`)
 * - linux: pulse `default` when ffmpeg has the pulse demuxer, else alsa `default`
 * - win32: dshow `audio=<name>`; without `--device` the first listed input is used
 */
export async function resolveInput(opts: ResolveInputOptions): Promise<InputSpec> {
  const { platform, device } = opts;
  switch (platform) {
    case 'darwin': {
      if (!device) return { format: 'avfoundation', input: ':default' };
      if (/^\d+$/.test(device.trim())) return { format: 'avfoundation', input: `:${device.trim()}` };
      const devices = opts.devices ?? (await listAudioDevices(opts));
      const picked = pickDevice(devices, device);
      // avfoundation also matches a bare name; fall back to that when the list lookup misses.
      return { format: 'avfoundation', input: picked ? picked.id : `:${device}` };
    }
    case 'win32': {
      if (device) {
        const devices = opts.devices ?? (await listAudioDevices(opts));
        const picked = pickDevice(devices, device);
        return { format: 'dshow', input: `audio=${picked ? picked.id : device}` };
      }
      const devices = opts.devices ?? (await listAudioDevices(opts));
      if (devices.length === 0) throw new Error('no dshow audio input device found; pass --device <name> (see --list-devices)');
      return { format: 'dshow', input: `audio=${devices[0].id}` };
    }
    default: {
      const probe = await opts.exec(opts.ffmpeg, ['-hide_banner', '-devices'], { timeoutMs: 10_000 });
      const hasPulse = /^\s*D?E?\s+pulse\s/m.test(probe.stdout) || /\bpulse\b/.test(probe.stdout);
      if (hasPulse) {
        if (device && !/^\d+$/.test(device.trim())) return { format: 'pulse', input: device };
        if (device) {
          const devices = opts.devices ?? (await listAudioDevices(opts));
          const picked = pickDevice(devices, device);
          return { format: 'pulse', input: picked ? picked.id : 'default' };
        }
        return { format: 'pulse', input: 'default' };
      }
      if (device) {
        const devices = opts.devices ?? (await listAudioDevices(opts));
        const picked = pickDevice(devices, device);
        return { format: 'alsa', input: picked ? picked.id : device };
      }
      return { format: 'alsa', input: 'default' };
    }
  }
}

export interface FfmpegArgsOptions {
  input: InputSpec;
  wav: string;
  /** Stop on its own after this many seconds. */
  seconds?: number;
}

/** The ffmpeg argv; exported so tests can assert the capture format. */
export function ffmpegRecordArgs(opts: FfmpegArgsOptions): string[] {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', opts.input.format, '-i', opts.input.input];
  if (opts.seconds !== undefined && opts.seconds > 0) args.push('-t', String(opts.seconds));
  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', opts.wav);
  return args;
}

export interface StartRecorderOptions {
  ffmpeg: string;
  spawn: VoiceSpawn;
  input: InputSpec;
  wav: string;
  seconds?: number;
  /** `--toggle`: detach so the recorder outlives this process. */
  detached: boolean;
  /** stderr log for a detached recorder. */
  logFile?: string;
}

export function startRecorder(opts: StartRecorderOptions): ChildHandle {
  const args = ffmpegRecordArgs({ input: opts.input, wav: opts.wav, seconds: opts.seconds });
  return opts.spawn(opts.ffmpeg, args, { detached: opts.detached, ...(opts.logFile ? { logFile: opts.logFile } : {}) });
}

export interface StopRecorderOptions {
  pid: number;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  /** Skip the SIGINT because the recorder already received one (Ctrl-C in the foreground). */
  alreadySignalled?: boolean;
}

export interface StopResult {
  /** True when ffmpeg exited within the grace period (the WAV header is finalized). */
  finalized: boolean;
  /** True when SIGKILL had to be sent. */
  killed: boolean;
}

/**
 * Ask ffmpeg to stop (SIGINT makes it flush and write the WAV header) and
 * wait up to `graceMs` for the process to disappear. A recorder that is still
 * alive afterwards is SIGKILLed; the WAV may then lack a valid header.
 */
export async function stopRecorder(opts: StopRecorderOptions): Promise<StopResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? STOP_GRACE_MS;
  if (!opts.isAlive(opts.pid)) return { finalized: true, killed: false };
  if (!opts.alreadySignalled) opts.kill(opts.pid, 'SIGINT');
  const deadline = Date.now() + graceMs;
  let waited = 0;
  while (opts.isAlive(opts.pid)) {
    if (Date.now() >= deadline) {
      opts.kill(opts.pid, 'SIGKILL');
      await sleep(50);
      return { finalized: false, killed: true };
    }
    const step = waited < 200 ? 20 : 50;
    await sleep(step);
    waited += step;
  }
  return { finalized: true, killed: false };
}

/** A WAV is usable once ffmpeg wrote more than its 44-byte header. */
export async function wavHasAudio(wav: string): Promise<boolean> {
  try {
    const st = await fs.stat(wav);
    return st.size > 44;
  } catch {
    return false;
  }
}
