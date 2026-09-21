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
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { listAudioDevices, pickDevice } from './devices.js';
import type { AudioDevice } from './devices.js';
import type { ChildHandle, VoiceExec, VoiceSpawn } from './process.js';
import { writeFileAtomic } from '../util/atomic.js';

/** A forgotten `--toggle` must not fill the disk: ffmpeg stops on its own after this. */
export const MAX_TOGGLE_SECONDS = 600;
/** How long `stopRecorder` waits for ffmpeg to exit after the stop signal. */
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

/**
 * The ffmpeg argv; exported so tests can assert the capture format.
 *
 * `-flush_packets 1` is what makes an abruptly ended capture survive, and it is
 * not cosmetic. ffmpeg's default output buffer is 256 KB, which at 16 kHz mono
 * s16 is a little over eight seconds: a recorder that is terminated rather than
 * asked to stop has written **nothing at all** to the file before then.
 * Measured on macOS with ffmpeg 9.0.2 — a capture killed at 4 s left a 0-byte
 * WAV, and one killed at 3 s with this flag left 3.5 s of audio that whisper.cpp
 * read back happily. Windows has no way to ask ffmpeg to stop (see
 * `stopRecorder`), so without this every `--toggle` recording shorter than
 * ~8 s would be lost there. One write per packet, a handful per second.
 */
export function ffmpegRecordArgs(opts: FfmpegArgsOptions): string[] {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', opts.input.format, '-i', opts.input.input];
  if (opts.seconds !== undefined && opts.seconds > 0) args.push('-t', String(opts.seconds));
  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-y', opts.wav);
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
  /** Skip the stop signal because the recorder already received one (Ctrl-C in the foreground). */
  alreadySignalled?: boolean;
  /** Defaults to `process.platform`; decides whether a graceful stop is even possible. */
  platform?: NodeJS.Platform;
}

export interface StopResult {
  /**
   * True when ffmpeg was given the chance to write its trailer, so the WAV
   * header holds the real sizes. False whenever the recorder was terminated
   * instead — which on Windows is every stop this code issues.
   */
  finalized: boolean;
  /** True when the recorder outlived the grace period and had to be killed. */
  killed: boolean;
  /**
   * True when the platform gave ffmpeg no chance to flush. Not an error: the
   * capture is on disk either way (see `-flush_packets` in `ffmpegRecordArgs`),
   * it just keeps the provisional header ffmpeg wrote at the start.
   */
  abrupt: boolean;
}

/**
 * Stop the recorder and wait up to `graceMs` for it to disappear.
 *
 * **This is graceful on POSIX and abrupt on Windows, and the difference is not
 * ours to fix.** On macOS and Linux, SIGINT makes ffmpeg finish the file:
 * it writes the trailer, patching the real RIFF and data sizes into the header.
 * On Windows there is no signal delivery at all — `process.kill(pid, sig)`
 * calls `TerminateProcess` for every signal including SIGINT, so ffmpeg is shot
 * where it stands and never runs its trailer. The honest form of that is to
 * send SIGKILL, which is what the platform is going to do anyway, and to report
 * `finalized: false` rather than claim a flush that did not happen.
 *
 * The alternative — putting the child in its own group and posting a real
 * `CTRL_C_EVENT` — does not work here and is not worth pretending about:
 * `GenerateConsoleCtrlEvent` reaches only processes sharing the caller's
 * console, Node has no binding for it, and a `--toggle` recorder is spawned
 * `detached` (so libuv gives it `DETACHED_PROCESS`, i.e. no console) and is
 * stopped by a *different* `lexicon voice` process on the next hotkey press.
 * There is no console in common to signal through.
 *
 * What makes the abrupt stop survivable is the capture side: with
 * `-flush_packets 1` everything ffmpeg has already muxed is on disk, and the
 * WAV it leaves behind says "size unknown" (0xFFFFFFFF) in its header rather
 * than being unreadable. whisper.cpp reads that file: verified against
 * whisper-cli by feeding it exactly such a capture, and measured here on macOS
 * with ffmpeg 9.0.2, where a SIGKILL at 3 s and a SIGINT at 3 s left the same
 * 112,640 bytes of audio and differed only in the header.
 *
 * What it costs is the tail the input device was still holding. On macOS and
 * Linux that is small. On Windows `ffmpegRecordArgs` passes no
 * `-audio_buffer_size`, so dshow uses the device's own default, which ffmpeg's
 * documentation describes as typically a multiple of 500 ms: the loss there is
 * on the order of half a second, not "the last fraction of a second". Nothing
 * here measures it, because dshow does not exist off Windows.
 *
 * UNVERIFIED on real Windows: both the TerminateProcess behaviour and the
 * buffer size are from documented semantics, not from a run on a Windows box.
 */
