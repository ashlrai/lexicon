/**
 * What this tool knows about Claude Code's own configuration: the shape of
 * `settings.json`, how a hook is merged into it without disturbing anything
 * else, how to tell whether the lexicon plugin is already registered, and
 * where the MCP server and hook entry points live.
 *
 * Shared by `lexicon install claude` (which writes these files) and
 * `lexicon doctor` (which reads them back and reports on them), so the two
 * cannot drift apart about what "installed" means.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { homeDir, usableHome } from '../util/xdg.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../util/json.js';
import { PACKAGE_NAME, UNKNOWN_VERSION, packageVersion } from '../util/package.js';
import { findPackageRoot } from './cli-entry.js';

/** Hook events the lexicon hook handles; `install-claude` registers both. */
export const HOOK_EVENTS: readonly string[] = ['UserPromptSubmit', 'SessionStart'];

/**
 * Claude Code's config directory: `$CLAUDE_CONFIG_DIR` when set, else
 * `~/.claude` -- which is `%USERPROFILE%\.claude` on Windows, since
 * `os.homedir()` reads USERPROFILE there. Claude Code does not honour
 * XDG_CONFIG_HOME, so neither do we.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  // The home default is read only when it is needed, and never as an empty or relative HOME.
  return override ? override : path.join(home === undefined ? homeDir() : usableHome(home), '.claude');
}

/** Commands `install-claude` (any version) or the plugin register for the hook. */
const LEXICON_HOOK_COMMAND = /user-prompt-submit\.js|plugin[\\/]hook\.mjs|lexicon/i;

/**
 * The id (`lexicon@<marketplace>`) under which the lexicon plugin is recorded,
 * either in Claude's plugin registry (`installed_plugins.json`, `plugins` keyed
 * by id) or in settings.json `enabledPlugins`; undefined when neither lists it.
 */
export function findInstalledLexiconPlugin(settings: unknown, installedPlugins: unknown): string | undefined {
  const isLexicon = (id: string): boolean => /^lexicon@/i.test(id);
  if (isRecord(installedPlugins) && isRecord(installedPlugins.plugins)) {
    const id = Object.keys(installedPlugins.plugins).find(isLexicon);
    if (id) return id;
  }
  if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
    const id = Object.entries(settings.enabledPlugins).find(([k, v]) => isLexicon(k) && v === true)?.[0];
    if (id) return id;
  }
  return undefined;
}

/** True when settings.json registers a lexicon hook command for `event`. */
export function settingsHasLexiconHook(settings: unknown, event: string): boolean {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return false;
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (g) =>
      isRecord(g) &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isRecord(h) && typeof h.command === 'string' && LEXICON_HOOK_COMMAND.test(h.command)),
  );
}

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function hookConfigFor(
  command: string,
  timeout = 5,
  events: readonly string[] = ['UserPromptSubmit'],
): { hooks: Record<string, HookGroup[]> } {
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of events) hooks[event] = [{ hooks: [{ type: 'command', command, timeout }] }];
  return { hooks };
}

/**
 * A hook command `lexicon install claude` wrote, from any install location:
 * `node "<dir>/plugin/hook.mjs"`, `node "<dir>/dist/hooks/user-prompt-submit.js"`
 * (quoted or not, either separator) or `npx -y @ashlr/lexicon[@<version>] hook`.
 * Narrower than LEXICON_HOOK_COMMAND, which also matches a user's own script
 * with "lexicon" in its name: only these are replaced on a reinstall.
 */
