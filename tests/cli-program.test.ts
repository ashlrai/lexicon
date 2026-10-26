/** Commander actions must forward daemon options added after the startup split. */
import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';
import type { DaemonCommandOptions } from '../src/daemon/clipboard.js';

const runDaemonCommand = vi.hoisted(() => vi.fn(async (_opts: DaemonCommandOptions) => 0));
vi.mock('../src/daemon/clipboard.js', () => ({ runDaemonCommand }));

describe('daemon command wiring', () => {
  it('forwards expander mode, a custom socket, and the project directory', async () => {
    runDaemonCommand.mockClear();
    const program = buildProgram(makeIO());
    await program.parseAsync(['node', 'lexicon', '--cwd', '/project', 'daemon', '--expander', '--socket', '/run/custom expander.sock']);
    expect(runDaemonCommand).toHaveBeenCalledTimes(1);
    expect(runDaemonCommand).toHaveBeenCalledWith(expect.objectContaining({
      expander: true,
      socketPath: '/run/custom expander.sock',
      cwd: '/project',
    }));
  });

  it('keeps the default socket when expander mode has no override', async () => {
    runDaemonCommand.mockClear();
    await buildProgram(makeIO()).parseAsync(['node', 'lexicon', 'daemon', '--expander']);
    expect(runDaemonCommand).toHaveBeenCalledTimes(1);
    const options = runDaemonCommand.mock.calls[0]?.[0];
    expect(options).toEqual(expect.objectContaining({ expander: true }));
    expect(options).not.toHaveProperty('socketPath');
  });

  it('keeps ordinary daemon calls in clipboard mode', async () => {
    runDaemonCommand.mockClear();
    await buildProgram(makeIO()).parseAsync(['node', 'lexicon', 'daemon', '--once']);
    expect(runDaemonCommand).toHaveBeenCalledWith(expect.objectContaining({ expander: false, once: true }));
  });
});
