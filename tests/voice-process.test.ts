/**
 * The real process seam of `lexicon voice` (src/voice/process.ts): spawning
 * plain `node` children, never ffmpeg or whisper-cli. Temp directories only.
 */
import { existsSync, promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultExec, defaultIsAlive, defaultKill, defaultSpawn } from '../src/voice/process.js';
import { stopRecorder } from '../src/voice/recorder.js';

const node = process.execPath;

describe('defaultExec', () => {
  // Catches: Ctrl-C during transcription had no way to stop whisper-cli.
  it('stops the child when the signal aborts and resolves with code null', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const run = defaultExec(node, ['-e', 'setTimeout(() => {}, 20000)'], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const r = await run;
    expect(r.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('an ordinary run is untouched by a signal that never aborts', async () => {
    const r = await defaultExec(node, ['-e', 'process.stdout.write("ok")'], { signal: new AbortController().signal });
    expect(r).toMatchObject({ code: 0, stdout: 'ok' });
  });
});

describe('defaultExec timeout', () => {
  // Catches: a child killed at timeoutMs read exactly like one killed by any other signal.
  it('says timedOut when timeoutMs ran out', async () => {
    const r = await defaultExec(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 100 });
    expect(r).toMatchObject({ code: null, timedOut: true });
    const quick = await defaultExec(node, ['-e', '0'], { timeoutMs: 10_000 });
    expect(quick.timedOut).toBeUndefined();
  });
});

describe('defaultSpawn', () => {
  it('stops an attached recorder through the PID seam and retains its stderr', async () => {
    const child = defaultSpawn(node, ['-e', 'process.stderr.write("ready\\n"); setTimeout(() => {}, 20000)'], { detached: false });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error('child did not start');
      // Wait until Node is running, so SIGINT cannot race process startup.
      await vi.waitFor(() => expect(child.stderr()).toBe('ready\n'), { timeout: 5_000 });
      expect(defaultIsAlive(pid)).toBe(true);
      const stopped = await stopRecorder({ pid, isAlive: defaultIsAlive, kill: defaultKill, platform: process.platform });
      await child.exited;
      expect(stopped.killed).toBe(false);
      expect(defaultIsAlive(pid)).toBe(false);
      expect(child.stderr()).toBe('ready\n');
    } finally {
      if (child.pid !== undefined && defaultIsAlive(child.pid)) defaultKill(child.pid, 'SIGKILL');
      await child.exited;
    }
  });

  const hasProcFd = process.platform === 'linux' && existsSync('/proc/self/fd');
  // Catches: the parent kept the detached recorder's log descriptor open, one per start.
  it.skipIf(!hasProcFd)('closes its copy of a detached child\'s log descriptor, and the child still writes the log', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-voice-process-'));
    try {
      const logFile = path.join(dir, 'recorder.log');
      const openFds = (): number => readdirSync('/proc/self/fd').length;
      const before = openFds();
      const children = [];
      for (let i = 0; i < 3; i += 1) {
        children.push(defaultSpawn(node, ['-e', 'process.stderr.write("from the recorder\\n")'], { detached: true, logFile }));
      }
      for (const child of children) await child.exited;
      expect(openFds()).toBeLessThanOrEqual(before);
      expect(await fs.readFile(logFile, 'utf8')).toBe('from the recorder\n'.repeat(3));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
