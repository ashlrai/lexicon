import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDeviceList,
  parseArecordList,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePulseSources,
  pickDevice,
} from '../src/voice/devices.js';
import { HISTORY_MAX_LINES, appendHistory, historyPath, readHistory } from '../src/voice/history.js';
import { expandTilde, modelFileName, modelUrl, resolveModel } from '../src/voice/models.js';
import type { Downloader } from '../src/voice/models.js';
import { installHint, locateWhisperCli, makeProcessDescribe, makeProcessList } from '../src/voice/process.js';
import type { ChildHandle, ExecResult, SpawnOptions, VoiceExec, VoiceSpawn } from '../src/voice/process.js';
import {
  PROVISIONAL_TTL_MS,
  captureSeconds,
  claimState,
  claimStop,
  sweepVoiceDir,
  ensureVoiceDir,
  ffmpegRecordArgs,
  inspectWav,
  isStaleProvisional,
  readState,
  recorderLogPath,
  stateFilePath,
  stopRecorder,
  voiceDir,
  wavHasAudio,
  writeState,
  commandIsRecorder,
  confirmRecorder,
  findOrphanRecorder,
  recorderFingerprint,
} from '../src/voice/recorder.js';
import { cleanTranscript, parseWhisperOutput, whisperArgs } from '../src/voice/transcribe.js';
import {
  EXIT_ERROR,
  EXIT_MISSING_TOOL,
  EXIT_NOTHING_HEARD,
  EXIT_OK,
  runVoice,
  runVoiceListDevices,
  runVoiceStatus,
  runVoiceToggle,
} from '../src/voice/voice.js';
import type { VoiceDeps, VoiceJsonResult, VoiceOptions } from '../src/voice/voice.js';

// ---------------------------------------------------------------------------
// Fixtures

/**
 * A WAV as ffmpeg writes one: 16 kHz mono s16, a `fmt ` chunk, and a `data`
 * chunk whose size is 0xFFFFFFFF until the trailer runs.
 *
 * `finalized: false` is what a capture looks like while it is still recording —
 * and, on Windows, what it looks like for ever, because the recorder is
 * terminated rather than asked to stop and never writes the trailer.
 */
function wavBytes(opts: { audioBytes: number; finalized: boolean; riff?: string }): Buffer {
  const UNKNOWN = 0xffff_ffff;
  const header = Buffer.alloc(44);
  header.write(opts.riff ?? 'RIFF', 0, 'latin1');
  header.writeUInt32LE(opts.finalized ? 36 + opts.audioBytes : UNKNOWN, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(opts.finalized ? opts.audioBytes : UNKNOWN, 40);
  return Buffer.concat([header, Buffer.alloc(opts.audioBytes, 7)]);
}

/**
 * Put a chunk between `fmt ` and `data`, where ffmpeg puts its `LIST`/`INFO`.
 * `size` is the declared body size; an odd one gets the RIFF pad byte, so a
 * test can take that byte away again and see what the walk does without it.
 */
function withChunkBeforeData(wav: Buffer, id: string, size: number): Buffer {
  const chunk = Buffer.alloc(8 + size + (size % 2));
  chunk.write(id, 0, 'latin1');
  chunk.writeUInt32LE(size, 4);
  chunk.write('INFOISFT', 8, 'latin1');
  return Buffer.concat([wav.subarray(0, 36), chunk, wav.subarray(36)]);
}

const AVFOUNDATION_LIST = `[AVFoundation indev @ 0x86b01c140] AVFoundation video devices:
[AVFoundation indev @ 0x86b01c140] [0] MacBook Pro Camera
[AVFoundation indev @ 0x86b01c140] [1] MacBook Pro Desk View Camera
[AVFoundation indev @ 0x86b01c140] [2] Capture screen 0
[AVFoundation indev @ 0x86b01c140] AVFoundation audio devices:
[AVFoundation indev @ 0x86b01c140] [0] Mason’s iPhone Microphone
[AVFoundation indev @ 0x86b01c140] [1] External Microphone
[AVFoundation indev @ 0x86b01c140] [2] MacBook Pro Microphone
[in#0 @ 0x86b01c000] Error opening input: Input/output error
Error opening input file .
Error opening input files: Input/output error
`;

const DSHOW_LIST = `[dshow @ 000001] "Integrated Camera" (video)
[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 000001] "Microphone Array (Realtek(R) Audio)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{1234}"
[dshow @ 000001] "Headset Microphone (USB)" (audio)
dummy: Immediate exit requested
`;

const PULSE_SOURCES = `Auto-detected sources for pulse:
  alsa_output.pci-0000_00_1f.3.analog-stereo.monitor [Monitor of Built-in Audio Analog Stereo]
* alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo]
  alsa_input.usb-Blue_Yeti-00.analog-stereo [Yeti Stereo Microphone Analog Stereo]
`;

const ARECORD_LIST = `**** List of CAPTURE Hardware Devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC295 Analog [ALC295 Analog]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 1: Microphone [Yeti Stereo Microphone], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
`;

const LEXICON_YAML = `version: 1
terms:
  - canonical: Ashlr.AI
    aliases: [Ashler, Ashlar]
    category: brand
  - canonical: Kubernetes
    aliases: ["cooper netties", "Cooper Nettie's"]
    category: product
`;

// ---------------------------------------------------------------------------
// Harness: fake exec / spawn / pids, real temp filesystem

interface Harness {
  dir: string;
  globalPath: string;
  binDir: string;
  execCalls: Array<{ cmd: string; args: string[] }>;
  spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }>;
  transcript: string;
  whisperExit: number;
  alive: Set<number>;
  kills: Array<{ pid: number; signal: string }>;
  clipboard: string[];
  pastes: number;
  out: string[];
  err: string[];
  io: { stdout(s: string): void; stderr(s: string): void };
  deps: VoiceDeps;
  opts: VoiceOptions;
  nextPid: number;
  /** Resolvers for attached children (foreground mode). */
  children: Array<{ pid: number; resolve: (code: number | null) => void }>;
}

async function makeHarness(overrides: { platform?: NodeJS.Platform; missing?: string[]; lexicon?: string } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-voice-'));
  const globalPath = path.join(dir, 'lexicon.yaml');
  await fs.writeFile(globalPath, overrides.lexicon ?? LEXICON_YAML);
  const binDir = '/fake/bin';
  const missing = new Set(overrides.missing ?? []);
  const modelsDir = path.join(dir, 'models');
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelsDir, 'ggml-base.en.bin'), 'fake model');

  const h: Harness = {
    dir,
    globalPath,
    binDir,
    execCalls: [],
    spawnCalls: [],
    transcript: 'ping ashler about the cooper netties rollout',
    whisperExit: 0,
    alive: new Set(),
    kills: [],
    clipboard: [],
    pastes: 0,
    out: [],
    err: [],
    io: { stdout: (s) => h.out.push(s), stderr: (s) => h.err.push(s) },
    deps: {},
    opts: {},
    nextPid: 4242,
    children: [],
  };

  const exec: VoiceExec = async (cmd, args): Promise<ExecResult> => {
    h.execCalls.push({ cmd, args: [...args] });
    const base = path.basename(cmd);
    if (base === 'whisper-cli' || base === 'main') {
      const of = args[args.indexOf('-of') + 1];
      if (h.whisperExit === 0) {
        await fs.writeFile(`${of}.json`, JSON.stringify({ transcription: [{ text: ` ${h.transcript}` }] }));
      }
      return { code: h.whisperExit, stdout: '', stderr: h.whisperExit === 0 ? '' : 'whisper: boom' };
    }
    if (base === 'ffmpeg' && args.includes('-list_devices')) {
      return { code: 1, stdout: '', stderr: args.includes('avfoundation') ? AVFOUNDATION_LIST : DSHOW_LIST };
    }
    if (base === 'ffmpeg' && args.includes('-devices')) {
      return { code: 0, stdout: ' D  pulse           Pulse audio input\n DE alsa            ALSA audio\n', stderr: '' };
    }
    if (base === 'ffmpeg' && args.includes('-sources')) {
      return { code: 0, stdout: PULSE_SOURCES, stderr: '' };
    }
    if (base === 'osascript') {
      h.pastes += 1;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const spawn: VoiceSpawn = (cmd, args, opts): ChildHandle => {
    h.spawnCalls.push({ cmd, args: [...args], opts });
    const pid = h.nextPid++;
    h.alive.add(pid);
    const wav = args[args.length - 1];
    // ffmpeg would write the WAV as it records: header first, samples as they
    // arrive, real sizes only in the trailer. Write that, not 1000 zero bytes —
    // the capture check reads the container now, and a placeholder that is not
    // a WAV would make every one of these tests fail the way a broken
    // recording does.
    mkdirSync(path.dirname(wav), { recursive: true });
    writeFileSync(wav, wavBytes({ audioBytes: 1000, finalized: false }));
    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((res) => {
      resolveExit = (code) => {
        h.alive.delete(pid);
        res(code);
      };
    });
    h.children.push({ pid, resolve: resolveExit });
    return {
      pid,
      exited,
      stderr: () => '',
      kill: (signal) => {
        h.kills.push({ pid, signal });
        resolveExit(signal === 'SIGKILL' ? null : 255);
      },
    };
  };

  h.deps = {
    exec,
    spawn,
    platform: overrides.platform ?? 'darwin',
    env: { PATH: binDir },
    isAlive: (pid) => h.alive.has(pid),
    kill: (pid, signal) => {
      h.kills.push({ pid, signal });
      h.alive.delete(pid);
      // a real signal makes ffmpeg exit, which settles the attached child's `exited`
      for (const c of h.children) if (c.pid === pid) c.resolve(signal === 'SIGKILL' ? null : 255);
    },
    sleep: async () => undefined,
    exists: async (p) => p.startsWith(binDir) && !missing.has(path.basename(p)),
    extraBinDirs: [],
    modelFallbackDirs: [],
    tmpDir: path.join(dir, 'tmp'),
    clipboardWrite: async (text) => {
      h.clipboard.push(text);
    },
    now: () => new Date('2026-09-19T12:00:00.000Z'),
  };
  h.opts = { cwd: dir, globalPath, quiet: true };
  return h;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await fs.rm(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function harness(overrides?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
  const h = await makeHarness(overrides);
  harnesses.push(h);
  return h;
}

function whisperCall(h: Harness): { cmd: string; args: string[] } | undefined {
  return h.execCalls.find((c) => path.basename(c.cmd) === 'whisper-cli');
}

/**
 * A state file whose recorder is gone (pid 99999 is not in `h.alive`), holding
 * `bytes` as its capture. This is what the next hotkey press finds after the
 * recorder hit the ten-minute cap, crashed, or never started. Returns the WAV.
 */
async function deadRecorderState(h: Harness, bytes: Buffer): Promise<string> {
  const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
  await fs.mkdir(path.dirname(wav), { recursive: true });
  await fs.writeFile(wav, bytes);
  await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ pid: 99999, wav, startedAt: '2026-09-19T11:00:00.000Z' }));
  return wav;
}

