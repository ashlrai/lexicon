/**
 * XDG Base Directory resolution, in one place.
 *
 * Four call sites used to read `XDG_CONFIG_HOME` four different ways — `||`
 * on `process.env` directly, a trimmed truthiness check, and twice with `??`
 * — so `XDG_CONFIG_HOME=""` produced a *relative* path in two of them and the
 * `~/.config` fallback in the other two. The spec is explicit on both points:
 *
 *   "If $XDG_CONFIG_HOME is either not set or empty, a default equal to
 *    $HOME/.config should be used."
 *   "All paths set in these environment variables must be absolute. If an
 *    implementation encounters a relative path [...] it should consider the
 *    path invalid and ignore it."
 *
 * — https://specifications.freedesktop.org/basedir-spec/latest/
 *
 * So: unset, blank, whitespace-only and relative all fall back, and the env
 * var wins in every other case. `env` and `home` are parameters rather than
 * ambient reads so the resolution is testable without mutating the process.
 */
import path from 'node:path';
import os from 'node:os';

/** Honour `value` only when it is set, non-blank and absolute; else `fallback`. */
function absoluteOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  // POSIX rules decide: on Windows these variables are not part of any
  // platform convention, and a bare `C:foo` is not absolute anywhere.
  return path.isAbsolute(trimmed) ? trimmed : fallback;
}

export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_CONFIG_HOME, path.join(home, '.config'));
}

export function xdgDataHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_DATA_HOME, path.join(home, '.local', 'share'));
}

export function xdgStateHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return absoluteOr(env.XDG_STATE_HOME, path.join(home, '.local', 'state'));
}
