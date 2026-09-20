/**
 * Microphone capture with ffmpeg (16 kHz mono s16 WAV, what whisper.cpp
 * wants) and the `--toggle` state file that lets a hotkey start a recording
 * in one process and stop it in the next.
 *
 * Everything under `<config>/voice/` is private to the user: the directory is
 * created 0700 and every file in it (state, history, recorder log, WAV) 0600,
 * because the WAV and history hold whatever was said near the microphone.
 *
 * The state file doubles as the start lock. A start claims it with an
 * exclusive create (`wx`) holding a provisional record (no pid yet) before
 * ffmpeg is spawned, then rewrites it atomically with the real pid. Two
 * hotkey presses that race therefore produce one recorder: the loser sees
 * EEXIST and re-reads the file instead of spawning a second ffmpeg.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listAudioDevices, pickDevice } from './devices.js';
import type { AudioDevice } from './devices.js';
import type { ChildHandle, VoiceExec, VoiceSpawn } from './process.js';
import { writeFileAtomic } from '../util/atomic.js';

/** A forgotten `--toggle` must not fill the disk: ffmpeg stops on its own after this. */
export const MAX_TOGGLE_SECONDS = 600;
/** How long `stopRecorder` waits for ffmpeg to finalize the WAV after SIGINT. */
export const STOP_GRACE_MS = 3000;
/**
 * A provisional state record (claimed, no pid yet) older than this is a start
 * that died between the claim and the spawn; the next toggle replaces it.
 */
export const PROVISIONAL_TTL_MS = 5_000;

/** Mode for every file under the voice directory. */
export const VOICE_FILE_MODE = 0o600;
/** Mode for the voice directory itself. */
export const VOICE_DIR_MODE = 0o700;

export interface RecordingState {
  /** The detached ffmpeg. Absent while a start is in flight (provisional record). */
  pid?: number;
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

export function recorderLogPath(globalPath: string): string {
  return path.join(voiceDir(globalPath), 'recorder.log');
}

/** mkdir -p the voice directory as 0700 (and tighten one created earlier with a looser mode). */
export async function ensureVoiceDir(globalPath: string): Promise<string> {
  const dir = voiceDir(globalPath);
  await fs.mkdir(dir, { recursive: true, mode: VOICE_DIR_MODE });
  await fs.chmod(dir, VOICE_DIR_MODE).catch(() => undefined);
  return dir;
}

/**
 * Atomic 0600 write. `unique` because two `lexicon voice --toggle` invocations
 * can race for the recorder state file, and a shared `<target>.tmp` would let
 * one clobber the other's half-written temp.
 */
export async function writePrivateFile(file: string, data: string): Promise<void> {
  await writeFileAtomic(file, data, { mode: VOICE_FILE_MODE, unique: true });
}

/**
 * Create `file` empty with mode 0600 if it does not exist, and chmod it to
 * 0600 either way. Used before handing a path to ffmpeg (the WAV, its log):
 * ffmpeg opens with O_TRUNC / O_APPEND, which keeps the mode we set here.
 */
export async function touchPrivateFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'a', VOICE_FILE_MODE);
  try {
    await handle.chmod(VOICE_FILE_MODE);
  } finally {
    await handle.close();
  }
}

export async function readState(globalPath: string): Promise<RecordingState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFilePath(globalPath), 'utf8')) as Partial<RecordingState>;
    if (typeof parsed.wav !== 'string' || typeof parsed.startedAt !== 'string') return undefined;
    if (parsed.pid !== undefined && typeof parsed.pid !== 'number') return undefined;
    return { ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}), wav: parsed.wav, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/** True for a claimed-but-not-yet-spawned record. */
export function isProvisional(state: RecordingState): boolean {
  return state.pid === undefined;
}

/** True when a provisional record is older than PROVISIONAL_TTL_MS (or has an unreadable timestamp). */
export function isStaleProvisional(state: RecordingState, nowMs: number): boolean {
  const started = Date.parse(state.startedAt);
  return !Number.isFinite(started) || nowMs - started > PROVISIONAL_TTL_MS;
}

/**
 * Claim the state file for a new recording: exclusive create (`wx`) with a
 * provisional record. Resolves false when the file already exists, which
 * means another toggle got there first; the caller re-reads it and decides.
 */
export async function claimState(globalPath: string, state: RecordingState): Promise<boolean> {
  const file = stateFilePath(globalPath);
  await ensureVoiceDir(globalPath);
  try {
    await fs.writeFile(file, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx', mode: VOICE_FILE_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  await fs.chmod(file, VOICE_FILE_MODE).catch(() => undefined);
  return true;
}

/** Rewrite the state file atomically (tmp + rename) with mode 0600. */
export async function writeState(globalPath: string, state: RecordingState): Promise<void> {
  await ensureVoiceDir(globalPath);
  await writePrivateFile(stateFilePath(globalPath), `${JSON.stringify(state)}\n`);
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