const posix = process.platform !== 'win32';

/** True when ffmpeg is on PATH, so the real-capture checks can run. */
function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

async function modeOf(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

/**
 * Hold every `ffmpeg -list_devices` call (reached through `--device <name>`)
 * until the test releases it. That point sits after the toggle has read the
 * state file and before it claims it, so two presses can be parked there and
 * released in a chosen order.
 */
function gateDeviceLookups(h: Harness): { release: () => void; count: () => number } {
  const waiting: Array<() => void> = [];
  const base = h.deps.exec as VoiceExec;
  h.deps.exec = async (cmd, args, o) => {
    if (args.includes('-list_devices')) await new Promise<void>((r) => waiting.push(r));
    return base(cmd, args, o);
  };
  h.opts.device = 'External Microphone';
  return {
    release: () => {
      const next = waiting.shift();
      if (!next) throw new Error('nothing waiting at the gate');
      next();
    },
    count: () => waiting.length,
  };
}

// ---------------------------------------------------------------------------
// Toggle mode

describe('lexicon voice --toggle', () => {
  it('starts a detached recording, writes the state file and prints "recording"', async () => {
    const h = await harness();
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);

    expect(h.spawnCalls).toHaveLength(1);
    const { cmd, args, opts } = h.spawnCalls[0];
    expect(cmd).toBe('/fake/bin/ffmpeg');
    expect(opts.detached).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['-f', 'avfoundation', '-i', ':default', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
    expect(args[args.length - 1]).toMatch(/voice[\\/]recording-.*\.wav$/);

    const state = await readState(h.globalPath);
    expect(state).toBeDefined();
    expect(state?.pid).toBe(4242);
    expect(state?.startedAt).toBe('2026-09-19T12:00:00.000Z');
    expect(state?.wav).toBe(args[args.length - 1]);
    expect(stateFilePath(h.globalPath)).toBe(path.join(h.dir, 'voice', 'recording.json'));
  });

  it('stops the recorder on the second call, transcribes, normalizes and clears the state file', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    const wav = (await readState(h.globalPath))?.wav;
    h.out.length = 0;

    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(h.err.join('')).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(h.kills).toEqual([{ pid: 4242, signal: 'SIGINT' }]);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(await readState(h.globalPath)).toBeUndefined();
    // the recording is deleted once transcribed
    await expect(fs.access(wav ?? '')).rejects.toThrow();
    // whisper ran on the recorded wav with the model from the models dir
    const w = whisperCall(h);
    expect(w?.args).toEqual(expect.arrayContaining(['-f', wav, '-m', path.join(h.dir, 'models', 'ggml-base.en.bin'), '-l', 'en', '-nt', '-np', '-oj']));
  });

  /**
   * The data-loss bug this file exists to keep fixed. Every `--toggle` capture
   * is spawned with `-t 600`, so a recording nobody stopped ends itself at ten
   * minutes: complete, finalized, ten minutes of speech. The next press found a
   * pid that was gone, called that "stale" and deleted the WAV without opening
   * it, then printed `recording` as if nothing had happened.
   */
  it('transcribes the finished recording a self-terminated recorder left behind', async () => {
    const h = await harness();
    const wav = await deadRecorderState(h, wavBytes({ audioBytes: 600 * 32_000, finalized: true }));

    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(h.err.join('')).toContain('no longer running; transcribing the 600s it recorded');
    // It was transcribed, not replaced by a new recording.
    expect(whisperCall(h)?.args).toEqual(expect.arrayContaining(['-f', wav]));
    expect(h.spawnCalls).toEqual([]);
    expect(h.kills).toEqual([]);
    expect(await readState(h.globalPath)).toBeUndefined();
    // The length comes from the audio, not from the wall clock since startedAt.
    expect((await readHistory(h.globalPath))[0].ms.record).toBe(600_000);
  });

  it('transcribes what a crashed recorder wrote instead of deleting it', async () => {
    // Device unplugged partway: ffmpeg is gone and never wrote its trailer, so
    // the header still says "size unknown". The audio is on disk all the same.
    const h = await harness();
    const wav = await deadRecorderState(h, wavBytes({ audioBytes: 112_640, finalized: false }));

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(whisperCall(h)?.args).toEqual(expect.arrayContaining(['-f', wav]));
    expect(h.spawnCalls).toEqual([]);
    // Deleted only once whisper had read it.
    await expect(fs.access(wav)).rejects.toThrow();
  });

  it('says why a recorder that never started produced nothing, and removes only the empty placeholder', async () => {
    // Microphone permission denied: ffmpeg exits without ever opening the
    // output, so what is on disk is the 0-byte file the start pre-created.
    // The old code printed `recording` here, for ever, with no explanation.
    const h = await harness();
    const wav = await deadRecorderState(h, Buffer.alloc(0));
    await fs.writeFile(recorderLogPath(h.globalPath), '[AVFoundation indev @ 0x1] Error opening input: Input/output error\n');

    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_ERROR);
    expect(h.out).toEqual([]);
    const err = h.err.join('');
    expect(err).toContain('stopped on its own and left no audio (the recording is empty)');
    expect(err).toContain('ffmpeg said: [AVFoundation indev @ 0x1] Error opening input: Input/output error');
    expect(err).toContain('Microphone permission');
    expect(err).toContain('Press the hotkey again');
    expect(h.spawnCalls).toEqual([]);
    expect(await readState(h.globalPath)).toBeUndefined();
    // Nothing was in it, so nothing is kept.
    await expect(fs.access(wav)).rejects.toThrow();
  });

  it('keeps a capture it cannot parse rather than deleting the user audio', async () => {
    const h = await harness();
    const wav = await deadRecorderState(h, Buffer.alloc(100_000, 3));

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.err.join('')).toContain('the recording is not a WAV file');
    expect(h.err.join('')).toContain(`the 100000 bytes that were written are kept at ${wav}`);
    expect((await fs.stat(wav)).size).toBe(100_000);
  });

  it('the stop half keeps a capture it refuses, and names it', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    const wav = (await readState(h.globalPath))?.wav ?? '';
    // The recorder is alive, but what it wrote is not something we can read.
    await fs.writeFile(wav, Buffer.alloc(2048, 9));
    h.out.length = 0;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.kills).toEqual([{ pid: 4242, signal: 'SIGINT' }]);
    expect(h.err.join('')).toContain(`the 2048 bytes that were written are kept at ${wav}`);
    expect((await fs.stat(wav)).size).toBe(2048);
  });

  it('SIGKILLs a recorder that ignores SIGINT past the grace period', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    // isAlive keeps saying yes, so stopRecorder escalates.
    let t = 0;
    const kills: string[] = [];
    const result = await stopRecorder({
      pid: 4242,
      isAlive: () => !kills.includes('SIGKILL'),
      kill: (_pid, signal) => {
        kills.push(signal);
      },
      sleep: async (ms) => {
        t += ms;
      },
      graceMs: 100,
      platform: 'darwin',
    });
    expect(kills).toEqual(['SIGINT', 'SIGKILL']);
    expect(result).toEqual({ finalized: false, killed: true, abrupt: false });
    expect(t).toBeGreaterThan(0);
  });

  /**
   * The Windows stop, told the truth. Node turns every signal into
   * TerminateProcess there, so SIGINT would be a lie in both directions: it
   * does not reach ffmpeg as an interrupt, and what comes back must not be
   * reported as a finalized file.
   */
  it('on win32 terminates the recorder and does not claim the WAV was finalized', async () => {
    const kills: string[] = [];
    let alive = true;
    const result = await stopRecorder({
      pid: 4242,
      isAlive: () => alive,
      kill: (_pid, signal) => {
        kills.push(signal);
        alive = false;
      },
      sleep: async () => undefined,
      platform: 'win32',
    });
    expect(kills).toEqual(['SIGKILL']);
    expect(result).toEqual({ finalized: false, killed: false, abrupt: true });
  });

  /**
   * The exception: a Ctrl-C the user typed is a real console event that Windows
   * delivered to the whole process group, so the foreground recorder did get to
   * flush. Nothing is sent, and nothing is claimed to be abrupt.
   */
  it('on win32 a user Ctrl-C is a genuine interrupt, so the stop is not abrupt', async () => {
    const kills: string[] = [];
    let alive = true;
    const result = await stopRecorder({
      pid: 4242,
      isAlive: () => {
        const was = alive;
        alive = false;
        return was;
      },
      kill: (_pid, signal) => kills.push(signal),
      sleep: async () => undefined,
      platform: 'win32',
      alreadySignalled: true,
    });
    expect(kills).toEqual([]);
    expect(result).toEqual({ finalized: true, killed: false, abrupt: false });
  });

  it('sends SIGINT and reports a finalized WAV off Windows', async () => {
    const kills: string[] = [];
    let alive = true;
    const result = await stopRecorder({
      pid: 4242,
      isAlive: () => alive,
      kill: (_pid, signal) => {
        kills.push(signal);
        alive = false;
      },
      sleep: async () => undefined,
      platform: 'linux',
    });
    expect(kills).toEqual(['SIGINT']);
    expect(result).toEqual({ finalized: true, killed: false, abrupt: false });
  });

  it('--status reports recording since <time> (0) or idle (1)', async () => {
    const h = await harness();
    expect(await runVoiceStatus(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.out).toEqual(['idle\n']);
    h.out.length = 0;
    await runVoiceToggle(h.opts, h.io, h.deps);
    h.out.length = 0;
    expect(await runVoiceStatus(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording since 2026-09-19T12:00:00.000Z\n']);
    h.out.length = 0;
    expect(await runVoiceStatus({ ...h.opts, json: true }, h.io, h.deps)).toBe(EXIT_OK);
    expect(JSON.parse(h.out[0])).toEqual({ recording: true, since: '2026-09-19T12:00:00.000Z', pid: 4242 });
  });
});

describe('lexicon voice --toggle start race', () => {
  it('a second press while a start is in flight prints "recording" and spawns nothing', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-in-flight.wav');
    // A provisional record: claimed a moment ago, no pid yet.
    expect(await claimState(h.globalPath, { wav, startedAt: '2026-09-19T12:00:00.000Z' })).toBe(true);
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.spawnCalls).toEqual([]);
    expect(h.kills).toEqual([]);
    expect(await readState(h.globalPath)).toEqual({ wav, startedAt: '2026-09-19T12:00:00.000Z' });
  });

  it('two presses that race (second starts while the first is spawning) produce one recorder and one state file', async () => {
    const h = await harness();
    // The first press's spawn fires the second press before returning: the
    // second runs while the state file still holds the first's provisional
    // record, exactly the window between the claim and the pid rewrite.
    let second: Promise<number> | undefined;
    const base = h.deps.spawn as VoiceSpawn;
    h.deps.spawn = (cmd, args, o) => {
      const handle = base(cmd, args, o);
      if (!second) second = runVoiceToggle(h.opts, h.io, h.deps);
      return handle;
    };
    const first = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(first).toBe(EXIT_OK);
    expect(await second).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n', 'recording\n']);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.kills).toEqual([]);
    const state = await readState(h.globalPath);
    expect(state?.pid).toBe(4242);
    const files = (await fs.readdir(voiceDir(h.globalPath))).filter((f) => f.endsWith('.json') || f.endsWith('.tmp'));
    expect(files).toEqual(['recording.json']);
  });

  it('losing the exclusive claim re-reads the file: a young provisional record means "recording", no second ffmpeg', async () => {
    const h = await harness();
    const gate = gateDeviceLookups(h);
    // Both presses read an empty state, then park before the claim.
    const a = runVoiceToggle(h.opts, h.io, h.deps);
    const b = runVoiceToggle(h.opts, h.io, h.deps);
    await vi.waitFor(() => expect(gate.count()).toBe(2));
    gate.release();
    expect(await Promise.race([a, b])).toBe(EXIT_OK);
    expect(h.spawnCalls).toHaveLength(1);
    const started = await readState(h.globalPath);
    expect(started?.pid).toBe(4242);
    // Put the first press back between its claim and its pid rewrite, then let the second press try to claim.
    await writeState(h.globalPath, { wav: started?.wav ?? '', startedAt: started?.startedAt ?? '' });
    gate.release();
    expect(await Promise.all([a, b])).toEqual([EXIT_OK, EXIT_OK]);
    expect(h.out).toEqual(['recording\n', 'recording\n']);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.kills).toEqual([]);
    expect(await readState(h.globalPath)).toEqual({ wav: started?.wav, startedAt: started?.startedAt });
  });

  it('losing the claim to a start that already finished treats the press as "stop"', async () => {
    const h = await harness();
    const gate = gateDeviceLookups(h);
    const a = runVoiceToggle(h.opts, h.io, h.deps);
    const b = runVoiceToggle(h.opts, h.io, h.deps);
    await vi.waitFor(() => expect(gate.count()).toBe(2));
    gate.release();
    expect(await Promise.race([a, b])).toBe(EXIT_OK);
    gate.release();
    expect(await Promise.all([a, b])).toEqual([EXIT_OK, EXIT_OK]);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.kills).toEqual([{ pid: 4242, signal: 'SIGINT' }]);
    expect(h.out).toEqual(['recording\n', 'ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(await readState(h.globalPath)).toBeUndefined();
  });

  it('replaces a stale provisional record (a start that died before recording its pid)', async () => {
    const h = await harness();
    const staleWav = path.join(voiceDir(h.globalPath), 'recording-stale.wav');
    await fs.mkdir(path.dirname(staleWav), { recursive: true });
    // The usual case: the claim created the file, the start died before ffmpeg
    // wrote anything into it. Nothing to lose, so it goes.
    await fs.writeFile(staleWav, Buffer.alloc(0));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav: staleWav, startedAt: '2026-09-19T11:00:00.000Z' }));
    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.err.join('')).toContain('stale recording state (a start that never recorded its pid)');
    expect(h.spawnCalls).toHaveLength(1);
    expect((await readState(h.globalPath))?.pid).toBe(4242);
    await expect(fs.access(staleWav)).rejects.toThrow();
  });

  /**
   * The other way a provisional record goes stale: the start spawned ffmpeg and
   * then died before writing the pid, so an orphan recorder is still filling
   * that WAV and we have no pid to stop it with. We cannot transcribe a file
   * something else is writing, but deleting it is still the wrong answer.
   */
  it('keeps the audio an orphaned recorder is still writing, and says where it is', async () => {
    const h = await harness();
    const staleWav = path.join(voiceDir(h.globalPath), 'recording-orphan.wav');
    await fs.mkdir(path.dirname(staleWav), { recursive: true });
    await fs.writeFile(staleWav, wavBytes({ audioBytes: 64_000, finalized: false }));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav: staleWav, startedAt: '2026-09-19T11:00:00.000Z' }));
    h.opts.quiet = false;
    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.err.join('')).toContain(`the previous start left 64044 bytes at ${staleWav}; it is kept`);
    expect((await fs.stat(staleWav)).size).toBe(64_044);
    // and a new recording started, into a different file
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].args.at(-1)).not.toBe(staleWav);
  });

  it('a failed spawn removes the provisional record so the next press starts cleanly', async () => {
    const h = await harness();
    h.deps.spawn = () => {
      throw new Error('spawn ENOENT');
    };
    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.err.join('')).toContain('spawn ENOENT');
    expect(await readState(h.globalPath)).toBeUndefined();
    expect((await fs.readdir(voiceDir(h.globalPath))).filter((f) => f.endsWith('.wav'))).toEqual([]);

    const noPid: VoiceSpawn = () => ({ pid: undefined, exited: Promise.resolve(null), stderr: () => '', kill: () => undefined });
    h.deps.spawn = noPid;
    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.err.join('')).toContain('could not start ffmpeg');
    expect(await readState(h.globalPath)).toBeUndefined();
  });

  it('--status reports a provisional record as idle', async () => {
    const h = await harness();
    await claimState(h.globalPath, { wav: 'x.wav', startedAt: '2026-09-19T12:00:00.000Z' });
    expect(await runVoiceStatus(h.opts, h.io, h.deps)).toBe(EXIT_ERROR);
    expect(h.out).toEqual(['idle\n']);
  });

  it('claimState is exclusive; readState accepts a missing pid and rejects a bad one', async () => {
    const h = await harness();
    expect(await claimState(h.globalPath, { wav: 'a.wav', startedAt: 't' })).toBe(true);
    expect(await claimState(h.globalPath, { wav: 'b.wav', startedAt: 't' })).toBe(false);
    expect(await readState(h.globalPath)).toEqual({ wav: 'a.wav', startedAt: 't' });
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ pid: 'nope', wav: 'a.wav', startedAt: 't' }));
    expect(await readState(h.globalPath)).toBeUndefined();
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    expect(isStaleProvisional({ wav: 'a', startedAt: '2026-09-19T12:00:00.000Z' }, now + PROVISIONAL_TTL_MS)).toBe(false);
    expect(isStaleProvisional({ wav: 'a', startedAt: '2026-09-19T12:00:00.000Z' }, now + PROVISIONAL_TTL_MS + 1)).toBe(true);
    expect(isStaleProvisional({ wav: 'a', startedAt: 'garbage' }, now)).toBe(true);
  });
});

