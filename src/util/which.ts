/**
 * Locating an executable, without spawning `which`/`where`.
 *
 * One implementation, three entry points: `findOnPath` (async, the default —
 * it checks the execute bit), `findOnPathSync` (for the synchronous callers:
 * `lexicon doctor` and CLI-entry resolution) and `locateTool`/`locateToolSync`,
 * which try several candidate names in order and then fall back to a list of
 * well-known directories. The sync and async forms resolve identically: they
 * split PATH the same way, expand PATHEXT the same way on Windows, and try the
 * candidate names in the same order, so the path `lexicon doctor` reports is
 * the path the voice pipeline will actually run.
 */
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Directories searched after PATH on POSIX, for GUI shells with a minimal environment. */
export const WELL_KNOWN_BIN_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export interface FindOnPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Existence/executability probe, injectable for tests. Default: fs.access. */
  exists?: (candidate: string) => Promise<boolean>;
}

/** The PATH entries, in order. Windows spells the variable inconsistently, so all three casings are tried. */
function pathDirs(env: NodeJS.ProcessEnv, win: boolean): string[] {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  return pathVar.split(win ? ';' : ':').filter(Boolean);
}

/**
 * The file names to try for `bin` in each directory. On POSIX that is just
 * `bin`; on Windows it is `bin` + each PATHEXT extension (upper and lower
 * case), then the bare name — unless `bin` already carries an extension.
 */
function candidateNames(bin: string, env: NodeJS.ProcessEnv, win: boolean): string[] {
  if (!win) return [bin];
  const p = path.win32;
  if (p.extname(bin) !== '') return [bin];
  const exts = (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean);
  return [...new Set([...exts.map((ext) => bin + ext), ...exts.map((ext) => bin + ext.toLowerCase()), bin])];
}

/** The default probe: the file must exist, and on POSIX be executable. */
async function accessible(candidate: string, win: boolean): Promise<boolean> {
  try {
    await fs.access(candidate, win ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate `bin` on PATH. Returns the absolute path or undefined. */
export async function findOnPath(bin: string, opts: FindOnPathOptions = {}): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exists = opts.exists ?? ((candidate: string) => accessible(candidate, win));
  const names = candidateNames(bin, env, win);
  for (const dir of pathDirs(env, win)) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface FindOnPathSyncOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Synchronous `findOnPath`, for the callers that cannot await: the doctor's
 * check table and `resolveCliEntry`. Uses `existsSync` rather than an execute
 * bit test, so it is very slightly more permissive than the async form.
 */
export function findOnPathSync(bin: string, opts: FindOnPathSyncOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const names = candidateNames(bin, env, win);
  for (const dir of pathDirs(env, win)) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface LocateOptions extends FindOnPathOptions {
  /** Extra directories tried after PATH. Default `WELL_KNOWN_BIN_DIRS` on POSIX, none on win32. */
  extraDirs?: readonly string[];
}

function extraDirsFor(opts: { extraDirs?: readonly string[] }, platform: NodeJS.Platform): readonly string[] {
  return opts.extraDirs ?? (platform === 'win32' ? [] : WELL_KNOWN_BIN_DIRS);
}

/**
 * Find the first of `names` on PATH, then in the well-known directories.
 * Name order is the preference order: every PATH entry is tried for the first
 * name before the second name is considered.
 */
export async function locateTool(names: readonly string[], opts: LocateOptions = {}): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === 'win32';
  const exists = opts.exists ?? ((candidate: string) => accessible(candidate, win));
  for (const name of names) {
    const onPath = await findOnPath(name, { env, platform, exists });
    if (onPath) return onPath;
  }
  for (const dir of extraDirsFor(opts, platform)) {
    for (const name of names) {
      const candidate = path.join(dir, win ? `${name}.exe` : name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Synchronous `locateTool`, for `lexicon doctor`. Resolves to the same path the async form would. */
export function locateToolSync(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const name of names) {
    const onPath = findOnPathSync(name, { env, platform });
    if (onPath) return onPath;
  }
  for (const dir of extraDirsFor({}, platform)) {
    for (const name of names) {
      const candidate = path.join(dir, platform === 'win32' ? `${name}.exe` : name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