export async function stopRecorder(opts: StopRecorderOptions): Promise<StopResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? STOP_GRACE_MS;
  // A Ctrl-C the user typed is a real console event that Windows delivered to
  // the whole process group, so the foreground recorder did get to flush; only
  // a stop *we* issue is abrupt there.
  const abrupt = (opts.platform ?? process.platform) === 'win32' && !opts.alreadySignalled;
  if (!opts.isAlive(opts.pid)) return { finalized: true, killed: false, abrupt: false };
  if (!opts.alreadySignalled) opts.kill(opts.pid, abrupt ? 'SIGKILL' : 'SIGINT');
  const deadline = Date.now() + graceMs;
  let waited = 0;
  while (opts.isAlive(opts.pid)) {
    if (Date.now() >= deadline) {
      opts.kill(opts.pid, 'SIGKILL');
      await sleep(50);
      return { finalized: false, killed: true, abrupt };
    }
    const step = waited < 200 ? 20 : 50;
    await sleep(step);
    waited += step;
  }
  return { finalized: !abrupt, killed: false, abrupt };
}

/** What a capture on disk turned out to be. */
export interface WavCheck {
  /** True when the file is a WAV with audio in it. */
  ok: boolean;
  /** Why it is not, phrased for the user. Undefined when `ok`. */
  reason?: string;
  /** PCM bytes actually present on disk after the `data` chunk header. */
  audioBytes: number;
  /** True when the header carries real sizes, i.e. ffmpeg wrote its trailer. */
  finalized: boolean;
  /** The file's size on disk. 0 when it is missing or empty. */
  bytes: number;
}

/** ffmpeg's placeholder for a size it does not know yet. */
const UNKNOWN_SIZE = 0xffff_ffff;
/** `RIFF` + size + `WAVE`. */
const RIFF_HEADER = 12;
/** A chunk header: four-character id plus a 32-bit size. */
const CHUNK_HEADER = 8;
/**
 * Give up after this many chunks. A real capture has three or four; the cap is
 * only here so a malformed file cannot spin the walk.
 */
const MAX_CHUNKS = 64;
/** 16 kHz mono s16: the capture format, and what a byte count means in seconds. */
export const CAPTURE_BYTES_PER_SECOND = 16_000 * 2;

/** Seconds of audio in `audioBytes` of the capture format, rounded to milliseconds. */
export function captureSeconds(audioBytes: number): number {
  return Math.round((audioBytes / CAPTURE_BYTES_PER_SECOND) * 1000) / 1000;
}

interface ChunkHeader {
  id: string;
  declared: number;
}

/** Read one chunk header, or undefined when the file ends inside it. */
async function readChunkHeader(handle: FileHandle, offset: number): Promise<ChunkHeader | undefined> {
  const buf = Buffer.alloc(CHUNK_HEADER);
  const { bytesRead } = await handle.read(buf, 0, CHUNK_HEADER, offset);
  if (bytesRead < CHUNK_HEADER) return undefined;
  return { id: buf.toString('latin1', 0, 4), declared: buf.readUInt32LE(4) };
}

/** RIFF chunk ids are four printable ASCII characters; PCM almost never looks like one. */
function isChunkId(id: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(id);
}

/**
 * Where the chunk whose body starts at `body` is followed by the next one.
 *
 * RIFF pads an odd-sized chunk to an even offset, and most writers do. Some do
 * not, and stepping over a pad byte that is not there lands one byte into the
 * next id, which used to end the walk with "no audio data chunk" on a file that
 * had audio in it. So: take the padded offset when a chunk header is really
 * there, and the unpadded one otherwise.
 */
async function nextChunkOffset(handle: FileHandle, body: number, declared: number, size: number): Promise<number> {
  const unpadded = body + declared;
  if (declared % 2 === 0) return unpadded;
  const padded = unpadded + 1;
  if (padded + CHUNK_HEADER > size) return unpadded;
  const next = await readChunkHeader(handle, padded);
  return next && isChunkId(next.id) ? padded : unpadded;
}

/**
 * How many of the bytes from `from` to the end of the file are a well-formed
 * chunk list rather than audio, and 0 when they are not one.
 *
 * This is what tells an empty `data` chunk followed by a writer's trailing
 * `LIST`/`INFO` apart from a `data` chunk whose size is a placeholder. PCM
 * would have to begin with four printable ASCII bytes and land exactly on the
 * end of the file to be mistaken for metadata.
 */