describe.skipIf(!posix)('voice file permissions', () => {
  it('creates the voice dir 0700 and the state file, recorder log and WAV 0600 on start', async () => {
    const h = await harness();
    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(await modeOf(voiceDir(h.globalPath))).toBe(0o700);
    expect(await modeOf(stateFilePath(h.globalPath))).toBe(0o600);
    expect(await modeOf(recorderLogPath(h.globalPath))).toBe(0o600);
    const wav = (await readState(h.globalPath))?.wav ?? '';
    expect(wav).toMatch(/\.wav$/);
    expect(await modeOf(wav)).toBe(0o600);
    // The foreground WAV in the scratch dir gets the same treatment.
    const fg = await harness();
    fg.deps.waitForStop = async () => 'enter';
    await runVoice(fg.opts, fg.io, fg.deps);
    // it was deleted after transcription; assert on what ffmpeg was handed instead
    const fgWav = fg.spawnCalls[0]?.args.at(-1) ?? '';
    await fs.writeFile(fgWav, '');
    expect(await modeOf(fgWav)).not.toBe(0o600); // sanity: a plain write is not private ...
    const { touchPrivateFile } = await import('../src/voice/recorder.js');
    await touchPrivateFile(fgWav);
    expect(await modeOf(fgWav)).toBe(0o600); // ... and the helper makes it so
  });

  it('writes history.jsonl 0600 and tightens an existing loose history or state file on rewrite', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    await runVoiceToggle(h.opts, h.io, h.deps);
    expect(await modeOf(historyPath(h.globalPath))).toBe(0o600);

    await fs.chmod(historyPath(h.globalPath), 0o644);
    await appendHistory(h.globalPath, { at: 't', raw: 'r', output: 'o', model: 'm', ms: { record: 0, transcribe: 0, normalize: 0 } });
    expect(await modeOf(historyPath(h.globalPath))).toBe(0o600);

    await fs.writeFile(stateFilePath(h.globalPath), '{}', { mode: 0o644 });
    await writeState(h.globalPath, { pid: 1, wav: 'w', startedAt: 't' });
    expect(await modeOf(stateFilePath(h.globalPath))).toBe(0o600);
  });

  it('ensureVoiceDir tightens a voice dir created earlier with a looser mode', async () => {
    const h = await harness();
    await fs.mkdir(voiceDir(h.globalPath), { recursive: true, mode: 0o755 });
    expect(await modeOf(voiceDir(h.globalPath))).toBe(0o755);
    await ensureVoiceDir(h.globalPath);
    expect(await modeOf(voiceDir(h.globalPath))).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// Foreground mode

describe('lexicon voice (foreground)', () => {
  it('records until Enter, sends SIGINT to ffmpeg and prints the corrected text', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.spawnCalls[0].opts.detached).toBe(false);
    expect(h.kills).toEqual([{ pid: 4242, signal: 'SIGINT' }]);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
  });

  it('does not re-signal ffmpeg after Ctrl-C (it already got the SIGINT)', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => {
      // the terminal delivered SIGINT to the whole group; ffmpeg exits on its own
      h.children[0].resolve(255);
      return 'sigint';
    };
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.kills).toEqual([]);
  });

  it('--seconds passes -t to ffmpeg and waits for it to exit', async () => {
    const h = await harness();
    const spawn = h.deps.spawn;
    h.deps.spawn = (cmd, args, opts) => {
      const child = spawn!(cmd, args, opts);
      setTimeout(() => h.children[0].resolve(0), 5);
      return child;
    };
    const code = await runVoice({ ...h.opts, seconds: 3 }, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.spawnCalls[0].args).toEqual(expect.arrayContaining(['-t', '3']));
    expect(h.kills).toEqual([]);
  });

  it('builds the whisper prompt from the lexicon canonicals and passes it as --prompt', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice(h.opts, h.io, h.deps);
    const w = whisperCall(h);
    expect(w).toBeDefined();
    const i = w!.args.indexOf('--prompt');
    expect(i).toBeGreaterThan(-1);
    const prompt = w!.args[i + 1];
    expect(prompt.split(', ').sort()).toEqual(['Ashlr.AI', 'Kubernetes']);
    expect(prompt).not.toContain('Ashler');
  });

  it('--no-prompt omits --prompt', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, prompt: false }, h.io, h.deps);
    expect(whisperCall(h)!.args).not.toContain('--prompt');
  });

  it('--lang and --translate reach whisper-cli', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, lang: 'de', translate: true }, h.io, h.deps);
    const args = whisperCall(h)!.args;
    expect(args).toEqual(expect.arrayContaining(['-l', 'de', '-tr']));
  });

  it('--json prints { raw, output, replacements, summary, model, seconds, ms }', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    const code = await runVoice({ ...h.opts, json: true }, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(h.out[0]) as VoiceJsonResult;
    expect(parsed.raw).toBe('ping ashler about the cooper netties rollout');
    expect(parsed.output).toBe('ping Ashlr.AI about the Kubernetes rollout');
    expect(parsed.replacements.map((x) => [x.original, x.replacement])).toEqual([
      ['ashler', 'Ashlr.AI'],
      ['cooper netties', 'Kubernetes'],
    ]);
    expect(parsed.summary).toContain('"ashler" -> "Ashlr.AI"');
    expect(parsed.model).toBe('base.en');
    expect(typeof parsed.seconds).toBe('number');
    expect(Object.keys(parsed.ms).sort()).toEqual(['normalize', 'record', 'transcribe']);
    expect(Object.keys(parsed).sort()).toEqual(['model', 'ms', 'output', 'raw', 'replacements', 'seconds', 'summary']);
  });

  it('appends to voice/history.jsonl and records hits for the corrected terms', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice(h.opts, h.io, h.deps);
    const history = await readHistory(h.globalPath);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      at: '2026-09-19T12:00:00.000Z',
      raw: 'ping ashler about the cooper netties rollout',
      output: 'ping Ashlr.AI about the Kubernetes rollout',
      model: 'base.en',
    });
    expect(Object.keys(history[0].ms).sort()).toEqual(['normalize', 'record', 'transcribe']);
    const yaml = await fs.readFile(h.globalPath, 'utf8');
    expect(yaml).toMatch(/hits: 1/);
  });

  it('--no-history leaves history.jsonl alone', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, history: false }, h.io, h.deps);
    await expect(fs.access(historyPath(h.globalPath))).rejects.toThrow();
  });

  /**
   * Catches moving the capture's removal back ahead of the empty-transcript
   * check in `runVoice`. `cleanTranscript` turns `[BLANK_AUDIO]` into the empty
   * string, and so does a wrong `--lang` or a model too small for the speaker,
   * so the file has to outlive a transcript of nothing.
   */
  it('strips [BLANK_AUDIO] and exits 3 with "(nothing heard)", keeping the audio', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    h.transcript = ' [BLANK_AUDIO] ';
    h.opts.quiet = false;
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_NOTHING_HEARD);
    expect(h.out).toEqual(['(nothing heard)\n']);
    expect(await readHistory(h.globalPath)).toEqual([]);
    const kept = (await fs.readdir(path.join(h.dir, 'tmp'))).filter((f) => f.endsWith('.wav'));
    expect(kept).toHaveLength(1);
    expect(h.err.join('')).toContain('whisper read nothing out of this capture, so the recording is kept at');
  });

  it('removes the capture once whisper has read something out of it', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    expect(await runVoice(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect((await fs.readdir(path.join(h.dir, 'tmp'))).filter((f) => f.endsWith('.wav'))).toEqual([]);
  });

  it('exits 2 with an install hint when whisper-cli is missing', async () => {
    const h = await harness({ missing: ['whisper-cli', 'whisper-cpp'] });
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_MISSING_TOOL);
    expect(h.err.join('')).toContain('whisper-cli not found');
    expect(h.err.join('')).toContain('brew install ffmpeg whisper-cpp');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('exits 2 when ffmpeg is missing, naming both tools if both are absent', async () => {
    const h = await harness({ missing: ['ffmpeg', 'whisper-cli', 'whisper-cpp'], platform: 'linux' });
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_MISSING_TOOL);
    expect(h.err.join('')).toContain('ffmpeg and whisper-cli not found');
    expect(h.err.join('')).toContain('apt install ffmpeg');
  });

  it('LEXICON_WHISPER_BIN points at a checkout binary named main', async () => {
    const h = await harness({ missing: ['whisper-cli', 'whisper-cpp'] });
    h.deps.env = { PATH: h.binDir, LEXICON_WHISPER_BIN: '/fake/bin/main' };
    h.deps.waitForStop = async () => 'enter';
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.execCalls.some((c) => c.cmd === '/fake/bin/main')).toBe(true);
  });

  it('surfaces a whisper failure and keeps the audio', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    h.whisperExit = 1;
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join('')).toMatch(/whisper-cli exited 1: whisper: boom \(audio kept at .*\.wav\)/);
  });

  it('--copy writes the corrected text to the clipboard', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, copy: true }, h.io, h.deps);
    expect(h.clipboard).toEqual(['ping Ashlr.AI about the Kubernetes rollout']);
    expect(h.pastes).toBe(0);
  });

  it('--paste copies and sends Cmd+V through osascript on darwin', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, paste: true }, h.io, h.deps);
    expect(h.clipboard).toEqual(['ping Ashlr.AI about the Kubernetes rollout']);
    const osa = h.execCalls.find((c) => c.cmd === 'osascript');
    expect(osa?.args).toEqual(['-e', 'tell application "System Events" to keystroke "v" using command down']);
  });

  it('--paste off darwin falls back to --copy with a "not supported yet" notice', async () => {
    const h = await harness({ platform: 'linux' });
    h.deps.waitForStop = async () => 'enter';
    const code = await runVoice({ ...h.opts, paste: true }, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.clipboard).toHaveLength(1);
    expect(h.pastes).toBe(0);
    expect(h.err.join('')).toContain('--paste is not supported yet on linux');
    // linux records through pulse when ffmpeg has the demuxer
    expect(h.spawnCalls[0].args).toEqual(expect.arrayContaining(['-f', 'pulse', '-i', 'default']));
  });

  it('--device picks the avfoundation index by name', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    await runVoice({ ...h.opts, device: 'external' }, h.io, h.deps);
    expect(h.spawnCalls[0].args).toEqual(expect.arrayContaining(['-i', ':1']));
  });

  it('downloads a missing named model with a progress line', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    h.opts.quiet = false;
    const download: Downloader = async (url, dest, onProgress) => {
      expect(url).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin');
      onProgress({ received: 50, total: 100 });
      onProgress({ received: 100, total: 100 });
      await fs.writeFile(dest, 'fake');
    };
    h.deps.download = download;
    const code = await runVoice({ ...h.opts, model: 'small.en' }, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.err.join('')).toContain('whisper model small.en not found; fetching');
    expect(h.err.join('')).toContain('downloading ggml-small.en.bin 100%');
    expect(whisperCall(h)!.args).toEqual(expect.arrayContaining(['-m', path.join(h.dir, 'models', 'ggml-small.en.bin')]));
  });

  it('LEXICON_WHISPER_MODELS overrides the models directory', async () => {
    const h = await harness();
    const alt = path.join(h.dir, 'alt-models');
    await fs.mkdir(alt);
    await fs.writeFile(path.join(alt, 'ggml-base.en.bin'), 'x');
    h.deps.env = { PATH: h.binDir, LEXICON_WHISPER_MODELS: alt };
    h.deps.waitForStop = async () => 'enter';
    await runVoice(h.opts, h.io, h.deps);
    expect(whisperCall(h)!.args).toEqual(expect.arrayContaining(['-m', path.join(alt, 'ggml-base.en.bin')]));
  });

  it('--list-devices prints the avfoundation audio devices', async () => {
    const h = await harness();
    const code = await runVoiceListDevices(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out.join('')).toBe('[0] Mason’s iPhone Microphone\n[1] External Microphone\n[2] MacBook Pro Microphone\n');
  });
});

