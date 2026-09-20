import { mkdirSync, promises as fs, writeFileSync } from 'node:fs';
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
import { installHint, locateWhisperCli } from '../src/voice/process.js';
import type { ChildHandle, ExecResult, SpawnOptions, VoiceExec, VoiceSpawn } from '../src/voice/process.js';
import {
  PROVISIONAL_TTL_MS,
  claimState,
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

const posix = process.platform !== 'win32';

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

  it('cleans up a stale state file (pid not alive) and starts a new recording', async () => {
    const h = await harness();
    const staleWav = path.join(h.dir, 'voice', 'recording-stale.wav');
    await fs.mkdir(path.dirname(staleWav), { recursive: true });
    await fs.writeFile(staleWav, Buffer.alloc(100));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ pid: 99999, wav: staleWav, startedAt: '2026-09-19T11:00:00.000Z' }));

    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.err.join('')).toContain('stale recording state (pid 99999 is gone)');
    expect(h.kills).toEqual([]);
    expect(h.spawnCalls).toHaveLength(1);
    const state = await readState(h.globalPath);
    expect(state?.pid).toBe(4242);
    await expect(fs.access(staleWav)).rejects.toThrow();
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

  it('replaces a stale provisional record (a start that died before spawning)', async () => {
    const h = await harness();
    const staleWav = path.join(voiceDir(h.globalPath), 'recording-stale.wav');
    await fs.mkdir(path.dirname(staleWav), { recursive: true });
    await fs.writeFile(staleWav, Buffer.alloc(100));
    await fs.writeFile(stateFilePath(h.globalPath), JSON.stringify({ wav: staleWav, startedAt: '2026-09-19T11:00:00.000Z' }));
    h.opts.quiet = false;
    const code = await runVoiceToggle(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_OK);
    expect(h.out).toEqual(['recording\n']);
    expect(h.err.join('')).toContain('stale recording state (a start that never spawned)');
    expect(h.spawnCalls).toHaveLength(1);
    expect((await readState(h.globalPath))?.pid).toBe(4242);
    await expect(fs.access(staleWav)).rejects.toThrow();
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

  it('strips [BLANK_AUDIO] and exits 3 with "(nothing heard)" on an empty transcript', async () => {
    const h = await harness();
    h.deps.waitForStop = async () => 'enter';
    h.transcript = ' [BLANK_AUDIO] ';
    const code = await runVoice(h.opts, h.io, h.deps);
    expect(code).toBe(EXIT_NOTHING_HEARD);
    expect(h.out).toEqual(['(nothing heard)\n']);
    expect(await readHistory(h.globalPath)).toEqual([]);
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

    expect(await inspectWav(wav)).toEqual({ ok: true, audioBytes: 640, finalized: true });
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
    const base = wavBytes({ audioBytes: 200, finalized: false });
    const info = Buffer.alloc(8 + 12);
    info.write('LIST', 0, 'latin1');
    info.writeUInt32LE(12, 4);
    info.write('INFOISFT', 8, 'latin1');
    const wav = await write('listed.wav', Buffer.concat([base.subarray(0, 36), info, base.subarray(36)]));

    const check = await inspectWav(wav);
    expect(check.ok).toBe(true);
    expect(check.audioBytes).toBe(200);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
