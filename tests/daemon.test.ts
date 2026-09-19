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
  };
});

import * as core from '../src/core/index.js';
import { runClipboardDaemon } from '../src/daemon/clipboard.js';

interface Harness {
  clipboard: string;
  read: ReturnType<typeof vi.fn<() => Promise<string>>>;
  write: ReturnType<typeof vi.fn<(s: string) => Promise<void>>>;
  out: string[];
  controller: AbortController;
  done: Promise<void>;
}

function start(initial: string, opts: { dryRun?: boolean; quiet?: boolean; mirror?: boolean } = {}): Harness {
  const h: Partial<Harness> & { clipboard: string; out: string[] } = { clipboard: initial, out: [] };
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
    err: () => undefined,
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

  it('throws a clear error off macOS when no clipboard functions are injected', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      await expect(runClipboardDaemon({ quiet: true })).rejects.toThrow(/macOS/);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});