// ---------------------------------------------------------------------------
// Pure pieces

describe('cleanTranscript', () => {
  it('strips whisper tags, collapses whitespace and trims', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('[BLANK_AUDIO] Ping Ashler.  [MUSIC]\n about the  rollout. [inaudible]')).toBe('Ping Ashler. about the rollout.');
    expect(cleanTranscript('(applause) hello (soft music) there *laughs*')).toBe('hello there');
    // a dictated parenthetical is not a noise tag
    expect(cleanTranscript('deploy it (the new build) tonight')).toBe('deploy it (the new build) tonight');
  });

  it('parseWhisperOutput joins JSON segments and falls back to stdout', () => {
    expect(parseWhisperOutput(JSON.stringify({ transcription: [{ text: ' a' }, { text: ' b' }] }), 'x')).toBe(' a  b');
    expect(parseWhisperOutput('not json', 'plain')).toBe('plain');
    expect(parseWhisperOutput(undefined, 'plain')).toBe('plain');
  });

  it('whisperArgs and ffmpegRecordArgs produce the documented argv', () => {
    expect(whisperArgs({ modelPath: '/m.bin', wav: '/a.wav', outBase: '/o', lang: 'en', translate: false, prompt: 'A, B' })).toEqual([
      '-m', '/m.bin', '-f', '/a.wav', '-l', 'en', '-nt', '-np', '-oj', '-of', '/o', '--prompt', 'A, B',
    ]);
    expect(ffmpegRecordArgs({ input: { format: 'avfoundation', input: ':default' }, wav: '/r.wav', seconds: 600 })).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':default', '-t', '600', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-y', '/r.wav',
    ]);
  });
});

