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
import { bold, dim, green, indent, line, red, safe, safeLines, yellow } from './io.js';
import type { CommonOptions, IO } from './io.js';
import {
  HOOK_EVENTS,
  claudeConfigDir,
  defaultExec,
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
  if (client === 'claude-desktop') {
    return 'Claude Desktop reads this only at launch: quit it completely and reopen.';
  }
  return undefined;
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
  // is running out of an npx cache, which npm is free to delete (see launchFor).
  const launch = launchFor(serverPath, 'mcp');
  const base: StdioServerEntry = { command: launch.command, args: launch.args };
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
 * false when an identical entry is already present.
 */
export function mergeServerIntoJson(
  current: unknown,
  key: 'mcpServers' | 'servers',
  entry: StdioServerEntry | VsCodeServerEntry,
): MergeResult<Record<string, unknown>> {
  const base: Record<string, unknown> = isRecord(current) ? (structuredClone(current) as Record<string, unknown>) : {};
  const existingMap = base[key];
  if (existingMap !== undefined && !isRecord(existingMap)) {
    throw new Error(`"${key}" is not an object; refusing to overwrite it`);
  }
  const servers: Record<string, unknown> = isRecord(existingMap) ? existingMap : {};
  if (deepEqual(servers.lexicon, entry)) {
    return { next: base, changed: false };
  }
  servers.lexicon = structuredClone(entry);
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
  return [
    `[${CODEX_TABLE}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ].join('\n');
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
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^\\s*\\[\\s*${escaped}\\s*\\]\\s*(#.*)?$`);
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
  const { next, changed } = mergeServerIntoJson(read.value ?? {}, target.key, target.entry);
  if (!changed) return 'unchanged';
  await writeJsonFile(target.file, next);
  return read.exists ? 'updated' : 'created';
}

async function applyToml(target: InstallTarget): Promise<InstallOutcome> {
  const { text, existed } = await readText(target.file);
  const { next, changed } = upsertTomlTable(text, CODEX_TABLE, codexBlock(target.entry));
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

function printExportHint(io: IO, step: number, client: InstallClient): void {
  line(io, bold(`${step}. Give ${labelFor(client)} the vocabulary`));
  line(io, `   lexicon export claude-md >> ${rulesFileFor(client)}`);
  line(io, dim('   (paste the markdown into that file so the model prefers the canonical spellings even without the MCP tool)'));
}

function printGeneric(io: IO, serverPath: string): void {
  const launch = launchFor(serverPath, 'mcp');
  line(io, bold('Generic MCP client configuration'));
  line(io, indent(jsonSnippet('mcpServers', { command: launch.command, args: launch.args }), '   '));
  line(io);
  line(io, bold('Supported clients'));
  for (const c of INSTALL_CLIENTS) {
    if (c === 'generic') continue;
    line(io, `   lexicon install ${c}`);
  }
  line(io);
  line(io, dim('add --apply to write the config, --project for the repo-level file where the client supports one'));
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
    printGeneric(io, serverPath);
    return 0;
  }

  if (name === 'claude') {
    const claudeOpts = { ...opts, scope: project ? 'project' : 'user' };
    const claudeDeps = {
      ...(deps.cliDir ? { cliDir: deps.cliDir } : {}),
      ...(opts.home ? { settingsPath: path.join(claudeConfigDir(process.env, home), 'settings.json') } : {}),
      ...(deps.onWritten ? { onWritten: deps.onWritten } : {}),
      ...(deps.exec ? { exec: deps.exec } : {}),
    };
    return runInstallClaude(claudeOpts, io, claudeDeps);
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
  }
  const caveat = clientCaveat(name, project);
  if (caveat !== undefined) line(io, dim(`   note: ${caveat}`));
  line(io);

  printExportHint(io, 2, name);
  if (!opts.apply) {
    line(io);
    line(io, dim('run again with --apply to write step 1'));
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
  const { server: serverPath, hook: hookPath, bundled } = resolveIntegrationPaths(deps.cliDir);
  const settingsPath = deps.settingsPath ?? path.join(claudeConfigDir(), 'settings.json');
  const exec = deps.exec ?? defaultExec;
  let failed = false;

  // 1. MCP server registration ------------------------------------------------
  const serverLaunch = launchFor(serverPath, 'mcp');
  const mcpArgs = ['mcp', 'add', '--scope', scope, 'lexicon', '--', serverLaunch.command, ...serverLaunch.args];
  line(io, bold('1. Register the MCP server'));
  line(io, `   claude ${mcpArgs.map(quoteArg).join(' ')}`);
  if (serverLaunch.viaNpx) line(io, dim('   (run from an npx cache, so the config calls npx rather than a path npm may delete)'));
  else if (bundled) line(io, dim('   (self-contained bundle: no node_modules needed at runtime)'));
  if (opts.apply) {
    if (!serverLaunch.viaNpx && !existsSync(serverPath)) {
      line(io, yellow(`   note: ${safe(serverPath)} does not exist yet (run npm run build first)`));
    }
    try {
      const out = exec('claude', mcpArgs).trim();
      line(io, green(`   ${out || 'registered'}`));
    } catch (err) {
      const message = errorMessage(err);
      if (/already exists/i.test(message)) {
        // `claude mcp add` refuses to overwrite an existing entry. That is the
        // idempotent case, not a failure: every other writer here reports "already
        // present, nothing changed" and carries on, so this one does too.
        line(io, dim('   already registered with claude, nothing changed'));
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
  }
  line(io);

  // 3. CLAUDE.md nudge ----------------------------------------------------------------
  line(io, bold('3. Add to your CLAUDE.md'));
  line(io, `   ${CLAUDE_MD_SNIPPET}`);
  if (!opts.apply) {
    line(io);
    line(io, dim('run again with --apply to perform steps 1 and 2'));
  }
  return failed ? 1 : 0;
}

function quoteArg(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
}
