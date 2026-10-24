/**
 * `lexicon serve`: run the local HTTP API (src/serve/server.ts), show its URL
 * and token, check whether it is up, open the extension pairing page
 * (`--pair`), or install it as a login service (launchd on macOS, a systemd
 * user unit on Linux, a Task Scheduler logon task on Windows).
 * Handlers are exported for tests; registerServeCommands() only wires commander.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { homeDir } from '../util/xdg.js';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { createServer, DEFAULT_HOST, DEFAULT_PORT, PAIR_PATH, pairPortNote, ensureServeConfig, getServePath, readServeConfig, isLexiconHealth, isLoopbackHost, probeHealth, serveUrl, FOREIGN_HEALTH_ERROR, SERVE_STATUS_HINTS, unusableServeConfigReason } from '../serve/index.js';
import { isRecord } from '../util/json.js';
import { resolveCliEntry } from './cli-entry.js';
import { lexiconServerEnv } from './cmd-install.js';
import { isVolatileEntry } from './claude-settings.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { fail, jsonError, jsonOk, line, refuse, safe, safeError, safeLines, safeMessage, tildify } from './io.js';
import type { CommonOptions, IO } from './io.js';
import {
  LAUNCH_AGENT_LABEL,
  SCHEDULED_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  launchAgentLogPath,
  launchAgentPath,
  scheduledTaskName,
  serveLabel,
  systemdUnitPath,
} from './serve-paths.js';

export { LAUNCH_AGENT_LABEL, SCHEDULED_TASK_NAME, SERVE_LABEL_ENV_VAR, SYSTEMD_UNIT_NAME, launchAgentLogPath, launchAgentPath, programPathFromTaskXml, scheduledTaskName, serveLabel, systemdUnitPath } from './serve-paths.js';
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
  /** Open the extension pairing page (GET /pair) in the default browser instead of serving. */
  pair?: boolean;
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
  /** Home directory (LaunchAgents / Logs / .config live under it). Default homeDir() (src/util/xdg.ts). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs launchctl / systemctl and the `--pair` browser opener. Injectable for tests. */
  exec?: ServeExec;
  /**
   * Absolute path of the built CLI (dist/cli/index.js). Default:
   * `resolveCliEntry()` (`$LEXICON_CLI`, the package's dist/cli/index.js, or
   * a `lexicon` on PATH). `--install` refuses to write a service whose
   * program path does not exist, whichever way it was resolved.
   */
  cliPath?: string;
  /** Node binary used by the service. Default process.execPath. */
  nodePath?: string;
  /** Version of `nodePath` (`v20.18.0`), for the Windows `--env-file` gate. Default process.version. */
  nodeVersion?: string;
  /** Numeric uid for `launchctl bootstrap gui/<uid>`. Default process.getuid(). */
  uid?: number;
  /** HTTP client for `--status`. Default global fetch. */
  fetch?: typeof fetch;
  /** Stops the server (in addition to SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Called once the server is listening (tests). */
  onListening?: (info: { port: number; url: string; token: string }) => void;
}

function red(s: string, env: NodeJS.ProcessEnv): string {
  return process.stderr.isTTY && !env.NO_COLOR ? `\x1b[31m${s}\x1b[0m` : s;
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

// ---------------------------------------------------------------------------
// --show / --status
// ---------------------------------------------------------------------------

export async function runServeShow(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const home = deps.home ?? homeDir();
  const config = await ensureServeConfig(storeOpts(opts), { onTokenReplaced: (message) => io.stderr(`lexicon: warning: ${safeMessage(message)}\n`) });
  const port = opts.port ?? config.port;
  const url = serveUrl(port, opts.host ?? DEFAULT_HOST);
  const configPath = getServePath(storeOpts(opts));
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ url, port, token: config.token, configPath }), null, 2));
    return 0;
  }
  line(io, `url:    ${url}`);
  line(io, `token:  ${config.token}`);
  line(io, `config: ${safe(tildify(configPath, home))}`);
  return 0;
}