describe('device parsers', () => {
  it('parses the avfoundation listing (audio block only)', () => {
    const devices = parseAvfoundationDevices(AVFOUNDATION_LIST);
    expect(devices).toEqual([
      { index: 0, name: 'Mason’s iPhone Microphone', id: ':0', backend: 'avfoundation' },
      { index: 1, name: 'External Microphone', id: ':1', backend: 'avfoundation' },
      { index: 2, name: 'MacBook Pro Microphone', id: ':2', backend: 'avfoundation' },
    ]);
    expect(pickDevice(devices, '2')?.name).toBe('MacBook Pro Microphone');
    expect(pickDevice(devices, 'macbook pro microphone')?.id).toBe(':2');
    expect(pickDevice(devices, 'iphone')?.id).toBe(':0');
    expect(pickDevice(devices, 'nope')).toBeUndefined();
  });

  it('parses dshow, pulse and arecord listings', () => {
    expect(parseDshowDevices(DSHOW_LIST).map((d) => d.name)).toEqual(['Microphone Array (Realtek(R) Audio)', 'Headset Microphone (USB)']);
    const pulse = parsePulseSources(PULSE_SOURCES);
    expect(pulse.map((d) => d.id)).toEqual(['alsa_input.pci-0000_00_1f.3.analog-stereo', 'alsa_input.usb-Blue_Yeti-00.analog-stereo']);
    expect(pulse[1].name).toBe('Yeti Stereo Microphone Analog Stereo');
    const alsa = parseArecordList(ARECORD_LIST);
    expect(alsa).toEqual([
      { index: 0, name: 'HDA Intel PCH (ALC295 Analog)', id: 'hw:0,0', backend: 'alsa' },
      { index: 1, name: 'Yeti Stereo Microphone (USB Audio)', id: 'hw:1,0', backend: 'alsa' },
    ]);
    expect(formatDeviceList(alsa)).toBe('[0] HDA Intel PCH (ALC295 Analog)  (hw:0,0)\n[1] Yeti Stereo Microphone (USB Audio)  (hw:1,0)\n');
    expect(formatDeviceList([])).toBe('no audio input devices found\n');
  });
});

describe('history', () => {
  it('caps the file at the newest N lines', async () => {
    const h = await harness();
    const entry = (i: number) => ({ at: `t${i}`, raw: `r${i}`, output: `o${i}`, model: 'base.en', ms: { record: 0, transcribe: 0, normalize: 0 } });
    for (let i = 0; i < 7; i += 1) await appendHistory(h.globalPath, entry(i), 5);
    const kept = await readHistory(h.globalPath);
    expect(kept.map((e) => e.at)).toEqual(['t2', 't3', 't4', 't5', 't6']);
    const text = await fs.readFile(historyPath(h.globalPath), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter(Boolean)).toHaveLength(5);
    expect(HISTORY_MAX_LINES).toBe(1000);
  });
});

describe('models and tools', () => {
  it('resolves names to ggml files, prefers the models dir, then the fallback dirs', () => {
    // Every expectation goes through path.join/path.resolve because
    // resolveModel does: on a Windows runner these are backslash paths and
    // path.resolve('/x/...') additionally gains a drive letter.
    const CFG_MODELS = path.join('/cfg', 'models');
    const FALLBACK = path.resolve('/fallback');
    const present = new Set([path.join(FALLBACK, 'ggml-base.en.bin'), path.join(CFG_MODELS, 'ggml-tiny.en.bin')]);
    const exists = (p: string) => present.has(p);
    const opts = { globalPath: path.join('/cfg', 'lexicon.yaml'), env: {}, fallbackDirs: [FALLBACK], exists };
    expect(resolveModel('tiny.en', opts)).toEqual({ name: 'tiny.en', path: path.join(CFG_MODELS, 'ggml-tiny.en.bin'), present: true, url: modelUrl('tiny.en') });
    expect(resolveModel('base.en', opts)).toMatchObject({ path: path.join(FALLBACK, 'ggml-base.en.bin'), present: true, foundIn: FALLBACK });
    expect(resolveModel('small.en', opts)).toEqual({ name: 'small.en', path: path.join(CFG_MODELS, 'ggml-small.en.bin'), present: false, url: modelUrl('small.en') });
    const explicit = path.join('/x', 'ggml-medium.bin');
    expect(resolveModel(explicit, opts)).toEqual({ name: 'medium', path: path.resolve(explicit), present: false });
    expect(modelFileName('base.en')).toBe('ggml-base.en.bin');
    expect(resolveModel('base.en', { ...opts, env: { LEXICON_WHISPER_MODELS: FALLBACK } }).path).toBe(path.join(FALLBACK, 'ggml-base.en.bin'));
  });

  it('expands a leading ~ against the real home on every platform, not $HOME', () => {
    // process.env.HOME is undefined on Windows (it is USERPROFILE there), and
    // the old `process.env.HOME ?? ''` silently produced a cwd-relative path.
    expect(expandTilde('~/models/x.bin', '/home/me')).toBe(path.join('/home/me', 'models', 'x.bin'));
    expect(expandTilde('~', '/home/me')).toBe('/home/me');
    expect(expandTilde('/abs/x.bin', '/home/me')).toBe('/abs/x.bin');
    expect(expandTilde('relative/x.bin', '/home/me')).toBe('relative/x.bin');
    expect(resolveModel('~/m/ggml-tiny.bin', { globalPath: path.join('/cfg', 'lexicon.yaml'), env: {}, exists: () => false }).path).toBe(
      path.resolve(path.join(os.homedir(), 'm', 'ggml-tiny.bin')),
    );
  });

  it('locateWhisperCli honours LEXICON_WHISPER_BIN and falls back to PATH names', async () => {
    const exists = async (p: string) => p === '/bin/whisper-cpp' || p === '/src/main';
    expect(await locateWhisperCli({ env: { PATH: '/bin', LEXICON_WHISPER_BIN: '/src/main' }, platform: 'darwin', exists, extraDirs: [] })).toBe('/src/main');
    expect(await locateWhisperCli({ env: { PATH: '/bin', LEXICON_WHISPER_BIN: '/nope' }, platform: 'darwin', exists, extraDirs: [] })).toBeUndefined();
    expect(await locateWhisperCli({ env: { PATH: '/bin' }, platform: 'darwin', exists, extraDirs: [] })).toBe('/bin/whisper-cpp');
    expect(installHint('win32')).toContain('winget');
  });
});

