/**
 * Value-free Phantom presence check for `lexicon doctor` (report-only).
 *
 * Detects Phantom ONLY through `phantom --version` and the env markers that
 * `phantom exec` sets for its child (PHANTOM_PROXY_PORT, PHANTOM_PROXY_TOKEN),
 * the same approach as ashlr-plugin #187. It never reads, reveals or resolves
 * a secret, never runs any other phantom subcommand, and only checks that the
 * token marker is present (its value is never read into the message). The
 * check is always `info`, so it cannot change `ok`, `ready` or the exit code.
 */
import type { DoctorCheck } from './cmd-doctor.js';

export interface PhantomPresenceProbe {
  env: NodeJS.ProcessEnv;
  /** Run a binary and return stdout; must throw on failure. */
  exec: (file: string, args: readonly string[]) => string;
}

export type PhantomCli = { state: 'present'; version: string } | { state: 'absent' } | { state: 'error' };

/** `phantom --version`, reduced to a short version token. Nothing else is run. */
export function probePhantomCli(exec: PhantomPresenceProbe['exec']): PhantomCli {
  let out: string;
  try {
    out = exec('phantom', ['--version']);
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? { state: 'absent' } : { state: 'error' };
  }
  const version = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]{1,32})?/.exec(out)?.[0];
  return version ? { state: 'present', version } : { state: 'error' };
}

/** True inside `phantom exec`: a valid proxy port and a non-empty token marker. */
export function inPhantomExecSession(env: NodeJS.ProcessEnv): boolean {
  const port = (env['PHANTOM_PROXY_PORT'] ?? '').trim();
  const valid = /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  return valid && (env['PHANTOM_PROXY_TOKEN'] ?? '').trim() !== '';
}

export function checkPhantomPresence(probe: PhantomPresenceProbe): DoctorCheck {
  const cli = probePhantomCli(probe.exec);
  const session = inPhantomExecSession(probe.env) ? '; running under phantom exec' : '';
  const cliText =
    cli.state === 'present'
      ? `phantom ${cli.version} on PATH`
      : cli.state === 'absent'
        ? 'phantom not on PATH'
        : 'phantom --version failed';
  return { level: 'info', message: `phantom (optional, report-only): ${cliText}${session}` };
}