export async function runServeStatus(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  // A status query is read-only: it used to create serve.json (and a token)
  // when none existed. Without one, the default port is probed with no token
  // and the result says serve is not configured.
  const config = await readServeConfig(storeOpts(opts));
  const configPath = getServePath(storeOpts(opts));
  const port = opts.port ?? config?.port ?? DEFAULT_PORT;
  const url = serveUrl(port, opts.host ?? DEFAULT_HOST);
  const probe = await probeHealth(url, {
    ...(config ? { token: config.token } : {}),
    timeoutMs: STATUS_TIMEOUT_MS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const why = unusableServeConfigReason(configPath);
  const notConfigured = config ? {} : { configured: false, configPath, note: `serve is not configured: ${configPath} ${why}` };
  const health =
    probe.state === 'up' && isRecord(probe.body) ? (probe.body as { ok?: unknown; version?: unknown; terms?: unknown }) : undefined;
  const up = probe.state === 'up' && isLexiconHealth(probe.body);
  // A 200 that is not lexicon serve's /health: another program holds the port.
  const foreign = probe.state === 'up' && !up;
  const downError = probe.state === 'down' ? probe.error : '';
  if (opts.json) {
    // `error` and `hint` are the keys MCP serve_status returns; `reason` stays for existing scripts.
    let rest: Record<string, unknown>;
    if (up) rest = { health };
    else if (probe.state === 'failing') rest = { running: true, status: probe.status, reason: probe.error, error: probe.error, hint: SERVE_STATUS_HINTS.failing };
    else if (foreign) rest = { reason: 'unexpected /health response', error: FOREIGN_HEALTH_ERROR, hint: SERVE_STATUS_HINTS.foreign };
    else rest = { reason: downError, error: downError, hint: SERVE_STATUS_HINTS.down };
    // `nextStep` repeats `hint`: every other failing --json document of the
    // CLI names what to do next under that key, so a script reading
    // `{ ok: false, error, nextStep }` found nothing here.
    if (typeof rest.hint === 'string') rest.nextStep = rest.hint;
    // `ok` equal to up (exit code 0) first, as every other --json document leads with it.
    line(io, JSON.stringify({ ok: up, up, url, ...rest, ...notConfigured }, null, 2));
    return up ? 0 : 1;
  }
  if (!config) line(io, `serve is not configured: ${safe(tildify(configPath, deps.home ?? homeDir()))} ${why}`);
  if (up) {
    const version = typeof health?.version === 'string' ? health.version : '?';
    const terms = typeof health?.terms === 'number' ? health.terms : 0;
    line(io, `lexicon serve is up at ${url} (version ${safe(version)}, ${terms} term${terms === 1 ? '' : 's'})`);
    return 0;
  }
  if (probe.state === 'failing') {
    // Running, so "start it" would be wrong advice: the error is what to fix.
    // safeError, not safe: the 200-character cap of `safe` cut a long lexicon path in half.
    line(io, `lexicon serve is running at ${url} but /health failed (HTTP ${probe.status}): ${safeError(probe.error)}`);
    return 1;
  }
  if (foreign) {
    // "Start it" would fail with EADDRINUSE: the port is taken by something else.
    line(io, `something else answers on that port: ${url}/health did not answer as lexicon serve does`);
    line(io, 'another program holds the port: stop it, or run the local API on another port with: lexicon serve --port <n>');
    return 1;
  }
  line(io, `lexicon serve is down at ${url}${downError ? ` (${safe(downError)})` : ''}`);
  line(io, 'start it with: lexicon serve      (or install it: lexicon serve --install)');
  return 1;
}

// ---------------------------------------------------------------------------
// --pair
// ---------------------------------------------------------------------------

/**
 * The command that opens a URL in the default browser, per platform. No shell:
 * the URL is an argument, never interpolated. On Windows `start` is a cmd.exe
 * builtin, so it runs through `cmd /c start "" <url>` (the empty string is the
 * window title `start` would otherwise take the URL for).
 */
export function browserOpenCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } | undefined {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return { cmd: 'xdg-open', args: [url] };
  return undefined;
}

/** `http://127.0.0.1:<port>/pair`: always 127.0.0.1, which is what the extension's match pattern and the server's Host check expect. */
export function pairUrl(port: number): string {
  return `${serveUrl(port, DEFAULT_HOST)}${PAIR_PATH}`;
}

/**
 * `lexicon serve --pair`: confirm the server is up (GET /health), then open
 * `/pair` in the default browser. The extension's content script on that
 * page reads the token and pairs itself; nothing is pasted by hand.
 */
export async function runServePair(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultServeExec;
  const doFetch = deps.fetch ?? fetch;
  // Read-only, like --status: pairing used to create serve.json (and mint a
  // token) when none existed, which configured serve as a side effect of
  // asking to pair with it. Without one there is no server to pair with.
  const config = await readServeConfig(storeOpts(opts));
  if (!config) {
    const configPath = getServePath(storeOpts(opts));
    const why = unusableServeConfigReason(configPath);
    const error = `serve is not configured: ${configPath} ${why}`;
    const nextStep = 'run `lexicon serve --install` (or `lexicon serve` in the foreground) first, then run `lexicon serve --pair` again';
    if (opts.json) line(io, JSON.stringify({ ...jsonError(error, nextStep), up: false, configured: false, configPath }, null, 2));
    io.stderr(`lexicon: serve is not configured: ${safe(tildify(configPath, deps.home ?? homeDir()))} ${why}\n`);
    io.stderr(`lexicon: ${nextStep}\n`);
    return 1;
  }
  const port = opts.port ?? config.port;
  const url = pairUrl(port);
  const healthUrl = `${serveUrl(port, DEFAULT_HOST)}/health`;

  let up = false;
  let foreign = false;
  let reason = '';
  try {
    const res = await doFetch(healthUrl, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) reason = `HTTP ${res.status}`;
    else {
      // lexicon serve's /health shape, as --status checks it: any `{ ok: true }`
      // counted, so another program on the port had its page opened as the
      // pairing page and the output said the extension would pair there.
      const body: unknown = await res.json().catch(() => undefined);
      up = isLexiconHealth(body);
      foreign = !up;
    }
  } catch (err) {
    reason = errorMessage(err);
  }
  if (foreign) {
    const error = `${FOREIGN_HEALTH_ERROR} (${healthUrl})`;
    if (opts.json) line(io, JSON.stringify({ ...jsonError(error, SERVE_STATUS_HINTS.foreign), up: false, url, reason: 'unexpected /health response' }, null, 2));
    io.stderr(`lexicon: ${safeMessage(error)}\n`);
    io.stderr(`lexicon: ${SERVE_STATUS_HINTS.foreign}\n`);
    return 1;
  }
  if (!up) {
    if (opts.json) {
      const error = `lexicon serve is down at ${serveUrl(port, DEFAULT_HOST)}${reason ? ` (${reason})` : ''}`;
      const nextStep = 'start it with `lexicon serve` or `lexicon serve --install` first, then run `lexicon serve --pair` again';
      line(io, JSON.stringify({ ...jsonError(error, nextStep), up: false, url, reason }, null, 2));
    } else {
      io.stderr(`lexicon: lexicon serve is down at ${serveUrl(port, DEFAULT_HOST)}${reason ? ` (${safe(reason)})` : ''}\n`);
      io.stderr('lexicon: start it with `lexicon serve` or `lexicon serve --install` first, then run `lexicon serve --pair` again\n');
    }
    return 1;
  }

  const opener = browserOpenCommand(url, platform);
  let opened = false;
  let openError = '';
  if (!opener) {
    openError = `no browser opener known for ${platform}`;
  } else {
    const result = await exec(opener.cmd, opener.args);
    opened = result.code === 0;
    if (!opened) openError = (result.stderr || result.stdout).trim() || `${opener.cmd} exited with ${result.code ?? 'an error'}`;
  }

  // The extension's pairing script runs on DEFAULT_PORT only (its manifest);
  // another port is paired from its Options.
  const note = port === DEFAULT_PORT ? undefined : pairPortNote(port);
  if (opts.json) {
    line(io, JSON.stringify({ ok: opened, up: true, url, opened, ...(opened ? {} : { error: openError }), ...(note ? { note } : {}) }, null, 2));
    return opened ? 0 : 1;
  }
  if (opened) {
    line(io, `opening ${url} in your browser`);
    line(io, note ?? 'the Lexicon extension pairs itself on that page; if nothing happens, open the URL by hand');
    return 0;
  }
  io.stderr(`lexicon: could not open a browser (${safeLines(openError)})\n`);
  line(io, `open this URL in the browser that has the Lexicon extension: ${url}`);
  if (note) line(io, note);
  return 1;
}

// ---------------------------------------------------------------------------
// --install / --uninstall
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Variables `lexicon serve --install` writes into the login service when they
 * are set at install time, as absolute paths. A login service does not start
 * from the user's shell, so without them it reads (and mints a token into) the
 * default ~/.config/lexicon instead of the lexicon and serve.json that
 * `lexicon serve --show` reads in that shell. LEXICON_CWD is not here: it
 * steers the MCP server's project lookup, and serve takes `cwd` per request.
 */
export const SERVE_PASSTHROUGH_ENV = ['LEXICON_PATH', 'XDG_CONFIG_HOME'] as const;

/** File next to serve.json holding the Scheduled Task's variables (`node --env-file`). */
export const SERVE_ENV_FILE_NAME = 'serve.env';

/** `node --env-file` arrived in 20.6.0. */
export function nodeSupportsEnvFile(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 20 || (major === 20 && minor >= 6);
}

/**
 * The `--env-file` document for `env`. Node's parser expands `\n` inside
 * double quotes (fatal for `C:\new\...`) and ends an unquoted value at `#`,
 * so each value is single-quoted, or backtick-quoted when it holds a `'`;
 * both are literal. Throws for a value holding both, or a line break.
 */
export function serveEnvFile(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env).map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`${name} contains a line break`);
    if (!value.includes("'")) return `${name}='${value}'`;
    if (!value.includes('`')) return `${name}=\`${value}\``;
    throw new Error(`${name} contains both ' and \` and cannot be written to an env file`);
  });
  return `# Written by lexicon serve --install; read by the Scheduled Task (node --env-file).\n${lines.join('\n')}\n`;
}