/**
 * What the capture check accepts, and what it stopped accepting.
 *
 * The old rule was `size > 44`, which asked nothing about the container: a
 * truncated file, a header with no samples, or 1000 zero bytes all passed it
 * and went to whisper.cpp, which answers "failed to read the frames of the
 * audio data". The new rule reads the RIFF/WAVE structure — while still
 * accepting a capture whose sizes ffmpeg never got to patch in, because that is
 * every `--toggle` recording on Windows and whisper.cpp reads those fine.
 */
describe('capture validation', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-wav-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, bytes: Buffer): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };

  it('accepts a capture ffmpeg never finalized', async () => {
    const wav = await write('unfinalized.wav', wavBytes({ audioBytes: 32_000, finalized: false }));

    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.finalized).toBe(false);
    // The header says "size unknown", so the bytes on disk are the answer.
    expect(check.audioBytes).toBe(32_000);
    expect(await wavHasAudio(wav)).toBe(true);
  });

  it('accepts a finalized capture and says so', async () => {
    const wav = await write('finalized.wav', wavBytes({ audioBytes: 640, finalized: true }));

    expect(await inspectWav(wav)).toEqual({ ok: true, audioBytes: 640, finalized: true, bytes: 684 });
  });

  it('rejects a header with no audio behind it', async () => {
    const wav = await write('headeronly.wav', wavBytes({ audioBytes: 0, finalized: false }));

    const check = await inspectWav(wav);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('no audio');
    expect(await wavHasAudio(wav)).toBe(false);
  });

  it('rejects bytes that are not a WAV, however many there are', async () => {
    // The old check passed this: it is 1000 bytes, and 1000 > 44.
    const wav = await write('zeros.wav', Buffer.alloc(1000));

    expect((await inspectWav(wav)).reason).toContain('not a WAV');
    expect(await wavHasAudio(wav)).toBe(false);
  });

  it('rejects an empty file, a truncated header and a missing file', async () => {
    expect((await inspectWav(await write('empty.wav', Buffer.alloc(0)))).reason).toContain('empty');
    expect((await inspectWav(await write('stub.wav', Buffer.from('RIF')))).reason).toContain('truncated');
    expect((await inspectWav(path.join(dir, 'nope.wav'))).reason).toContain('no file');
  });

  it('rejects a container that is not RIFF/WAVE', async () => {
    const wav = await write('avi.wav', wavBytes({ audioBytes: 100, finalized: true, riff: 'RIFX' }));

    expect((await inspectWav(wav)).ok).toBe(false);
  });

  it('walks past the chunks ffmpeg writes before the audio', async () => {
    // ffmpeg puts a LIST/INFO chunk between `fmt ` and `data`; the walk has to
    // step over it rather than give up at the first chunk that is not `data`.
    const wav = await write('listed.wav', withChunkBeforeData(wavBytes({ audioBytes: 200, finalized: false }), 'LIST', 12));

    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.audioBytes).toBe(200);
  });

  /**
   * The walk used to read the first 4096 bytes and look for `data` inside them,
   * so a `data` header past byte 4088 was reported as "no audio data chunk" and
   * the caller deleted the recording. A long `LIST`/`INFO` (or any writer's
   * padding chunk) puts it there.
   */
  it('finds a data chunk that sits past the first 4 KB', async () => {
    const wav = await write('far.wav', withChunkBeforeData(wavBytes({ audioBytes: 320, finalized: true }), 'JUNK', 8000));

    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.audioBytes).toBe(320);
  });

  /**
   * RIFF pads an odd chunk to an even offset. Not every writer does.
   *
   * Swept rather than sampled, because the single size this used to check
   * passed by luck. Stepping to the padded offset first reads one byte into
   * the next chunk id, so what comes back is that id's last three characters
   * followed by the low byte of its size, and that byte is printable ASCII for
   * 95 values in 256. The `data` chunk's size is the capture length, so which
   * captures survive depends on their length: the sweep refused 48 of these
   * 128 before the walk read the unpadded offset first. Reverting
   * `nextChunkOffset` to try the padded offset first fails this immediately.
   */
  it('finds the audio behind an unpadded odd chunk at every capture size', async () => {
    const refused: string[] = [];
    for (let i = 0; i < 128; i += 1) {
      const audioBytes = 32 + i * 2;
      const padded = withChunkBeforeData(wavBytes({ audioBytes, finalized: true }), 'LIST', 13);
      const at = padded.indexOf(Buffer.from('data', 'latin1'));
      const unpadded = Buffer.concat([padded.subarray(0, at - 1), padded.subarray(at)]);
      const check = await inspectWav(await write(`sweep-${audioBytes}.wav`, unpadded));
      if (!check.ok || check.audioBytes !== audioBytes) refused.push(`${audioBytes}: ${check.reason ?? check.audioBytes}`);
      // The writer that did pad has to keep working at every size too.
      const still = await inspectWav(await write(`sweep-padded-${audioBytes}.wav`, padded));
      if (!still.ok || still.audioBytes !== audioBytes) refused.push(`padded ${audioBytes}: ${still.reason ?? still.audioBytes}`);
    }
    expect(refused).toEqual([]);
  });

  it('recovers when an odd-sized chunk has no RIFF pad byte', async () => {
    const padded = withChunkBeforeData(wavBytes({ audioBytes: 160, finalized: true }), 'LIST', 13);
    expect((await inspectWav(await write('padded.wav', padded))).audioBytes).toBe(160);
    // Same file with the pad byte the writer was supposed to add left out.
    const at = padded.indexOf(Buffer.from('data', 'latin1'));
    const unpadded = Buffer.concat([padded.subarray(0, at - 1), padded.subarray(at)]);
    const check = await inspectWav(await write('unpadded.wav', unpadded));
    expect(check.ok).toBe(true);
    expect(check.audioBytes).toBe(160);
  });

  /**
   * A `data` chunk that declares 0 is not ffmpeg's "size unknown" (that is
   * 0xFFFFFFFF, measured). Reading it as unknown made the trailing `LIST`/`INFO`
   * behind it look like audio, so 30 bytes of ASCII went to whisper.cpp as PCM.
   */
  it('does not read trailing metadata as audio when the data chunk declares 0', async () => {
    const header = wavBytes({ audioBytes: 0, finalized: true }); // 44 bytes, data size 0
    const info = Buffer.alloc(8 + 30);
    info.write('LIST', 0, 'latin1');
    info.writeUInt32LE(30, 4);
    info.write('INFOISFTLavf63.1.102 xxxxx', 8, 'latin1');
    const check = await inspectWav(await write('zerodata.wav', Buffer.concat([header, info])));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('no audio');
    expect(check.audioBytes).toBe(0);
  });

  /** A writer that uses 0 as its placeholder still has real audio behind it. */
  it('accepts audio behind a data chunk that declares 0', async () => {
    const wav = wavBytes({ audioBytes: 6400, finalized: true });
    wav.writeUInt32LE(0, 40);
    const check = await inspectWav(await write('zerostream.wav', wav));
    expect(check.ok).toBe(true);
    expect(check.audioBytes).toBe(6400);
    expect(check.finalized).toBe(false);
  });

  it('reports the size on disk so a caller can decide whether there is anything to keep', async () => {
    expect((await inspectWav(await write('some.wav', Buffer.alloc(1000)))).bytes).toBe(1000);
    expect((await inspectWav(await write('none.wav', Buffer.alloc(0)))).bytes).toBe(0);
    expect((await inspectWav(path.join(dir, 'gone.wav'))).bytes).toBe(0);
  });
});

/**
 * The fixtures above are what we believe ffmpeg writes. These three run the
 * real thing through the three ends a `--toggle` capture can come to, and check
 * the belief. A synthetic `lavfi` source stands in for the microphone: the WAV
 * muxer, which is what `inspectWav` reads, does not know the difference, and no
 * CI runner has audio hardware.
 *
 * Measured here on macOS with ffmpeg 9.0.2: a capture ended by `-t` carries its
 * real sizes; one killed mid-flight carries 0xFFFFFFFF in both the RIFF and the
 * `data` header and keeps every byte ffmpeg had already flushed (a SIGKILL and
 * a SIGINT at 3 s left the same 112,640 bytes of audio); and an input that
 * never opens leaves no output file at all, which is why the only file the
 * toggle deletes is the empty one its own start created.
 */
