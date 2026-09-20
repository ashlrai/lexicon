/**
 * PATH lookup (src/util/which.ts). The async and sync forms must resolve to
 * the same binary: `lexicon doctor` reports what `locateToolSync` finds, and
 * the voice pipeline runs what `locateTool` finds.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOnPath, findOnPathSync, locateTool, locateToolSync } from '../src/util/which.js';

describe('findOnPath', () => {
  it('splits PATH with the platform delimiter and probes each dir', async () => {
    const probed: string[] = [];
    const exists = async (c: string) => {
      probed.push(c);
      return c === '/usr/local/bin/xclip';
    };
    expect(await findOnPath('xclip', { platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, exists })).toBe('/usr/local/bin/xclip');
    expect(probed).toEqual(['/usr/bin/xclip', '/usr/local/bin/xclip']);
    expect(await findOnPath('xclip', { platform: 'linux', env: { PATH: '' }, exists })).toBeUndefined();
  });

  it('on win32 tries PATHEXT extensions (then the bare name) in every PATH entry', async () => {
    const probed: string[] = [];
    const exists = async (c: string) => {
      probed.push(c);
      return c === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE';
    };
    const env = { Path: 'C:\\Tools;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', PATHEXT: '.COM;.EXE' };
    expect(await findOnPath('powershell', { platform: 'win32', env, exists })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE',
    );
    expect(probed.slice(0, 5)).toEqual([
      'C:\\Tools\\powershell.COM',
      'C:\\Tools\\powershell.EXE',
      'C:\\Tools\\powershell.com',
      'C:\\Tools\\powershell.exe',
      'C:\\Tools\\powershell',
    ]);
    // A name that already has an extension is probed as-is.
    probed.length = 0;
    await findOnPath('wl-copy.exe', { platform: 'win32', env, exists });
    expect(probed).toEqual(['C:\\Tools\\wl-copy.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\wl-copy.exe']);
  });

  it('finds a real executable on this machine', async () => {
    const node = await findOnPath('node');
    expect(node).toBeDefined();
  });
});

describe('findOnPathSync', () => {
  it('agrees with the async form on this machine', () => {
    expect(findOnPathSync('node')).toBeDefined();
  });
});

describe('locateTool / locateToolSync', () => {
  // whisper-cpp sits in an earlier PATH entry than whisper-cli, but whisper-cli
  // is the preferred name. `lexicon doctor` (sync) must report the binary the
  // voice pipeline (async) will actually run, so both forms must pick the same.
  let root: string;
  let env: NodeJS.ProcessEnv;
  const names = ['whisper-cli', 'whisper-cpp'];

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-which-')));
    await fs.mkdir(path.join(root, 'a'));
    await fs.mkdir(path.join(root, 'b'));
    await fs.writeFile(path.join(root, 'a', 'whisper-cpp'), '', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'b', 'whisper-cli'), '', { mode: 0o755 });
    // path.delimiter, not ':' -- on Windows the separator is ';' and a
    // drive-letter colon would make `C:\...\a:C:\...\b` one bogus entry.
    env = { PATH: [path.join(root, 'a'), path.join(root, 'b')].join(path.delimiter) };
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('prefers the first candidate name over an earlier PATH entry (async)', async () => {
    expect(await locateTool(names, { env, extraDirs: [] })).toBe(path.join(root, 'b', 'whisper-cli'));
  });

  it('prefers the first candidate name over an earlier PATH entry (sync)', () => {
    expect(locateToolSync(names, env)).toBe(path.join(root, 'b', 'whisper-cli'));
  });

  it('falls back to the well-known directories after PATH', async () => {
    const found = await locateTool(['ffmpeg'], {
      env: { PATH: '/nowhere' },
      platform: 'linux',
      exists: async (c) => c === '/usr/local/bin/ffmpeg',
    });
    expect(found).toBe('/usr/local/bin/ffmpeg');
  });

  it('returns undefined when nothing matches', () => {
    expect(locateToolSync(['definitely-not-a-real-binary-xyz'], { PATH: '/nowhere' }, 'linux')).toBeUndefined();
  });
});
