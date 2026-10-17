/**
 * The parts every MCP tool module needs: the shared per-server context, the
 * result wrappers, the error guard and the small pieces of package/path
 * discovery. Split out of server.ts so each `tools/*.ts` module can be read on
 * its own; server.ts keeps the resources, the prompts and the wiring.
 */
import { realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { projectWriteTrusted, resolvePaths } from '../core/index.js';
import type { ImportFormat, LoadedLexicon, TermSuggestion } from '../core/index.js';
import type { IO } from '../cli/commands.js';
import { unreadableLexiconEdit } from '../cli/io.js';
import { errorMessage } from '../util/errors.js';
import { findPackageRoot, packageVersion } from '../util/package.js';
import { cliCommand } from '../util/cli-hint.js';

/**
 * Everything a tool handler needs from the server it is registered on. `load`
 * re-reads the lexicon from disk on every call, so edits made by the CLI or by
 * hand show up without a restart.
 */
export interface ToolContext {
  /**
   * Directory used to locate the project `.lexicon.yaml`. Read it inside a
   * handler, never once at registration: it can change after the client
   * answers `roots/list`.
   */
  readonly cwd: string;
  /**
   * Directories the client named as MCP roots (`file://` roots that exist),
   * empty until it answers `roots/list` or when it has no roots. Read inside a
   * handler, as with `cwd`.
   */
  readonly roots: readonly string[];
  load(): Promise<LoadedLexicon>;
  /** normalize_transcript's matching budget in ms (MCP_NORMALIZE_BUDGET_MS unless overridden). */
  readonly normalizeBudgetMs: number;
  /** Characters of `text` normalize_transcript matches (MCP_NORMALIZE_MAX_CHARS unless overridden). */
  readonly normalizeMaxChars: number;
}

/** What each `tools/*.ts` module exports: it registers a group of tools on the server. */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

export const SERVER_NAME = 'lexicon';

// All CLI handlers the agent-native tools reuse are imported statically: a
// dynamic `import()` of a module that is also in the static graph makes
// esbuild lazy-wrap the shared subgraph (zod included) and the plugin bundle
// then fails at load ("Class2 is not a constructor").

/** An `IO` sink that captures what a CLI handler would have printed, so a tool can return it. */
export function bufferIO(): IO & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    out: () => out,
    err: () => err,
  };
}

/**
 * A required string argument that must hold more than whitespace. `.min(1)`
 * alone let `"  "` through, so remove_term answered "no term" for a blank
 * canonical and suggest_canonical searched for nothing, both as successes.
 * The pattern is in the JSON schema too, so a validating client sees it.
 */
export function nonBlank(): z.ZodString {
  return z.string().min(1).regex(/\S/, 'must not be blank');
}

/** Clients `install_client` accepts: every `lexicon install` target except the `generic` printout. */
export const INSTALL_CLIENT_VALUES = ['claude', 'codex', 'cursor', 'windsurf', 'gemini', 'vscode', 'claude-desktop'] as const;

export const INSTALL_SCOPES = ['user', 'project'] as const;

export const IMPORT_FORMAT_VALUES = ['auto', 'wispr', 'superwhisper', 'macos', 'espanso', 'markdown', 'text', 'csv', 'json'] as const satisfies readonly ImportFormat[];

export const SUGGESTION_KINDS = ['alias', 'term', 'never', 'stale'] as const satisfies readonly TermSuggestion['kind'][];

// Compile-time check that the tuple still covers every kind the core can produce.
type _AllKindsCovered = Exclude<TermSuggestion['kind'], (typeof SUGGESTION_KINDS)[number]> extends never ? true : never;
const _allKindsCovered: _AllKindsCovered = true;
void _allKindsCovered;

/** stderr-only logger. stdout belongs to the MCP transport. */
export function log(...args: unknown[]): void {
  console.error(`[${SERVER_NAME}]`, ...args);
}

interface PackageInfo {
  /** Directory holding the @ashlr/lexicon package.json. */
  root: string;
  version: string;
}

export function findPackage(): PackageInfo | undefined {
  const root = findPackageRoot(import.meta.url);
  return root ? { root, version: packageVersion(import.meta.url) } : undefined;
}

export function readPackageVersion(): string {
  const pkg = findPackage();
  if (pkg) return pkg.version;
  log('could not read package.json version');
  return '0.0.0';
}

/**
 * The `cliDir` the install helpers derive the package root from
 * (`<cliDir>/../..`). Resolved from package.json rather than this module's
 * location because the plugin bundle sits in `plugin/`, not `dist/mcp/`.
 */
export function cliDirForInstall(): string | undefined {
  const pkg = findPackage();
  return pkg ? join(pkg.root, 'dist', 'cli') : undefined;
}