async function trailingChunkBytes(handle: FileHandle, from: number, size: number): Promise<number> {
  let offset = from;
  for (let i = 0; i < MAX_CHUNKS && offset < size; i += 1) {
    if (offset + CHUNK_HEADER > size) return 0;
    const chunk = await readChunkHeader(handle, offset);
    if (!chunk || !isChunkId(chunk.id) || chunk.declared === UNKNOWN_SIZE) return 0;
    const next = await nextChunkOffset(handle, offset + CHUNK_HEADER, chunk.declared, size);
    if (next <= offset || next > size) return 0;
    offset = next;
  }
  return offset === size ? size - from : 0;
}

/**
 * Look at a capture and say whether it is audio.
 *
 * The old check was `size > 44`, which is not a WAV check at all: a truncated
 * or header-only file passes it and is then handed to whisper.cpp, which fails
 * with "failed to read the frames of the audio data" — observed, by feeding
 * whisper-cli a 78-byte header. Conversely a *valid* unfinalized capture cannot
 * be judged by its declared sizes, because ffmpeg leaves them at 0xFFFFFFFF
 * until its trailer runs, which on Windows it never does. So: check the
 * container for real, then trust the bytes on disk rather than the header's
 * opinion of how many there are.
 *
 * The walk reads chunk headers from the file at the offsets they sit at. It
 * used to work off the first 4096 bytes, which quietly turned any capture whose
 * `data` header sat past byte 4088 (a long `LIST`/`INFO`, an embedded cover)
 * into "no audio data chunk". A refusal here is a refusal to transcribe, so it
 * has to be about the file rather than about how much of it we bothered to
 * read. Callers must not delete a file this refuses: see `runVoiceToggle`.
 */
export async function inspectWav(wav: string): Promise<WavCheck> {
  let handle;
  try {
    handle = await fs.open(wav, 'r');
  } catch {
    return { ok: false, reason: 'no file was written', audioBytes: 0, finalized: false, bytes: 0 };
  }
  let size = 0;
  const miss = (reason: string, finalized = false): WavCheck => ({ ok: false, reason, audioBytes: 0, finalized, bytes: size });
  try {
    size = (await handle.stat()).size;
    if (size === 0) return miss('the recording is empty');
    if (size < RIFF_HEADER) return miss('the recording is truncated');

    const head = Buffer.alloc(RIFF_HEADER);
    await handle.read(head, 0, RIFF_HEADER, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      return miss('the recording is not a WAV file');
    }

    let offset = RIFF_HEADER;
    for (let i = 0; i < MAX_CHUNKS && offset + CHUNK_HEADER <= size; i += 1) {
      const chunk = await readChunkHeader(handle, offset);
      if (!chunk || !isChunkId(chunk.id)) break;
      const body = offset + CHUNK_HEADER;
      if (chunk.id === 'data') {
        const onDisk = Math.max(0, size - body);
        let audioBytes: number;
        let finalized: boolean;
        if (chunk.declared === UNKNOWN_SIZE) {
          // Still ffmpeg's placeholder: the file length is the truth, minus
          // anything a writer appended after the audio.
          audioBytes = onDisk - (await trailingChunkBytes(handle, body, size));
          finalized = false;
        } else if (chunk.declared === 0) {
          // Ambiguous. An empty `data` chunk with metadata behind it is a
          // finished recording of nothing; a zero with audio behind it is
          // another writer's streaming placeholder, and that audio is real.
          const trailing = await trailingChunkBytes(handle, body, size);
          audioBytes = onDisk - trailing;
          finalized = trailing === onDisk;
        } else {
          // A real size. Authoritative when the file is at least that long
          // (ffmpeg may have written padding past it); a capture cut short
          // still holds whatever made it to disk.
          finalized = body + chunk.declared <= size;
          audioBytes = finalized ? Math.min(onDisk, chunk.declared) : onDisk;
        }
        if (audioBytes <= 0) return miss('the recording holds no audio (header only)', finalized);
        return { ok: true, audioBytes, finalized, bytes: size };
      }
      if (chunk.declared === UNKNOWN_SIZE) break;
      const next = await nextChunkOffset(handle, body, chunk.declared, size);
      if (next <= offset) break;
      offset = next;
    }
    return miss('the recording has no audio data chunk');
  } catch {
    return miss('the recording could not be read');
  } finally {
    await handle.close();
  }
}

/** True when the capture is a WAV with audio in it. See `inspectWav` for why. */
export async function wavHasAudio(wav: string): Promise<boolean> {
  return (await inspectWav(wav)).ok;
}
