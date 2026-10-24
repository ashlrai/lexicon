/**
 * `lexicon install [client]`: print (or with --apply, write) the MCP client
 * configuration that points an agent at the lexicon stdio server.
 *
 * Every writer merges into the existing file, never clobbers unrelated keys,
 * and is idempotent: a second run with the same inputs reports "nothing
 * changed". JSON files are written with 2-space indentation; the Codex TOML
 * file is edited as text (one `[mcp_servers.lexicon]` block) so we do not
 * need a TOML library.
 *
 * `claude` delegates to runInstallClaude below (which also merges the
 * UserPromptSubmit and SessionStart hooks). `lexicon install claude` is the
 * documented spelling; `lexicon install-claude` is a hidden alias kept for
 * back-compat and forwards here (see index.ts).
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { errorMessage, isEnoent } from '../util/errors.js';
import { isRecord, readJsonFile, writeJsonFile } from '../util/json.js';
import { xdgConfigHome } from '../util/xdg.js';
import { CliRefusal, bold, dim, green, indent, jsonError, line, red, safe, safeLines, yellow } from './io.js';
import type { CommonOptions, IO } from './io.js';
import {
  HOOK_EVENTS,
  claudeConfigDir,
  defaultExec,
  findInstalledLexiconPlugin,
  hookConfigFor,
  hookTimeoutFor,
  launchCommandLine,
  launchFor,
  mergeHookIntoSettings,
  resolveIntegrationPaths,
} from './claude-settings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const INSTALL_CLIENTS = [
  'claude',
  'codex',
  'cursor',
  'windsurf',
  'gemini',
  'claude-desktop',
  'vscode',
  'generic',
] as const;

export type InstallClient = (typeof INSTALL_CLIENTS)[number];

export interface InstallOptions extends CommonOptions {
  /** Write the change instead of printing it. */
  apply?: boolean;
  /** `user` (default) or `project`. For non-Claude clients `project` equals --project. */
  scope?: string;
  /** Write the project-level config (./.cursor/mcp.json etc.) instead of the user-level one. */
  project?: boolean;
  /** Override the home directory (test hook). */
  home?: string;
  /**
   * Print one JSON document instead of the text: `{ ok: true, client, scope,
   * applied, written, output }` (`written` the files `--apply` touched, `output`
   * the text the command would have printed) or `{ ok: false, error, nextStep }`.
   */
  json?: boolean;
}

export interface InstallDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Directory containing the built CLI (dist/cli). Default: the package root's dist/cli. */
  cliDir?: string;
  /**
   * Runs `claude mcp add` for the `claude` client; must throw on failure.
   * Default `defaultExec`. Forwarded to `runInstallClaude` so a test can
   * describe what the claude CLI did without one being on the machine.
   */
  exec?: (file: string, args: readonly string[]) => string;
  /** Called once per config file touched under `--apply` (setup uses it for its summary). */
  onWritten?: (file: string, outcome: InstallOutcome) => void;
}

/** A stdio MCP server entry in the shape every client except VS Code uses. */
export interface StdioServerEntry {
  command: string;
  args: string[];
  /** Variables the server needs to find the same lexicon as this shell (see lexiconServerEnv). */
  env?: Record<string, string>;
}

/** Variables `lexicon install` carries into a client's MCP entry when they are set. */
export const PASSTHROUGH_ENV = ['LEXICON_PATH', 'LEXICON_CWD'] as const;

/**
 * The lexicon variables set in `env`, as absolute paths (resolved against
 * `cwd`), or undefined when none is set. `names` defaults to PASSTHROUGH_ENV;
 * `lexicon serve --install` passes its own list (SERVE_PASSTHROUGH_ENV).
 *
 * A GUI client (Claude Desktop, Cursor, VS Code) does not start from the
 * user's shell, so a server it launches never sees an exported LEXICON_PATH:
 * it silently reads ~/.config/lexicon/lexicon.yaml instead of the file the
 * user installed from. Writing them into the entry makes the installed server
 * read the same lexicon `lexicon install` was run against. Relative values
 * are resolved here because the client's working directory is not ours.
 */
