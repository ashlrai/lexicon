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
  /** Resolve to '' when the clipboard is empty or holds something that is not text. */
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

const MAX_OUTPUT = 16 * 1024 * 1024;

/**
 * Default process runner. Writes (a `stdin` payload) ignore stdout/stderr and
 * resolve as soon as the process exits: `xclip -i` forks a child that keeps
 * the selection alive and would otherwise hold the pipes open forever.
 */
export function defaultClipboardExec(cmd: string, args: readonly string[], stdin?: string): Promise<string> {
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
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    child.once('error', fail);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill();
        fail(new Error(`${cmd}: output exceeds ${MAX_OUTPUT} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.once(isWrite ? 'exit' : 'close', (code: number | null) => {
      if (settled) return;
      settled = true;
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
 * display/session problem still surfaces so the daemon does not sit silent.
 */
async function readOrEmpty(exec: ClipboardExec, cmd: string, args: readonly string[]): Promise<string> {
  try {
    return await exec(cmd, args);
  } catch (e) {
    if (isEnoent(e)) throw e;
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
    description: 'wl-paste --no-newline / wl-copy (Wayland, wl-clipboard)',
    read: () => readOrEmpty(exec, 'wl-paste', ['--no-newline']),
    write: async (text) => {
      await exec('wl-copy', [], text);
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
 * Windows clipboards are usually CRLF: reads normalize to `\n` so the matcher
 * sees plain text, and the next write restores the line-ending style that was
 * read.
 */
export function powershellBackend(exec: ClipboardExec = defaultClipboardExec, shell = 'powershell'): ClipboardBackend {
  let crlf = false;
  const readScript = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write([string](Get-Clipboard -Raw))';
  const writeScript = '[Console]::InputEncoding = [Text.Encoding]::UTF8; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t';
  return {
    name: 'powershell',
    description: `${shell} Get-Clipboard -Raw / Set-Clipboard (Windows)`,
    read: async () => {
      const raw = await readOrEmpty(exec, shell, ['-NoProfile', '-NonInteractive', '-Command', readScript]);
      crlf = raw.includes('\r\n');
      return crlf ? raw.replace(/\r\n/g, '\n') : raw;
    },
    write: async (text) => {
      const payload = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
      await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', writeScript], payload);
    },
  };
}

export const LINUX_INSTALL_HINT =
  'install one: sudo apt install wl-clipboard (Wayland) or sudo apt install xclip (X11; xsel also works)';

/** Build a backend by name, for `--backend`. */
export function createClipboardBackend(name: ClipboardBackendName, exec: ClipboardExec = defaultClipboardExec): ClipboardBackend {
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
      return powershellBackend(exec);
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
      throw new Error(`clipboard daemon does not support platform "${platform}"`);
  }
}
