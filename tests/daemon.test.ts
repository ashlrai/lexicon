import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lexicon, NormalizeResult } from '../src/core/types.js';

vi.mock('../src/core/index.js', () => {
  const lexicon: Lexicon = { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] };
  const normalize = (text: string): NormalizeResult => {
    const output = text.replace(/Ashler/g, 'Ashlr.AI');
    const idx = text.indexOf('Ashler');
    return {
      input: text,
      output,
      changed: output !== text,
      replacements:
        idx === -1
          ? []
          : [{ start: idx, end: idx + 6, original: 'Ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 }],
    };
  };
  return {
    normalize: vi.fn(normalize),
    diffSummary: vi.fn((r: NormalizeResult) => r.replacements.map((x) => `"${x.original}" -> "${x.replacement}"`).join('\n')),
    loadLexicon: vi.fn(async () => ({ merged: lexicon, global: { path: '/g', scope: 'global', lexicon, exists: true } })),
    recordHits: vi.fn(async () => undefined),
  };
});

import * as core from '../src/core/index.js';
import { runClipboardDaemon, runClipboardOnce, runDaemonCommand } from '../src/daemon/clipboard.js';
import {
  ExecError,
  createClipboardBackend,
  detectClipboardBackend,
  powershellBackend,
} from '../src/daemon/clipboard-backends.js';
import type { ClipboardExec } from '../src/daemon/clipboard-backends.js';

interface Harness {
  clipboard: string;
  read: ReturnType<typeof vi.fn<() => Promise<string>>>;
  write: ReturnType<typeof vi.fn<(s: string) => Promise<void>>>;
  out: string[];
  err: string[];
  controller: AbortController;
  done: Promise<void>;
}

function start(initial: string, opts: { dryRun?: boolean; quiet?: boolean; mirror?: boolean } = {}): Harness {
  const h: Partial<Harness> & { clipboard: string; out: string[]; err: string[] } = { clipboard: initial, out: [], err: [] };
  h.read = vi.fn(async () => h.clipboard);
  h.write = vi.fn(async (s: string) => {
    // A real clipboard would now hold what we wrote; `mirror:false` simulates a laggy pbpaste.
    if (opts.mirror !== false) h.clipboard = s;
  });
  h.controller = new AbortController();
  h.done = runClipboardDaemon({
    intervalMs: 250,
    dryRun: opts.dryRun ?? false,
    quiet: opts.quiet ?? true,
    read: h.read,
    write: h.write,
    signal: h.controller.signal,
    out: (s) => h.out.push(s),
    err: (s) => h.err.push(s),
    cwd: '/fake/cwd',
  });
  return h as Harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runClipboardDaemon', () => {
  it('corrects a new clipboard value and writes it back once', async () => {
    const h = start('meet Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith('meet Ashlr.AI');

    // Subsequent polls see our own output (and the original input) and do nothing.
    await vi.advanceTimersByTimeAsync(250 * 3);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(3);

    h.controller.abort();
    await h.done;
  });

  it('records hits for the corrected canonicals after a write, and keeps polling when that fails', async () => {
    vi.mocked(core.recordHits).mockRejectedValueOnce(new Error('disk full'));
    const h = start('meet Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledWith('meet Ashlr.AI');
    expect(core.recordHits).toHaveBeenCalledTimes(1);
    expect(core.recordHits).toHaveBeenCalledWith(['Ashlr.AI'], { cwd: '/fake/cwd' });
    expect(h.err.join('')).toContain('recordHits: disk full');

    // The loop is alive: a second correction is written and counted again.
    h.clipboard = 'call Ashler now';
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(core.recordHits).toHaveBeenCalledTimes(2);
    expect(h.err).toHaveLength(1);

    h.controller.abort();
    await h.done;
  });

  it('dryRun never records hits', async () => {
    const h = start('meet Ashler', { dryRun: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).not.toHaveBeenCalled();
    expect(core.recordHits).not.toHaveBeenCalled();
    h.controller.abort();
    await h.done;
  });

  it('loop guard: the same text read again (laggy clipboard) is not written twice', async () => {
    const h = start('meet Ashler', { mirror: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250 * 4);
    expect(h.write).toHaveBeenCalledTimes(1);

    // A genuinely new value is processed.
    h.clipboard = 'call Ashler now';
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenLastCalledWith('call Ashlr.AI now');

    h.controller.abort();
    await h.done;
  });

  it('dryRun reports but never writes', async () => {
    const h = start('meet Ashler', { dryRun: true, quiet: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).not.toHaveBeenCalled();
    const report = h.out.join('');
    expect(report).toContain('(dry-run)');
    expect(report).toContain('"Ashler" -> "Ashlr.AI"');
    expect(report).toMatch(/\[\d\d:\d\d:\d\d\]/);

    h.controller.abort();
    await h.done;
  });

  it('ignores unchanged, letterless and oversized clipboard contents', async () => {
    const h = start('12345 --- 678');
    await vi.advanceTimersByTimeAsync(0);
    expect(core.normalize).not.toHaveBeenCalled();

    h.clipboard = 'Ashler '.repeat(4000); // > 20000 chars
    await vi.advanceTimersByTimeAsync(250);
    expect(core.normalize).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();

    h.clipboard = 'nothing to fix here';
    await vi.advanceTimersByTimeAsync(250);
    expect(core.normalize).toHaveBeenCalledTimes(1);
    expect(h.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(core.normalize).toHaveBeenCalledTimes(1); // unchanged value not re-normalized

    h.controller.abort();
    await h.done;
  });

  it('reloads the lexicon at most every 5s and stops when the signal aborts', async () => {
    const h = start('a Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(core.loadLexicon).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 10; i += 1) {
      h.clipboard = `v${i} Ashler`;
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(core.loadLexicon).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    h.clipboard = 'late Ashler';
    await vi.advanceTimersByTimeAsync(250);
    expect(core.loadLexicon).toHaveBeenCalledTimes(2);

    h.controller.abort();
    await expect(h.done).resolves.toBeUndefined();
    const reads = h.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.read.mock.calls.length).toBe(reads); // timer cleared
  });

  it('resolves immediately when started with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 'x');
    await runClipboardDaemon({ read, write: async () => undefined, signal: controller.signal, quiet: true });
    expect(read).not.toHaveBeenCalled();
  });

  it('throws with an install hint on Linux when no clipboard tool is on PATH', async () => {
    await expect(runClipboardDaemon({ quiet: true, platform: 'linux', env: { PATH: '' } })).rejects.toThrow(/wl-clipboard.*xclip/);
  });

  it('completes a single injected read function from the detected backend', async () => {
    const calls: { cmd: string; args: string[]; stdin?: string }[] = [];
    const exec: ClipboardExec = async (cmd, args, stdin) => {
      calls.push({ cmd, args: [...args], stdin });
      return '';
    };
    const controller = new AbortController();
    const read = vi.fn(async () => 'meet Ashler');
    const done = runClipboardDaemon({ read, exec, backend: 'pbcopy', quiet: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ cmd: 'pbcopy', args: [], stdin: 'meet Ashlr.AI' }]);
    controller.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------
// Once mode

function onceHarness(initial: string) {
  const h = { clipboard: initial, out: [] as string[], err: [] as string[] };
  const read = vi.fn(async () => h.clipboard);
  const write = vi.fn(async (s: string) => {
    h.clipboard = s;
  });
  return { h, read, write, out: (s: string) => h.out.push(s), err: (s: string) => h.err.push(s) };
}

describe('runClipboardOnce', () => {
  it('changed text is written back once and summarized', async () => {
    const { h, read, write, out, err } = onceHarness('meet Ashler');
    const result = await runClipboardOnce({ read, write, out, err });
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('meet Ashlr.AI');
    expect(h.clipboard).toBe('meet Ashlr.AI');
    expect(result).toEqual({ changed: true, written: true, corrections: 1, pasted: false });
    const report = h.out.join('');
    expect(report).toMatch(/^1 correction\n/);
    expect(report).toContain('"Ashler" -> "Ashlr.AI"');
    expect(report).not.toMatch(/\[\d\d:\d\d:\d\d\]/);
  });

  it('records hits after the write; a failing recordHits is reported on err without changing the result', async () => {
    const ok = onceHarness('meet Ashler');
    await runClipboardOnce({ read: ok.read, write: ok.write, out: ok.out, err: ok.err, cwd: '/fake/cwd' });
    expect(core.recordHits).toHaveBeenCalledWith(['Ashlr.AI'], { cwd: '/fake/cwd' });

    vi.mocked(core.recordHits).mockRejectedValueOnce(new Error('disk full'));
    const { h, read, write, out, err } = onceHarness('meet Ashler');
    const result = await runClipboardOnce({ read, write, out, err, cwd: '/fake/cwd' });
    expect(result).toEqual({ changed: true, written: true, corrections: 1, pasted: false });
    expect(h.out.join('')).toMatch(/^1 correction\n/);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.err.join('')).toContain('recordHits: disk full');

    const dry = onceHarness('meet Ashler');
    vi.mocked(core.recordHits).mockClear();
    await runClipboardOnce({ read: dry.read, write: dry.write, out: dry.out, err: dry.err, dryRun: true });
    expect(core.recordHits).not.toHaveBeenCalled();
  });

  it('unchanged text is not written and prints "no changes"', async () => {
    const { h, read, write, out, err } = onceHarness('nothing to fix');
    const result = await runClipboardOnce({ read, write, out, err });
    expect(write).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: false, written: false, corrections: 0, pasted: false });
    expect(h.out.join('')).toBe('no changes\n');
  });

  it('empty clipboard prints no changes and never normalizes', async () => {
    const { h, read, write, out, err } = onceHarness('');
    await runClipboardOnce({ read, write, out, err });
    expect(core.normalize).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(h.out.join('')).toContain('no changes (clipboard is empty');
  });

  it('dryRun reports without writing', async () => {
    const { h, read, write, out, err } = onceHarness('meet Ashler');
    const result = await runClipboardOnce({ read, write, out, err, dryRun: true });
    expect(write).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.written).toBe(false);
    expect(h.out.join('')).toMatch(/^\(dry-run\) 1 correction/);
  });

  it('--paste sends the keystroke on darwin (even when unchanged) and reports failure with the Accessibility hint', async () => {
    const { read, write, out, err } = onceHarness('nothing to fix');
    const sendPaste = vi.fn(async () => undefined);
    const result = await runClipboardOnce({ read, write, out, err, paste: true, platform: 'darwin', sendPaste });
    expect(sendPaste).toHaveBeenCalledTimes(1);
    expect(result.pasted).toBe(true);

    const failing = vi.fn(async () => {
      throw new ExecError('osascript', 1, 'osascript is not allowed to send keystrokes (1002)');
    });
    await expect(runClipboardOnce({ read, write, out, err, paste: true, platform: 'darwin', sendPaste: failing })).rejects.toThrow(
      /Accessibility/,
    );
  });

  it('--paste uses osascript through exec by default', async () => {
    const { read, write, out, err } = onceHarness('meet Ashler');
    const exec = vi.fn<ClipboardExec>(async () => '');
    await runClipboardOnce({ read, write, out, err, paste: true, platform: 'darwin', exec });
    expect(exec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  });

  it('--paste off macOS is skipped with a message, exit stays clean', async () => {
    const { h, read, write, out, err } = onceHarness('meet Ashler');
    const sendPaste = vi.fn(async () => undefined);
    const result = await runClipboardOnce({ read, write, out, err, paste: true, platform: 'linux', sendPaste });
    expect(sendPaste).not.toHaveBeenCalled();
    expect(result.pasted).toBe(false);
    expect(result.written).toBe(true);
    expect(h.err.join('')).toMatch(/macOS-only/);
  });
});

describe('runDaemonCommand', () => {
  it('--which prints the backend and exits 0; exits 1 with the hint when none', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const push = (s: string) => out.push(s);
    expect(await runDaemonCommand({ which: true, backend: 'xclip', platform: 'linux', out: push, err: (s) => err.push(s) })).toBe(0);
    expect(out.join('')).toBe('clipboard backend: xclip (xclip -selection clipboard -o / -i (X11))\n');

    out.length = 0;
    expect(await runDaemonCommand({ which: true, platform: 'linux', env: { PATH: '' }, out: push, err: (s) => err.push(s) })).toBe(1);
    expect(err.join('')).toMatch(/no clipboard backend: .*wl-clipboard/);
  });

  it('--once dispatches to once mode and returns 0', async () => {
    const { h, read, write, out, err } = onceHarness('meet Ashler');
    expect(await runDaemonCommand({ once: true, read, write, out, err })).toBe(0);
    expect(h.clipboard).toBe('meet Ashlr.AI');
  });

  it('--paste without --once is rejected', async () => {
    await expect(runDaemonCommand({ paste: true, read: async () => '', write: async () => undefined })).rejects.toThrow(/--once/);
  });
});

// ---------------------------------------------------------------------------
// Backends (never spawn: every backend takes an injected exec)

interface Call {
  cmd: string;
  args: readonly string[];
  stdin?: string;
}

function fakeExec(reply: (call: Call) => string | Error): { exec: ClipboardExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ClipboardExec = async (cmd, args, stdin) => {
    const call: Call = stdin === undefined ? { cmd, args } : { cmd, args, stdin };
    calls.push(call);
    const r = reply(call);
    if (r instanceof Error) throw r;
    return r;
  };
  return { exec, calls };
}

describe('clipboard backends', () => {
  it('powershell: CRLF is normalized on read and restored on write; LF stays LF', async () => {
    let clipboard = 'meet Ashler\r\nsecond line\r\n';
    const { exec, calls } = fakeExec(({ cmd, args, stdin }) => {
      expect(cmd).toBe('powershell');
      expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
      if (stdin === undefined) {
        expect(args[3]).toContain('Get-Clipboard -Raw');
        return clipboard;
      }
      expect(args[3]).toContain('Set-Clipboard');
      clipboard = stdin;
      return '';
    });
    const backend = powershellBackend(exec);
    expect(await backend.read()).toBe('meet Ashler\nsecond line\n');
    await backend.write('meet Ashlr.AI\nsecond line\n');
    expect(clipboard).toBe('meet Ashlr.AI\r\nsecond line\r\n');
    expect(calls).toHaveLength(2);

    clipboard = 'plain\nlf';
    expect(await backend.read()).toBe('plain\nlf');
    await backend.write('plain\nLF');
    expect(clipboard).toBe('plain\nLF');
  });

  it('every backend returns "" when the tool exits non-zero (empty / non-text clipboard)', async () => {
    const { exec } = fakeExec(({ cmd }) => new ExecError(cmd, 1, 'Nothing is copied'));
    for (const name of ['pbcopy', 'wl', 'xclip', 'xsel', 'powershell'] as const) {
      expect(await createClipboardBackend(name, exec).read()).toBe('');
    }
  });

  it('a missing binary or a display problem is not swallowed', async () => {
    const enoent = Object.assign(new Error('spawn xclip ENOENT'), { code: 'ENOENT' });
    const { exec } = fakeExec(() => enoent);
    await expect(createClipboardBackend('xclip', exec).read()).rejects.toThrow(/ENOENT/);
    const { exec: noDisplay } = fakeExec(() => new ExecError('xclip', 1, "Error: Can't open display: (null)"));
    await expect(createClipboardBackend('xclip', noDisplay).read()).rejects.toThrow(/display/);
  });

  it('uses the documented commands', async () => {
    const { exec, calls } = fakeExec(() => 'x');
    await createClipboardBackend('pbcopy', exec).read();
    await createClipboardBackend('pbcopy', exec).write('a');
    await createClipboardBackend('wl', exec).read();
    await createClipboardBackend('wl', exec).write('b');
    await createClipboardBackend('xclip', exec).read();
    await createClipboardBackend('xclip', exec).write('c');
    await createClipboardBackend('xsel', exec).read();
    await createClipboardBackend('xsel', exec).write('d');
    expect(calls).toEqual([
      { cmd: 'pbpaste', args: [] },
      { cmd: 'pbcopy', args: [], stdin: 'a' },
      { cmd: 'wl-paste', args: ['--no-newline'] },
      { cmd: 'wl-copy', args: [], stdin: 'b' },
      { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      { cmd: 'xclip', args: ['-selection', 'clipboard', '-i'], stdin: 'c' },
      { cmd: 'xsel', args: ['--clipboard', '--output'] },
      { cmd: 'xsel', args: ['--clipboard', '--input'], stdin: 'd' },
    ]);
  });
});

describe('detectClipboardBackend', () => {
  const which = (...available: string[]) => async (bin: string) => available.includes(bin);

  it('darwin -> pbcopy', async () => {
    expect((await detectClipboardBackend('darwin', {}, which('pbpaste', 'pbcopy'))).name).toBe('pbcopy');
    await expect(detectClipboardBackend('darwin', {}, which())).rejects.toThrow(/pbpaste/);
  });

  it('linux + WAYLAND_DISPLAY + wl-paste/wl-copy -> wl', async () => {
    expect((await detectClipboardBackend('linux', { WAYLAND_DISPLAY: 'wayland-0' }, which('wl-paste', 'wl-copy', 'xclip'))).name).toBe('wl');
  });

  it('linux with WAYLAND_DISPLAY but no wl-clipboard, or no WAYLAND_DISPLAY -> xclip', async () => {
    expect((await detectClipboardBackend('linux', { WAYLAND_DISPLAY: 'wayland-0' }, which('xclip'))).name).toBe('xclip');
    expect((await detectClipboardBackend('linux', { DISPLAY: ':0' }, which('wl-paste', 'wl-copy', 'xclip'))).name).toBe('xclip');
  });

  it('linux xsel as last resort', async () => {
    expect((await detectClipboardBackend('linux', {}, which('xsel'))).name).toBe('xsel');
  });

  it('linux none -> error with install hint', async () => {
    await expect(detectClipboardBackend('linux', { DISPLAY: ':0' }, which())).rejects.toThrow(
      /X11 session.*sudo apt install wl-clipboard.*sudo apt install xclip/,
    );
  });

  it('win32 -> powershell (pwsh fallback)', async () => {
    const ps = await detectClipboardBackend('win32', {}, which('powershell'));
    expect(ps.name).toBe('powershell');
    expect(ps.description).toMatch(/^powershell /);
    const pwsh = await detectClipboardBackend('win32', {}, which('pwsh'));
    expect(pwsh.description).toMatch(/^pwsh /);
    await expect(detectClipboardBackend('win32', {}, which())).rejects.toThrow(/powershell/);
  });

  it('unknown platform -> error', async () => {
    await expect(detectClipboardBackend('haiku' as NodeJS.Platform, {}, which())).rejects.toThrow(/does not support/);
  });
});