/** `NAME=value` per line, indented, for the install report. */
function envReport(env: Readonly<Record<string, string>> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([name, value]) => `  Environment: ${safe(name)}=${safe(value)}\n`)
    .join('');
}

/** The launchd LaunchAgent: RunAtLoad + KeepAlive, stdout/stderr to `logPath`, plus `env` when given. */
export function launchAgentPlist(
  nodePath: string,
  cliPath: string,
  logPath: string,
  label: string = LAUNCH_AGENT_LABEL,
  env?: Readonly<Record<string, string>>,
): string {
  const args = [nodePath, cliPath, 'serve'].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envBlock =
    env && Object.keys(env).length > 0
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...Object.entries(env).flatMap(([name, value]) => [`    <key>${xmlEscape(name)}</key>`, `    <string>${xmlEscape(value)}</string>`]),
          '  </dict>',
        ]
      : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    ...envBlock,
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

/**
 * The Task Scheduler document for `schtasks /Create /XML`.
 *
 * Why XML rather than the `/TR "..."` one-liner the old help text printed:
 * `/TR` is a single opaque field holding a whole command line, and both the
 * node binary and the CLI entry routinely sit under `C:\Program Files\...`,
 * so the value must carry embedded quotes. Node's `spawn` re-quotes an argv
 * element containing quotes by backslash-escaping them, schtasks does not
 * understand `\"`, and the task ends up registered with a mangled command that
 * only fails at the next logon. `<Command>` and `<Arguments>` are separate
 * elements, so nothing has to survive two levels of quoting.
 *
 * `userId` binds the logon trigger to one account (the task otherwise fires
 * for every user on the machine); `InteractiveToken` runs it in that user's
 * desktop session without storing a password. `ExecutionTimeLimit PT0S`
 * disables the default 72-hour kill, and `RestartOnFailure` is the nearest
 * equivalent to launchd `KeepAlive` / systemd `Restart=on-failure`.
 */