const INSTALLED_HOOK_COMMAND =
  /^node\s+(?:"[^"]*|[^\s"]*)(?:[\\/]plugin[\\/]hook\.mjs|[\\/]hooks[\\/]user-prompt-submit\.js)"?$|^npx\s+-y\s+@ashlr\/lexicon(?:@\S+)?\s+hook$/;

export function isInstalledLexiconHook(command: string): boolean {
  return INSTALLED_HOOK_COMMAND.test(command.trim());
}

/**
 * A `lexicon` MCP server launch an install of this tool wrote, from any
 * location: `node <dir>/plugin/mcp-server.mjs` or `node <dir>/dist/mcp/server.js`
 * (the `node` command possibly an absolute path to it), or
 * `npx -y @ashlr/lexicon[@<version>] mcp`. `args` is the arguments joined by
 * single spaces, as `claude mcp get` prints them. A server of the user's own
 * that happens to be called `lexicon` does not match, so it is never
 * repointed or removed.
 */
export function isInstalledLexiconServer(command: string, args: string): boolean {
  const cmd = command.trim();
  const a = args.trim();
  if (/(?:^|[\\/])node(?:\.exe)?$/i.test(cmd)) {
    return /^"?.*(?:[\\/]plugin[\\/]mcp-server\.mjs|[\\/]mcp[\\/]server\.js)"?$/.test(a);
  }
  if (/(?:^|[\\/])npx(?:\.cmd)?$/i.test(cmd)) return /^-y @ashlr\/lexicon(?:@\S+)? mcp$/.test(a);
  return false;
}

/** What `claude mcp get <name>` printed about a server: its scope, command and arguments line. */
export interface ClaudeMcpRegistration {
  scope?: 'user' | 'project' | 'local';
  command?: string;
  /** The arguments joined by spaces, as printed. */
  args?: string;
}

/**
 * Read the `Scope:`, `Command:` and `Args:` lines of `claude mcp get`'s output
 * (`Scope: User config (available in all your projects)`, `Command: node`,
 * `Args: /x/plugin/mcp-server.mjs`). A line it does not print is left out.
 */
export function parseClaudeMcpGet(out: string): ClaudeMcpRegistration {
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}:[ \\t]*(.*?)\\s*$`, 'm').exec(out)?.[1];
  const result: ClaudeMcpRegistration = {};
  const scope = field('Scope')?.toLowerCase();
  if (scope?.startsWith('user')) result.scope = 'user';
  else if (scope?.startsWith('project')) result.scope = 'project';
  else if (scope?.startsWith('local')) result.scope = 'local';
  const command = field('Command');
  if (command) result.command = command;
  const args = field('Args');
  if (args !== undefined) result.args = args;
  return result;
}

/**
 * Merge a hook running `command` for each of `events` into a Claude settings
 * object. Never mutates the input. Existing hooks (any event) are preserved;
 * an event that already has a hook with an identical command is left alone.
 * One that has a hook an earlier install wrote from another location (an
 * upgrade, a move from a checkout to `npm i -g`, npx to a global install;
 * see isInstalledLexiconHook) gets that hook pointed at `command` instead of a
 * second one, so every prompt does not run the hook twice; any further copy
 * of it is removed (with its group when nothing else is left in it).
 */
export function mergeHookIntoSettings(
  settings: unknown,
  command: string,
  timeout = 5,
  events: readonly string[] = ['UserPromptSubmit'],
): { settings: ClaudeSettings; changed: boolean } {
  const base: ClaudeSettings = isRecord(settings) ? (structuredClone(settings) as ClaudeSettings) : {};
  if (base.hooks !== undefined && !isRecord(base.hooks)) {
    throw new Error('settings.hooks is not an object; refusing to overwrite it');
  }
  const hooks: Record<string, unknown> = isRecord(base.hooks) ? base.hooks : {};
  let changed = false;

  for (const event of events) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`settings.hooks.${event} is not an array; refusing to overwrite it`);
    }
    const groups: HookGroup[] = Array.isArray(existing) ? (existing as HookGroup[]) : [];
    const ours = (h: unknown): h is HookCommand =>
      isRecord(h) && typeof h.command === 'string' && (h.command === command || isInstalledLexiconHook(h.command));
    const found = groups.flatMap((g) => (isRecord(g) && Array.isArray(g.hooks) ? g.hooks.filter(ours) : []));
    if (found.length === 0) {
      groups.push({ hooks: [{ type: 'command', command, timeout }] });
      hooks[event] = groups;
      changed = true;
      continue;
    }
    // Keep the exact one when there is one (its timeout may be the user's), else repoint the first.
    const keep = found.find((h) => h.command === command) ?? found[0];
    if (keep && keep.command !== command) {
      keep.command = command;
      keep.timeout = timeout;
      changed = true;
    }
    if (found.length > 1) {
      const next: HookGroup[] = [];
      for (const g of groups) {
        if (!isRecord(g) || !Array.isArray(g.hooks) || !g.hooks.some((h) => ours(h) && h !== keep)) {
          next.push(g);
          continue;
        }
        const left = g.hooks.filter((h) => !ours(h) || h === keep);
        if (left.length > 0) next.push({ ...g, hooks: left });
      }
      hooks[event] = next;
      changed = true;
    }
  }

  if (changed) base.hooks = hooks as Record<string, HookGroup[]>;
  return { settings: base, changed };
}

export interface IntegrationPaths {
  /** Absolute path to the MCP server entry point. */
  server: string;
  /** Absolute path to the hook entry point. */
  hook: string;
  /** True when the self-contained bundles under plugin/ were found and chosen. */
  bundled: boolean;
}

/**
 * Where `install-claude` / `install` point clients at. Prefers the
 * self-contained bundles in `<package root>/plugin/` (no node_modules needed
 * at runtime, same files the Claude Code plugin uses) and falls back to the
 * tsc output under `<package root>/dist/` when they are absent (e.g. a
 * checkout that only ran `npm run build`). Without `cliDir` the package root
 * comes from `findPackageRoot` (cli-entry.ts), so the result is the same
 * whether this module runs from dist/ or inlined in the plugin bundle.
 */
export function resolveIntegrationPaths(cliDir?: string): IntegrationPaths {
  const pkgRoot = cliDir === undefined ? findPackageRoot(import.meta.url) : undefined;
  const dir = cliDir ?? (pkgRoot ? path.join(pkgRoot, 'dist', 'cli') : path.dirname(fileURLToPath(import.meta.url)));
  const root = path.resolve(dir, '..', '..');
  const bundledServer = path.join(root, 'plugin', 'mcp-server.mjs');
  const bundledHook = path.join(root, 'plugin', 'hook.mjs');
  if (existsSync(bundledServer) && existsSync(bundledHook)) {
    return { server: bundledServer, hook: bundledHook, bundled: true };
  }
  return {
    server: path.resolve(dir, '../mcp/server.js'),
    hook: path.resolve(dir, '../hooks/user-prompt-submit.js'),
    bundled: false,
  };
}

// ---------------------------------------------------------------------------
// Launching the server and the hook, from wherever this copy happens to live
// ---------------------------------------------------------------------------

/**
 * npm's `npx` cache: `~/.npm/_npx/<hash>/node_modules/@ashlr/lexicon/...`.
 * npm garbage-collects those directories, so an absolute path into one is a
 * config entry with an expiry date on it.
 */
const NPX_CACHE_SEGMENT = /[\\/]_npx[\\/]/;

/**
 * Claude Code's plugin cache: `<config dir>/plugins/cache/<marketplace>/lexicon/<version>/...`,
 * where the plugin's MCP server runs from. Each plugin update installs a new
 * version directory and retires the old one, so a client config or a hook
 * written with a path into it runs the old version until that directory is
 * removed, and then nothing at all.
 */
const PLUGIN_CACHE_SEGMENT = /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]lexicon[\\/]/;

/**
 * True when `p` lives in a cache another program deletes or replaces: npm's
 * npx cache (this process was started by `npx @ashlr/lexicon ...` and nothing
 * on this machine owns the files) or Claude Code's per-version plugin cache
 * (this is the plugin's MCP server, e.g. `install_client` or `setup_lexicon`
 * called from a plugin session).
 */
export function isVolatileEntry(p: string): boolean {
  return NPX_CACHE_SEGMENT.test(p) || PLUGIN_CACHE_SEGMENT.test(p);
}

/** A command and its arguments, as a client config or a hook line needs them. */
export interface StdioLaunch {
  command: string;
  args: string[];
  /**
   * True when the launch re-resolves the package through npx at run time
   * instead of pointing at a file. Callers use it to widen hook timeouts and
   * to explain the tradeoff.
   */
  viaNpx: boolean;
}

/**
 * How another program should start the lexicon `subcommand` (`mcp` or `hook`).
 *
 * Normally `node <absolute path>`: fastest, and the file is owned by a real
 * install. But `npx @ashlr/lexicon@latest setup` runs from a cache directory
 * npm may delete at any time, and writing that path into Cursor's config
 * would leave the user with an MCP server that works today and is gone next
 * week. In that case we write `npx -y @ashlr/lexicon@<version> <subcommand>`
 * instead, which re-resolves the package on every start: slower to boot, but
 * it keeps working, and it installs nothing.
 *
 * The version is pinned rather than `@latest` so a config keeps behaving the
 * way it did the day it was written.
 */
export function launchFor(entryPath: string, subcommand: 'mcp' | 'hook', version?: string): StdioLaunch {
  if (!isVolatileEntry(entryPath)) return { command: 'node', args: [entryPath], viaNpx: false };
  const v = version ?? packageVersion(import.meta.url);
  const spec = v === UNKNOWN_VERSION ? PACKAGE_NAME : `${PACKAGE_NAME}@${v}`;
  return { command: 'npx', args: ['-y', spec, subcommand], viaNpx: true };
}

/**
 * Hook timeout in seconds. A `node <path>` hook answers in ~20ms; an npx one
 * has to check its cache first and takes about a second, so it gets room to
 * do that without Claude Code killing it mid-prompt.
 */
export function hookTimeoutFor(launch: StdioLaunch): number {
  return launch.viaNpx ? 15 : 5;
}

/**
 * A launch rendered as a single shell command line, for settings.json hooks.
 *
 * File paths are always quoted, whether or not they currently need it: the
 * string is stored and re-read by another program, and a user who later moves
 * the install under a directory with a space in it should not have to notice.
 * Package specs and subcommand names (`-y`, `@ashlr/lexicon@0.5.0`, `hook`)
 * are left bare so the line stays readable.
 *
 * The backslash is the whole difficulty. On POSIX it is the shell's escape
 * character and has to be doubled inside the quotes. On Windows it is the
 * path separator and nothing else, so doubling it corrupts every path this
 * writes: `C:\Users\me\...` went into settings.json as
 * `"C:\\Users\\me\\..."`, which is not the file. Windows also cannot put a
 * `"` in a filename, so quoting there needs no escaping at all -- and the
 * other three POSIX metacharacters (`$`, backtick, `'`) are ordinary
 * characters to cmd.exe and PowerShell, so escaping them would break a path
 * that legitimately contains one.
 */
export function launchCommandLine(launch: StdioLaunch, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  // path.win32/path.posix rather than the host's `path`: with `platform`
  // passed in, the host's isAbsolute answers for the wrong OS and a
  // `C:\...` path reads as relative (so it would go in unquoted) on a Mac.
  const p = win ? path.win32 : path.posix;
  const quote = (s: string): string => {
    if (win) return /[\s"]/.test(s) || p.isAbsolute(s) ? `"${s.replace(/"/g, '')}"` : s;
    return /[\s"'$`\\]/.test(s) || p.isAbsolute(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
  };
  return [launch.command, ...launch.args].map(quote).join(' ');
}

/**
 * Run a binary and return its stdout, throwing on failure.
 *
 * The child's stderr is captured rather than discarded, and folded into the
 * thrown error: `execFileSync`'s own message is only "Command failed: <cmd>",
 * which told a user whose `claude mcp add` failed precisely nothing. The
 * reason ("MCP server lexicon already exists in user config") lives on the
 * child's output, so that is what the caller gets to show.
 */
export function defaultExec(file: string, args: readonly string[]): string {
  try {
    return execFileSync(file, [...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const text = (stream: unknown): string => (typeof stream === 'string' ? stream.trim() : '');
    const detail = text((err as { stderr?: unknown }).stderr) || text((err as { stdout?: unknown }).stdout);
    if (!detail) throw err;
    // First lines only: a failing CLI can be chatty, and this ends up on one terminal line.
    throw new Error(`${err instanceof Error ? err.message : String(err)}: ${detail.split('\n').slice(0, 3).join(' ')}`);
  }
}

/**
 * Version of the @ashlr/lexicon package.json: two levels above src/cli or
 * dist/cli, one level above the plugin/ bundles (which inline this module).
 * '0.0.0' when neither can be read.
 */
