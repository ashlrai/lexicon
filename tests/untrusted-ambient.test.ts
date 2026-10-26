/**
 * The clipboard daemon, `lexicon voice` and `lexicon setup` correct text with
 * the merged lexicon and never look inside a skipped (untrusted or changed)
 * repo `.lexicon.yaml`, so none of them may parse it. Everything here is the
 * real core over a scratch global lexicon and repo; only the schema module is
 * wrapped, to count which files reach `parseLexicon`.
 */
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every canonical `parseLexicon` saw, so a test can tell whether the project file was parsed. */
const schemaParses = vi.hoisted(() => ({ canonicals: [] as string[] }));
vi.mock('../src/core/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/schema.js')>();
  return {
    ...real,
    parseLexicon: (raw: unknown) => {
      const terms = (raw as { terms?: unknown } | null)?.terms;
      if (Array.isArray(terms)) {
        for (const t of terms) if (typeof (t as { canonical?: unknown })?.canonical === 'string') schemaParses.canonicals.push((t as { canonical: string }).canonical);
      }
      return real.parseLexicon(raw);
    },
  };
});

import { runClipboardDaemon, runClipboardOnce } from '../src/daemon/clipboard.js';
import { runVoice } from '../src/voice/voice.js';
import type { ChildHandle, ExecResult, VoiceExec, VoiceSpawn } from '../src/voice/process.js';
import { runSetup } from '../src/cli/cmd-setup.js';
import { getHitsPath, recordHits, trustProject } from '../src/core/index.js';
import { makeIO } from './helpers.js';

/** The untrusted project file's only canonical: seeing it in `schemaParses` means the file was parsed. */
const MARKER = 'UntrustedMarker';

let tmp: string;
let globalPath: string;
let repo: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-untrusted-ambient-')));
  globalPath = path.join(tmp, 'home', '.config', 'lexicon', 'lexicon.yaml');
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.lexicon.yaml'), `version: 1\nterms:\n  - canonical: ${MARKER}\n    aliases: [Ashler, marker]\n`);
  for (const key of ['HOME', 'USERPROFILE', 'LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL']) savedEnv[key] = process.env[key];
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = path.join(tmp, 'home');
  process.env.LEXICON_PATH = globalPath;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.LEXICON_TRUST_ALL;
  schemaParses.canonicals.length = 0;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the clipboard daemon and an untrusted project lexicon', () => {
  // Catches: runClipboardOnce loaded with the default parseSkipped, parsing
  // the repo file on every run only to leave it out of the merge.
  it('--once corrects with the global terms and never parses the project file', async () => {
    const written: string[] = [];
    const out: string[] = [];
    const result = await runClipboardOnce({
      cwd: repo,
      dryRun: true,
      read: async () => 'ping Ashler',
      write: async (s) => void written.push(s),
      out: (s) => void out.push(s),
      err: () => undefined,
    });
    expect(result.changed).toBe(true);
    expect(out.join('')).toContain('Ashlr.AI');
    expect(schemaParses.canonicals).toContain('Ashlr.AI');
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });

  // Catches: --once handed recordHits only the cwd, and recordHits read and
  // parsed the untrusted project file to find which canonicals it owns.
  it('--once records the hit without parsing the project file', async () => {
    const written: string[] = [];
    const result = await runClipboardOnce({
      cwd: repo,
      quiet: true,
      read: async () => 'ping Ashler',
      write: async (s) => void written.push(s),
      out: () => undefined,
      err: () => undefined,
    });
    expect(result.written).toBe(true);
    expect(written).toEqual(['ping Ashlr.AI']);
    const hits = await waitForHits();
    expect(Object.values(hits.global ?? {})).toEqual([1]);
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });

  // Catches: the poll loop's load (and each reload) parsed the repo file.
  it('the poll loop corrects with the global terms and never parses the project file', async () => {
    const controller = new AbortController();
    const out: string[] = [];
    const done = runClipboardDaemon({
      cwd: repo,
      dryRun: true,
      quiet: false,
      intervalMs: 20,
      read: async () => 'ping Ashler',
      write: async () => undefined,
      signal: controller.signal,
      out: (s) => {
        out.push(s);
        if (s.includes('correction')) controller.abort();
      },
      err: () => undefined,
    });
    await done;
    expect(out.join('')).toContain('Ashlr.AI');
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });
});

