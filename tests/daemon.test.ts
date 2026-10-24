import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lexicon, NormalizeResult } from '../src/core/types.js';

vi.mock('../src/core/index.js', async () => {
  // The shared note wording (core/notes.ts) is used as is.
  const notes = await vi.importActual<typeof import('../src/core/notes.js')>('../src/core/notes.js');
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
    ...notes,
    normalize: vi.fn(normalize),
    diffSummary: vi.fn((r: NormalizeResult) => r.replacements.map((x) => `"${x.original}" -> "${x.replacement}"`).join('\n')),
    loadLexicon: vi.fn(async () => ({ merged: lexicon, global: { path: '/g', scope: 'global', lexicon, exists: true } })),
    recordHits: vi.fn(async () => undefined),
    // The files the loop stats to see an edit: a temp file a test can change.
    resolvePaths: vi.fn(() => ({ global: watched.global })),
    getTrustPath: vi.fn(() => watched.trust),
  };
});

// Hoisted with the mock above: the paths it reports, set per test.
const watched = vi.hoisted(() => ({ global: '/nonexistent/lexicon.yaml', trust: '/nonexistent/trust.json' }));

import * as core from '../src/core/index.js';
import { main as daemonMain, runClipboardDaemon, runClipboardOnce, runDaemonCommand } from '../src/daemon/clipboard.js';
import {
  ExecError,
  createClipboardBackend,
  detectClipboardBackend,
  powershellBackend,
} from '../src/daemon/clipboard-backends.js';
import * as backends from '../src/daemon/clipboard-backends.js';
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

  // Catches: with no terms the daemon watched in silence and never said
  // nothing would be corrected.
  it('says once at start when the lexicon has no terms', async () => {
    const empty = { version: 1 as const, terms: [] };
    vi.mocked(core.loadLexicon).mockResolvedValue({ merged: empty, global: { path: '/g', scope: 'global', lexicon: empty, exists: false } });
    try {
      const out: string[] = [];
      const err: string[] = [];
      const controller = new AbortController();
      const done = runClipboardDaemon({ intervalMs: 250, read: async () => 'meet Ashley', write: async () => undefined, signal: controller.signal, out: (s) => out.push(s), err: (s) => err.push(s) });
      await vi.advanceTimersByTimeAsync(250 * 3);
      const notes = err.filter((s) => s.includes('nothing will be corrected'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/clipboard daemon: nothing will be corrected: the lexicon has no terms yet; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>\n$/);
      controller.abort();
      await done;
    } finally {
      vi.mocked(core.loadLexicon).mockReset();
      vi.mocked(core.loadLexicon).mockImplementation(async () => ({
        merged: { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] },
        global: { path: '/g', scope: 'global', lexicon: { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] }, exists: true },
      }));
    }
  });

  it('records hits for the corrected canonicals after a write, and keeps polling when that fails', async () => {
    vi.mocked(core.recordHits).mockRejectedValueOnce(new Error('disk full'));
    const h = start('meet Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledWith('meet Ashlr.AI');
    expect(core.recordHits).toHaveBeenCalledTimes(1);
    expect(core.recordHits).toHaveBeenCalledWith(['Ashlr.AI'], { cwd: '/fake/cwd', loaded: expect.objectContaining({ global: expect.objectContaining({ path: '/g' }) }) });
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

  it('a clipboard that keeps failing is reported once, then again when it recovers', async () => {
    const h = start('');
    let failing = true;
    h.read.mockImplementation(async () => {
      if (failing) throw new Error("xclip exited with code 1: Error: Can't open display: (null)");
      return h.clipboard;
    });
    await vi.advanceTimersByTimeAsync(250 * 20);
    expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/Can't open display.*retrying every 250ms/);

    failing = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(h.err).toHaveLength(2);
    expect(h.err[1]).toMatch(/working again/);

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
    // Catches: the header said only `(dry-run) 1 correction`, not that nothing was written.
    expect(report).toMatch(/\] \(dry-run\) 1 correction; the clipboard was left unchanged\n/);
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

  // Catches: a tool that handed over an image's bytes (wl-paste with no text on
  // offer) had the decoding "corrected" and written back, so the copied image
  // was replaced by mangled text.
  it('never rewrites binary clipboard content', async () => {
    const png = '\uFFFDPNG\r\n\u001a\n\u0000\u0000Ashler\uFFFD\uFFFD garbage';
    const h = start(png);
    await vi.advanceTimersByTimeAsync(0);
    expect(core.normalize).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    h.clipboard = 'meet Ashler\u0000';
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).not.toHaveBeenCalled();
    h.clipboard = 'meet Ashler';
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).toHaveBeenCalledWith('meet Ashlr.AI');
    h.controller.abort();
    await h.done;
  });

  // Catches: the guard kept the last corrected input forever, so copying the
  // same dictated text again later (after copying anything else) was never corrected.
  it('corrects the same text again once something else was copied in between', async () => {
    const h = start('meet Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
    h.clipboard = 'something else';
    await vi.advanceTimersByTimeAsync(250);
    h.clipboard = 'meet Ashler';
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenLastCalledWith('meet Ashlr.AI');
    h.controller.abort();
    await h.done;
  });

  it('a clipboard tool that puts the original back right after the write is not fought', async () => {
    const h = start('meet Ashler');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
    // A clipboard manager restores what was there before.
    h.clipboard = 'meet Ashler';
    await vi.advanceTimersByTimeAsync(250 * 4);
    expect(h.write).toHaveBeenCalledTimes(1);
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

  // Catches: an edit to the lexicon file was seen only by the next 5 s
  // reload, so a term just learned was not used on the next copy.
  it('reloads the lexicon on the next copy after a lexicon file changes', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lexicon-daemon-reload-'));
    watched.global = join(dir, 'lexicon.yaml');
    watched.trust = join(dir, 'trust.json');
    writeFileSync(watched.global, 'version: 1\nterms: []\n');
    try {
      const h = start('a Ashler');
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(core.loadLexicon).toHaveBeenCalledTimes(1));
      h.clipboard = 'b Ashler';
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(2));
      expect(core.loadLexicon).toHaveBeenCalledTimes(1);
      writeFileSync(watched.global, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
      h.clipboard = 'c Ashler';
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(core.loadLexicon).toHaveBeenCalledTimes(2));
      // A new trust.json counts too (a project file trusted from another shell).
      writeFileSync(watched.trust, '{}\n');
      h.clipboard = 'd Ashler';
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(core.loadLexicon).toHaveBeenCalledTimes(3));
      h.controller.abort();
      await h.done;
    } finally {
      watched.global = '/nonexistent/lexicon.yaml';
      watched.trust = '/nonexistent/trust.json';
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves immediately when started with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 'x');
    await runClipboardDaemon({ read, write: async () => undefined, signal: controller.signal, quiet: true });
    expect(read).not.toHaveBeenCalled();
  });

  // Catches: lastSeen was set before the write, so a write that failed once
  // (a clipboard tool that hiccuped) was never retried for that text.
  it('retries a write that failed on the next poll, and reports the failure once', async () => {
    const h = start('meet Ashler');
    h.write.mockRejectedValueOnce(new Error('wl-copy exited with code 1: compositor busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.clipboard).toBe('meet Ashler');
    expect(h.err.join('')).toContain('compositor busy');
    await vi.advanceTimersByTimeAsync(250);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.clipboard).toBe('meet Ashlr.AI');
    await vi.advanceTimersByTimeAsync(250 * 3);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.err.join('')).toMatch(/working again/);
    h.controller.abort();
    await h.done;
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
    expect(core.recordHits).toHaveBeenCalledWith(['Ashlr.AI'], { cwd: '/fake/cwd', loaded: expect.objectContaining({ global: expect.objectContaining({ path: '/g' }) }) });

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
    // Catches: `daemon --once --dry-run` printed `(dry-run) 1 correction` and never said the clipboard was left as it was.
    expect(dry.h.out.join('')).toMatch(/^\(dry-run\) 1 correction; the clipboard was left unchanged\n/);
    expect(dry.write).not.toHaveBeenCalled();
  });

  it('binary content is left as it was and said so', async () => {
    const write = vi.fn(async () => undefined);
    const out: string[] = [];
    const res = await runClipboardOnce({ read: async () => '\uFFFDPNG\r\n\u0000Ashler', write, out: (s) => out.push(s), err: () => undefined, cwd: '/fake' });
    expect(res).toEqual({ changed: false, written: false, corrections: 0, pasted: false });
    expect(write).not.toHaveBeenCalled();
    expect(core.normalize).not.toHaveBeenCalled();
    expect(out.join('')).toBe('no changes (clipboard holds binary data, not text; left as it was)\n');
  });

  it('unchanged text is not written and prints "no changes"', async () => {
    const { h, read, write, out, err } = onceHarness('nothing to fix');
    const result = await runClipboardOnce({ read, write, out, err });
    expect(write).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: false, written: false, corrections: 0, pasted: false });
    expect(h.out.join('')).toBe('no changes\n');
  });

  // Catches: with no terms every clipboard answered a bare "no changes",
  // which reads as nothing to fix, naming no way to add a term.
  it('says the lexicon has no terms, and how to add one, when it corrects nothing', async () => {
    const empty = { version: 1 as const, terms: [] };
    vi.mocked(core.loadLexicon).mockResolvedValueOnce({ merged: empty, global: { path: '/g', scope: 'global', lexicon: empty, exists: false } });
    const { h, read, write, out, err } = onceHarness('meet Ashley');
    await runClipboardOnce({ read, write, out, err });
    expect(h.out.join('')).toBe('no changes (the lexicon has no terms yet; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>)\n');

    vi.mocked(core.loadLexicon).mockResolvedValueOnce({
      merged: empty,
      global: { path: '/g', scope: 'global', lexicon: empty, exists: false },
      skippedProject: { path: '/r/.lexicon.yaml', scope: 'project', lexicon: empty, exists: true },
    });
    const skipped = onceHarness('meet Ashley');
    await runClipboardOnce({ read: skipped.read, write: skipped.write, out: skipped.out, err: skipped.err });
    expect(skipped.h.out.join('')).toBe('no changes (the project lexicon is not trusted, so its terms were not used; review it and run `lexicon trust`)\n');
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
  // Catches: a forced --backend powershell always ran (and checked for)
  // `powershell`, so with only PowerShell 7 on PATH it was refused though
  // `pwsh` runs the same scripts, which detection already falls back to.
  it.skipIf(process.platform === 'win32')('--backend powershell uses pwsh when powershell is not on PATH, and names both when neither is', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lexicon-pwsh-'));
    try {
      await writeFile(path.join(dir, 'pwsh'), '#!/bin/sh\n', { mode: 0o755 });
      const out: string[] = [];
      const err: string[] = [];
      expect(await runDaemonCommand({ which: true, backend: 'powershell', platform: 'linux', env: { PATH: dir }, paste: false, out: (s) => out.push(s), err: (s) => err.push(s) })).toBe(0);
      expect(out.join('')).toBe('clipboard backend: powershell (pwsh Get-Clipboard -Raw / Set-Clipboard (Windows))\n');
      out.length = 0;
      expect(await runDaemonCommand({ which: true, backend: 'powershell', platform: 'linux', env: { PATH: '' }, paste: false, out: (s) => out.push(s), err: (s) => err.push(s) })).toBe(1);
      expect(err.join('')).toContain('--backend powershell: powershell and pwsh not found on PATH (it ships with Windows; check your PATH, or install PowerShell 7 as pwsh)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--which prints the backend and exits 0; exits 1 with the hint when none', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const push = (s: string) => out.push(s);
    // An injected exec stands in for the tool, so no PATH check applies.
    expect(
      await runDaemonCommand({ which: true, backend: 'xclip', platform: 'linux', exec: async () => '', paste: false, out: push, err: (s) => err.push(s) }),
    ).toBe(0);
    // `paste: false` is what the CLI passes without --paste: no --paste line off macOS.
    expect(out.join('')).toBe('clipboard backend: xclip (xclip -selection clipboard -o / -i (X11))\n');

    // A forced backend whose tool is missing is refused with the install hint, not reported as usable.
    out.length = 0;
    expect(await runDaemonCommand({ which: true, backend: 'xclip', platform: 'linux', env: { PATH: '' }, out: push, err: (s) => err.push(s) })).toBe(1);
    expect(err.join('')).toContain('--backend xclip: xclip not found on PATH (install it: sudo apt install xclip)');
    expect(out).toEqual([]);
    await expect(runClipboardOnce({ backend: 'wl', platform: 'linux', env: { PATH: '' }, out: push })).rejects.toThrow(
      /wl-paste and wl-copy not found on PATH/,
    );
    err.length = 0;

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
    // Catches: the refusal named no command to run instead.
    await expect(runDaemonCommand({ paste: true, read: async () => '', write: async () => undefined })).rejects.toThrow(
      '--paste works only with --once (correct the clipboard once, then paste); run: lexicon daemon --once --paste',
    );
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

  // Catches: a clipboard with both CRLF and LF line breaks was read as all
  // LF and written back as all CRLF, changing lines no correction touched.
  it('powershell: text with mixed line breaks is passed through as it is', async () => {
    let clipboard = 'meet Ashler\r\nsecond\nthird\r\n';
    const { exec } = fakeExec(({ stdin }) => {
      if (stdin === undefined) return clipboard;
      clipboard = stdin;
      return '';
    });
    const backend = powershellBackend(exec);
    expect(await backend.read()).toBe('meet Ashler\r\nsecond\nthird\r\n');
    await backend.write('meet Ashlr.AI\r\nsecond\nthird\r\n');
    expect(clipboard).toBe('meet Ashlr.AI\r\nsecond\nthird\r\n');
  });

  // Catches: [Console]::OutputEncoding = [Text.Encoding]::UTF8 makes Windows
  // PowerShell 5.1 write a byte order mark ahead of redirected output, so the
  // read began with U+FEFF and the corrected text written back carried it.
  it('powershell: a byte order mark ahead of the clipboard text is dropped, and none is asked for', async () => {
    let written: string | undefined;
    const { exec, calls } = fakeExec(({ stdin }) => {
      if (stdin === undefined) return '\uFEFFmeet Ashler';
      written = stdin;
      return '';
    });
    const backend = powershellBackend(exec);
    expect(await backend.read()).toBe('meet Ashler');
    await backend.write('meet Ashlr.AI');
    expect(written).toBe('meet Ashlr.AI');
    for (const call of calls) {
      expect(call.args[3]).toContain('New-Object System.Text.UTF8Encoding $false');
      expect(call.args[3]).not.toContain('[Text.Encoding]::UTF8');
    }
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
      { cmd: 'wl-paste', args: ['--no-newline', '--type', 'text'] },
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

  // Catches: an unsupported platform was named with no way forward.
  it('an unsupported platform names --backend and lexicon normalize', async () => {
    await expect(detectClipboardBackend('android', {}, which('xclip'))).rejects.toThrow(
      'clipboard daemon does not support platform "android"; pass --backend <pbcopy|wl|xclip|xsel|powershell> if one of those tools works here, or pipe the text through lexicon normalize instead',
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

// ---------------------------------------------------------------------------
// A clipboard too large to correct, read through a real process

describe('a clipboard too large to correct', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  /** An exec whose reads print `size()` bytes of "Ashler " from a real node process (or `small` when size() is 0). */
  function bigExec(size: () => number, small = '') {
    const writes: string[] = [];
    const exec: ClipboardExec = async (_cmd, _args, stdin) => {
      if (stdin !== undefined) {
        writes.push(stdin);
        return '';
      }
      const n = size();
      if (n === 0) return small;
      return backends.defaultClipboardExec(process.execPath, ['-e', `process.stdout.write('Ashler '.repeat(${Math.ceil(n / 7)}))`]);
    };
    return { exec, writes };
  }

  // Catches: past 16 MB the read failed and was swallowed, so --once said
  // "clipboard is empty or not text" while 20k chars..16 MB said "too large".
  it('--once says "too large" for a clipboard over 16 MB, as it does under it, and exits cleanly', async () => {
    for (const bytes of [100_000, 17 * 1024 * 1024]) {
      const { exec, writes } = bigExec(() => bytes);
      const out: string[] = [];
      const res = await runClipboardOnce({ backend: 'xclip', exec, platform: 'linux', out: (s) => out.push(s), err: () => undefined, cwd: '/fake' });
      expect(out.join(''), String(bytes)).toBe('no changes (clipboard too large)\n');
      expect(res).toEqual({ changed: false, written: false, corrections: 0, pasted: false });
      expect(writes).toEqual([]);
    }
    expect(await runDaemonCommand({ once: true, backend: 'xclip', exec: bigExec(() => 17 * 1024 * 1024).exec, platform: 'linux', out: () => undefined, err: () => undefined, cwd: '/fake' })).toBe(0);
  }, 20_000);

  // The read stops at MAX_CLIPBOARD_READ_BYTES instead of buffering up to 16 MB on every poll.
  it('the default exec stops reading at MAX_CLIPBOARD_READ_BYTES, which still covers MAX_CLIPBOARD_CHARS of any text', async () => {
    const { MAX_CLIPBOARD_CHARS } = await import('../src/daemon/clipboard.js');
    expect(backends.MAX_CLIPBOARD_READ_BYTES).toBeGreaterThanOrEqual(3 * MAX_CLIPBOARD_CHARS);
    expect(backends.MAX_CLIPBOARD_READ_BYTES).toBeLessThan(1024 * 1024);
    const over = backends.MAX_CLIPBOARD_READ_BYTES + 10;
    await expect(backends.defaultClipboardExec(process.execPath, ['-e', `process.stdout.write('a'.repeat(${over}))`])).rejects.toMatchObject({ name: 'ClipboardTooLargeError' });
    const ok = await backends.defaultClipboardExec(process.execPath, ['-e', `process.stdout.write('a'.repeat(${backends.MAX_CLIPBOARD_READ_BYTES}))`]);
    expect(ok.length).toBe(backends.MAX_CLIPBOARD_READ_BYTES);
  });

  // Catches: a clipboard tool that never exits (`xclip -o` waiting on a
  // selection owner that does not answer) left the read unsettled forever:
  // the watcher stopped polling without a word and the child kept the
  // process alive past ctrl-C. It is now killed and reported.
  it('the default exec stops a tool that runs past its timeout, and a read reports it rather than an empty clipboard', async () => {
    expect(backends.CLIPBOARD_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
    const started = Date.now();
    await expect(backends.defaultClipboardExec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 300)).rejects.toMatchObject({
      name: 'ClipboardTimeoutError',
      message: expect.stringContaining('did not finish within 300 ms'),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A write that hangs is stopped the same way.
    await expect(backends.defaultClipboardExec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 'text', 300)).rejects.toMatchObject({ name: 'ClipboardTimeoutError' });
    const { exec } = fakeExec(({ cmd }) => new backends.ClipboardTimeoutError(cmd, 5000));
    for (const name of ['pbcopy', 'wl', 'xclip', 'xsel', 'powershell'] as const) {
      await expect(createClipboardBackend(name, exec).read()).rejects.toMatchObject({ name: 'ClipboardTimeoutError' });
    }
  }, 20_000);

  it('the loop skips a too-large clipboard without reporting an error, then corrects the next copy', async () => {
    let bytes = 17 * 1024 * 1024;
    const { exec, writes } = bigExec(() => bytes, 'meet Ashler');
    const err: string[] = [];
    const controller = new AbortController();
    const done = runClipboardDaemon({ intervalMs: 20, backend: 'xclip', exec, platform: 'linux', quiet: true, signal: controller.signal, err: (s) => err.push(s), cwd: '/fake' });
    await new Promise((r) => setTimeout(r, 400));
    expect(writes).toEqual([]);
    expect(err).toEqual([]);
    bytes = 0;
    await vi.waitFor(() => expect(writes).toEqual(['meet Ashlr.AI']), { timeout: 5_000 });
    controller.abort();
    await done;
  }, 20_000);

  it('--paste still pastes a clipboard that was too large to correct', async () => {
    const { exec } = bigExec(() => 17 * 1024 * 1024);
    const sendPaste = vi.fn(async () => undefined);
    const res = await runClipboardOnce({ backend: 'pbcopy', exec, platform: 'darwin', paste: true, sendPaste, out: () => undefined, err: () => undefined, cwd: '/fake' });
    expect(sendPaste).toHaveBeenCalledTimes(1);
    expect(res.pasted).toBe(true);
  });
});

// Catches: the standalone entry took `--cwd` with no value (cwd undefined) or
// the next flag as the directory (`--cwd --once` set cwd to "--once").
describe('standalone main --cwd', () => {
  it('refuses --cwd with no value, an empty value or a flag in its place', async () => {
    await expect(daemonMain(['--cwd'])).rejects.toThrow('--cwd expects a directory (got nothing); run: lexicon daemon --cwd <dir>');
    await expect(daemonMain(['--cwd', '--once'])).rejects.toThrow('--cwd expects a directory (got "--once")');
    await expect(daemonMain(['--cwd='])).rejects.toThrow('--cwd expects a directory (got "")');
    await expect(daemonMain(['--cwd', '  '])).rejects.toThrow('--cwd expects a directory');
  });
});
