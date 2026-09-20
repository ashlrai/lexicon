/**
 * The parts every MCP tool module needs: the shared per-server context, the
 * result wrappers, the error guard and the small pieces of package/path
 * discovery. Split out of server.ts so each `tools/*.ts` module can be read on
 * its own; server.ts keeps the resources, the prompts and the wiring.
 */
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeForDisplay } from '../core/index.js';
import type { ImportFormat, LexiconFile, LoadedLexicon, TermSuggestion } from '../core/index.js';
import type { IO } from '../cli/commands.js';
import { errorMessage } from '../util/errors.js';
import { findPackageRoot, packageVersion } from '../util/package.js';

/**
 * Everything a tool handler needs from the server it is registered on. `load`
 * re-reads the lexicon from disk on every call, so edits made by the CLI or by
 * hand show up without a restart.
 */
export interface ToolContext {
  /** Directory used to locate the project `.lexicon.yaml`. */
  cwd: string;
  load(): Promise<LoadedLexicon>;
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

/** Clients `install_client` accepts: every `lexicon install` target except the `generic` printout. */
export const INSTALL_CLIENT_VALUES = ['claude', 'codex', 'cursor', 'windsurf', 'gemini', 'vscode', 'claude-desktop'] as const;

export const INSTALL_SCOPES = ['user', 'project'] as const;

export const IMPORT_FORMAT_VALUES = ['auto', 'wispr', 'superwhisper', 'macos', 'espanso', 'text', 'csv', 'json'] as const satisfies readonly ImportFormat[];

export const SUGGESTION_KINDS = ['alias', 'term', 'never', 'stale'] as const satisfies readonly TermSuggestion['kind'][];

// Compile-time check that the tuple still covers every kind the core can produce.
type _AllKindsCovered = Exclude<TermSuggestion['kind'], (typeof SUGGESTION_KINDS)[number]> extends never ? true : never;
const _allKindsCovered: _AllKindsCovered = true;
void _allKindsCovered;

/** `lexicon serve` health endpoint (DEFAULT_PORT in src/serve/config.ts; kept literal so the bundle does not pull the server in). */
export const SERVE_HEALTH_URL = 'http://127.0.0.1:41733/health';

/** Terms listed in a trust preview before "... and N more". */
const TRUST_PREVIEW_ROWS = 25;

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
  const message = errorMessage(err);
  log('tool error:', message);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * True for core's ProjectTrustError (a project-scope write refused because the
 * repo's .lexicon.yaml is unreviewed). Duck-typed by name so it also holds
 * when core is mocked in tests.
 */
export function isProjectTrustError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ProjectTrustError';
}

/** Runs a tool body and converts any thrown error into an isError result. */
export async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

interface TrustPreviewRow {
  canonical: string;
  firstAlias?: string;
  aliasCount: number;
  hasNotes: boolean;
}

/**
 * Compact, display-safe view of a project lexicon for the trust dialogue:
 * canonicals and the first alias only, sanitized, capped. Notes are reported
 * as present, never quoted: the file is untrusted input until the user says so.
 */
export function trustPreview(file: LexiconFile): { termCount: number; preview: TrustPreviewRow[]; more: number } {
  const terms = file.lexicon.terms;
  const preview = terms.slice(0, TRUST_PREVIEW_ROWS).map((t): TrustPreviewRow => ({
    canonical: sanitizeForDisplay(t.canonical),
    ...(t.aliases.length > 0 ? { firstAlias: sanitizeForDisplay(t.aliases[0]) } : {}),
    aliasCount: t.aliases.length,
    hasNotes: typeof t.notes === 'string' && t.notes.trim() !== '',
  }));
  return { termCount: terms.length, preview, more: Math.max(0, terms.length - TRUST_PREVIEW_ROWS) };
}

export function filePathsInUse(loaded: LoadedLexicon): { global: string; project?: string } {
  return {
    global: loaded.global.path,
    ...(loaded.project ? { project: loaded.project.path } : {}),
  };
}
