/**
 * `lexicon serve`: run the local HTTP API (src/serve/server.ts), show its URL
 * and token, check whether it is up, or install it as a login service
 * (launchd on macOS, a systemd user unit on Linux; instructions on Windows).
 * Handlers are exported for tests; registerServeCommands() only wires commander.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { createServer, DEFAULT_HOST, DEFAULT_PORT, ensureServeConfig, getServePath, isLoopbackHost, serveUrl } from '../serve/index.js';
import { safe, safeLines } from './commands.js';
import type { CommonOptions, IO } from './commands.js';

export const LAUNCH_AGENT_LABEL = 'ai.ashlr.lexicon.serve';
export const SYSTEMD_UNIT_NAME = 'lexicon-serve.service';
/** How long `--status` waits for /health. */
export const STATUS_TIMEOUT_MS = 1_500;

export interface ServeOptions extends CommonOptions {
  /** Port to bind (default 41733; 0 picks a free port). */
  port?: number;
  /** Interface to bind; anything but loopback prints a warning. */
  host?: string;
  json?: boolean;
  quiet?: boolean;
  /** Print the URL and token instead of serving. */
  show?: boolean;
  /** GET /health and report up/down instead of serving. */
  status?: boolean;
  /** Install as a login service. */
  install?: boolean;
  /** Remove the login service. */
  uninstall?: boolean;
  /** Test hook: explicit global lexicon path (serve.json lives next to it). */
  globalPath?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ServeExec = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

export interface ServeDeps {
  platform?: NodeJS.Platform;
  /** Home directory (LaunchAgents / Logs / .config live under it). Default os.homedir(). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs launchctl / systemctl. Injectable for tests. */
  exec?: ServeExec;
  /** Absolute path of the built CLI (dist/cli/index.js). Default: next to this module. */
  cliPath?: string;
  /** Node binary used by the service. Default process.execPath. */
  nodePath?: string;
  /** Numeric uid for `launchctl bootstrap gui/<uid>`. Default process.getuid(). */
  uid?: number;
  /** HTTP client for `--status`. Default global fetch. */
  fetch?: typeof fetch;
  /** Stops the server (in addition to SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Called once the server is listening (tests). */
  onListening?: (info: { port: number; url: string; token: string }) => void;
}

function line(io: IO, s = ''): void {
  io.stdout(`${s}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function red(s: string, env: NodeJS.ProcessEnv): string {
  return process.stderr.isTTY && !env.NO_COLOR ? `\x1b[31m${s}\x1b[0m` : s;
}

/** `~/.config/lexicon/serve.json` when the path sits under the home directory. */
function tildify(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : p;
}

function storeOpts(opts: ServeOptions): { globalPath?: string } {
  return opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {};
}

/** Default process runner: no shell, collects stdout/stderr. */
export const defaultServeExec: ServeExec = (cmd, args) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: errorMessage(err) });
      return;
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

function defaultCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
}

// ---------------------------------------------------------------------------
// --show / --status
// ---------------------------------------------------------------------------

export async function runServeShow(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const home = deps.home ?? os.homedir();
  const config = await ensureServeConfig(storeOpts(opts));
  const port = opts.port ?? config.port;
  const url = serveUrl(port, opts.host ?? DEFAULT_HOST);
  const configPath = getServePath(storeOpts(opts));
  if (opts.json) {
    line(io, JSON.stringify({ url, port, token: config.token, configPath }, null, 2));
    return 0;
  }
  line(io, `url:    ${url}`);
  line(io, `token:  ${config.token}`);
  line(io, `config: ${safe(tildify(configPath, home))}`);
  return 0;
}

export async function runServeStatus(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const config = await ensureServeConfig(storeOpts(opts));
  const port = opts.port ?? config.port;
  const url = serveUrl(port, opts.host ?? DEFAULT_HOST);
  const doFetch = deps.fetch ?? fetch;
  let health: { ok?: unknown; version?: unknown; terms?: unknown } | undefined;
  let reason = '';
  try {
    const res = await doFetch(`${url}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) reason = `HTTP ${res.status}`;
    else health = (await res.json()) as typeof health;
  } catch (err) {
    reason = errorMessage(err);
  }
  const up = health?.ok === true;
  if (opts.json) {
    line(io, JSON.stringify({ up, url, ...(up ? { health } : { reason }) }, null, 2));
    return up ? 0 : 1;
  }
  if (up) {
    const version = typeof health?.version === 'string' ? health.version : '?';
    const terms = typeof health?.terms === 'number' ? health.terms : 0;
    line(io, `lexicon serve is up at ${url} (version ${safe(version)}, ${terms} term${terms === 1 ? '' : 's'})`);
    return 0;
  }
  line(io, `lexicon serve is down at ${url}${reason ? ` (${safe(reason)})` : ''}`);
  line(io, 'start it with: lexicon serve      (or install it: lexicon serve --install)');
  return 1;
}

// ---------------------------------------------------------------------------
// --install / --uninstall
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The launchd LaunchAgent: RunAtLoad + KeepAlive, stdout/stderr to `logPath`. */
export function launchAgentPlist(nodePath: string, cliPath: string, logPath: string): string {
  const args = [nodePath, cliPath, 'serve'].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function unitQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The systemd user unit. */
export function systemdUnit(nodePath: string, cliPath: string): string {
  return [
    '[Unit]',
    'Description=lexicon serve (local HTTP API for @ashlr/lexicon)',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} serve`,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function launchAgentPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function launchAgentLogPath(home: string): string {
  return path.join(home, 'Library', 'Logs', 'lexicon', 'serve.log');
}

export function systemdUnitPath(home: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

async function runAndReport(exec: ServeExec, io: IO, cmd: string, args: readonly string[]): Promise<ExecResult> {
  line(io, `ran: ${[cmd, ...args].map((a) => safe(a)).join(' ')}`);
  const result = await exec(cmd, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    io.stderr(`  exit ${result.code ?? 'error'}${detail ? `: ${safeLines(detail)}` : ''}\n`);
  }
  return result;
}

export async function runServeInstall(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultServeExec;
  const nodePath = deps.nodePath ?? process.execPath;
  const cliPath = deps.cliPath ?? defaultCliPath();
  // Make sure the token exists before the service starts, so `--show` right after works.
  await ensureServeConfig(storeOpts(opts));

  if (platform === 'darwin') {
    const plistPath = launchAgentPath(home);
    const logPath = launchAgentLogPath(home);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(plistPath, launchAgentPlist(nodePath, cliPath, logPath), 'utf8');
    line(io, `wrote ${safe(plistPath)}`);
    line(io, `  ProgramArguments: ${safe(nodePath)} ${safe(cliPath)} serve`);
    line(io, `  RunAtLoad + KeepAlive, logs in ${safe(logPath)}`);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    // A previous install must be booted out before bootstrap accepts the new plist.
    await exec('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    const bootstrap = await runAndReport(exec, io, 'launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    if (bootstrap.code !== 0) {
      const load = await runAndReport(exec, io, 'launchctl', ['load', plistPath]);
      if (load.code !== 0) {
        io.stderr('lexicon: could not load the LaunchAgent; the plist is in place, load it manually or log out and in\n');
        return 1;
      }
    }
    line(io, `installed ${LAUNCH_AGENT_LABEL}; check with: lexicon serve --status`);
    return 0;
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(home, env);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(unitPath, systemdUnit(nodePath, cliPath), 'utf8');
    line(io, `wrote ${safe(unitPath)}`);
    line(io, `  ExecStart: ${safe(nodePath)} ${safe(cliPath)} serve`);
    await runAndReport(exec, io, 'systemctl', ['--user', 'daemon-reload']);
    const enable = await runAndReport(exec, io, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      io.stderr('lexicon: could not enable the unit; the file is in place, run `systemctl --user enable --now lexicon-serve.service` manually\n');
      return 1;
    }
    line(io, `installed ${SYSTEMD_UNIT_NAME}; check with: lexicon serve --status`);
    return 0;
  }

  if (platform === 'win32') {
    line(io, 'lexicon serve --install is not automated on Windows. Create a Scheduled Task that runs at logon:');
    line(io);
    line(io, `  schtasks /Create /SC ONLOGON /TN "lexicon serve" /TR "\\"${nodePath}\\" \\"${cliPath}\\" serve"`);
    line(io);
    line(io, 'or use Task Scheduler: trigger "At log on", action "Start a program" with');
    line(io, `  program:   ${safe(nodePath)}`);
    line(io, `  arguments: "${safe(cliPath)}" serve`);
    line(io, 'Nothing was written.');
    return 0;
  }

  io.stderr(`lexicon: serve --install is not supported on ${platform}; run \`lexicon serve\` from your session startup instead\n`);
  return 1;
}

export async function runServeUninstall(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultServeExec;
  void opts;

  if (platform === 'darwin') {
    const plistPath = launchAgentPath(home);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    const bootout = await runAndReport(exec, io, 'launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    if (bootout.code !== 0) await runAndReport(exec, io, 'launchctl', ['unload', plistPath]);
    try {
      await fs.unlink(plistPath);
      line(io, `removed ${safe(plistPath)}`);
    } catch {
      line(io, `${safe(plistPath)} was not installed`);
    }
    return 0;
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(home, env);
    await runAndReport(exec, io, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
    try {
      await fs.unlink(unitPath);
      line(io, `removed ${safe(unitPath)}`);
    } catch {
      line(io, `${safe(unitPath)} was not installed`);
    }
    await runAndReport(exec, io, 'systemctl', ['--user', 'daemon-reload']);
    return 0;
  }

  if (platform === 'win32') {
    line(io, 'remove the Scheduled Task with:  schtasks /Delete /TN "lexicon serve" /F');
    return 0;
  }

  io.stderr(`lexicon: serve --uninstall is not supported on ${platform}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// serve (the default)
// ---------------------------------------------------------------------------

export async function runServeForeground(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const host = opts.host ?? DEFAULT_HOST;
  if (opts.host !== undefined && !isLoopbackHost(opts.host)) {
    io.stderr(
      `${red('warning:', env)} binding to ${safe(opts.host)} exposes the lexicon API to the network; anyone with the token can read and change your lexicon\n`,
    );
  }
  const server = createServer({
    host,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.cwd !== undefined ? { cwd: path.resolve(opts.cwd) } : {}),
    ...storeOpts(opts),
    quiet: opts.quiet ?? false,
    log: (l) => io.stderr(`${l}\n`),
  });

  let info;
  try {
    info = await server.start();
  } catch (err) {
    io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
    return 1;
  }
  if (opts.json) {
    line(io, JSON.stringify({ url: info.url, port: info.port, host: info.host, token: info.token, configPath: info.configPath }));
  } else {
    line(io, `lexicon serve listening on ${info.url} (token in ${safe(tildify(info.configPath, home))})`);
  }
  deps.onListening?.({ port: info.port, url: info.url, token: info.token });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      deps.signal?.removeEventListener('abort', stop);
      resolve();
    };
    if (deps.signal?.aborted) {
      resolve();
      return;
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    deps.signal?.addEventListener('abort', stop, { once: true });
  });
  await server.stop();
  if (!opts.quiet && !opts.json) line(io, 'lexicon serve stopped');
  return 0;
}

export async function runServe(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const modes = [opts.show, opts.status, opts.install, opts.uninstall].filter(Boolean).length;
  if (modes > 1) {
    io.stderr('lexicon: use only one of --show, --status, --install, --uninstall\n');
    return 1;
  }
  try {
    if (opts.show) return await runServeShow(opts, io, deps);
    if (opts.status) return await runServeStatus(opts, io, deps);
    if (opts.install) return await runServeInstall(opts, io, deps);
    if (opts.uninstall) return await runServeUninstall(opts, io, deps);
    return await runServeForeground(opts, io, deps);
  } catch (err) {
    io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535 || String(n) !== value.trim()) {
    throw new InvalidArgumentError('expected a port between 0 and 65535 (0 picks a free port)');
  }
  return n;
}

export function registerServeCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  program
    .command('serve')
    .description(`run the local HTTP API on http://127.0.0.1:${DEFAULT_PORT} for extensions, Shortcuts, Raycast and desktop apps`)
    .option('--port <n>', `port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)`, parsePort)
    .option('--host <host>', 'interface to bind (default 127.0.0.1; anything else is exposed to the network)')
    .option('--json', 'print the listening info (or --show/--status result) as JSON')
    .option('--quiet', 'do not log requests')
    .option('--show', 'print the URL and bearer token (for the extension options page) and exit')
    .option('--status', 'check whether the server is up and exit')
    .option('--install', 'install as a login service (launchd on macOS, systemd --user on Linux)')
    .option('--uninstall', 'remove the login service')
    .action(async (opts: ServeOptions) => done(await runServe({ ...opts, ...globals() }, io)));
}