describe.skipIf(process.env.LEXICON_SKIP_E2E || !hasFfmpeg())('capture validation against real ffmpeg', () => {
  let dir = '';
  const sine = ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'];
  const encode = ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-y'];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-ffmpeg-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts a capture that ended itself on -t, the way a forgotten toggle does', async () => {
    const wav = path.join(dir, 'selfterm.wav');
    const run = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...sine, '-t', '0.5', ...encode, wav]);
    expect(run.status).toBe(0);

    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.finalized).toBe(true);
    expect(check.audioBytes).toBe(16_000); // 0.5 s at 32000 bytes a second
    expect(captureSeconds(check.audioBytes)).toBe(0.5);
  });

  it('accepts a capture whose recorder was killed before it could write the trailer', async () => {
    const wav = path.join(dir, 'killed.wav');
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...sine, '-t', '600', ...encode, wav]);
    await new Promise((r) => setTimeout(r, 700));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const header = await fs.readFile(wav);
    expect(header.readUInt32LE(4)).toBe(0xffff_ffff); // RIFF size: never patched
    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.finalized).toBe(false);
    expect(check.audioBytes).toBeGreaterThan(0);
    expect(check.audioBytes).toBe(check.bytes - 78); // ffmpeg's header, LIST/INFO and all
  });

  it('leaves no file at all when the input never opens', async () => {
    const wav = path.join(dir, 'nodev.wav');
    const run = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nope=x', ...encode, wav]);
    expect(run.status).not.toBe(0);

    const check = await inspectWav(wav);
    expect(check.ok).toBe(false);
    expect(check.bytes).toBe(0);
    expect(check.reason).toContain('no file');
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * Two ways the toggle used to lose track of its own recorder. Both are about
 * the pid in the state file being the only handle we keep on a detached
 * process, and a pid being a weaker handle than it looks.
 */
describe('identifying the recorder behind a pid', () => {
  const WAV = '/tmp/lexicon/voice/recording-2026-09-19T11-00-00-000Z.wav';
  const FFMPEG = `/opt/homebrew/bin/ffmpeg -f avfoundation -i :default -t 600 -ac 1 -y ${WAV}`;

  it('matches our own recorder and nothing else', () => {
    expect(recorderFingerprint(WAV)).toBe('recording-2026-09-19T11-00-00-000Z.wav');
    expect(commandIsRecorder(FFMPEG, WAV)).toBe(true);
    // Right file, wrong program: something else is reading our capture.
    expect(commandIsRecorder(`/usr/bin/open ${WAV}`, WAV)).toBe(false);
    // Right program, wrong file: another recording entirely.
    expect(commandIsRecorder('/opt/homebrew/bin/ffmpeg -i other.wav', WAV)).toBe(false);
    expect(commandIsRecorder('', WAV)).toBe(false);
  });

  /**
   * Catches reverting `commandIsRecorder` to a bare `command.includes(name)`.
   * A user converting their own capture is an ffmpeg with our filename in its
   * command line, and signalling it kills their job over a recording we were
   * not recording.
   */
  it('does not mistake an ffmpeg reading the capture for the one writing it', () => {
    expect(commandIsRecorder(`/opt/homebrew/bin/ffmpeg -i ${WAV} note.mp3`, WAV)).toBe(false);
    expect(commandIsRecorder(`ffmpeg -i ${WAV} -af loudnorm out.wav`, WAV)).toBe(false);
    // The output position is what makes it ours, quoted path and all.
    expect(commandIsRecorder(`ffmpeg -f avfoundation -i :default -y "${WAV}"`, WAV)).toBe(true);
  });

  /**
   * Catches dropping the line-joining from `commandIsRecorder`. PowerShell
   * wraps a long CommandLine at the console width rather than truncating it,
   * and the capture's path, being last, is what lands past the fold. Read as
   * "some other process", that answer gets a live recorder's audio deleted.
   */
  it('matches a command line PowerShell folded in the middle of the capture path', () => {
    const folded = `${FFMPEG.slice(0, FFMPEG.length - 12)}\r\n${FFMPEG.slice(FFMPEG.length - 12)}`;
    expect(folded).not.toBe(FFMPEG);
    expect(commandIsRecorder(folded, WAV)).toBe(true);
  });

  it('reads a command line out of ps and out of PowerShell', async () => {
    const posix = makeProcessDescribe(async () => ({ code: 0, stdout: `${FFMPEG}\n`, stderr: '' }), 'darwin');
    expect(await posix(4242)).toBe(FFMPEG);
    const win = makeProcessDescribe(async () => ({ code: 0, stdout: `${FFMPEG}\r\n`, stderr: '' }), 'win32');
    expect(await win(4242)).toBe(FFMPEG);
    // A pid that is gone, and a ps that is not there at all.
    expect(await makeProcessDescribe(async () => ({ code: 1, stdout: '', stderr: '' }), 'darwin')(1)).toBeUndefined();
    expect(
      await makeProcessDescribe(() => Promise.reject(new Error('ENOENT')), 'darwin')(1),
    ).toBeUndefined();
  });

  /**
   * Catches making `makeProcessList` answer `[]` again when it could not look.
   * "I cannot tell" and "nothing is running" are different answers, and the
   * caller acts on the second one by abandoning a live capture.
   */
  it('parses a process table, and says undefined rather than empty when it cannot read one', async () => {
    const list = makeProcessList(
      async () => ({ code: 0, stdout: `  501 /bin/zsh\n 4242 ${FFMPEG}\nrubbish\n`, stderr: '' }),
      'darwin',
    );
    expect(await list()).toEqual([
      { pid: 501, command: '/bin/zsh' },
      { pid: 4242, command: FFMPEG },
    ]);
    // No `ps` on this host at all.
    expect(await makeProcessList(() => Promise.reject(new Error('nope')), 'darwin')()).toBeUndefined();
    // A `ps` that ran and failed.
    expect(await makeProcessList(async () => ({ code: 1, stdout: '', stderr: 'denied' }), 'darwin')()).toBeUndefined();
    // A table that was read and holds nothing is still an empty list.
    expect(await makeProcessList(async () => ({ code: 0, stdout: '', stderr: '' }), 'darwin')()).toEqual([]);
  });

  it('asks PowerShell for a width no command line reaches, so nothing is folded', async () => {
    const calls: string[][] = [];
    const exec: VoiceExec = async (_cmd, args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    await makeProcessDescribe(exec, 'win32')(4242);
    await makeProcessList(exec, 'win32')();
    for (const args of calls) expect(args[args.length - 1]).toContain('Out-String -Width 32767');
  });

  it('answers undefined when it cannot tell, so the caller keeps the old behaviour', async () => {
    expect(await confirmRecorder(1, WAV, async () => undefined)).toBeUndefined();
    expect(await confirmRecorder(1, WAV, async () => FFMPEG)).toBe(true);
    expect(await confirmRecorder(1, WAV, async () => '/usr/sbin/cupsd')).toBe(false);
  });

  it('finds an orphaned recorder by the capture it is writing', async () => {
    const list = async () => [
      { pid: 501, command: '/bin/zsh' },
      { pid: 7777, command: FFMPEG },
    ];
    expect(await findOrphanRecorder(WAV, list)).toBe(7777);
    expect(await findOrphanRecorder('/tmp/other.wav', list)).toBeUndefined();
    expect(await findOrphanRecorder(WAV, async () => [])).toBeUndefined();
    // A table that could not be read is its own answer, not "none".
    expect(await findOrphanRecorder(WAV, async () => undefined)).toBe('unknown');
  });
});

describe('lexicon voice --toggle, when the pid is not what it seems', () => {
  /**
   * Fails against the old code, which trusted `isAlive` alone: it would have
   * sent SIGINT to pid 99999, a process that has nothing to do with us.
   */
  it('does not signal a recycled pid that now belongs to something else', async () => {
    const h = await harness();
    const wav = await deadRecorderState(h, wavBytes({ audioBytes: 32_000, finalized: true }));
    // The number is live again, running someone else's process.
    h.alive.add(99999);
    h.deps.describeProcess = async () => '/usr/sbin/cupsd';

    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);

    expect(code).toBe(EXIT_OK);
    expect(h.kills).toEqual([]);
    expect(h.err.join('')).toContain('belongs to something else now');
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(await readState(h.globalPath)).toBeUndefined();
    void wav;
  });

  it('still stops a pid it cannot ask about, which is how this behaved before', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    h.out.length = 0;
    h.deps.describeProcess = async () => undefined;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.kills).toEqual([{ pid: 4242, signal: 'SIGINT' }]);
  });

  /**
   * Fails against the old code, which cleared the state, left the orphan
   * running until its own `-t 600` expired, and started a second recorder
   * competing for the microphone.
   */
  it('finds and stops a recorder whose pid was never written down', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
    await fs.mkdir(path.dirname(wav), { recursive: true });
    await fs.writeFile(wav, wavBytes({ audioBytes: 64_000, finalized: false }));
    // Provisional: claimed, spawned, then the start died before writing the pid.
    await fs.writeFile(
      stateFilePath(h.globalPath),
      JSON.stringify({ wav, startedAt: '2026-09-19T11:00:00.000Z' }),
    );
    h.alive.add(7777);
    h.deps.listProcesses = async () => [{ pid: 7777, command: `/fake/bin/ffmpeg -i :default -y ${wav}` }];

    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);

    expect(code).toBe(EXIT_OK);
    expect(h.err.join('')).toContain('left a recorder running (pid 7777)');
    expect(h.kills).toEqual([{ pid: 7777, signal: 'SIGINT' }]);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(h.spawnCalls).toHaveLength(0);
    expect(await readState(h.globalPath)).toBeUndefined();
  });

  it('starts a new recording when the dead start left no recorder behind', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
    await fs.mkdir(path.dirname(wav), { recursive: true });
    await fs.writeFile(wav, '');
    await fs.writeFile(
      stateFilePath(h.globalPath),
      JSON.stringify({ wav, startedAt: '2026-09-19T11:00:00.000Z' }),
    );
    h.deps.listProcesses = async () => [];

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

/**
 * Four ways a recording was being destroyed on a guess. Each test names the
 * reversion it catches; every one of them was reproduced against real ffmpeg
 * 9.0.2 and real whisper.cpp before it was written.
 */
describe('a capture outlives every reading of it', () => {
  /**
   * Catches moving the `fs.rm` in `transcribeCapture` back ahead of `deliver`.
   * Measured: a ten-minute capture, 19.2 MB from ffmpeg, a `--lang` the speaker
   * was not speaking, exit 3, `(nothing heard)`, and nothing left on disk.
   */
  it('keeps the recording when whisper read nothing out of it', async () => {
    const h = await harness();
    const wav = await deadRecorderState(h, wavBytes({ audioBytes: 600 * 32_000, finalized: true }));
    h.transcript = ' [BLANK_AUDIO] ';
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_NOTHING_HEARD);
    expect(h.out).toEqual(['(nothing heard)\n']);
    expect(h.err.join('')).toContain(`whisper read nothing out of this capture, so the recording is kept at ${wav}`);
    expect(h.err.join('')).toContain('A wrong --lang');
    expect((await fs.stat(wav)).size).toBe(600 * 32_000 + 44);
    expect(await readHistory(h.globalPath)).toEqual([]);
  });

  /**
   * Catches dropping the `keepBecause` that `handleClaimedState` passes when
   * `confirmRecorder` says no about a pid that is still alive. The only thing
   * claiming the recorder is gone there is the command line we read back, and
   * a command line can be read back wrong: PowerShell folds a long one, and
   * the capture's path is the part that ends up past the fold. Reproduced with
   * a real ffmpeg recording into a real WAV, which this branch transcribed and
   * then deleted out from under it without ever signalling it.
   */
  it('does not delete the capture of a pid that is still alive', async () => {
    const h = await harness();
    await runVoiceToggle(h.opts, h.io, h.deps);
    const wav = (await readState(h.globalPath))?.wav ?? '';
    h.out.length = 0;
    // The recorder is alive and recording; the lookup says it is not ours.
    h.deps.describeProcess = async () => '/usr/sbin/cupsd';
    h.deps.listProcesses = async () => undefined;
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(h.err.join('')).toContain('pid 4242 is still running, so something may still be writing this capture');
    expect((await fs.stat(wav)).size).toBeGreaterThan(0);
    // Not our pid as far as anything could tell, so it is not signalled either.
    expect(h.kills).toEqual([]);
  });

  /**
   * The other half of the same branch: when the process table can be read and
   * it names the process writing our capture, that is our recorder whatever
   * the per-pid lookup said. Stopping it properly is what makes deleting the
   * capture afterwards safe.
   */
  it('stops the recorder the process table found when the pid lookup read wrong', async () => {
    const h = await harness();
    const wav = await deadRecorderState(h, wavBytes({ audioBytes: 64_000, finalized: false }));
    h.alive.add(99999);
    h.alive.add(7777);
    h.deps.describeProcess = async () => '/usr/sbin/cupsd';
    h.deps.listProcesses = async () => [{ pid: 7777, command: `/fake/bin/ffmpeg -f avfoundation -i :default -y ${wav}` }];
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.err.join('')).toContain('pid 7777 is writing this capture; stopping that one');
    expect(h.kills).toEqual([{ pid: 7777, signal: 'SIGINT' }]);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    await expect(fs.access(wav)).rejects.toThrow();
  });

  /**
   * Catches reading `undefined` from the process table as "nothing is writing
   * this". A host with no `ps` answers that way for every press, not once in a
   * blue moon: reproduced with a real ffmpeg five minutes into a capture and a
   * `ps` lookup that could not run, where the old code walked away from the
   * audio and started a second recorder on top of it.
   */
  it('transcribes a stale start instead of abandoning it when the process table cannot be read', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
    await fs.mkdir(path.dirname(wav), { recursive: true });
    await fs.writeFile(wav, wavBytes({ audioBytes: 300 * 32_000, finalized: false }));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav, startedAt: '2026-09-19T11:00:00.000Z' }));
    h.deps.listProcesses = async () => undefined;
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['ping Ashlr.AI about the Kubernetes rollout\n']);
    expect(h.err.join('')).toContain('300s of audio and no pid, and the process table cannot be read here');
    // Kept, because a recorder we cannot see may still be appending to it.
    expect((await fs.stat(wav)).size).toBe(300 * 32_000 + 44);
    // And no second recorder competing for the microphone.
    expect(h.spawnCalls).toEqual([]);
    expect((await readHistory(h.globalPath))[0].ms.record).toBe(300_000);
  });

  it('still starts a new recording when the table can be read and holds no recorder', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
    await fs.mkdir(path.dirname(wav), { recursive: true });
    await fs.writeFile(wav, wavBytes({ audioBytes: 32_000, finalized: false }));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav, startedAt: '2026-09-19T11:00:00.000Z' }));
    h.deps.listProcesses = async () => [];
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.spawnCalls).toHaveLength(1);
    expect((await fs.stat(wav)).size).toBeGreaterThan(0);
  });
});