export function scheduledTaskXml(nodePath: string, cliPath: string, userId?: string, envFile?: string): string {
  // The task has no environment of its own; node loads the variables itself.
  const args = `${envFile ? `--env-file="${envFile}" ` : ''}"${cliPath}" serve`;
  const principal = [
    '  <Principals>',
    '    <Principal id="Author">',
    ...(userId ? [`      <UserId>${xmlEscape(userId)}</UserId>`] : []),
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>lexicon serve (local HTTP API for @ashlr/lexicon)</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    ...(userId ? [`      <UserId>${xmlEscape(userId)}</UserId>`] : []),
    '    </LogonTrigger>',
    '  </Triggers>',
    ...principal,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(nodePath)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** `DOMAIN\\user` for the task principal, from the environment schtasks itself reads. */
export function taskUserId(env: NodeJS.ProcessEnv): string | undefined {
  const user = env.USERNAME?.trim();
  if (!user) return undefined;
  const domain = (env.USERDOMAIN ?? env.COMPUTERNAME)?.trim();
  return domain ? `${domain}\\${user}` : user;
}

/** systemd's quoting: C-style backslash escapes inside "...", and `%` doubled (specifier expansion). */
function unitQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** The systemd user unit, with one `Environment=` line per entry of `env`. */
export function systemdUnit(nodePath: string, cliPath: string, env?: Readonly<Record<string, string>>): string {
  const envLines = Object.entries(env ?? {}).map(([name, value]) => `Environment=${unitQuote(`${name}=${value}`)}`);
  return [
    '[Unit]',
    'Description=lexicon serve (local HTTP API for @ashlr/lexicon)',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    ...envLines,
    `ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} serve`,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
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

/**
 * Why a login service pointing at `cliPath` would be refused, or undefined
 * when it would not: a path in an npx or Claude Code plugin cache (npm may
 * delete it, so the service would crash-loop; there is no npx form for a
 * permanent service), or, on the platforms the installer writes a service
 * for, a path that does not exist (a broken service would also replace a
 * working install under the same label).
 */
async function cliEntryBlocker(cliPath: string, platform: NodeJS.Platform): Promise<{ reason: string; volatile: boolean } | undefined> {
  if (isVolatileEntry(cliPath)) {
    return {
      volatile: true,
      reason:
        `this copy is running from an npx or Claude Code plugin cache (${safe(cliPath)}), ` +
        'which may be deleted. Install it for real first (npm i -g @ashlr/lexicon), then run: lexicon serve --install',
    };
  }
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    try {
      await fs.access(cliPath);
    } catch {
      return { volatile: false, reason: `${safe(cliPath)} does not exist (run npm run build, or set LEXICON_CLI to the built dist/cli/index.js)` };
    }
  }
  return undefined;
}

/**
 * The reason `runServeInstall` with these deps would refuse before writing
 * anything (the CLI entry cannot be located, sits in an npx or plugin cache,
 * or does not exist), or undefined when it would go ahead. Lets a plan (setup
 * `--dry-run`, MCP `setup_lexicon` without apply) say so up front instead of
 * promising a login service the real run refuses.
 */
export async function serveInstallBlocker(deps: Pick<ServeDeps, 'cliPath' | 'env' | 'platform'> = {}): Promise<string | undefined> {
  let cliPath: string;
  try {
    cliPath = resolveCliEntry({ env: deps.env ?? process.env, ...(deps.cliPath !== undefined ? { cliPath: deps.cliPath } : {}) });
  } catch (err) {
    return errorMessage(err);
  }
  return (await cliEntryBlocker(cliPath, deps.platform ?? process.platform))?.reason;
}

export async function runServeInstall(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homeDir();
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultServeExec;
  const nodePath = deps.nodePath ?? process.execPath;
  let cliPath: string;
  try {
    cliPath = resolveCliEntry({ env, ...(deps.cliPath !== undefined ? { cliPath: deps.cliPath } : {}) });
  } catch (err) {
    return fail(io, err);
  }
  // The same reasoning, one step earlier: a path inside an npx cache exists
  // right now but npm may delete it, so a login service pointing at one is a
  // crash-loop waiting to happen. Unlike a client config there is no npx form
  // to fall back to -- a service is meant to be permanent -- so this refuses
  // and names the one command that makes it permanent.
  const blocked = await cliEntryBlocker(cliPath, platform);
  if (blocked) {
    io.stderr(`lexicon: refusing to install the login service: ${blocked.reason}${blocked.volatile ? '. Nothing was written' : '; nothing was written'}\n`);
    return 1;
  }
  // Make sure the token exists before the service starts, so `--show` right after works.
  await ensureServeConfig(storeOpts(opts), { onTokenReplaced: (message) => io.stderr(`lexicon: warning: ${safeMessage(message)}\n`) });
  // The service must read the lexicon and serve.json this shell does (see SERVE_PASSTHROUGH_ENV).
  const serviceEnv = lexiconServerEnv(env, path.resolve(opts.cwd ?? process.cwd()), SERVE_PASSTHROUGH_ENV);

  if (platform === 'darwin') {
    const label = serveLabel(env);
    const plistPath = launchAgentPath(home, env);
    const logPath = launchAgentLogPath(home);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(plistPath, launchAgentPlist(nodePath, cliPath, logPath, label, serviceEnv), 'utf8');
    line(io, `wrote ${safe(plistPath)}`);
    line(io, `  ProgramArguments: ${safe(nodePath)} ${safe(cliPath)} serve`);
    io.stdout(envReport(serviceEnv));
    line(io, `  RunAtLoad + KeepAlive, logs in ${safe(logPath)}`);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    // A previous install must be booted out before bootstrap accepts the new plist.
    await exec('launchctl', ['bootout', `gui/${uid}/${label}`]);
    const bootstrap = await runAndReport(exec, io, 'launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    if (bootstrap.code !== 0) {
      const load = await runAndReport(exec, io, 'launchctl', ['load', plistPath]);
      if (load.code !== 0) {
        io.stderr(
          `lexicon: could not load the LaunchAgent; the plist is in place, so load it with: launchctl bootstrap gui/${uid} ${safe(plistPath)} (or log out and in), then check with: lexicon serve --status\n`,
        );
        return 1;
      }
    }
    line(io, `installed ${label}; check with: lexicon serve --status`);
    return 0;
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(home, env);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(unitPath, systemdUnit(nodePath, cliPath, serviceEnv), 'utf8');
    line(io, `wrote ${safe(unitPath)}`);
    line(io, `  ExecStart: ${safe(nodePath)} ${safe(cliPath)} serve`);
    io.stdout(envReport(serviceEnv));
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
    const taskName = scheduledTaskName(env);
    let envFile: string | undefined;
    if (serviceEnv) {
      const nodeVersion = deps.nodeVersion ?? process.version;
      if (!nodeSupportsEnvFile(nodeVersion)) {
        io.stderr(
          `lexicon: warning: node ${safe(nodeVersion)} cannot load an env file (needs 20.6+), so the task will not see ` +
            `${Object.keys(serviceEnv).join(' or ')}; set them as user environment variables (setx) or upgrade node\n`,
        );
      } else {
        let text: string;
        try {
          text = serveEnvFile(serviceEnv);
        } catch (err) {
          return fail(io, `cannot carry the environment into the Scheduled Task: ${errorMessage(err)}; nothing is installed`);
        }
        envFile = path.join(path.dirname(getServePath(storeOpts(opts))), SERVE_ENV_FILE_NAME);
        await fs.writeFile(envFile, text, 'utf8');
      }
    }
    const xml = scheduledTaskXml(nodePath, cliPath, taskUserId(env), envFile);
    // schtasks /Create /XML rejects a UTF-8 document ("The task XML is
    // malformed"); it wants UTF-16. The BOM is what makes it unambiguous.
    const xmlPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-task-')), 'lexicon-serve.xml');
    await fs.writeFile(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));
    try {
      // /F replaces an existing task of the same name, which is what a
      // re-install means; without it schtasks refuses and exits non-zero.
      const created = await runAndReport(exec, io, 'schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
      if (created.code !== 0) {
        io.stderr(
          `lexicon: could not create the Scheduled Task "${safe(taskName)}"; nothing is installed. ` +
            'Fix the schtasks /Create error above and rerun `lexicon serve --install`, ' +
            'or run `lexicon serve` to start the local API in the foreground\n',
        );
        return 1;
      }
    } finally {
      await fs.rm(path.dirname(xmlPath), { recursive: true, force: true });
    }
    line(io, `created Scheduled Task ${safe(taskName)} (trigger: at logon)`);
    line(io, `  Command:   ${safe(nodePath)}`);
    line(io, `  Arguments: ${envFile ? `--env-file="${safe(envFile)}" ` : ''}"${safe(cliPath)}" serve`);
    io.stdout(envFile ? envReport(serviceEnv) : '');
    line(io, `installed ${taskName}; check with: lexicon serve --status`);
    return 0;
  }

  io.stderr(`lexicon: serve --install is not supported on ${platform}; run \`lexicon serve\` from your session startup instead\n`);
  return 1;
}

/**
 * Delete a login-service file for --uninstall. A missing file is the "was not
 * installed" case (true, exit 0); any other failure (permissions, a directory
 * in its place) is reported on stderr and returns false, so the command does
 * not say the service is gone while its file is still there.
 */
async function removeServiceFile(file: string, io: IO): Promise<boolean> {
  try {
    await fs.unlink(file);
    line(io, `removed ${safe(file)}`);
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      line(io, `${safe(file)} was not installed`);
      return true;
    }
    io.stderr(`lexicon: could not remove ${safe(file)}: ${safeLines(errorMessage(err))}\n`);
    return false;
  }
}

export async function runServeUninstall(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homeDir();
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultServeExec;
  void opts;

  if (platform === 'darwin') {
    const plistPath = launchAgentPath(home, env);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    const bootout = await runAndReport(exec, io, 'launchctl', ['bootout', `gui/${uid}/${serveLabel(env)}`]);
    if (bootout.code !== 0) await runAndReport(exec, io, 'launchctl', ['unload', plistPath]);
    if (!(await removeServiceFile(plistPath, io))) return 1;
    return 0;
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(home, env);
    await runAndReport(exec, io, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
    const removed = await removeServiceFile(unitPath, io);
    await runAndReport(exec, io, 'systemctl', ['--user', 'daemon-reload']);
    return removed ? 0 : 1;
  }

  if (platform === 'win32') {
    const taskName = scheduledTaskName(env);
    const deleted = await runAndReport(exec, io, 'schtasks', ['/Delete', '/TN', taskName, '/F']);
    // schtasks exits non-zero when the task is not there, which is the same
    // "was not installed" case the other two platforms report rather than fail.
    if (deleted.code === 0) line(io, `removed Scheduled Task ${safe(taskName)}`);
    else line(io, `Scheduled Task ${safe(taskName)} was not installed`);
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
  const home = deps.home ?? homeDir();
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
    return fail(io, err, opts.json);
  }
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ url: info.url, port: info.port, host: info.host, token: info.token, configPath: info.configPath })));
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

