/**
 * The real process seam of `lexicon voice` (src/voice/process.ts): spawning
 * plain `node` children, never ffmpeg or whisper-cli. Temp directories only.
 */
import { describe, expect, it } from 'vitest';
import { defaultExec } from '../src/voice/process.js';

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
