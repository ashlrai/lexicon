/**
 * Cross-platform clipboard access for the daemon.
 *
 * One backend per platform tool: `pbcopy` (macOS), `wl` (Wayland
 * wl-clipboard), `xclip` and `xsel` (X11), `powershell` (Windows). Detection
 * only looks at the platform, the environment and PATH, so it never spawns a
 * process; process spawning goes through an injectable `exec` so tests never
 * touch a real clipboard.
 */
import { spawn } from 'node:child_process';
import { findOnPath } from '../util/which.js';
import { isEnoent } from '../util/errors.js';

export interface ClipboardBackend {
  /** Stable identifier, also accepted by `lexicon daemon --backend <name>`. */
  name: string;
  /** Human-readable description of the commands used (for `--which` and doctor). */
  description?: string;
  /**
   * Resolve to '' when the clipboard is empty or holds something that is not
   * text. May reject with a ClipboardTooLargeError (isClipboardTooLarge) for a
   * clipboard past MAX_CLIPBOARD_READ_BYTES, which the daemon skips as too large.
   */
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export const CLIPBOARD_BACKEND_NAMES = ['pbcopy', 'wl', 'xclip', 'xsel', 'powershell'] as const;
export type ClipboardBackendName = (typeof CLIPBOARD_BACKEND_NAMES)[number];

export function isClipboardBackendName(value: string): value is ClipboardBackendName {
  return (CLIPBOARD_BACKEND_NAMES as readonly string[]).includes(value);
}

/**
 * Run `cmd` with `args`, optionally feeding `stdin`, and resolve with stdout.
 * Must reject with an `ExecError` (or an Error carrying `code: 'ENOENT'`) on a
 * non-zero exit or a missing binary.
 */
export type ClipboardExec = (cmd: string, args: readonly string[], stdin?: string) => Promise<string>;

export class ExecError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`${cmd} exited with code ${exitCode ?? 'null'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    this.name = 'ExecError';
  }
}

/**
 * Most stdout bytes a read takes before giving up on the clipboard as too
 * large. The daemon corrects at most MAX_CLIPBOARD_CHARS (20,000) UTF-16 units,
 * and no text needs more than 3 UTF-8 bytes per unit, so anything past 64 KiB
 * is over that limit whatever it holds. Stopping here, rather than at 16 MB,
 * keeps the 250 ms poll from re-reading a huge clipboard in full every time.
 */
export const MAX_CLIPBOARD_READ_BYTES = 64 * 1024;

/**
 * A read that stopped at MAX_CLIPBOARD_READ_BYTES: the clipboard holds more
 * text than the daemon corrects. Not a failure; the daemon skips it as too large.
 */
export class ClipboardTooLargeError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly limit: number,
  ) {
    super(`${cmd}: clipboard holds more than ${limit} bytes`);
    this.name = 'ClipboardTooLargeError';
  }
}

/**
 * How long a clipboard tool may run before it is killed. `xclip -o` waits for
 * the selection owner to answer and an unresponsive owner never does; with
 * no limit the read never settled, so the watcher stopped polling without a
 * word, and the spawned tool kept the process alive past ctrl-C.
 */
export const CLIPBOARD_EXEC_TIMEOUT_MS = 5_000;

/**
 * The limit for the PowerShell backend. Each read and write starts a new
 * powershell.exe, which loads .NET and the clipboard cmdlets before it runs
 * a line: a cold start on a busy or slow machine took over 5 s, so a
 * clipboard that was answering fine was reported as hung and left
 * uncorrected. A hung owner is still stopped, just later.
 */
export const POWERSHELL_EXEC_TIMEOUT_MS = 20_000;

/** A clipboard tool that ran past CLIPBOARD_EXEC_TIMEOUT_MS and was killed. Reported, never read as an empty clipboard. */
export class ClipboardTimeoutError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly timeoutMs: number,
  ) {
    super(`${cmd} did not finish within ${timeoutMs} ms and was stopped (the app holding the clipboard may not be answering)`);
    this.name = 'ClipboardTimeoutError';
  }
}

/** True for a ClipboardTimeoutError (by name, so an injected exec may throw its own). */
export function isClipboardTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'ClipboardTimeoutError';
}

/** True for a ClipboardTooLargeError (by name, so an injected exec may throw its own). */
export function isClipboardTooLarge(err: unknown): boolean {
  return err instanceof Error && err.name === 'ClipboardTooLargeError';
}

/**
 * Default process runner. Writes (a `stdin` payload) ignore stdout/stderr and
 * resolve as soon as the process exits: `xclip -i` forks a child that keeps
 * the selection alive and would otherwise hold the pipes open forever. A read
 * whose stdout passes MAX_CLIPBOARD_READ_BYTES kills the tool and rejects with
 * a ClipboardTooLargeError.
 */
export function defaultClipboardExec(
  cmd: string,
  args: readonly string[],
  stdin?: string,
  timeoutMs: number = CLIPBOARD_EXEC_TIMEOUT_MS,
): Promise<string> {
  const isWrite = stdin !== undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: [isWrite ? 'pipe' : 'ignore', isWrite ? 'ignore' : 'pipe', isWrite ? 'ignore' : 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new ClipboardTimeoutError(cmd, timeoutMs));
    }, timeoutMs);
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    };
    child.once('error', fail);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIPBOARD_READ_BYTES) {
        child.kill();
        fail(new ClipboardTooLargeError(cmd, MAX_CLIPBOARD_READ_BYTES));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.once(isWrite ? 'exit' : 'close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new ExecError(cmd, code, Buffer.concat(errChunks).toString('utf8')));
    });
    if (isWrite && child.stdin) {
      // EPIPE when the tool exits early; the exit code tells the real story.
      child.stdin.once('error', () => undefined);
      child.stdin.end(stdin, 'utf8');
    }
  });
}

/**
 * Read helper shared by every backend: an empty or non-text clipboard makes
 * most tools exit non-zero (`wl-paste`: "Nothing is copied", `xclip`: "target
 * STRING not available"), which is not an error for us. A missing binary or a
 * display/session problem still surfaces so the daemon does not sit silent,
 * and so does a ClipboardTooLargeError: swallowed, a clipboard over the read
 * cap was reported as empty while a smaller oversized one was "too large".
 */
async function readOrEmpty(exec: ClipboardExec, cmd: string, args: readonly string[]): Promise<string> {
  try {
    return await exec(cmd, args);
  } catch (e) {
    if (isEnoent(e) || isClipboardTooLarge(e) || isClipboardTimeout(e)) throw e;
    if (e instanceof ExecError && /display|DISPLAY|WAYLAND_DISPLAY|compositor|not allowed|permission/i.test(e.stderr)) throw e;
    return '';
  }
}

export function pbcopyBackend(exec: ClipboardExec = defaultClipboardExec): ClipboardBackend {
  return {
    name: 'pbcopy',
    description: 'pbpaste / pbcopy (macOS)',
    read: () => readOrEmpty(exec, 'pbpaste', []),
    write: async (text) => {
      await exec('pbcopy', [], text);
    },
  };
}

export function wlBackend(exec: ClipboardExec = defaultClipboardExec): ClipboardBackend {
  return {
    name: 'wl',
    description: 'wl-paste --no-newline --type text / wl-copy --type text/plain (Wayland, wl-clipboard)',
    // `--type text` asks for any text type: without it wl-paste hands over the
    // first offered type when no text is offered, so a copied image came back
    // as PNG bytes. With no text on offer it exits non-zero, which reads as ''.
    read: () => readOrEmpty(exec, 'wl-paste', ['--no-newline', '--type', 'text']),
    // `--type text/plain`: without it wl-copy guesses the type from the bytes
    // (with xdg-mime when installed), so a correction that looked like markup
    // or a file path could be offered as another type and paste as nothing
    // in a text field. A text type also makes wl-copy offer the usual text
    // aliases (UTF8_STRING, text/plain;charset=utf-8, ...). The other
    // backends write text already: pbcopy, xclip -i (UTF8_STRING), xsel and
    // Set-Clipboard take nothing but text.
    write: async (text) => {
      await exec('wl-copy', ['--type', 'text/plain'], text);
    },
  };
}

export function xclipBackend(exec: ClipboardExec = defaultClipboardExec): ClipboardBackend {
  return {
    name: 'xclip',
    description: 'xclip -selection clipboard -o / -i (X11)',
    read: () => readOrEmpty(exec, 'xclip', ['-selection', 'clipboard', '-o']),
    write: async (text) => {
      await exec('xclip', ['-selection', 'clipboard', '-i'], text);
    },
  };
}

export function xselBackend(exec: ClipboardExec = defaultClipboardExec): ClipboardBackend {
  return {
    name: 'xsel',
    description: 'xsel --clipboard --output / --input (X11)',
    read: () => readOrEmpty(exec, 'xsel', ['--clipboard', '--output']),
    write: async (text) => {
      await exec('xsel', ['--clipboard', '--input'], text);
    },
  };
}

/**
 * Windows via PowerShell. `Get-Clipboard -Raw` is written with
 * `[Console]::Out.Write` so no trailing newline is appended, and stdin/stdout
 * are forced to UTF-8 (powershell.exe otherwise uses the OEM code page). The
 * text is fed on stdin and read whole with `[Console]::In.ReadToEnd()` rather
 * than `$input`, which is line-based and would drop the final newline.
 *
 * Windows clipboards are usually CRLF: a read whose every line break is CRLF
 * is normalized to `\n` so the matcher sees plain text, and the next write
 * restores CRLF. Text with both kinds is left as it is, both ways.
 */
export function powershellBackend(exec: ClipboardExec = defaultClipboardExec, shell = 'powershell'): ClipboardBackend {
  let crlf = false;
  // An injected exec keeps its own limit; the default one gets PowerShell's.
  const run: ClipboardExec =
    exec === defaultClipboardExec ? (cmd, args, stdin) => defaultClipboardExec(cmd, args, stdin, POWERSHELL_EXEC_TIMEOUT_MS) : exec;
  // UTF8Encoding without a byte order mark: [Text.Encoding]::UTF8 carries
  // one, which Windows PowerShell 5.1 writes ahead of redirected output, so
  // the read began with U+FEFF and the correction written back put it on
  // the clipboard. A BOM that still arrives is dropped below.
  const readScript = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::Out.Write([string](Get-Clipboard -Raw))';
  const writeScript = '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t';
  return {
    name: 'powershell',
    description: `${shell} Get-Clipboard -Raw / Set-Clipboard (Windows)`,
    read: async () => {
      const raw = (await readOrEmpty(run, shell, ['-NoProfile', '-NonInteractive', '-Command', readScript])).replace(/^\uFEFF/, '');
      // Only a clipboard whose every line break is CRLF is normalized: one with
      // both kinds was rewritten with CRLF everywhere, changing lines the
      // lexicon never touched. Mixed text is passed through as it is.
      crlf = raw.includes('\r\n') && !/(^|[^\r])\n/.test(raw);
      return crlf ? raw.replace(/\r\n/g, '\n') : raw;
    },
    write: async (text) => {
      const payload = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
      await run(shell, ['-NoProfile', '-NonInteractive', '-Command', writeScript], payload);
    },
  };
}

export const LINUX_INSTALL_HINT =
  'install one: sudo apt install wl-clipboard (Wayland) or sudo apt install xclip (X11; xsel also works)';

/** The executables a backend runs, for checking a forced `--backend` before it is used. */
export const CLIPBOARD_BACKEND_BINARIES: Readonly<Record<ClipboardBackendName, readonly string[]>> = {
  pbcopy: ['pbpaste', 'pbcopy'],
  wl: ['wl-paste', 'wl-copy'],
  xclip: ['xclip'],
  xsel: ['xsel'],
  powershell: ['powershell'],
};

/** The install hint for a backend's tools, or '' when none applies. */
function backendInstallHint(name: ClipboardBackendName): string {
  switch (name) {
    case 'wl':
      return 'install it: sudo apt install wl-clipboard';
    case 'xclip':
      return 'install it: sudo apt install xclip';
    case 'xsel':
      return 'install it: sudo apt install xsel';
    case 'pbcopy':
      return 'it ships with macOS; check your PATH';
    case 'powershell':
      return 'it ships with Windows; check your PATH, or install PowerShell 7 as pwsh';
    default:
      return '';
  }
}

/**
 * Reject a forced `--backend` whose tools are not on PATH, with the install
 * hint, instead of letting every clipboard read fail with `spawn xclip ENOENT`.
 */
export async function checkClipboardBackend(
  name: ClipboardBackendName,
  which: (bin: string) => Promise<boolean>,
): Promise<void> {
  // PowerShell 7 (`pwsh`) runs the same scripts; detection already falls
  // back to it, and a forced `--backend powershell` does too (see
  // powershellShell), so only both missing is a refusal.
  if (name === 'powershell' && !(await which('powershell')) && (await which('pwsh'))) return;
  const missing: string[] = [];
  for (const bin of CLIPBOARD_BACKEND_BINARIES[name]) {
    if (!(await which(bin))) missing.push(bin);
  }
  if (missing.length === 0) return;
  if (name === 'powershell') missing.push('pwsh');
  const hint = backendInstallHint(name);
  throw new Error(`--backend ${name}: ${missing.join(' and ')} not found on PATH${hint ? ` (${hint})` : ''}`);
}

/**
 * The shell a forced `--backend powershell` runs: `powershell` when it is on
 * PATH, else `pwsh` when that is, as detection picks it. It always ran
 * `powershell`, so on a machine with only PowerShell 7 (most Linux and macOS
 * installs, and some Windows ones) the forced backend was refused or failed
 * every read, though `pwsh` would have done.
 */
export async function powershellShell(which: (bin: string) => Promise<boolean>): Promise<'powershell' | 'pwsh'> {
  if (await which('powershell')) return 'powershell';
  return (await which('pwsh')) ? 'pwsh' : 'powershell';
}

/** Build a backend by name, for `--backend`. `shell` is the PowerShell to run for `powershell` (default `powershell`). */
export function createClipboardBackend(name: ClipboardBackendName, exec: ClipboardExec = defaultClipboardExec, shell: 'powershell' | 'pwsh' = 'powershell'): ClipboardBackend {
  switch (name) {
    case 'pbcopy':
      return pbcopyBackend(exec);
    case 'wl':
      return wlBackend(exec);
    case 'xclip':
      return xclipBackend(exec);
    case 'xsel':
      return xselBackend(exec);
    case 'powershell':
      return powershellBackend(exec, shell);
    default: {
      const never: never = name;
      throw new Error(`unknown clipboard backend: ${String(never)}`);
    }
  }
}

/**
 * Pick the clipboard backend for this machine.
 *
 * - darwin: pbpaste/pbcopy
 * - linux (and the BSDs): wl-clipboard when `WAYLAND_DISPLAY` is set and both
 *   `wl-paste` and `wl-copy` are on PATH, else xclip, else xsel
 * - win32: powershell (falls back to pwsh)
 *
 * Throws with an install hint when nothing usable is found.
 */
export async function detectClipboardBackend(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  which?: (bin: string) => Promise<boolean>,
  exec: ClipboardExec = defaultClipboardExec,
): Promise<ClipboardBackend> {
  const has = which ?? (async (bin: string) => (await findOnPath(bin, { env, platform })) !== undefined);

  switch (platform) {
    case 'darwin': {
      if (!(await has('pbpaste')) || !(await has('pbcopy'))) {
        throw new Error('pbpaste/pbcopy not found on PATH (they ship with macOS; check your PATH)');
      }
      return pbcopyBackend(exec);
    }
    case 'win32': {
      if (await has('powershell')) return powershellBackend(exec, 'powershell');
      if (await has('pwsh')) return powershellBackend(exec, 'pwsh');
      throw new Error('powershell.exe not found on PATH (it ships with Windows; check your PATH, or install PowerShell 7 as pwsh)');
    }
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd':
    case 'sunos':
    case 'aix': {
      if (env.WAYLAND_DISPLAY && (await has('wl-paste')) && (await has('wl-copy'))) return wlBackend(exec);
      if (await has('xclip')) return xclipBackend(exec);
      if (await has('xsel')) return xselBackend(exec);
      const session = env.WAYLAND_DISPLAY ? 'Wayland session' : env.DISPLAY ? 'X11 session' : 'no DISPLAY or WAYLAND_DISPLAY set';
      throw new Error(`no clipboard tool found (${session}); ${LINUX_INSTALL_HINT}`);
    }
    default:
      throw new Error(
        `clipboard daemon does not support platform "${platform}"; pass --backend <${CLIPBOARD_BACKEND_NAMES.join('|')}> if one of those tools works here, ` +
          'or pipe the text through lexicon normalize instead',
      );
  }
}