/** What `lexicon serve --install --json` and `--uninstall --json` print. */
export interface ServeServiceJson {
  ok: boolean;
  action: 'install' | 'uninstall';
  platform: NodeJS.Platform;
  /** The transcript the command prints without --json, uncoloured. */
  output: string;
  /** Present when ok is false: the last `lexicon:` line of the run's stderr. */
  error?: string;
  nextStep?: string;
}

/**
 * `--install` / `--uninstall` under `--json`: the text run into a buffer,
 * wrapped in one document. It printed the transcript as is, so a script that
 * passed --json parsed prose. Its stderr (the commands it ran and how they
 * failed) still goes to stderr.
 */
async function runServeServiceJson(action: 'install' | 'uninstall', opts: ServeOptions, io: IO, deps: ServeDeps): Promise<number> {
  let out = '';
  let err = '';
  const buffer: IO = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  };
  const textOpts: ServeOptions = { ...opts, json: false };
  let code: number;
  try {
    code = action === 'install' ? await runServeInstall(textOpts, buffer, deps) : await runServeUninstall(textOpts, buffer, deps);
  } catch (e) {
    code = fail(buffer, e);
  }
  if (err) io.stderr(err);
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  const doc: ServeServiceJson = { ok: code === 0, action, platform: deps.platform ?? process.platform, output: plain(out) };
  if (code !== 0) {
    const errLines = plain(err).split('\n').filter((l) => l.trim() !== '');
    const own = errLines.filter((l) => l.startsWith('lexicon: ')).at(-1);
    doc.error = own !== undefined ? own.slice('lexicon: '.length) : (errLines.at(-1)?.trim() ?? `serve --${action} failed`);
    doc.nextStep = `fix the problem in error, then run lexicon serve --${action} --json again`;
  }
  line(io, JSON.stringify(doc, null, 2));
  return code;
}