export function textResult(payload: unknown): CallToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { isError: false, content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = withLexiconFix(errorMessage(err));
  log('tool error:', message);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * A store error for a lexicon file that does not parse or validate, which
 * already names the file, with the fix appended on a second line: the
 * `lexicon edit` command that opens it and `lexicon doctor` to check it.
 * Any other message is returned unchanged. Tools, resources and prompts all
 * report a broken file this way, so a model reading any of them can relay it.
 */
export function withLexiconFix(message: string): string {
  const edit = unreadableLexiconEdit(message);
  if (!edit) return message;
  return `${message}\nNothing was read or changed. Ask the user to fix that file by running ${cliCommand(edit.replace(/^lexicon /, ''))}, then check it with lexicon_doctor.`;
}


/**
 * Environment variable a human sets in the MCP server's env to let the
 * repo-reading tools (harvest_repo, suggest_terms) read more directories,
 * separated by the platform path delimiter (`:`, or `;` on Windows).
 */
export const HARVEST_ROOTS_ENV = 'LEXICON_HARVEST_ROOTS';

function realOrResolved(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Directories a model-chosen `path` may name: the server's directory and the
 * git root above it, the client's MCP roots, and `$LEXICON_HARVEST_ROOTS`.
 * Each is realpath'd (or just resolved when it does not exist).
 */
export function readableRoots(ctx: Pick<ToolContext, 'cwd' | 'roots'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [ctx.cwd, ...ctx.roots];
  const project = resolvePaths({ cwd: ctx.cwd }).project;
  if (project) dirs.push(dirname(project));
  for (const raw of (env[HARVEST_ROOTS_ENV] ?? '').split(delimiter)) {
    const dir = raw.trim();
    if (dir && isAbsolute(dir)) dirs.push(dir);
  }
  return [...new Set(dirs.map(realOrResolved))];
}

/** `dir` as one shell word, for a command the user copies into a terminal. */
export function shellWord(dir: string): string {
  return /^[\w@%+=:,./-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * The real path of `path` (resolved against the server directory) when it
 * lies inside one of `readableRoots`; otherwise throws, naming the CLI
 * command the user can run on it themselves. Symlinks are resolved first, so
 * a link inside a root that points outside it is refused. A model picks
 * `path`, so without this a tool would read whatever directory it named.
 */
export function containedPath(ctx: Pick<ToolContext, 'cwd' | 'roots'>, path: string, cliArgs: (dir: string) => string, env: NodeJS.ProcessEnv = process.env): string {
  const requested = resolve(ctx.cwd, path);
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new Error(`${JSON.stringify(path)} does not exist (resolved from ${ctx.cwd}); nothing was read.`);
  }
  const roots = readableRoots(ctx, env);
  if (roots.some((root) => isWithin(real, root))) return real;
  throw new Error(
    `${JSON.stringify(path)} is outside the directories this server may read (${roots.join(', ')}), so nothing was read. ` +
      `The user can run ${cliCommand(cliArgs(real))} on it themselves, open it as a workspace root in their client, ` +
      `or list it in ${HARVEST_ROOTS_ENV} in the MCP server's environment.`,
  );
}

/**
 * The store option every MCP write passes: `{ leaveUntrusted: true }` unless
 * the project file the write would land in is already trusted. A model must
 * not be the one that creates and trusts a project `.lexicon.yaml`, so a new,
 * untrusted or changed file is written unpinned and applies only after the
 * user runs `lexicon trust`; a file the user trusted takes the edit and keeps
 * its pin refreshed. A global write ignores the option.
 */
export async function mcpWriteOpts(ctx: Pick<ToolContext, 'cwd'>): Promise<{ leaveUntrusted?: true }> {
  return (await projectWriteTrusted({ cwd: ctx.cwd })) ? {} : { leaveUntrusted: true };
}

/**
 * `{ trusted: false, nextStep }` for a tool result that wrote a project file
 * without trusting it. `what` is the subject of the sentence (`"Kubectl"`,
 * `3 name(s)`); `plural` picks the verb.
 */
export function untrustedWriteFields(path: string, what: string, plural = false): { trusted: false; nextStep: string } {
  return {
    trusted: false,
    nextStep:
      `${what} ${plural ? 'were' : 'was'} written to ${path}, which is not trusted, so ${plural ? 'they do' : 'it does'} not apply yet. ` +
      `Ask the user to review the file and run ${cliCommand('trust')} in a terminal in that repo (it previews the file first), ` +
      'or call trust_project with action "trust", which asks them directly.',
  };
}

/** Runs a tool body and converts any thrown error into an isError result. */
export async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Compact, display-safe view of a project lexicon for the trust dialogue
 * (defined in core so `lexicon trust --json` returns the same rows).
 */
export { trustPreview } from '../core/index.js';

export function filePathsInUse(loaded: LoadedLexicon): { global: string; project?: string } {
  return {
    global: loaded.global.path,
    ...(loaded.project ? { project: loaded.project.path } : {}),
  };
}

/**
 * `{ projectTrust, skippedProject, note }` when a project lexicon exists but
 * was not merged, else `{}`. The path only, never the untrusted file's text.
 */
export function skippedProjectFields(
  loaded: LoadedLexicon,
  /** One more sentence for the note: what the skipped file means for this result. */
  consequence?: string,
): { projectTrust?: LoadedLexicon['projectTrust']; skippedProject?: string; note?: string } {
  if (!loaded.skippedProject) return {};
  const note =
    loaded.projectTrust === 'changed'
      ? 'The project .lexicon.yaml changed since it was trusted and was not loaded; the user can review it and run ' + cliCommand('trust') + ' again.'
      : 'An untrusted project .lexicon.yaml exists and was not loaded; the user can review it and run ' + cliCommand('trust') + ' to enable it.';
  return {
    projectTrust: loaded.projectTrust,
    skippedProject: loaded.skippedProject.path,
    note: consequence ? `${note} ${consequence}` : note,
  };
}