export function lexiconServerEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  names: readonly string[] = PASSTHROUGH_ENV,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) out[name] = path.resolve(cwd, value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** VS Code's `servers` map requires an explicit transport type. */
export interface VsCodeServerEntry extends StdioServerEntry {
  type: 'stdio';
}

/** Where a client keeps its config and what the lexicon entry looks like inside it. */
export interface InstallTarget {
  client: InstallClient;
  /** Human name used in headings. */
  label: string;
  /** Absolute path of the file to merge into. */
  file: string;
  /** JSON top-level key holding the server map, or `toml` for Codex. */
  format: 'json' | 'toml';
  /** For JSON targets: the top-level key (`mcpServers` or `servers`). */
  key: 'mcpServers' | 'servers';
  /** The `lexicon` entry to merge under `key`. */
  entry: StdioServerEntry | VsCodeServerEntry;
  /** Where that client reads its standing instructions from (for the export hint). */
  rulesFile: string;
}

/** Result of one merge, used by both the JSON and TOML writers. */
export interface MergeResult<T> {
  next: T;
  changed: boolean;
}

function isInstallClient(value: string): value is InstallClient {
  return (INSTALL_CLIENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the MCP server entry, resolved from the built CLI's
 * directory: the self-contained plugin/mcp-server.mjs when present, else
 * dist/mcp/server.js (see resolveIntegrationPaths).
 */
export function resolveServerPath(cliDir?: string): string {
  return resolveIntegrationPaths(cliDir).server;
}

interface PathContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  project: boolean;
}

/** %APPDATA% on Windows, with a sane fallback when the variable is unset. */
function appData(ctx: PathContext): string {
  return ctx.env.APPDATA ?? path.join(ctx.home, 'AppData', 'Roaming');
}

/** `$CODEX_HOME` when set, else `~/.codex`. */
function codexHome(ctx: PathContext): string {
  const override = ctx.env.CODEX_HOME?.trim();
  return override ? override : path.join(ctx.home, '.codex');
}

/** `$GEMINI_CLI_HOME/.gemini` when set, else `~/.gemini`. */
function geminiHome(ctx: PathContext): string {
  const override = ctx.env.GEMINI_CLI_HOME?.trim();
  return path.join(override ? override : ctx.home, '.gemini');
}

/** The config file each client reads. Throws when the client has no project-level file. */
export function configPathFor(client: Exclude<InstallClient, 'claude' | 'generic'>, ctx: PathContext): string {
  const { home, cwd, platform, project } = ctx;
  switch (client) {
    case 'codex':
      // `CODEX_HOME` relocates the whole ~/.codex directory (documented, and
      // Codex errors out when it points somewhere that does not exist).
      return project ? path.join(cwd, '.codex', 'config.toml') : path.join(codexHome(ctx), 'config.toml');
    case 'cursor':
      // Cursor documents only the `~/.cursor/mcp.json` form and honours no
      // env override; `~` is %USERPROFILE% on Windows, which os.homedir() gives.
      return project ? path.join(cwd, '.cursor', 'mcp.json') : path.join(home, '.cursor', 'mcp.json');
    case 'windsurf':
      if (project) throw new Error('windsurf has no project-level MCP config; drop --project');
      return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'gemini':
      // `GEMINI_CLI_HOME` moves the directory that holds `.gemini`, not the
      // `.gemini` directory itself.
      return project ? path.join(cwd, '.gemini', 'settings.json') : path.join(geminiHome(ctx), 'settings.json');
    case 'claude-desktop': {
      if (project) throw new Error('claude-desktop has no project-level MCP config; drop --project');
      if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (platform === 'win32') return path.join(appData(ctx), 'Claude', 'claude_desktop_config.json');
      // Linux is best effort: Anthropic documents only the macOS and Windows
      // paths, so follow the XDG variable when it is set rather than assuming
      // ~/.config.
      return path.join(xdgConfigHome(ctx.env, home), 'Claude', 'claude_desktop_config.json');
    }
    case 'vscode': {
      if (project) return path.join(cwd, '.vscode', 'mcp.json');
      if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      if (platform === 'win32') return path.join(appData(ctx), 'Code', 'User', 'mcp.json');
      // Not XDG: VS Code hardcodes $HOME/.config/Code on Linux and ignores
      // XDG_CONFIG_HOME (userDataProfile.ts). Honouring the variable here
      // would write a file VS Code never reads.
      return path.join(home, '.config', 'Code', 'User', 'mcp.json');
    }
  }
}

/** Name of the rules/memory file the export hint should point at. */
function rulesFileFor(client: InstallClient): string {
  switch (client) {
    case 'claude':
      return 'CLAUDE.md';
    case 'codex':
      return 'AGENTS.md';
    case 'cursor':
      return '.cursor/rules/lexicon.mdc';
    case 'windsurf':
      return '.windsurfrules';
    case 'gemini':
      return 'GEMINI.md';
    case 'claude-desktop':
      return 'the project instructions (or Settings > Profile > preferences)';
    case 'vscode':
      return '.github/copilot-instructions.md';
    default:
      return 'the agent’s rules or memory file';
  }
}

/**
 * What writing the file does not guarantee, per client, when the vendor's own
 * discovery rules have a condition we cannot check from here. Printed after
 * the write so the user is not left wondering why a correct config is being
 * ignored. Empty for the clients whose discovery is unconditional.
 */
function clientCaveat(client: InstallClient, project: boolean): string | undefined {
  if (client === 'codex' && project) {
    return 'Codex only reads a repo-local .codex/config.toml once you have marked this project as trusted; until then the file is loaded but disabled.';
  }
  if (client === 'vscode' && !project) {
    return 'VS Code keeps this file per profile. The path above is the default profile of VS Code stable; if you use a custom profile or Insiders, run "MCP: Open User Configuration" in VS Code and paste the entry there instead.';
  }
  if (client === 'gemini') {
    return 'If your settings.json sets mcp.allowed, add "lexicon" to that list or Gemini CLI will skip this server.';
  }
  return undefined;
}

/**
 * What the user does after the write so the client loads the new server. No
 * client here starts a server it was not running when its config changed on
 * disk: the CLIs (Claude Code, Codex, Gemini CLI) read their config when a
 * session starts, Claude Desktop only at launch, Cursor and VS Code on a
 * window reload, and Windsurf when its MCP panel is refreshed. Undefined for
 * `generic`, whose client is unknown.
 */
export function reloadStepFor(client: InstallClient): string | undefined {
  switch (client) {
    case 'claude':
      return 'restart Claude Code: a running session keeps the MCP servers and hooks it started with, so exit it and start a new one (/mcp then lists lexicon).';
    case 'codex':
      return 'restart Codex: it reads config.toml when a session starts, so exit any running codex session and start a new one (/mcp then lists lexicon).';
    case 'cursor':
      return 'reload the Cursor window (Command Palette: Developer: Reload Window) or restart Cursor, then check that lexicon is enabled in Cursor Settings > MCP.';
    case 'windsurf':
      return 'refresh the MCP servers in Windsurf (the refresh button in the Cascade MCP panel) or restart Windsurf.';
    case 'gemini':
      return 'restart Gemini CLI: it reads settings.json when it starts, so exit any running gemini session and start a new one (/mcp then lists lexicon).';
    case 'claude-desktop':
      return 'restart Claude Desktop: it reads this only at launch, so quit it completely (not just the window) and reopen it.';
    case 'vscode':
      return 'reload the VS Code window (Command Palette: Developer: Reload Window), or start lexicon from MCP: List Servers.';
    default:
      return undefined;
  }
}

function labelFor(client: InstallClient): string {
  switch (client) {
    case 'codex':
      return 'OpenAI Codex CLI';
    case 'cursor':
      return 'Cursor';
    case 'windsurf':
      return 'Windsurf';
    case 'gemini':
      return 'Gemini CLI';
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'vscode':
      return 'VS Code';
    case 'claude':
      return 'Claude Code';
    default:
      return 'any MCP client';
  }
}

export function targetFor(
  client: Exclude<InstallClient, 'claude' | 'generic'>,
  serverPath: string,
  ctx: PathContext,
): InstallTarget {
  // `node <abs path>` normally; `npx -y @ashlr/lexicon@<v> mcp` when this copy
  // is running out of an npx or plugin cache, which may be deleted (see launchFor).
  const launch = launchFor(serverPath, 'mcp');
  const env = lexiconServerEnv(ctx.env, ctx.cwd);
  const base: StdioServerEntry = { command: launch.command, args: launch.args, ...(env ? { env } : {}) };
  const file = configPathFor(client, ctx);
  const common = { client, label: labelFor(client), file, rulesFile: rulesFileFor(client) };
  switch (client) {
    case 'codex':
      return { ...common, format: 'toml', key: 'mcpServers', entry: base };
    case 'vscode':
      return { ...common, format: 'json', key: 'servers', entry: { type: 'stdio', ...base } };
    default:
      return { ...common, format: 'json', key: 'mcpServers', entry: base };
  }
}

// ---------------------------------------------------------------------------
// Pure merge helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge `entry` as `<key>.lexicon` into a parsed JSON config. Never mutates the
 * input; every other key (and every other server) is preserved. `changed` is
 * false when the managed launch fields already match. Client-owned options
 * such as env, disabled, timeouts and allowlists survive a reinstall.
 */
export function mergeServerIntoJson(
  current: unknown,
  key: 'mcpServers' | 'servers',
  entry: StdioServerEntry | VsCodeServerEntry,
): MergeResult<Record<string, unknown>> {
  if (!isRecord(current)) {
    throw new Error('client config is not an object; refusing to overwrite it');
  }
  const base: Record<string, unknown> = structuredClone(current);
  const existingMap = base[key];
  if (existingMap !== undefined && !isRecord(existingMap)) {
    throw new Error(`"${key}" is not an object; refusing to overwrite it`);
  }
  const servers: Record<string, unknown> = isRecord(existingMap) ? existingMap : {};
  const existingEntry = servers.lexicon;
  if (existingEntry !== undefined && !isRecord(existingEntry)) {
    throw new Error('"lexicon" is not an object; refusing to overwrite it');
  }
  // A remote entry cannot safely become stdio by retaining its URL or
  // transport discriminator. Leave it intact for an explicit manual choice.
  if (isRecord(existingEntry) && (
    ['url', 'httpUrl', 'serverUrl', 'sseUrl'].some(key => key in existingEntry)
    || (existingEntry.type !== undefined && existingEntry.type !== 'stdio')
  )) {
    throw new Error('"lexicon" uses a different transport; resolve its remote fields before installing stdio');
  }
  const mergedEntry: Record<string, unknown> = { ...(isRecord(existingEntry) ? existingEntry : {}), ...structuredClone(entry) };
  // Ours fill in what the entry lacks; a variable the user already set there
  // (their own LEXICON_PATH included) is theirs and is kept.
  if (entry.env && isRecord(existingEntry) && isRecord(existingEntry.env)) {
    mergedEntry.env = { ...entry.env, ...existingEntry.env };
  }
  if (deepEqual(existingEntry, mergedEntry)) {
    return { next: base, changed: false };
  }
  servers.lexicon = mergedEntry;
  base[key] = servers;
  return { next: base, changed: true };
}

/** TOML basic-string literal. JSON's escaping rules are a subset of TOML's. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

export const CODEX_TABLE = 'mcp_servers.lexicon';

/** The `[mcp_servers.lexicon]` block for Codex's config.toml (no trailing newline). */
export function codexBlock(entry: StdioServerEntry): string {
  const lines = [
    `[${CODEX_TABLE}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
  if (entry.env) {
    const pairs = Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
    lines.push(`env = { ${pairs.join(', ')} }`);
  }
  return lines.join('\n');
}

/**
 * Add `values` to an existing `[header]` table, after its last key line. A key
 * the table already sets is left as the user wrote it, like every other key,
 * comment and table. `text` must contain the header.
 */
export function upsertTomlKeys(text: string, header: string, values: Record<string, string>): MergeResult<string> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => tomlHeaderRe(header).test(l));
  if (start === -1) throw new Error(`[${header}] not found`);
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) end += 1;
  while (end > start + 1 && isBlankOrComment(lines[end - 1] ?? '')) end -= 1;
  const append: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const keyRe = new RegExp(`^\\s*"?${key}"?\\s*=`);
    if (!lines.some((l, i) => i > start && i < end && keyRe.test(l))) append.push(`${key} = ${tomlString(value)}`);
  }
  lines.splice(end, 0, ...append);
  const next = lines.join('\n');
  return { next, changed: next !== text };
}

function tomlHeaderRe(header: string): RegExp {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\s*${escaped}\\s*\\]\\s*(#.*)?$`);
}

/**
 * Insert or replace one top-level TOML table in `text`. The table spans from
 * its `[header]` line to (not including) the next line that starts with `[`,
 * so sub-tables such as `[mcp_servers.lexicon.env]` and every other table are
 * left alone. `block` must start with the `[header]` line.
 */
function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

export function upsertTomlTable(text: string, header: string, block: string): MergeResult<string> {
  const lines = text.split('\n');
  const headerRe = tomlHeaderRe(header);
  const start = lines.findIndex((l) => headerRe.test(l));
  const blockLines = block.split('\n');

  if (start === -1) {
    const trimmed = text.replace(/\s+$/, '');
    const next = trimmed === '' ? `${block}\n` : `${trimmed}\n\n${block}\n`;
    return { next, changed: true };
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) end += 1;
  // Keep the old block's tail of blank and comment-only lines outside the
  // replacement: a user's `# keep me` sitting between our block and the next
  // table (or the end of the file) is theirs, not ours to rewrite.
  let bodyEnd = end;
  while (bodyEnd > start + 1 && isBlankOrComment(lines[bodyEnd - 1] ?? '')) bodyEnd -= 1;
  const oldBlock = lines.slice(start, bodyEnd).join('\n');
  if (oldBlock === block) return { next: text, changed: false };

  const nextLines = [...lines.slice(0, start), ...blockLines, ...lines.slice(bodyEnd)];
  let next = nextLines.join('\n');
  if (!next.endsWith('\n')) next += '\n';
  return { next, changed: true };
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

async function readText(file: string): Promise<{ text: string; existed: boolean }> {
  try {
    return { text: await fs.readFile(file, 'utf8'), existed: true };
  } catch (err) {
    if (isEnoent(err)) return { text: '', existed: false };
    throw new Error(`could not read ${file}: ${errorMessage(err)}`);
  }
}

async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

/** Apply a JSON target. Returns what happened for the report line. */
async function applyJson(target: InstallTarget): Promise<InstallOutcome> {
  const read = await readJsonFile(target.file);
  if (read.error !== undefined) {
    throw new Error(`${target.file} is not valid JSON (${read.error}); fix or remove it first`);
  }
  const { next, changed } = mergeServerIntoJson(read.exists ? read.value : {}, target.key, target.entry);
  if (!changed) return 'unchanged';
  await writeJsonFile(target.file, next);
  return read.exists ? 'updated' : 'created';
}

function mergeChanged(first: MergeResult<string>, second: MergeResult<string>): MergeResult<string> {
  return { next: second.next, changed: first.changed || second.changed };
}

async function applyToml(target: InstallTarget): Promise<InstallOutcome> {
  const { text, existed } = await readText(target.file);
  const { env, ...launch } = target.entry;
  const envTable = `${CODEX_TABLE}.env`;
  // A user who keeps the server's variables in a `[mcp_servers.lexicon.env]`
  // sub-table gets ours added there: an inline `env = {...}` beside it would
  // define the key twice, which TOML rejects.
  const subTable = env !== undefined && text.split('\n').some((l) => tomlHeaderRe(envTable).test(l));
  const table = upsertTomlTable(text, CODEX_TABLE, codexBlock(subTable ? launch : target.entry));
  const { next, changed } = subTable && env ? mergeChanged(table, upsertTomlKeys(table.next, envTable, env)) : table;
  if (!changed) return 'unchanged';
  await writeText(target.file, next);
  return existed ? 'updated' : 'created';
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function jsonSnippet(key: 'mcpServers' | 'servers', entry: StdioServerEntry | VsCodeServerEntry): string {
  return JSON.stringify({ [key]: { lexicon: entry } }, null, 2);
}

/** Quote one word of a printed command for a POSIX shell, only when it needs it. */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a preview names to write what it showed: `lexicon install
 * <client>` with the flags this run was given (`--cwd`, `--scope` or
 * `--project`, `--home`) and `--apply`, so the line can be copied as it is.
 * `--cwd` is named only when it is not the current directory.
 */
export function installApplyCommand(client: InstallClient, opts: InstallOptions): string {
  const words = ['lexicon'];
  if (opts.cwd !== undefined && path.resolve(opts.cwd) !== process.cwd()) words.push('--cwd', opts.cwd);
  words.push('install', client);
  if (opts.scope !== undefined) words.push('--scope', opts.scope);
  else if (opts.project) words.push('--project');
  if (opts.home) words.push('--home', opts.home);
  words.push('--apply');
  return safe(words.map(shellWord).join(' '));
}

/** How to take the lexicon entry back out of a client's config file by hand. */
function undoEntry(target: InstallTarget): string {
  return target.format === 'toml'
    ? `delete the [${CODEX_TABLE}] table from ${safe(target.file)}`
    : `delete the "lexicon" entry under "${target.key}" in ${safe(target.file)}`;
}

function printExportHint(io: IO, step: number, client: InstallClient): void {
  line(io, bold(`${step}. Give ${labelFor(client)} the vocabulary`));
  line(io, `   lexicon export claude-md >> ${rulesFileFor(client)}`);
  line(io, dim('   (paste the markdown into that file so the model prefers the canonical spellings even without the MCP tool)'));
}

function printGeneric(io: IO, serverPath: string, env: Record<string, string> | undefined): void {
  const launch = launchFor(serverPath, 'mcp');
  line(io, bold('Generic MCP client configuration'));
  line(io, indent(jsonSnippet('mcpServers', { command: launch.command, args: launch.args, ...(env ? { env } : {}) }), '   '));
  line(io);
  line(io, bold('Supported clients'));
  for (const c of INSTALL_CLIENTS) {
    if (c === 'generic') continue;
    line(io, `   lexicon install ${c}`);
  }
  line(io);
  line(io, dim('name a client and add --apply to write its config, --project for the repo-level file where the client supports one'));
  line(io);
  printExportHint(io, 1, 'generic');
}

/**
 * Handler for `lexicon install [client]`. Returns an exit code.
 * Unknown clients and bad flag combinations throw (index.ts prints the message).
 */
export async function runInstall(
  client: string | undefined,
  opts: InstallOptions,
  io: IO,
  deps: InstallDeps = {},
): Promise<number> {
  if (opts.json) return runInstallJson(client, opts, io, deps);
  return installText(client, opts, io, deps);
}

/** What `lexicon install --json` prints when it succeeds. */
export interface InstallJsonResult {
  ok: true;
  /** The client as resolved (`generic` when none was named). */
  client: string;
  scope: 'user' | 'project';
  applied: boolean;
  /** Each config file `--apply` touched and what happened to it; empty for a preview. */
  written: { file: string; outcome: InstallOutcome }[];
  /** The text `lexicon install` prints without --json, uncoloured. */
  output: string;
}

/**
 * `lexicon install --json`: the text run into a buffer, wrapped in one
 * document. An unknown client or scope (and any other refusal) is
 * `{ ok: false, error, nextStep }`, so a script never parses prose.
 */
async function runInstallJson(client: string | undefined, opts: InstallOptions, io: IO, deps: InstallDeps): Promise<number> {
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
  const written: { file: string; outcome: InstallOutcome }[] = [];
  const onWritten = (file: string, outcome: InstallOutcome): void => {
    written.push({ file, outcome });
    deps.onWritten?.(file, outcome);
  };
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  const print = (doc: object): void => line(io, JSON.stringify(doc, null, 2));
  const name = (client ?? 'generic').toLowerCase();
  let code: number;
  try {
    code = await installText(client, { ...opts, json: false }, buffer, { ...deps, onWritten });
  } catch (e) {
    const message = errorMessage(e);
    const nextStep =
      e instanceof CliRefusal && e.nextStep
        ? e.nextStep
        : !isInstallClient(name)
          ? `name one of: ${INSTALL_CLIENTS.join(', ')} (e.g. lexicon install cursor --json)`
          : /--scope must be/.test(message)
            ? 'pass --scope user or --scope project'
            : `fix the problem in error, then run lexicon install ${name}${opts.apply ? ' --apply' : ''} --json again`;
    print(jsonError(message, nextStep));
    return 1;
  }
  if (err) io.stderr(err);
  if (code !== 0) {
    print({
      ...jsonError(`lexicon install ${name} did not complete; output says which step failed`, `fix that step, then run lexicon install ${name}${opts.apply ? ' --apply' : ''} --json again`),
      output: plain(out),
    });
    return code;
  }
  const scope = (opts.scope ?? (opts.project ? 'project' : 'user')) as 'user' | 'project';
  const result: InstallJsonResult = { ok: true, client: name, scope, applied: opts.apply === true, written, output: plain(out) };
  print(result);
  return 0;
}

async function installText(
  client: string | undefined,
  opts: InstallOptions,
  io: IO,
  deps: InstallDeps,
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = opts.home ? path.resolve(opts.home) : os.homedir();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const serverPath = resolveServerPath(deps.cliDir);

  const scope = opts.scope ?? (opts.project ? 'project' : 'user');
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`--scope must be "user" or "project" (got "${scope}")`);
  }
  const project = scope === 'project' || opts.project === true;

  const name = (client ?? 'generic').toLowerCase();
  if (!isInstallClient(name)) {
    throw new Error(
      `unknown client "${client}" (expected one of: ${INSTALL_CLIENTS.join(', ')})`,
    );
  }

  if (name === 'generic') {
    // There is no generic config file, so --apply or --project with no client
    // would print the snippet and write nothing, exit 0, though the printout
    // said "add --apply to write the config".
    if (opts.apply || project) {
      const flags = [opts.apply ? '--apply' : '', project ? '--project' : ''].filter(Boolean).join(' ');
      const clients = INSTALL_CLIENTS.filter((c) => c !== 'generic');
      throw new CliRefusal(
        `${flags} needs a client: with none named, lexicon install only prints the generic configuration and writes nothing`,
        `name the client to write, e.g. lexicon install cursor ${flags} (one of: ${clients.join(', ')})`,
      );
    }
    printGeneric(io, serverPath, lexiconServerEnv(env, cwd));
    return 0;
  }

  if (name === 'claude') {
    const claudeOpts = { ...opts, scope: project ? 'project' : 'user' };
    const claudeDeps = {
      ...(deps.cliDir ? { cliDir: deps.cliDir } : {}),
      ...(opts.home ? { settingsPath: path.join(claudeConfigDir(process.env, home), 'settings.json') } : {}),
      ...(deps.onWritten ? { onWritten: deps.onWritten } : {}),
      ...(deps.exec ? { exec: deps.exec } : {}),
      env,
    };
    return runInstallClaude({ ...claudeOpts, cwd, applyCommand: installApplyCommand('claude', opts) }, io, claudeDeps);
  }

  const target = targetFor(name, serverPath, { home, cwd, platform, env, project });
  const body = target.format === 'toml' ? codexBlock(target.entry) : jsonSnippet(target.key, target.entry);

  line(io, bold(`1. Add the lexicon MCP server to ${target.label}`));
  line(io, `   ${opts.apply ? 'merge into' : 'would merge into'} ${safe(target.file)}:`);
  line(io, indent(body, '   '));
  if (opts.apply) {
    const outcome = target.format === 'toml' ? await applyToml(target) : await applyJson(target);
    deps.onWritten?.(target.file, outcome);
    if (outcome === 'unchanged') {
      line(io, dim(`   ${safe(target.file)}: lexicon entry already present, nothing changed`));
    } else {
      line(io, green(`   ${outcome} ${safe(target.file)}: ${target.format === 'toml' ? `[${CODEX_TABLE}]` : `${target.key}.lexicon`}`));
    }
    // The write named its file but not the way back; the rest of the file is
    // the user's, so the undo is the one entry, not the file.
    line(io, dim(`   undo: ${undoEntry(target)}`));
  }
  const caveat = clientCaveat(name, project);
  if (caveat !== undefined) line(io, dim(`   note: ${caveat}`));
  const reload = reloadStepFor(name);
  if (reload !== undefined) line(io, opts.apply ? `   then: ${reload}` : dim(`   after --apply: ${reload}`));
  line(io);

  printExportHint(io, 2, name);
  if (!opts.apply) {
    line(io);
    line(io, dim(`to write step 1, run: ${installApplyCommand(name, opts)}`));
  }
  return 0;
}

export function registerInstallCommands(program: Command, io: IO): void {
  program
    .command('install')
    .description('print (or with --apply, write) the MCP config for an agent client; no client lists them')
    .argument('[client]', `one of: ${INSTALL_CLIENTS.join(', ')}`)
    .option('--apply', 'write the config file (merge; existing keys are kept)')
    .option('--scope <scope>', 'user|project (project = the repo-level config file)')
    .option('--project', 'same as --scope project')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print { ok: true, client, scope, applied, written, output } as JSON ({ ok: false, error, nextStep } for an unknown client or scope)')
    .action(async (client: string | undefined, opts: InstallOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const merged: InstallOptions = cwd ? { ...opts, cwd } : opts;
      const code = await runInstall(client, merged, io);
      if (code !== 0) process.exitCode = code;
    });
}

// ---------------------------------------------------------------------------
// install claude: the MCP registration + the settings.json hooks
// ---------------------------------------------------------------------------

export interface InstallClaudeOptions extends CommonOptions {
  apply?: boolean;
  scope?: string;
  /**
   * The command a preview names to perform steps 1 and 2. Default
   * `lexicon install claude [--scope project] --apply`; runInstall passes
   * `installApplyCommand` so the flags the user gave are kept.
   */
  applyCommand?: string;
}

/** What an installer did to one file; reported through `InstallClaudeDeps.onWritten` / `InstallDeps.onWritten`. */
export type InstallOutcome = 'created' | 'updated' | 'unchanged';

export interface InstallClaudeDeps {
  /** Directory containing the built CLI (dist/cli). Default: the package root's dist/cli. */
  cliDir?: string;
  /** Claude settings file. Default ~/.claude/settings.json. */
  settingsPath?: string;
  exec?: (file: string, args: readonly string[]) => string;
  /** Called once per config file touched under `--apply` (setup uses it for its summary). */
  onWritten?: (file: string, outcome: InstallOutcome) => void;
  /** Environment whose LEXICON_PATH / LEXICON_CWD are passed to `claude mcp add -e`. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Claude's plugin registry. Default `plugins/installed_plugins.json` beside `settingsPath`. */
  installedPluginsPath?: string;
}

/**
 * The lexicon plugin's id when Claude Code has it installed or enabled
 * (`findInstalledLexiconPlugin` over settings.json and installed_plugins.json),
 * else undefined. An unreadable file counts as not listing it.
 */
async function installedLexiconPlugin(settingsPath: string, installedPluginsPath: string): Promise<string | undefined> {
  const settings = await readJsonFile(settingsPath);
  const installed = await readJsonFile(installedPluginsPath);
  return findInstalledLexiconPlugin(settings.error === undefined ? settings.value : undefined, installed.error === undefined ? installed.value : undefined);
}

export const CLAUDE_MD_SNIPPET = 'Read the `lexicon://me` resource before interpreting dictated text.';

export async function runInstallClaude(
  opts: InstallClaudeOptions,
  io: IO,
  deps: InstallClaudeDeps = {},
): Promise<number> {
  const scope = opts.scope ?? 'user';
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`--scope must be "user" or "project" (got "${scope}")`);
  }
  const settingsPath = deps.settingsPath ?? path.join(claudeConfigDir(), 'settings.json');
  // The plugin already runs the MCP server and both hooks for every session.
  // A user-scope registration on top of it doubled the hook notes on every
  // prompt and added a second `lexicon` server (setup_lexicon from a plugin
  // session asked for exactly that). A project-scope install writes the
  // repo's config for whoever clones it, so it still goes ahead.
  if (scope === 'user') {
    const pluginId = await installedLexiconPlugin(
      settingsPath,
      deps.installedPluginsPath ?? path.join(path.dirname(settingsPath), 'plugins', 'installed_plugins.json'),
    );
    if (pluginId) {
      line(
        io,
        `the lexicon Claude Code plugin (${safe(pluginId)}) already provides the MCP server and the ${HOOK_EVENTS.join(' and ')} hooks, so nothing was ${opts.apply ? 'written' : 'planned'}; ` +
          `to wire Claude Code by hand instead, uninstall it first: claude plugin uninstall ${safe(pluginId)}`,
      );
      return 0;
    }
  }
  const { server: serverPath, hook: hookPath, bundled } = resolveIntegrationPaths(deps.cliDir);
  const exec = deps.exec ?? defaultExec;
  let failed = false;

  // 1. MCP server registration ------------------------------------------------
  const serverLaunch = launchFor(serverPath, 'mcp');
  // `-e` goes before `--scope`: it takes several values, so placed right
  // before the server name it would swallow the name as one more.
  const serverEnv = lexiconServerEnv(deps.env ?? process.env, path.resolve(opts.cwd ?? process.cwd()));
  const envArgs = Object.entries(serverEnv ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const mcpArgs = ['mcp', 'add', ...envArgs, '--scope', scope, 'lexicon', '--', serverLaunch.command, ...serverLaunch.args];
  line(io, bold('1. Register the MCP server'));
  // Arrow, not a bare reference: Array.map passes the index as the second
  // argument, which would land in `platform`.
  line(io, `   claude ${mcpArgs.map((a) => quoteArg(a)).join(' ')}`);
  if (serverLaunch.viaNpx) line(io, dim('   (run from an npx or Claude Code plugin cache, so the config calls npx rather than a path that may be deleted)'));
  else if (bundled) line(io, dim('   (self-contained bundle: no node_modules needed at runtime)'));
  if (opts.apply) {
    if (!serverLaunch.viaNpx && !existsSync(serverPath)) {
      line(io, yellow(`   note: ${safe(serverPath)} does not exist yet (run npm run build first)`));
    }
    try {
      const out = exec('claude', mcpArgs).trim();
      line(io, green(`   ${out || 'registered'}`));
      line(io, dim(`   undo: claude mcp remove --scope ${scope} lexicon`));
    } catch (err) {
      const message = errorMessage(err);
      if (/already exists/i.test(message)) {
        // `claude mcp add` refuses to overwrite an existing entry. That is the
        // idempotent case, not a failure: every other writer here reports "already
        // present, nothing changed" and carries on, so this one does too.
        line(io, dim('   already registered with claude, nothing changed'));
        line(io, dim(`   undo: claude mcp remove --scope ${scope} lexicon`));
      } else {
        failed = true;
        line(io, red(`   failed: ${safeLines(message)}`));
      }
    }
  }
  line(io);

  // 2. UserPromptSubmit + SessionStart hooks ----------------------------------------
  // Quoted per argument: the whole thing is a shell command string in settings.json.
  const hookLaunch = launchFor(hookPath, 'hook');
  const hookCommand = launchCommandLine(hookLaunch);
  const hookTimeout = hookTimeoutFor(hookLaunch);
  line(io, bold(`2. Add the ${HOOK_EVENTS.join(' and ')} hooks`));
  line(io, `   merge into ${safe(settingsPath)}:`);
  line(io, indent(JSON.stringify(hookConfigFor(hookCommand, hookTimeout, HOOK_EVENTS), null, 2), '   '));
  if (hookLaunch.viaNpx) {
    line(io, dim(`   (npx re-resolves the package each prompt: ~1s, hence the ${hookTimeout}s timeout.`));
    line(io, dim('    npm i -g @ashlr/lexicon, then rerun this, to make it instant.)'));
  }
  if (opts.apply) {
    const read = await readJsonFile(settingsPath);
    if (read.error !== undefined) {
      throw new Error(`could not read ${safe(settingsPath)}: ${safeLines(read.error)}`);
    }
    const existed = read.exists;
    const { settings, changed } = mergeHookIntoSettings(read.value ?? {}, hookCommand, hookTimeout, HOOK_EVENTS);
    if (changed) {
      await writeJsonFile(settingsPath, settings);
      line(io, green(`   ${existed ? 'updated' : 'created'} ${safe(settingsPath)}: added ${HOOK_EVENTS.join(' + ')} hooks`));
      deps.onWritten?.(settingsPath, existed ? 'updated' : 'created');
    } else {
      line(io, dim(`   ${safe(settingsPath)}: hooks already present, nothing changed`));
      deps.onWritten?.(settingsPath, 'unchanged');
    }
    line(io, dim(`   undo: delete the lexicon hook entries under ${HOOK_EVENTS.map((e) => `hooks.${e}`).join(' and ')} in ${safe(settingsPath)}`));
  }
  line(io);

  // 3. CLAUDE.md nudge ----------------------------------------------------------------
  line(io, bold('3. Add to your CLAUDE.md'));
  line(io, `   ${CLAUDE_MD_SNIPPET}`);
  if (opts.apply && !failed) {
    line(io);
    line(io, `then: ${reloadStepFor('claude')}`);
  } else if (!opts.apply) {
    line(io, dim(`   after --apply: ${reloadStepFor('claude')}`));
  }
  if (!opts.apply) {
    line(io);
    const command = opts.applyCommand ?? `lexicon install claude${scope === 'project' ? ' --scope project' : ''} --apply`;
    line(io, dim(`to perform steps 1 and 2, run: ${command}`));
  }
  return failed ? 1 : 0;
}

/**
 * Quote one argument of the printed `claude mcp add ...` line.
 *
 * Windows takes the same branch as launchCommandLine and for the same reason:
 * a backslash there is the path separator, not an escape, so doubling it
 * prints a command that the user copies and that then does not work. A
 * Windows filename cannot hold a `"`, so quoting needs no escaping at all.
 */
function quoteArg(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /[\s"]/.test(s) || path.win32.isAbsolute(s) ? `"${s.replace(/"/g, '')}"` : s;
  return /[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
}
