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
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { createServer, DEFAULT_HOST, DEFAULT_PORT, PAIR_PATH, ensureServeConfig, getServePath, isLoopbackHost, serveUrl } from '../serve/index.js';
import { resolveCliEntry } from './cli-entry.js';
import { isVolatileEntry } from './claude-settings.js';
import { errorMessage } from '../util/errors.js';
import { fail, line, safe, safeLines, tildify } from './io.js';
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
  /** Home directory (LaunchAgents / Logs / .config live under it). Default os.homedir(). */
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
  const config = await ensureServeConfig(storeOpts(opts));
  const port = opts.port ?? config.port;
  const url = pairUrl(port);
  const healthUrl = `${serveUrl(port, DEFAULT_HOST)}/health`;

  let up = false;
  let reason = '';
  try {
    const res = await doFetch(healthUrl, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) reason = `HTTP ${res.status}`;
    else up = ((await res.json()) as { ok?: unknown }).ok === true;
  } catch (err) {
    reason = errorMessage(err);
  }
  if (!up) {
    if (opts.json) {
      line(io, JSON.stringify({ up: false, url, reason }, null, 2));
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

  if (opts.json) {
    line(io, JSON.stringify({ up: true, url, opened, ...(opened ? {} : { error: openError }) }, null, 2));
    return opened ? 0 : 1;
  }
  if (opened) {
    line(io, `opening ${url} in your browser`);
    line(io, 'the Lexicon extension pairs itself on that page; if nothing happens, open the URL by hand');
    return 0;
  }
  io.stderr(`lexicon: could not open a browser (${safeLines(openError)})\n`);
  line(io, `open this URL in the browser that has the Lexicon extension: ${url}`);
  return 1;
}

// ---------------------------------------------------------------------------
// --install / --uninstall
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The launchd LaunchAgent: RunAtLoad + KeepAlive, stdout/stderr to `logPath`. */
export function launchAgentPlist(nodePath: string, cliPath: string, logPath: string, label: string = LAUNCH_AGENT_LABEL): string {
  const args = [nodePath, cliPath, 'serve'].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
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
export function scheduledTaskXml(nodePath: string, cliPath: string, userId?: string): string {
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
    `      <Arguments>${xmlEscape(`"${cliPath}" serve`)}</Arguments>`,
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
  if (isVolatileEntry(cliPath)) {
    io.stderr(
      `lexicon: refusing to install the login service: this copy is running from an npx cache (${safe(cliPath)}), ` +
        'which npm deletes. Install it for real first (npm i -g @ashlr/lexicon), then run: lexicon serve --install. Nothing was written\n',
    );
    return 1;
  }
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    // A service whose program does not exist would crash-loop under KeepAlive /
    // Restart / RestartOnFailure and, worse, replace a working install under the
    // same label. Nothing is written and nothing is booted out until the path is
    // known to exist.
    try {
      await fs.access(cliPath);
    } catch {
      io.stderr(
        `lexicon: refusing to install the login service: ${safe(cliPath)} does not exist (run npm run build, or set LEXICON_CLI to the built dist/cli/index.js); nothing was written\n`,
      );
      return 1;
    }
  }
  // Make sure the token exists before the service starts, so `--show` right after works.
  await ensureServeConfig(storeOpts(opts));

  if (platform === 'darwin') {
    const label = serveLabel(env);
    const plistPath = launchAgentPath(home, env);
    const logPath = launchAgentLogPath(home);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(plistPath, launchAgentPlist(nodePath, cliPath, logPath, label), 'utf8');
    line(io, `wrote ${safe(plistPath)}`);
    line(io, `  ProgramArguments: ${safe(nodePath)} ${safe(cliPath)} serve`);
    line(io, `  RunAtLoad + KeepAlive, logs in ${safe(logPath)}`);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    // A previous install must be booted out before bootstrap accepts the new plist.
    await exec('launchctl', ['bootout', `gui/${uid}/${label}`]);
    const bootstrap = await runAndReport(exec, io, 'launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    if (bootstrap.code !== 0) {
      const load = await runAndReport(exec, io, 'launchctl', ['load', plistPath]);
      if (load.code !== 0) {
        io.stderr('lexicon: could not load the LaunchAgent; the plist is in place, load it manually or log out and in\n');
        return 1;
      }
    }
    line(io, `installed ${label}; check with: lexicon serve --status`);
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
    const taskName = scheduledTaskName(env);
    const xml = scheduledTaskXml(nodePath, cliPath, taskUserId(env));
    // schtasks /Create /XML rejects a UTF-8 document ("The task XML is
    // malformed"); it wants UTF-16. The BOM is what makes it unambiguous.
    const xmlPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-task-')), 'lexicon-serve.xml');
    await fs.writeFile(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));
    try {
      // /F replaces an existing task of the same name, which is what a
      // re-install means; without it schtasks refuses and exits non-zero.
      const created = await runAndReport(exec, io, 'schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
      if (created.code !== 0) {
        io.stderr(`lexicon: could not create the Scheduled Task "${safe(taskName)}"; nothing is installed\n`);
        return 1;
      }
    } finally {
      await fs.rm(path.dirname(xmlPath), { recursive: true, force: true });
    }
    line(io, `created Scheduled Task ${safe(taskName)} (trigger: at logon)`);
    line(io, `  Command:   ${safe(nodePath)}`);
    line(io, `  Arguments: "${safe(cliPath)}" serve`);
    line(io, `installed ${taskName}; check with: lexicon serve --status`);
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
    const plistPath = launchAgentPath(home, env);
    const uid = deps.uid ?? process.getuid?.() ?? 501;
    const bootout = await runAndReport(exec, io, 'launchctl', ['bootout', `gui/${uid}/${serveLabel(env)}`]);
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
    return fail(io, err);
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
  const modes = [opts.show, opts.status, opts.pair, opts.install, opts.uninstall].filter(Boolean).length;
  if (modes > 1) {
    io.stderr('lexicon: use only one of --show, --status, --pair, --install, --uninstall\n');
    return 1;
  }
  try {
    if (opts.show) return await runServeShow(opts, io, deps);
    if (opts.status) return await runServeStatus(opts, io, deps);
    if (opts.pair) return await runServePair(opts, io, deps);
    if (opts.install) return await runServeInstall(opts, io, deps);
    if (opts.uninstall) return await runServeUninstall(opts, io, deps);
    return await runServeForeground(opts, io, deps);
  } catch (err) {
    return fail(io, err);
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
    .option('--pair', `open http://127.0.0.1:${DEFAULT_PORT}/pair in your browser so the extension pairs itself, and exit`)
    .option('--install', 'install as a login service (launchd on macOS, systemd --user on Linux, a Scheduled Task on Windows)')
    .option('--uninstall', 'remove the login service')
    .action(async (opts: ServeOptions) => done(await runServe({ ...opts, ...globals() }, io)));
}
