/**
 * XDG Base Directory resolution, in one place.
 *
 * Four call sites used to read `XDG_CONFIG_HOME` four different ways (`||`
 * on `process.env` directly, a trimmed truthiness check, and twice with
 * `??`), so `XDG_CONFIG_HOME=""` produced a *relative* path in two of them and the
 * `~/.config` fallback in the other two. The spec is explicit on both points:
 *
 *   "If $XDG_CONFIG_HOME is either not set or empty, a default equal to
 *    $HOME/.config should be used."
 *   "All paths set in these environment variables must be absolute. If an
 *    implementation encounters a relative path [...] it should consider the
 *    path invalid and ignore it."
 *
 * Source: https://specifications.freedesktop.org/basedir-spec/latest/
 *
 * So: unset, blank, whitespace-only and relative all fall back, and the env
 * var wins in every other case. `env` and `home` are parameters rather than
 * ambient reads so the resolution is testable without mutating the process.
 */
import path from 'node:path';
import os from 'node:os';

/** Honour `value` only when it is set, non-blank and absolute; else `fallback()`. */
function absoluteOr(value: string | undefined, fallback: () => string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback();
  // POSIX rules decide: on Windows these variables are not part of any
  // platform convention, and a bare `C:foo` is not absolute anywhere.
  return path.isAbsolute(trimmed) ? trimmed : fallback();
}

/**
 * `home` when it is an absolute path, else the home directory the user
 * database gives (`os.userInfo().homedir`), else an Error. `os.homedir()`
 * returns `$HOME` as it is, so `HOME=` (an empty value, as some sandboxes and
 * service launchers leave it) made every default path relative:
 * `.config/lexicon/lexicon.yaml` under the process's working directory. The
 * prompt hook runs in the user's repository, so that repository's own
 * `.config/lexicon/lexicon.yaml` was applied as the user's global lexicon (and
 * its `trust.json` consulted) with no trust check, and `hits.json` was written
 * into it. A relative `HOME` is refused the same way.
 */
export function usableHome(home: string): string {
  const trimmed = home.trim();
  if (trimmed && path.isAbsolute(trimmed)) return home;
  let fromUserDb: string | undefined;
  try {
    fromUserDb = os.userInfo().homedir;
  } catch {
    // no entry for this uid
  }
  if (fromUserDb && path.isAbsolute(fromUserDb)) return fromUserDb;
  const what = trimmed ? `the relative path ${JSON.stringify(trimmed)}` : 'empty';
  throw new Error(`no usable home directory: HOME is ${what} and the user database has none; set HOME to an absolute path, or LEXICON_PATH to the lexicon file`);
}

export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_CONFIG_HOME, () => path.join(usableHome(home), '.config'));
}

export function xdgDataHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_DATA_HOME, () => path.join(usableHome(home), '.local', 'share'));
}

export function xdgStateHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_STATE_HOME, () => path.join(usableHome(home), '.local', 'state'));
}

/**
 * The global lexicon file: `$LEXICON_PATH` when set, else
 * `<XDG config home>/lexicon/lexicon.yaml`. `resolvePaths` in core/store.ts
 * adds an explicit override on top; the plugin hook's entry stub uses this to
 * find the directory its compile cache lives in without loading the store.
 */
export function globalLexiconPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.LEXICON_PATH || path.join(xdgConfigHome(env, home), 'lexicon', 'lexicon.yaml');
}