/**
 * The stop half of a toggle, made exclusive the way the start half already was.
 */
describe('two hotkey presses, one recording', () => {
  /**
   * Catches removing the `claimStop` from `runVoiceToggle`. Without it both
   * presses transcribe the same capture and both deliver it, which with
   * `--paste` is two paste keystrokes for one thing said.
   */
  it('delivers a finished recording once however the two presses interleave', async () => {
    const h = await harness();
    await deadRecorderState(h, wavBytes({ audioBytes: 32_000, finalized: true }));

    const [a, b] = await Promise.all([runVoiceToggle(h.opts, h.io, h.deps), runVoiceToggle(h.opts, h.io, h.deps)]);
    expect([a, b]).toEqual([EXIT_OK, EXIT_OK]);
    expect(h.out.filter((s) => s.includes('Ashlr.AI'))).toHaveLength(1);
    expect(await readHistory(h.globalPath)).toHaveLength(1);
  });

  it('claimStop hands the state to exactly one caller and clears it', async () => {
    const h = await harness();
    await writeState(h.globalPath, { pid: 4242, wav: 'a.wav', startedAt: '2026-09-19T12:00:00.000Z' });

    const claims = await Promise.all([claimStop(h.globalPath), claimStop(h.globalPath), claimStop(h.globalPath)]);
    expect(claims.filter((c) => c !== undefined)).toEqual([{ pid: 4242, wav: 'a.wav', startedAt: '2026-09-19T12:00:00.000Z' }]);
    expect(await readState(h.globalPath)).toBeUndefined();
    // The claim moves the file aside and removes it; nothing is left behind.
    expect((await fs.readdir(voiceDir(h.globalPath))).filter((f) => f.startsWith('stopping-'))).toEqual([]);
    expect(await claimStop(h.globalPath)).toBeUndefined();
  });

  it('a press that loses the state file stands down instead of starting a second recorder', async () => {
    const h = await harness();
    const wav = path.join(voiceDir(h.globalPath), 'recording-2026-09-19T11-00-00-000Z.wav');
    await fs.mkdir(path.dirname(wav), { recursive: true });
    await fs.writeFile(wav, wavBytes({ audioBytes: 32_000, finalized: false }));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav, startedAt: '2026-09-19T11:00:00.000Z' }));
    // Another press claims the file between this one's read and its own claim.
    h.deps.now = () => {
      rmSync(stateFilePath(h.globalPath), { force: true });
      return new Date('2026-09-19T12:00:00.000Z');
    };

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual(['stopping\n']);
    expect(h.spawnCalls).toEqual([]);
    expect(h.kills).toEqual([]);
  });
});

describe('leftovers in the voice directory', () => {
  /**
   * Refused captures pile up, because every path that refuses one keeps it.
   * What is swept is only what cannot hold audio; what can is counted and
   * named, and left for the user to decide about.
   */
  it('sweeps empty captures and stale claims on a start, and counts the rest', async () => {
    const h = await harness();
    const dir = await ensureVoiceDir(h.globalPath);
    await fs.writeFile(path.join(dir, 'recording-empty.wav'), Buffer.alloc(0));
    await fs.writeFile(path.join(dir, 'recording-refused.wav'), Buffer.alloc(2_000_000, 3));
    await fs.writeFile(path.join(dir, 'history.jsonl'), '{}\n');
    const claim = path.join(dir, 'stopping-1-abc.json');
    await fs.writeFile(claim, '{}');
    await fs.utimes(claim, new Date('2026-09-19T11:00:00.000Z'), new Date('2026-09-19T11:00:00.000Z'));
    h.opts.quiet = false;

    expect(await runVoiceToggle(h.opts, h.io, h.deps)).toBe(EXIT_OK);
    const left = await fs.readdir(dir);
    expect(left).not.toContain('recording-empty.wav');
    expect(left).not.toContain('stopping-1-abc.json');
    expect(left).toContain('recording-refused.wav');
    expect(left).toContain('history.jsonl');
    expect(h.err.join('')).toContain('1 earlier recording (2.0 MB) is still in');
  });

  it('never sweeps the capture being recorded, or one that is merely young', async () => {
    const h = await harness();
    const dir = await ensureVoiceDir(h.globalPath);
    const live = path.join(dir, 'recording-live.wav');
    await fs.writeFile(live, wavBytes({ audioBytes: 1000, finalized: false }));
    const fresh = path.join(dir, 'stopping-2-def.json');
    await fs.writeFile(fresh, '{}');

    const counted = await sweepVoiceDir(h.globalPath, live, Date.parse('2026-09-19T12:00:00.000Z'));
    expect(counted).toEqual({ kept: 0, bytes: 0 });
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['recording-live.wav', 'stopping-2-def.json']));
  });
});