/** A minimal WAV header and samples, as ffmpeg writes while it records. */
function wavBytes(audioBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(0xffff_ffff, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(0xffff_ffff, 40);
  return Buffer.concat([header, Buffer.alloc(audioBytes, 7)]);
}

/** Fake ffmpeg and whisper-cli over the real temp filesystem; whisper "hears" `transcript`. */
async function voiceDeps(transcript: string): Promise<{ deps: Parameters<typeof runVoice>[2]; out: string[]; err: string[] }> {
  const modelsDir = path.join(path.dirname(globalPath), 'models');
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelsDir, 'ggml-base.en.bin'), Buffer.concat([Buffer.from('lmgg'), Buffer.from('fake model')]));
  const binDir = '/fake/bin';
  const children: Array<{ pid: number; resolve: (code: number | null) => void }> = [];
  const alive = new Set<number>();
  let nextPid = 4242;
  const exec: VoiceExec = async (cmd, args): Promise<ExecResult> => {
    const base = path.basename(cmd);
    if (base === 'whisper-cli') {
      const of = args[args.indexOf('-of') + 1];
      await fs.writeFile(`${of}.json`, JSON.stringify({ transcription: [{ text: ` ${transcript}` }] }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const spawn: VoiceSpawn = (_cmd, args): ChildHandle => {
    const pid = nextPid++;
    alive.add(pid);
    const wav = args[args.length - 1];
    mkdirSync(path.dirname(wav), { recursive: true });
    writeFileSync(wav, wavBytes(1000));
    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((res) => {
      resolveExit = (code) => {
        alive.delete(pid);
        res(code);
      };
    });
    children.push({ pid, resolve: resolveExit });
    return { pid, exited, stderr: () => '' };
  };
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      exec,
      spawn,
      platform: 'darwin',
      env: { PATH: binDir },
      isAlive: (pid) => alive.has(pid),
      kill: (pid) => {
        alive.delete(pid);
        for (const c of children) if (c.pid === pid) c.resolve(255);
      },
      sleep: async () => undefined,
      exists: async (p) => p.startsWith(binDir),
      extraBinDirs: [],
      modelFallbackDirs: [],
      tmpDir: path.join(tmp, 'voice-tmp'),
      clipboardWrite: async () => undefined,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      waitForStop: async () => 'enter',
    },
  };
}

/** hits.json once the background recordHits has written it. */
async function waitForHits(): Promise<{ global?: Record<string, number>; projects?: Record<string, Record<string, number>> }> {
  const file = getHitsPath({ globalPath });
  for (let i = 0; i < 200; i++) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as { global?: Record<string, number> };
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`no ${file}`);
}

describe('recordHits without a load and an untrusted project lexicon', () => {
  // Catches: recordHits parsed the project file before asking whether it
  // was trusted, on every call made without `loaded`.
  it('checks trust before parsing, and still counts under a trusted project file', async () => {
    await recordHits(['Ashlr.AI', MARKER], { cwd: repo, globalPath });
    expect(schemaParses.canonicals).not.toContain(MARKER);
    let hits = await waitForHits();
    expect(hits.global).toEqual({ 'ashlr.ai': 1 });
    expect(hits.projects ?? {}).toEqual({});

    await trustProject(path.join(repo, '.lexicon.yaml'), { globalPath });
    schemaParses.canonicals.length = 0;
    await recordHits([MARKER], { cwd: repo, globalPath });
    expect(schemaParses.canonicals).toContain(MARKER);
    hits = await waitForHits();
    expect(Object.values(hits.projects ?? {})).toEqual([{ untrustedmarker: 1 }]);
  });
});

describe('lexicon voice and an untrusted project lexicon', () => {
  // Catches: loadMerged (the whisper prompt and the normalize) loaded with the
  // default parseSkipped and parsed the repo file it then left out.
  it('transcribes with the global terms and never parses the project file', async () => {
    const v = await voiceDeps('hello there');
    const code = await runVoice({ cwd: repo, globalPath, quiet: true, history: false }, { stdout: (s) => v.out.push(s), stderr: (s) => v.err.push(s) }, v.deps);
    expect(code, v.err.join('')).toBe(0);
    expect(v.out.join('')).toBe('hello there\n');
    expect(schemaParses.canonicals).toContain('Ashlr.AI');
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });

  // Catches: deliver's recordHits, given only the cwd, parsed the repo file.
  it('records the hit of a correction without parsing the project file', async () => {
    const v = await voiceDeps('ping Ashler');
    const code = await runVoice({ cwd: repo, globalPath, quiet: true, history: false }, { stdout: (s) => v.out.push(s), stderr: (s) => v.err.push(s) }, v.deps);
    expect(code, v.err.join('')).toBe(0);
    expect(v.out.join('')).toBe('ping Ashlr.AI\n');
    expect((await waitForHits()).global).toEqual({ 'ashlr.ai': 1 });
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });
});

describe('lexicon setup and an untrusted project lexicon', () => {
  // Catches: the packs step (installedPacks), the export step and the demo
  // step each parsed the repo file, though each reads only the merged terms
  // or the global and trusted files.
  it('--yes --app wispr never parses the project file', async () => {
    const io = makeIO();
    const exportDir = path.join(tmp, 'exports');
    const home = path.join(tmp, 'home');
    const { code, summary } = await runSetup({ cwd: repo, yes: true, clients: '', company: 'Ashlr.AI', app: 'wispr', exportDir, serve: false, harvest: false }, io, {
      platform: 'darwin',
      env: { PATH: '/fake/bin' },
      home,
      exists: (p) => p.startsWith(tmp) && existsSync(p),
      exec: (file, args) => {
        if (file === 'git' && args.join(' ') === 'config --global user.name') return 'Mason Wyatt';
        throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
      },
      isInteractive: () => false,
      installClient: async () => 0,
      installServe: async () => 0,
      harvest: async () => [],
      serveBlocker: async () => undefined,
    });
    expect(code, io.err + io.out).toBe(0);
    expect(summary.exports.map((e) => e.format)).toEqual(['wispr']);
    expect(io.out).toContain('your agent sees');
    expect(schemaParses.canonicals).not.toContain(MARKER);
  });
});
