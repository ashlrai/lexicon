/**
 * `lexicon uninstall <client>`: take back out what `lexicon install <client>
 * --apply` put in, and nothing else.
 *
 * The targets are the install targets (same files, same `--scope` /
 * `--project` / `--home` meaning). Only entries this tool wrote are removed:
 * a `lexicon` server whose launch is one an install writes
 * (isInstalledLexiconServer) and hook commands an install writes
 * (isInstalledLexiconHook). A server of the user's own that happens to be
 * called `lexicon` is named and left alone, and every other key, server,
 * comment and byte of the file is kept (JSON files are edited through
 * editJsonText, Codex's TOML as text). `--dry-run` prints what would go and
 * writes nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { errorMessage, isEnoent } from '../util/errors.js';
import { isRecord, readJsonFile, writeJsonFile } from '../util/json.js';
import { homeDir } from '../util/xdg.js';
import { writeFileAtomic } from '../util/atomic.js';
import { CliRefusal, bold, dim, green, jsonError, line, safe, safePath, shownCommand, safeLines, safeMessage, yellow } from './io.js';
import type { CommonOptions, IO } from './io.js';
import {
  HOOK_EVENTS,
  claudeConfigDir,
  defaultExec,
  findInstalledLexiconPlugin,
  isInstalledLexiconHook,
  isInstalledLexiconServer,
  parseClaudeMcpGet,
  claudeRegistrationFile,
  claudeUserConfigPath,
  readClaudeRegistrationAt,
} from './claude-settings.js';
import type { ClaudeRegistrationFiles } from './claude-settings.js';
import { CODEX_TABLE, INSTALL_CLIENTS, claudeSettingsPathFor, codexServerElsewhere, explainWrite, isTomlTableHeader, resolveServerPath, targetFor } from './cmd-install.js';
import type { InstallClient, InstallTarget } from './cmd-install.js';

export interface UninstallOptions extends CommonOptions {
  /** Print what would be removed; write nothing. */
  dryRun?: boolean;
  /** `user` (default) or `project`, as for `lexicon install`. */
  scope?: string;
  /** Same as `scope: 'project'`. */
  project?: boolean;
  /** Override the home directory (test hook). */
  home?: string;
  /** Print one JSON document (UninstallJsonResult, or `{ ok: false, error, nextStep }`). */
  json?: boolean;
}

export interface UninstallDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs `claude mcp get` / `claude mcp remove`; must throw on failure. Default `defaultExec`. */
  exec?: (file: string, args: readonly string[]) => string;
  /** Claude settings file for the hooks. Default: as `lexicon install claude` picks it. */
  settingsPath?: string;
  /** Claude's user config (`.claude.json`), read when `claude mcp get` shows a registration at another scope. Default `claudeUserConfigPath(env, home)`. */
  claudeUserConfig?: string;
}

/**
 * What uninstall did (or, under `--dry-run`, would do) to one entry:
 * `removed`, `absent` (nothing of lexicon's there), or `kept` (an entry named
 * lexicon that this tool did not write, left alone).
 */
export type UninstallOutcome = 'removed' | 'absent' | 'kept';

export interface UninstallChange {
  /** The file (or, for the Claude Code registration, `claude mcp`) the entry lives in. */
  file: string;
  /** The entry: `mcpServers.lexicon`, `[mcp_servers.lexicon]`, `hooks`, `lexicon server`. */
  entry: string;
  outcome: UninstallOutcome;
}