export async function runServe(opts: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const given = (['show', 'status', 'pair', 'install', 'uninstall'] as const).filter((m) => opts[m] === true).map((m) => `--${m}`);
  const json = opts.json === true;
  // The nextStep names the flags that collided, as `lexicon voice` does for its
  // modes; the document had only `error`, unlike every other refusal.
  if (given.length > 1) {
    return refuse(io, json, 'use only one of --show, --status, --pair, --install, --uninstall', `pass only one of ${given.join(', ')} (see lexicon serve --help)`);
  }
  // --quiet silences request logging, which only a running server does; the
  // one-shot modes dropped it without a word, as voice --status dropped
  // recording flags before it refused them.
  if (given.length === 1 && opts.quiet === true) {
    return refuse(io, json, `--quiet only applies to a running server; ${given[0]} logs no requests`, `drop --quiet, or run lexicon serve --quiet to start the server without request logs`);
  }
  try {
    if (opts.show) return await runServeShow(opts, io, deps);
    if (opts.status) return await runServeStatus(opts, io, deps);
    if (opts.pair) return await runServePair(opts, io, deps);
    if (opts.install) return json ? await runServeServiceJson('install', opts, io, deps) : await runServeInstall(opts, io, deps);
    if (opts.uninstall) return json ? await runServeServiceJson('uninstall', opts, io, deps) : await runServeUninstall(opts, io, deps);
    return await runServeForeground(opts, io, deps);
  } catch (err) {
    return fail(io, err, json);
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
    .option('--json', 'print the listening info (or the --show, --status, --pair, --install or --uninstall result) as JSON, led by ok (for --status, ok equals up)')
    .option('--quiet', 'do not log requests (only when running the server; refused with --show, --status, --pair, --install, --uninstall)')
    .option('--show', 'print the URL and bearer token (for the extension options page) and exit')
    .option('--status', 'check whether the server is up and exit')
    .option('--pair', `open http://127.0.0.1:${DEFAULT_PORT}/pair in your browser so the extension pairs itself, and exit`)
    .option('--install', 'install as a login service (launchd on macOS, systemd --user on Linux, a Scheduled Task on Windows)')
    .option('--uninstall', 'remove the login service')
    .action(async (opts: ServeOptions) => done(await runServe({ ...opts, ...globals() }, io)));
}
