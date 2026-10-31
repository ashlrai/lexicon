/** Lightweight CLI transport. No core or commander imports on the cold path. */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { xdgStateHome } from '../util/xdg.js';
import { packageVersion } from '../util/package.js';
import { isRecord } from '../util/record.js';

/** Where `lexicon daemon --expander` listens unless `--socket` says otherwise. */
export function defaultExpanderSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    let user = 'user';
    try {
      user = os.userInfo().username;
    } catch {
      // no user database entry; the pipe's ACL still limits it to this user
    }
    return `\\\\.\\pipe\\lexicon-expander-${user.replace(/[^\w.-]/g, '_')}`;
  }
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  const base = runtime && path.isAbsolute(runtime) ? runtime : xdgStateHome(env, home);
  return path.join(base, 'lexicon', 'expander.sock');
}


/** Only commands without stdin, interactive input or intentional writes. */
export function isFastRead(argv: readonly string[]): boolean {
  return ['list', 'ls', 'stats', 'path', 'export'].includes(argv[0]) &&
    !argv.some((a) => ['--help', '-h', '--version', '-V', '--out'].includes(a) || a.startsWith('--out='));
}

/** Compare only configuration that affects these handlers; never change daemon env. */
export function cliReadContext(): string {
  return JSON.stringify([packageVersion(import.meta.url), process.cwd(), os.homedir(),
    ...['LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL', 'NO_COLOR'].map((k) => process.env[k] ?? null),
    Boolean(process.stdout.isTTY)]);
}

export interface FastReadResult { stdout: string; stderr: string; code: number }

/** A missed, old, broken or busy daemon is invisible to the caller. */
export async function tryFastRead(
  argv: readonly string[],
  socketPath?: string,
  timeoutMs = 100,
): Promise<FastReadResult | undefined> {
  if (!isFastRead(argv)) return undefined;
  try {
    const target = socketPath ?? defaultExpanderSocketPath();
    const request = JSON.stringify({ op: 'cli-read', argv, context: cliReadContext() }) + '\n';
    if (request.length > 80_000) return undefined;
    return await new Promise<FastReadResult | undefined>((resolve) => {
      const socket = net.connect(target);
      let buffered = '';
      const finish = (result?: FastReadResult): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      // Total deadline, not an inactivity timeout: trickled bytes cannot hold the CLI.
      const timer = setTimeout(() => finish(), timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(request));
      socket.once('error', () => finish());
      socket.once('close', () => finish());
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.length > 8 * 1024 * 1024) return finish();
        const nl = buffered.indexOf('\n');
        if (nl < 0) return;
        try {
          const v: unknown = JSON.parse(buffered.slice(0, nl));
          if (isRecord(v) && v.ok === true && typeof v.stdout === 'string' && typeof v.stderr === 'string' &&
              Number.isInteger(v.code) && Number(v.code) >= 0 && Number(v.code) <= 255) {
            finish({ stdout: v.stdout, stderr: v.stderr, code: Number(v.code) });
          } else finish();
        } catch { finish(); }
      });
    });
  } catch { return undefined; }
}