export interface UninstallJsonResult {
  ok: true;
  client: string;
  scope: 'user' | 'project';
  dryRun: boolean;
  changes: UninstallChange[];
  /** The text the command prints without --json, uncoloured. */
  output: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True when a parsed JSON server entry is one `lexicon install` writes. */
export function isInstalledServerEntry(entry: unknown): boolean {
  if (!isRecord(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)) return false;
  if (!entry.args.every((a): a is string => typeof a === 'string')) return false;
  return isInstalledLexiconServer(entry.command, entry.args.join(' '));
}

/**
 * `current` without `<key>.lexicon` when that entry is one `lexicon install`
 * wrote. Never mutates the input. `kept` leaves `next` equal to `current`.
 */
export function removeServerFromJson(current: unknown, key: 'mcpServers' | 'servers'): { next: unknown; outcome: UninstallOutcome } {
  if (!isRecord(current) || !isRecord(current[key]) || !Object.prototype.hasOwnProperty.call(current[key], 'lexicon')) {
    return { next: current, outcome: 'absent' };
  }
  const servers = current[key] as Record<string, unknown>;
  if (!isInstalledServerEntry(servers.lexicon)) return { next: current, outcome: 'kept' };
  const next = structuredClone(current);
  delete (next[key] as Record<string, unknown>).lexicon;
  return { next, outcome: 'removed' };
}

/** `[mcp_servers.lexicon]` however its key is spelled (`[mcp_servers."lexicon"]`, `[ mcp_servers . 'lexicon' ]`). */
const isLexiconTable = (l: string): boolean => isTomlTableHeader(l, CODEX_TABLE);
/** `[mcp_servers.lexicon]` or any of its sub-tables (`.env`, `.tools`, ...), however spelled. */
const isLexiconAnyTable = (l: string): boolean => isTomlTableHeader(l, CODEX_TABLE, { orSubTable: true });
const TABLE_RE = /^\s*\[/;

function isBlankOrComment(l: string): boolean {
  const t = l.trim();
  return t === '' || t.startsWith('#');
}

/**
 * A TOML basic-string or array-of-basic-strings value, as `codexBlock` writes
 * it; undefined otherwise. The key may be bare or quoted (`"command"`,
 * `'command'`), as install's key-based matching reads it: only the bare key
 * was read, so a table install recognised as lexicon's was kept by uninstall.
 */
function tomlValue(lines: readonly string[], key: string): unknown {
  const re = new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=\\s*(.+?)\\s*(#[^"\\]]*)?$`);
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) continue;
    try {
      return JSON.parse(m[1] as string) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Codex's config.toml `text` without the `[mcp_servers.lexicon]` table and
 * its sub-tables, when the table's `command` and `args` are a launch
 * `lexicon install codex` writes. A comment or blank line ending a removed
 * table is the user's and stays, as `upsertTomlTable` keeps it.
 */
export function removeServerFromToml(text: string): { next: string; outcome: UninstallOutcome } {
  const lines = text.split('\n');
  const start = lines.findIndex(isLexiconTable);
  if (start < 0) return { next: text, outcome: 'absent' };
  let end = start + 1;
  while (end < lines.length && !TABLE_RE.test(lines[end] ?? '')) end += 1;
  const body = lines.slice(start + 1, end);
  const command = tomlValue(body, 'command');
  const args = tomlValue(body, 'args');
  const owned =
    typeof command === 'string' && Array.isArray(args) && args.every((a) => typeof a === 'string') && isInstalledLexiconServer(command, args.join(' '));
  if (!owned) return { next: text, outcome: 'kept' };
  // Remove the table and every lexicon sub-table, wherever each sits.
  let out = lines;
  for (;;) {
    const at = out.findIndex(isLexiconAnyTable);
    if (at < 0) break;
    let stop = at + 1;
    while (stop < out.length && !TABLE_RE.test(out[stop] ?? '')) stop += 1;
    let bodyEnd = stop;
    while (bodyEnd > at + 1 && isBlankOrComment(out[bodyEnd - 1] ?? '')) bodyEnd -= 1;
    let from = at;
    // One blank line before the table goes with it when nothing but blank follows.
    if (from > 0 && (out[from - 1] ?? '').trim() === '' && (bodyEnd >= out.length || (out[bodyEnd] ?? '').trim() === '')) from -= 1;
    out = [...out.slice(0, from), ...out.slice(bodyEnd)];
  }
  let next = out.join('\n');
  if (next.trim() === '') next = '';
  return { next, outcome: 'removed' };
}

/**
 * `settings` without the hook commands `lexicon install claude` writes
 * (isInstalledLexiconHook) under each of `events`. A group left with no hooks
 * goes, an event left with no groups goes, and `hooks` goes when nothing is
 * left in it. Every other hook, group and key is kept. Never mutates the input.
 */
export function removeHooksFromSettings(settings: unknown, events: readonly string[] = HOOK_EVENTS): { settings: unknown; removed: number } {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return { settings, removed: 0 };
  const next = structuredClone(settings);
  const hooks = next.hooks as Record<string, unknown>;
  let removed = 0;
  for (const event of events) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isRecord(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const left = g.hooks.filter((h) => !(isRecord(h) && typeof h.command === 'string' && isInstalledLexiconHook(h.command)));
      removed += g.hooks.length - left.length;
      if (left.length === g.hooks.length) kept.push(g);
      else if (left.length > 0) kept.push({ ...g, hooks: left });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed === 0) return { settings, removed: 0 };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** The command that performs what a `--dry-run` showed: the same flags, without `--dry-run`. */
export function uninstallCommand(client: string, opts: UninstallOptions): string {
  const words = ['lexicon'];
  if (opts.cwd !== undefined && path.resolve(opts.cwd) !== process.cwd()) words.push('--cwd', opts.cwd);
  words.push('uninstall', client);
  if (opts.scope !== undefined) words.push('--scope', opts.scope);
  else if (opts.project) words.push('--project');
  if (opts.home) words.push('--home', opts.home);
  return shownCommand(words);
}

interface Ctx {
  io: IO;
  dryRun: boolean;
  changes: UninstallChange[];
}

function report(ctx: Ctx, change: UninstallChange, detail?: string): void {
  ctx.changes.push(change);
  const where = safePath(change.file);
  if (change.outcome === 'removed') {
    line(ctx.io, green(`   ${ctx.dryRun ? 'would remove' : 'removed'} ${change.entry} from ${where}`));
  } else if (change.outcome === 'kept') {
    line(ctx.io, yellow(`   ${where}: ${change.entry} was not written by lexicon install${detail ? ` (${safePath(detail)})` : ''}; left as it is`));
  } else {
    line(ctx.io, dim(`   ${where}: ${detail ?? `no ${change.entry}`}, nothing to remove`));
  }
}

async function uninstallJson(ctx: Ctx, target: InstallTarget): Promise<void> {
  const entry = `${target.key}.lexicon`;
  const read = await readJsonFile(target.file);
  if (!read.exists) return report(ctx, { file: target.file, entry, outcome: 'absent' }, 'does not exist');
  if (read.error !== undefined) {
    throw new CliRefusal(
      `could not read ${target.file} (${read.error}); nothing was changed`,
      `fix the file (or remove the "lexicon" entry under "${target.key}" by hand), then run this again`,
    );
  }
  const { next, outcome } = removeServerFromJson(read.value, target.key);
  const current = isRecord(read.value) && isRecord(read.value[target.key]) ? (read.value[target.key] as Record<string, unknown>).lexicon : undefined;
  const detail = isRecord(current) ? `${String(current.command)} ${Array.isArray(current.args) ? current.args.join(' ') : ''}`.trim() : undefined;
  if (outcome === 'removed' && !ctx.dryRun) await explainWrite(target.file, () => writeJsonFile(target.file, next, read.text));
  report(ctx, { file: target.file, entry, outcome }, outcome === 'kept' ? detail : undefined);
}

async function uninstallToml(ctx: Ctx, target: InstallTarget): Promise<void> {
  const entry = `[${CODEX_TABLE}]`;
  let text: string;
  try {
    text = await fs.readFile(target.file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return report(ctx, { file: target.file, entry, outcome: 'absent' }, 'does not exist');
    throw new Error(`could not read ${target.file}: ${errorMessage(err)}`);
  }
  // The forms install refuses (an inline table or dotted keys defining the
  // server, an array of tables) are refused here too: removing only the
  // table, or reporting the server absent, would leave lexicon configured.
  const elsewhere = codexServerElsewhere(text);
  if (elsewhere) {
    throw new CliRefusal(
      `${target.file} ${elsewhere}; nothing was changed`,
      `remove that lexicon definition from ${target.file} by hand`,
    );
  }
  const { next, outcome } = removeServerFromToml(text);
  if (outcome === 'removed' && !ctx.dryRun) {
    // Through a temp file and a rename, as install writes it: an in-place
    // write that failed partway left config.toml cut short.
    await explainWrite(target.file, () => writeFileAtomic(target.file, next));
  }
  report(ctx, { file: target.file, entry, outcome });
}

async function uninstallClaude(
  ctx: Ctx,
  scope: 'user' | 'project',
  settingsPath: string,
  exec: (file: string, args: readonly string[]) => string,
  files: ClaudeRegistrationFiles,
): Promise<boolean> {
  const { io } = ctx;
  let ok = true;
  line(io, bold('1. Remove the MCP server registration'));
  const entry = 'lexicon server';
  const where = `claude mcp (${scope} scope)`;
  let out: string | undefined;
  try {
    out = exec('claude', ['mcp', 'get', 'lexicon']);
  } catch (err) {
    const message = errorMessage(err);
    if (/not found|no mcp server/i.test(message)) {
      report(ctx, { file: where, entry, outcome: 'absent' }, 'no lexicon server registered');
    } else {
      ok = false;
      line(io, yellow(`   could not check the registration with claude mcp get lexicon: ${safeLines(message)}`));
      line(io, dim(`   to remove it by hand: claude mcp remove --scope ${scope} lexicon`));
    }
  }
  let got = out === undefined ? undefined : parseClaudeMcpGet(out);
  // `claude mcp get` has no --scope: it shows the registration that takes
  // precedence (local, then project, then user), so one at this scope under
  // another is read from its own file. It was reported as not registered here
  // and left behind.
  let shadow: string | undefined;
  if (got?.scope !== undefined && got.scope !== scope) {
    shadow = got.scope;
    const own = await readClaudeRegistrationAt(scope, files);
    if (own === undefined) {
      ok = false;
      got = undefined;
      line(io, yellow(`   could not read ${safePath(claudeRegistrationFile(scope, files))} to check the ${scope}-scope registration (claude mcp get shows the ${shadow}-scope one)`));
      line(io, dim(`   to remove it by hand: claude mcp remove --scope ${scope} lexicon`));
    } else if (own === null) {
      got = undefined;
      // lexicon install never registers at local scope, and no --scope of
      // this command reaches one: `--scope user` (what it said) finds the
      // same local registration again.
      const how = shadow === 'local' ? `remove it with claude mcp remove --scope local lexicon` : `pass --scope ${shadow} for it, or claude mcp remove --scope ${shadow} lexicon`;
      report(ctx, { file: where, entry, outcome: 'absent' }, `the lexicon server is registered at ${shadow} scope, not ${scope} (${how})`);
    } else {
      got = own;
    }
  }
  if (got !== undefined) {
    const launch = `${got.command ?? ''} ${got.args ?? ''}`.trim();
    if (got.command === undefined || got.args === undefined || !isInstalledLexiconServer(got.command, got.args)) {
      report(ctx, { file: where, entry, outcome: 'kept' }, launch || 'claude mcp get did not show its command');
    } else {
      let removedIt = true;
      if (!ctx.dryRun) {
        try {
          exec('claude', ['mcp', 'remove', '--scope', scope, 'lexicon']);
        } catch (err) {
          ok = false;
          removedIt = false;
          line(io, yellow(`   could not remove it (${safePath(launch)}): ${safeLines(errorMessage(err))}`));
        }
      }
      if (removedIt) report(ctx, { file: where, entry, outcome: 'removed' });
    }
    if (shadow !== undefined) {
      const how = shadow === 'project' ? 'lexicon uninstall claude --scope project' : `claude mcp remove --scope ${shadow} lexicon`;
      line(io, dim(`   note: a ${shadow}-scope lexicon registration is there too and stays; to remove it: ${how}`));
    }
  }
  line(io);
  await removeClaudeHooks(ctx, settingsPath);
  return ok;
}

async function removeClaudeHooks(ctx: Ctx, settingsPath: string): Promise<void> {
  line(ctx.io, bold(`2. Remove the ${HOOK_EVENTS.join(' and ')} hooks`));
  const entry = `lexicon hooks (${HOOK_EVENTS.map((e) => `hooks.${e}`).join(', ')})`;
  const read = await readJsonFile(settingsPath);
  if (!read.exists) return report(ctx, { file: settingsPath, entry, outcome: 'absent' }, 'does not exist');
  if (read.error !== undefined) {
    throw new CliRefusal(
      `could not read ${settingsPath} (${read.error}); nothing was changed there`,
      'fix the file (or remove the lexicon hook entries by hand), then run this again',
    );
  }
  const { settings, removed } = removeHooksFromSettings(read.value);
  if (removed === 0) return report(ctx, { file: settingsPath, entry, outcome: 'absent' });
  if (!ctx.dryRun) await explainWrite(settingsPath, () => writeJsonFile(settingsPath, settings, read.text));
  report(ctx, { file: settingsPath, entry, outcome: 'removed' });
}

/**
 * Handler for `lexicon uninstall <client>`. Returns an exit code; an unknown
 * client, a bad scope or a file it cannot read throws (a `CliRefusal` where
 * there is a next step), as `lexicon install` does.
 */
export async function runUninstall(client: string | undefined, opts: UninstallOptions, io: IO, deps: UninstallDeps = {}): Promise<number> {
  if (!opts.json) return uninstallText(client, opts, io, deps, []);
  let out = '';
  let err = '';
  const buffer: IO = { stdout: (s) => void (out += s), stderr: (s) => void (err += s) };
  const changes: UninstallChange[] = [];
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  const print = (doc: object): void => line(io, JSON.stringify(doc, null, 2));
  const name = (client ?? '').toLowerCase();
  let code: number;
  try {
    code = await uninstallText(client, { ...opts, json: false }, buffer, deps, changes);
  } catch (e) {
    const message = errorMessage(e);
    const nextStep = e instanceof CliRefusal && e.nextStep ? e.nextStep : `fix the problem in error, then run lexicon uninstall ${name} --json again`;
    print(jsonError(message, nextStep));
    io.stderr(`lexicon: ${safeMessage(message)}\nlexicon: ${safeMessage(nextStep)}\n`);
    return 1;
  }
  if (err) io.stderr(err);
  const scope = (opts.scope ?? (opts.project ? 'project' : 'user')) as 'user' | 'project';
  if (code !== 0) {
    print({ ...jsonError(`lexicon uninstall ${name} did not complete; output says which step failed`, `fix that step, then run lexicon uninstall ${name} --json again`), changes, output: plain(out) });
    return code;
  }
  const result: UninstallJsonResult = { ok: true, client: name, scope, dryRun: opts.dryRun === true, changes, output: plain(out) };
  print(result);
  return 0;
}

async function uninstallText(client: string | undefined, opts: UninstallOptions, io: IO, deps: UninstallDeps, changes: UninstallChange[]): Promise<number> {
  const clients = INSTALL_CLIENTS.filter((c) => c !== 'generic');
  const name = (client ?? '').toLowerCase();
  if (!(clients as readonly string[]).includes(name)) {
    throw new CliRefusal(
      client === undefined ? 'name the client to uninstall lexicon from' : `unknown client "${client}" (expected one of: ${clients.join(', ')})`,
      `run lexicon uninstall <client> --dry-run to see what would be removed (one of: ${clients.join(', ')})`,
    );
  }
  const scope = opts.scope ?? (opts.project ? 'project' : 'user');
  if (scope !== 'user' && scope !== 'project') {
    throw new CliRefusal(`--scope must be "user" or "project" (got "${scope}")`, 'pass --scope user or --scope project');
  }
  // --project was dropped without a word, so the user config was edited for
  // someone asking about the repo-level file. Install refuses this too.
  if (scope === 'user' && opts.project === true) {
    throw new CliRefusal('--scope user and --project contradict each other; nothing was changed', 'pass one of them: --scope user for your own config, or --project (--scope project) for the repo-level file');
  }
  const project = scope === 'project';
  const env = deps.env ?? process.env;
  const home = opts.home ? path.resolve(opts.home) : homeDir();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const ctx: Ctx = { io, dryRun: opts.dryRun === true, changes };
  let ok = true;

  if (name === 'claude') {
    const settingsPath =
      deps.settingsPath ?? (opts.home && !project ? path.join(claudeConfigDir(env, home), 'settings.json') : claudeSettingsPathFor(scope, cwd, env));
    // In the directory the uninstall is for, as install runs it: the project
    // and local scopes are that directory's.
    const exec = deps.exec ?? ((file: string, args: readonly string[]): string => defaultExec(file, args, { cwd }));
    ok = await uninstallClaude(ctx, scope, settingsPath, exec, {
      userConfig: deps.claudeUserConfig ?? claudeUserConfigPath(env, home),
      cwd,
    });
    if (!project) {
      const settings = await readJsonFile(settingsPath);
      const installed = await readJsonFile(path.join(path.dirname(settingsPath), 'plugins', 'installed_plugins.json'));
      const pluginId = findInstalledLexiconPlugin(settings.error === undefined ? settings.value : undefined, installed.error === undefined ? installed.value : undefined);
      if (pluginId) line(io, dim(`   note: the lexicon Claude Code plugin (${safe(pluginId)}) is installed and still runs lexicon; to remove it: claude plugin uninstall ${safe(pluginId)}`));
    }
  } else {
    const target = targetFor(name as Exclude<InstallClient, 'claude' | 'generic'>, resolveServerPath(), {
      home,
      cwd,
      platform: deps.platform ?? process.platform,
      env,
      project,
    });
    line(io, bold(`1. Remove the lexicon MCP server from ${target.label}`));
    if (target.format === 'toml') await uninstallToml(ctx, target);
    else await uninstallJson(ctx, target);
  }

  const removed = changes.some((c) => c.outcome === 'removed');
  if (removed && ctx.dryRun) {
    line(io);
    line(io, dim(`to remove it, run: ${uninstallCommand(name, opts)}`));
  } else if (removed) {
    line(io);
    line(io, `then: restart or reload ${name === 'claude' ? 'Claude Code' : 'the client'} so a running session stops starting lexicon; lexicon install ${name} --apply puts it back`);
  }
  return ok ? 0 : 1;
}

export function registerUninstallCommands(program: Command, io: IO): void {
  program
    .command('uninstall')
    .description('remove the MCP config (and, for claude, the hooks) lexicon install wrote for a client; nothing else is touched')
    .argument('[client]', `one of: ${INSTALL_CLIENTS.filter((c) => c !== 'generic').join(', ')}`)
    .option('--dry-run', 'print what would be removed; write nothing')
    .option('--scope <scope>', 'user|project (project = the repo-level config file), as for install')
    .option('--project', 'same as --scope project')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print { ok: true, client, scope, dryRun, changes, output } as JSON ({ ok: false, error, nextStep } on a refusal)')
    .action(async (client: string | undefined, opts: UninstallOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const code = await runUninstall(client, cwd ? { ...opts, cwd } : opts, io);
      if (code !== 0) process.exitCode = code;
    });
}
