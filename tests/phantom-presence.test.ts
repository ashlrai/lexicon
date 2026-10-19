import { describe, expect, it } from 'vitest';
import { checkPhantomPresence, inPhantomExecSession, probePhantomCli } from '../src/cli/phantom-presence.js';

type Call = { file: string; args: readonly string[] };

function recorder(impl: () => string): { exec: (f: string, a: readonly string[]) => string; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: (file, args) => {
      calls.push({ file, args });
      return impl();
    },
  };
}

const enoent = (): never => {
  throw Object.assign(new Error('spawn phantom ENOENT'), { code: 'ENOENT' });
};

const TOKEN = 'phm_tok_SECRET_MARKER_value_1234567890';

describe('phantom presence (report-only)', () => {
  it('present: reports the version as info', () => {
    const r = recorder(() => 'phantom 0.9.3\n');
    const c = checkPhantomPresence({ env: {}, exec: r.exec });
    expect(c).toEqual({ level: 'info', message: 'phantom (optional, report-only): phantom 0.9.3 on PATH' });
  });

  it('absent: ENOENT is reported as not on PATH, still info', () => {
    const c = checkPhantomPresence({ env: {}, exec: recorder(enoent).exec });
    expect(c.level).toBe('info');
    expect(c.message).toContain('phantom not on PATH');
  });

  it('version failure: a non-zero exit or unparsable output is reported without its detail', () => {
    const failing = recorder(() => {
      throw new Error(`Command failed: phantom --version: leaked ${TOKEN}`);
    });
    const c1 = checkPhantomPresence({ env: {}, exec: failing.exec });
    expect(c1.level).toBe('info');
    expect(c1.message).toContain('phantom --version failed');
    expect(c1.message).not.toContain(TOKEN);
    expect(probePhantomCli(recorder(() => 'garbage').exec)).toEqual({ state: 'error' });
  });

  it('detects a phantom exec session from markers without printing the token', () => {
    const env = { PHANTOM_PROXY_PORT: '43123', PHANTOM_PROXY_TOKEN: TOKEN };
    const c = checkPhantomPresence({ env, exec: recorder(() => 'phantom 1.0.0').exec });
    expect(c.message).toContain('running under phantom exec');
    expect(c.message).not.toContain(TOKEN);
    expect(c.message).not.toContain('43123');
    expect(inPhantomExecSession({ PHANTOM_PROXY_PORT: '43123' })).toBe(false);
    expect(inPhantomExecSession({ PHANTOM_PROXY_PORT: '99999', PHANTOM_PROXY_TOKEN: 'x' })).toBe(false);
    expect(inPhantomExecSession({})).toBe(false);
  });

  it('makes exactly one call, `phantom --version`, and never a secret-reading subcommand', () => {
    for (const impl of [() => 'phantom 1.2.3', enoent]) {
      const r = recorder(impl);
      checkPhantomPresence({ env: { PHANTOM_PROXY_PORT: '1', PHANTOM_PROXY_TOKEN: 't' }, exec: r.exec });
      expect(r.calls).toEqual([{ file: 'phantom', args: ['--version'] }]);
      for (const call of r.calls) {
        expect(call.args.join(' ')).not.toMatch(/reveal|get|export|resolve|env|exec|list|copy/);
      }
    }
  });
});

describe('lexicon doctor with the phantom check', () => {
  it('ok, ready, summary and nextStep are identical whether phantom is present, absent or failing', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { runDoctorReport } = await import('../src/cli/cmd-doctor.js');
    const home = mkdtempSync(path.join(tmpdir(), 'lex-phm-'));
    const run = (phantom: () => string) => {
      const calls: string[] = [];
      const exec = (file: string, args: readonly string[]): string => {
        calls.push(`${file} ${args.join(' ')}`);
        return file === 'phantom' ? phantom() : 'no servers';
      };
      return runDoctorReport({ cwd: home }, { home, platform: 'linux', env: { PATH: '' }, exec }).then((r) => ({ r, calls }));
    };
    const present = await run(() => 'phantom 1.0.0');
    const absent = await run(enoent);
    const failing = await run(() => {
      throw new Error('boom');
    });
    for (const { r } of [absent, failing]) {
      expect({ ok: r.ok, ready: r.ready, summary: r.summary, nextStep: r.nextStep }).toEqual({
        ok: present.r.ok,
        ready: present.r.ready,
        summary: present.r.summary,
        nextStep: present.r.nextStep,
      });
    }
    expect(present.r.checks.filter((c) => c.message.startsWith('phantom ('))).toEqual([
      { level: 'info', message: 'phantom (optional, report-only): phantom 1.0.0 on PATH' },
    ]);
    for (const { calls } of [present, absent, failing]) {
      expect(calls.filter((c) => c.startsWith('phantom'))).toEqual(['phantom --version']);
    }
  });
});
