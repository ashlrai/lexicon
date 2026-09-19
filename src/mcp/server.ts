#!/usr/bin/env node
/**
 * stdio MCP server exposing the personal lexicon to agents.
 *
 * Invariants:
 *  - Nothing is ever written to stdout except MCP protocol frames (stdio transport
 *    owns stdout). All diagnostics go through `log()` -> stderr.
 *  - The lexicon is re-read from disk on every tool/resource/prompt call so edits
 *    made by the CLI or by hand show up without restarting the server.
 *  - Tool handlers never throw; failures come back as `{ isError: true }` results so
 *    the calling agent sees a readable message instead of a protocol error.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  getTrustPath,
  harvestRepo,
  isTrusted,
  learnCorrection,
  listTrusted,
  loadLexicon,
  loadVoiceHistory,
  normalize,
  readLexiconFile,
  recordHits,
  removeTerm,
  resolvePaths,
  sanitizeForDisplay,
  suggestAliases,
  suggestCanonicalFor,
  suggestTerms,
  trustAllEnabled,
  trustProject,
  untrustProject,
} from '../core/index.js';
import type {
  ExportFormat,
  ImportFormat,
  LexiconFile,
  LoadedLexicon,
  Term,
  TermCategory,
  TermScope,
  TermSuggestion,
  VoiceHistoryEntry,
} from '../core/index.js';
import { runDoctorReport } from '../cli/commands.js';
import type { IO } from '../cli/commands.js';
import { MAX_IMPORT_BYTES, runImport } from '../cli/cmd-import.js';
import { runInstall } from '../cli/cmd-install.js';
import { runSetup } from '../cli/cmd-setup.js';

export interface ServerOptions {
  /** Directory used to locate the project `.lexicon.yaml`. Defaults to $LEXICON_CWD or process.cwd(). */
  cwd?: string;
}

const SERVER_NAME = 'lexicon';

// All CLI handlers the agent-native tools reuse are imported statically: a
// dynamic `import()` of a module that is also in the static graph makes
// esbuild lazy-wrap the shared subgraph (zod included) and the plugin bundle
// then fails at load ("Class2 is not a constructor").

/** An `IO` sink that captures what a CLI handler would have printed, so a tool can return it. */
function bufferIO(): IO & { out: () => string; err: () => string } {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clients `install_client` accepts: every `lexicon install` target except the `generic` printout. */
const INSTALL_CLIENT_VALUES = ['claude', 'codex', 'cursor', 'windsurf', 'gemini', 'vscode', 'claude-desktop'] as const;

const INSTALL_SCOPES = ['user', 'project'] as const;

const IMPORT_FORMAT_VALUES = ['auto', 'wispr', 'superwhisper', 'macos', 'espanso', 'text', 'csv', 'json'] as const satisfies readonly ImportFormat[];

const SUGGESTION_KINDS = ['alias', 'term', 'never', 'stale'] as const satisfies readonly TermSuggestion['kind'][];

// Compile-time check that the tuple still covers every kind the core can produce.
type _AllKindsCovered = Exclude<TermSuggestion['kind'], (typeof SUGGESTION_KINDS)[number]> extends never ? true : never;
const _allKindsCovered: _AllKindsCovered = true;
void _allKindsCovered;

/** `lexicon serve` health endpoint (DEFAULT_PORT in src/serve/config.ts; kept literal so the bundle does not pull the server in). */
const SERVE_HEALTH_URL = 'http://127.0.0.1:41733/health';

/** Terms listed in a trust preview before "... and N more". */
const TRUST_PREVIEW_ROWS = 25;

/** Enum tuples for zod. `satisfies` keeps them in lock-step with the core union types. */
const TERM_CATEGORIES = [
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
] as const satisfies readonly TermCategory[];

const TERM_SCOPES = ['global', 'project'] as const satisfies readonly TermScope[];

const EXPORT_FORMAT_VALUES = [
  'wispr',
  'superwhisper',
  'whisper-prompt',
  'macos',
  'claude-md',
  'csv',
  'json',
  'deepgram',
  'espanso',
  'assemblyai',
  'azure',
  'google',
  'openai',
  'text',
  'markdown',
] as const satisfies readonly ExportFormat[];

// Compile-time exhaustiveness: fails to build if a format is added to the union but not here.
type _AllFormatsCovered = Exclude<ExportFormat, (typeof EXPORT_FORMAT_VALUES)[number]> extends never
  ? true
  : never;
const _allFormatsCovered: _AllFormatsCovered = true;
void _allFormatsCovered;

const VOICE_CONTEXT_INSTRUCTION =
  'Apply these canonical spellings to everything I say for the rest of this session. ' +
  'If you see a word that looks like a garbled version of one of them, use the canonical form without asking.';

/** The `onboard` prompt: a user-role script that drives the model through first-run setup. */
const ONBOARD_PROMPT = [
  'Help me set up my voice lexicon so the names I dictate come out spelled right. Go in this order, one question at a time, and keep each message short:',
  '1. Ask for my company or product names, spelled exactly as they should appear (capitalization and punctuation included), and how I pronounce each one.',
  '2. Ask for the names of teammates or people I mention often, spelled the way they write them.',
  '3. Ask which agent clients I use: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI or VS Code.',
  '4. Call the setup_lexicon tool with my company, my name and those clients. Tell me what it installed and where the lexicon file lives.',
  '5. For every other name I gave you, call add_term without aliases so likely misspellings are generated, then show each term with its aliases on one line so I can veto any.',
  '6. Finish with one sentence I can dictate to test it that contains two of the names, and tell me to try it in a new session.',
  'Never install anything or trust a project file without telling me first. If a step fails, show me the error and continue with the rest.',
].join('\n');

/** Sent to the client at initialize; the one-screen summary of how an agent should use this server. */
const SERVER_INSTRUCTIONS = [
  "Personal voice lexicon: the canonical spellings of names the user dictates and the misspellings STT produces for them.",
  'Read the lexicon://me resource once at session start and keep its canonical forms in mind for the whole session.',
  'Call normalize_transcript on any input that looks dictated (run-on prose, no code, a garbled proper noun) and act on its output.',
  "Call learn_correction whenever the user corrects a spelling ('it's Ashlr.AI not Ashler', 'I said X', or fixes a name you wrote) so it is corrected automatically next time.",
  'If a word looks like a garbled name and normalize_transcript did not change it, call suggest_canonical before guessing.',
  'Never rewrite text inside code blocks, inline code, file paths, URLs or emails.',
  'If the lexicon is empty, offer to set it up: ask for the company/product spelling and the clients in use, then call setup_lexicon (or use the onboard prompt).',
  'When corrections are not happening, call lexicon_doctor. When the user asks how to improve corrections, call suggest_terms, present the proposals and apply the accepted ones with apply_suggestion.',
  'Preview install_client before applying it, and never trust a project lexicon (trust_project) before showing the user its preview and getting a yes.',
].join('\n');

/** stderr-only logger. stdout belongs to the MCP transport. */
function log(...args: unknown[]): void {
  console.error(`[${SERVER_NAME}]`, ...args);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface PackageInfo {
  /** Directory holding the @ashlr/lexicon package.json. */
  root: string;
  version: string;
}

function findPackage(): PackageInfo | undefined {
  // dist/mcp/server.js and src/mcp/server.ts sit two levels below package.json;
  // the self-contained plugin/mcp-server.mjs bundle sits one level below it.
  // The name check keeps an unrelated package.json further up from being picked.
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const url = new URL(rel, import.meta.url);
      const raw = readFileSync(url, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) continue;
      if (parsed.name === '@ashlr/lexicon' && typeof parsed.version === 'string') {
        return { root: dirname(fileURLToPath(url)), version: parsed.version };
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function readPackageVersion(): string {
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
function cliDirForInstall(): string | undefined {
  const pkg = findPackage();
  return pkg ? join(pkg.root, 'dist', 'cli') : undefined;
}

function textResult(payload: unknown): CallToolResult {
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
function isProjectTrustError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ProjectTrustError';
}

/** Runs a tool body and converts any thrown error into an isError result. */
async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
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
function trustPreview(file: LexiconFile): { termCount: number; preview: TrustPreviewRow[]; more: number } {
  const terms = file.lexicon.terms;
  const preview = terms.slice(0, TRUST_PREVIEW_ROWS).map((t): TrustPreviewRow => ({
    canonical: sanitizeForDisplay(t.canonical),
    ...(t.aliases.length > 0 ? { firstAlias: sanitizeForDisplay(t.aliases[0]) } : {}),
    aliasCount: t.aliases.length,
    hasNotes: typeof t.notes === 'string' && t.notes.trim() !== '',
  }));
  return { termCount: terms.length, preview, more: Math.max(0, terms.length - TRUST_PREVIEW_ROWS) };
}

function filePathsInUse(loaded: LoadedLexicon): { global: string; project?: string } {
  return {
    global: loaded.global.path,
    ...(loaded.project ? { project: loaded.project.path } : {}),
  };
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.env.LEXICON_CWD ?? process.cwd();
  const load = (): Promise<LoadedLexicon> => loadLexicon({ cwd });

  const server = new McpServer(
    { name: SERVER_NAME, version: readPackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ---------------------------------------------------------------- tools

  server.registerTool(
    'normalize_transcript',
    {
      title: 'Normalize dictated text',
      description:
        "Rewrite a dictated/transcribed text using the user's personal lexicon (fixes STT misspellings of names, brands, acronyms, identifiers). " +
        'Call this on any user message that came from voice/dictation or contains a word that looks like a garbled proper noun. ' +
        'Returns corrected text and the list of replacements.',
      inputSchema: {
        text: z.string().describe('The dictated or transcribed text to correct.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('When true, report candidate replacements without applying them (output === input).'),
        minConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Override the minimum confidence (0..1) a fuzzy/phonetic match needs. Exact alias matches are always 1.'),
      },
    },
    async ({ text, dryRun, minConfidence }) =>
      guarded(async () => {
        const loaded = await load();
        const result = normalize(text, loaded.merged, {
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
        if (result.changed && !dryRun) {
          const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
          // Best effort: recordHits is contractually non-throwing, but guard anyway so
          // a store hiccup can never turn a successful normalize into an error.
          await recordHits(canonicals, { cwd }).catch((err: unknown) =>
            log('recordHits failed:', errorMessage(err)),
          );
        }
        return textResult({
          output: result.output,
          changed: result.changed,
          replacements: result.replacements,
          summary: result.replacements.length > 0 ? diffSummary(result) : '',
        });
      }),
  );

  server.registerTool(
    'add_term',
    {
      title: 'Add a lexicon term',
      description:
        "Save a canonical spelling to the user's lexicon so future dictation is corrected to it. " +
        'Use when the user corrects you ("it\'s Ashlr.AI, not Ashler") - pass the misheard spelling as an alias. ' +
        'If aliases are omitted, likely STT misspellings are generated automatically. Merges aliases into an existing term with the same canonical.',
      inputSchema: {
        canonical: z.string().min(1).describe('The correct spelling, exactly as the user wants it written.'),
        aliases: z
          .array(z.string())
          .optional()
          .describe('Spellings STT actually produces for this term. Omit to auto-suggest.'),
        phonetic: z.string().optional().describe('Pronunciation hint, e.g. "ASH-ler".'),
        category: z.enum(TERM_CATEGORIES).optional(),
        notes: z.string().optional().describe('Free text shown to agents, e.g. "my company; never write Ashlar".'),
        never: z
          .array(z.string())
          .optional()
          .describe('Ordinary words that must never be rewritten to this term even if they sound alike, e.g. ["sauce"] for SaaS.'),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe("'global' (default, ~/.config/lexicon) or 'project' (.lexicon.yaml in the current repo)."),
      },
    },
    async ({ canonical, aliases, phonetic, category, notes, never, scope }) =>
      guarded(async () => {
        const resolvedAliases = aliases && aliases.length > 0 ? aliases : suggestAliases(canonical);
        const term: Term = {
          canonical,
          aliases: resolvedAliases,
          source: 'user',
          ...(phonetic !== undefined ? { phonetic } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(never && never.length > 0 ? { never } : {}),
          ...(scope !== undefined ? { scope } : {}),
        };
        const saved = await addTerm(term, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({ term: saved.term, path: saved.file.path, created: saved.created });
      }),
  );

  server.registerTool(
    'remove_term',
    {
      title: 'Remove a lexicon term',
      description: "Delete a term (by canonical spelling, case-insensitive) from the user's lexicon.",
      inputSchema: {
        canonical: z.string().min(1),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe('Which lexicon file to remove it from. Defaults to the store\'s resolution order.'),
      },
    },
    async ({ canonical, scope }) =>
      guarded(async () => {
        const removed = await removeTerm(canonical, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({ canonical, removed });
      }),
  );

  server.registerTool(
    'list_terms',
    {
      title: 'List lexicon terms',
      description:
        "List the user's lexicon terms (global + project merged). Optional case-insensitive substring filter over canonical spellings and aliases, and category filter.",
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring matched against canonical and aliases.'),
        category: z.enum(TERM_CATEGORIES).optional(),
      },
    },
    async ({ query, category }) =>
      guarded(async () => {
        const loaded = await load();
        const needle = query?.trim().toLowerCase();
        const terms = loaded.merged.terms.filter((t) => {
          if (category && t.category !== category) return false;
          if (!needle) return true;
          if (t.canonical.toLowerCase().includes(needle)) return true;
          return t.aliases.some((a) => a.toLowerCase().includes(needle));
        });
        return textResult({
          terms,
          counts: {
            matched: terms.length,
            total: loaded.merged.terms.length,
            global: loaded.global.lexicon.terms.length,
            project: loaded.project?.lexicon.terms.length ?? 0,
          },
          paths: filePathsInUse(loaded),
          ...(loaded.skippedProject
            ? {
                projectTrust: loaded.projectTrust,
                skippedProject: loaded.skippedProject.path,
                note:
                  loaded.projectTrust === 'changed'
                    ? 'The project .lexicon.yaml changed since it was trusted and was not loaded; the user can review it and run `lexicon trust` again.'
                    : 'An untrusted project .lexicon.yaml exists and was not loaded; the user can review it and run `lexicon trust` to enable it.',
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    'harvest_repo',
    {
      title: 'Harvest names from a repository',
      description:
        'Scan a repository for proper nouns an STT engine is likely to mangle (package names, PascalCase identifiers, git authors, README headings) and propose them as lexicon terms. ' +
        'Run this when entering a repo that has no .lexicon.yaml. With add:true the candidates are written to the project lexicon.',
      inputSchema: {
        path: z.string().optional().describe('Repository root. Defaults to the server working directory.'),
        limit: z.number().int().positive().optional().describe('Max candidates to return (default 50).'),
        minCount: z.number().int().positive().optional().describe('Minimum occurrences for a candidate (default 2).'),
        add: z.boolean().optional().describe('When true, add every candidate to the project lexicon.'),
      },
    },
    async ({ path, limit, minCount, add }) =>
      guarded(async () => {
        const root = path ? resolve(cwd, path) : cwd;
        const candidates = await harvestRepo(root, {
          ...(limit !== undefined ? { limit } : {}),
          ...(minCount !== undefined ? { minCount } : {}),
        });
        let added = 0;
        const failures: Array<{ canonical: string; error: string }> = [];
        if (add) {
          for (const c of candidates) {
            try {
              // Write into the harvested repo's own project lexicon, not the server cwd.
              await addTerm(
                {
                  canonical: c.canonical,
                  aliases: c.suggestedAliases,
                  category: c.category,
                  source: c.source,
                  scope: 'project',
                },
                { cwd: root, scope: 'project' },
              );
              added += 1;
            } catch (err) {
              // Every remaining candidate would fail the same way; surface it
              // once as the tool error instead of N identical failure rows.
              if (isProjectTrustError(err)) throw err;
              failures.push({ canonical: c.canonical, error: errorMessage(err) });
            }
          }
        }
        return textResult({
          root,
          candidates,
          count: candidates.length,
          ...(add ? { added, failures } : {}),
        });
      }),
  );

  server.registerTool(
    'export_lexicon',
    {
      title: 'Export the lexicon',
      description:
        "Export the merged lexicon in a format for another tool: 'claude-md' (markdown for CLAUDE.md / system prompts), 'markdown', 'text', 'wispr', 'superwhisper', 'whisper-prompt', 'openai', 'macos', 'espanso', 'deepgram', 'assemblyai', 'azure', 'google', 'csv', or raw 'json'.",
      inputSchema: {
        format: z.enum(EXPORT_FORMAT_VALUES),
        categories: z.array(z.enum(TERM_CATEGORIES)).optional().describe('Only include these categories.'),
        limit: z.number().int().positive().optional().describe('Cap the number of terms exported.'),
      },
    },
    async ({ format, categories, limit }) =>
      guarded(async () => {
        const loaded = await load();
        const exported = exportLexicon(loaded.merged, format, {
          ...(categories !== undefined ? { categories } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return textResult(exported);
      }),
  );

  server.registerTool(
    'learn_correction',
    {
      title: 'Learn from a spelling correction',
      description:
        'Record that the user corrected a transcription: they said `meant` but the transcript/agent wrote `heard`. ' +
        "Call this whenever the user says things like 'it's Ashlr.AI not Ashler', 'I said X', or fixes a name you wrote. " +
        'Adds `heard` as an alias so future dictation is corrected automatically.',
      inputSchema: {
        heard: z.string().min(1).describe('The wrong form that was written, e.g. "Ashler".'),
        meant: z.string().min(1).describe('The spelling the user wants, e.g. "Ashlr.AI".'),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe("'global' (default; or wherever the term already lives) or 'project' (.lexicon.yaml in the current repo)."),
      },
    },
    async ({ heard, meant, scope }) =>
      guarded(async () => {
        const learned = await learnCorrection({ heard, meant }, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({
          term: learned.term,
          path: learned.file.path,
          created: learned.created,
          aliasAdded: learned.aliasAdded,
          summary: learned.aliasAdded
            ? `"${heard}" -> "${learned.term.canonical}" saved`
            : `"${heard}" was already an alias of "${learned.term.canonical}"`,
        });
      }),
  );

  server.registerTool(
    'suggest_canonical',
    {
      title: 'Suggest the canonical form of a garbled word',
      description:
        'Given a word that looks like a garbled proper noun and was not corrected by normalize_transcript, ' +
        "return the closest existing lexicon terms so you can ask the user 'did you mean X?'.",
      inputSchema: {
        heard: z.string().min(1).describe('The suspicious word or phrase as it appeared in the transcript.'),
      },
    },
    async ({ heard }) =>
      guarded(async () => {
        const loaded = await load();
        const suggestions = suggestCanonicalFor(heard, loaded.merged).map((s) => ({
          canonical: s.term.canonical,
          confidence: Number(s.confidence.toFixed(3)),
          aliases: s.term.aliases,
          ...(s.term.category !== undefined ? { category: s.term.category } : {}),
        }));
        return textResult({ heard, suggestions });
      }),
  );

  server.registerTool(
    'lexicon_stats',
    {
      title: 'Lexicon usage statistics',
      description:
        'Counts of terms and aliases, total hits, the most-used terms, terms that never fired, and a per-file breakdown of the merged lexicon.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const loaded = await load();
        return textResult(computeStats(loaded));
      }),
  );

  // ------------------------------------------- setup, install, trust, import

  server.registerTool(
    'lexicon_doctor',
    {
      title: 'Diagnose the lexicon install',
      description:
        'Diagnose the lexicon install: files, trust, hooks, MCP registration, clipboard, voice tools. ' +
        'Call when corrections are not happening or the user asks whether it is set up. ' +
        "Returns { ok, checks: [{ level: 'ok'|'warn'|'fail'|'info', message }], paths, versions }; summarise the fails and warns for the user and offer the fix each message names.",
      inputSchema: {},
    },
    async () => guarded(async () => textResult(await runDoctorReport({ cwd }))),
  );

  server.registerTool(
    'install_client',
    {
      title: 'Register the lexicon MCP server in an agent client',
      description:
        "Register the lexicon MCP server (and, for Claude Code, its hooks) in an agent client's config: claude, codex, cursor, windsurf, gemini, vscode or claude-desktop. " +
        'Call with apply omitted (or false) first: that is a preview that returns the exact file and entry that would change and writes nothing. ' +
        'Show the preview to the user and call again with apply: true only after they confirm. Idempotent: an entry that is already present is left alone.',
      inputSchema: {
        client: z.enum(INSTALL_CLIENT_VALUES).describe('Which client to configure.'),
        apply: z.boolean().optional().describe('false/omitted = preview only (default). true = write the config after the user confirmed.'),
        scope: z
          .enum(INSTALL_SCOPES)
          .optional()
          .describe("'user' (default: the user-level config) or 'project' (the config inside the current repo, e.g. ./.cursor/mcp.json)."),
      },
    },
    async ({ client, apply, scope }) =>
      guarded(async () => {
        const io = bufferIO();
        const cliDir = cliDirForInstall();
        const code = await runInstall(
          client,
          { cwd, apply: apply === true, ...(scope !== undefined ? { scope } : {}) },
          io,
          cliDir !== undefined ? { cliDir } : {},
        );
        const stderr = io.err().trim();
        return textResult({
          client,
          scope: scope ?? 'user',
          applied: apply === true,
          ok: code === 0,
          output: io.out().trimEnd(),
          ...(stderr ? { stderr } : {}),
          ...(apply === true ? {} : { next: 'Show this to the user; call again with apply: true once they confirm.' }),
        });
      }),
  );

  server.registerTool(
    'trust_project',
    {
      title: 'Inspect or approve a project lexicon',
      description:
        "Manage trust for a repo's .lexicon.yaml, which is merged only after the user approves it (it can inject text into every session). " +
        "action 'status' returns the trust state plus a compact preview (canonicals, first alias, counts) of the file; " +
        "'trust' approves the file at its current content and returns the same preview; 'untrust' revokes it. " +
        "Always call 'status' first, show the user the preview and ask; call 'trust' only after they say yes. Never trust a file the user has not seen.",
      inputSchema: {
        action: z.enum(['status', 'trust', 'untrust']),
        path: z.string().optional().describe('Lexicon file to act on. Defaults to the project .lexicon.yaml resolved from the server working directory.'),
      },
    },
    async ({ action, path }) =>
      guarded(async () => {
        const filePath = path ? resolve(cwd, path) : resolvePaths({ cwd }).project;
        const registry = getTrustPath({ cwd });

        if (action === 'status') {
          const base = { action, registry, trustAll: trustAllEnabled(), trusted: await listTrusted({ cwd }) };
          if (!filePath) return textResult({ ...base, status: 'none', note: `no project .lexicon.yaml found from ${cwd}` });
          let file: LexiconFile;
          try {
            file = await readLexiconFile(filePath, 'project');
          } catch (err) {
            return textResult({ ...base, path: filePath, status: 'invalid', error: errorMessage(err) });
          }
          if (!file.exists) return textResult({ ...base, path: filePath, status: 'missing' });
          const status = await isTrusted(file, { cwd });
          return textResult({ ...base, path: filePath, status, ...trustPreview(file) });
        }

        if (!filePath) throw new Error(`no project .lexicon.yaml found from ${cwd}; pass a path`);

        if (action === 'untrust') {
          const removed = await untrustProject(filePath, { cwd });
          return textResult({
            action,
            path: filePath,
            removed,
            registry,
            summary: removed ? `untrusted ${filePath}; it will no longer be merged` : `${filePath} was not trusted; nothing to do`,
          });
        }

        // action === 'trust': parse first so a broken file is reported instead of trusted blind.
        let file: LexiconFile;
        try {
          file = await readLexiconFile(filePath, 'project');
        } catch (err) {
          throw new Error(`refusing to trust an invalid lexicon: ${errorMessage(err)}`);
        }
        if (!file.exists) throw new Error(`file does not exist: ${filePath}`);
        const before = await isTrusted(file, { cwd });
        const entry = await trustProject(filePath, { cwd });
        const verb = before === 'trusted' ? 're-pinned' : before === 'changed' ? 'updated' : 'trusted';
        return textResult({
          action,
          path: filePath,
          previousStatus: before,
          status: 'trusted',
          result: verb,
          sha256: entry.sha256.slice(0, 12),
          trustedAt: entry.trustedAt,
          registry,
          ...trustPreview(file),
          note: 'Merged into the lexicon until its content changes; then it must be trusted again.',
        });
      }),
  );

  server.registerTool(
    'import_dictionary',
    {
      title: 'Import an existing dictionary',
      description:
        "Import a dictionary the user already has (Wispr Flow CSV, Superwhisper JSON, macOS Text Replacement plist, espanso YAML, plain text 'Canonical: alias1, alias2', generic CSV, or a lexicon JSON/YAML) into the lexicon. " +
        'Pass either path (a file on disk, resolved from the server working directory) or content (the text itself, up to 8 MB). ' +
        'Use dryRun: true first to show the user what would be added, then run again without it.',
      inputSchema: {
        path: z.string().optional().describe('File to import. Its extension helps auto-detection.'),
        content: z.string().max(MAX_IMPORT_BYTES).optional().describe('The dictionary text, when the file is not on this machine.'),
        format: z.enum(IMPORT_FORMAT_VALUES).optional().describe("Input format; 'auto' (default) sniffs it."),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
        dryRun: z.boolean().optional().describe('Report what would be added without writing.'),
      },
    },
    async ({ path, content, format, scope, dryRun }) =>
      guarded(async () => {
        if (path === undefined && content === undefined) throw new Error('pass path or content');
        const io = bufferIO();
        const code = await runImport(
          path ?? '-',
          { cwd, format: format ?? 'auto', project: scope === 'project', dryRun: dryRun === true, json: true },
          io,
          content !== undefined ? async () => content : undefined,
        );
        if (code !== 0) throw new Error(io.err().trim() || `import failed (exit ${code})`);
        const out = io.out().trim();
        let report: unknown;
        try {
          report = JSON.parse(out);
        } catch {
          report = { output: out };
        }
        const stderr = io.err().trim();
        return textResult(isRecord(report) ? { ...report, ...(stderr ? { stderr } : {}) } : report);
      }),
  );

  server.registerTool(
    'suggest_terms',
    {
      title: 'Propose lexicon improvements',
      description:
        "Propose new aliases, terms and never-words from the user's voice history, usage and repo. " +
        'Call weekly or when the user asks how to improve corrections; present them and apply accepted ones with apply_suggestion (or add_term). ' +
        "Each suggestion has kind 'alias' (a misspelling to add to an existing term), 'term' (a new name), 'never' (a word wrongly rewritten), or 'stale' (a term that never fires), plus reason, confidence and evidence.",
      inputSchema: {
        cwd: z.string().optional().describe('Repository to scan for evidence. Defaults to the server working directory.'),
        limit: z.number().int().positive().optional().describe('Max suggestions to return.'),
      },
    },
    async ({ cwd: cwdArg, limit }) =>
      guarded(async () => {
        const root = cwdArg ? resolve(cwd, cwdArg) : cwd;
        const loaded = await loadLexicon({ cwd: root });
        const history: VoiceHistoryEntry[] = await loadVoiceHistory(loaded.global.path).catch((err: unknown) => {
          log('loadVoiceHistory failed:', errorMessage(err));
          return [];
        });
        const suggestions = await suggestTerms({ loaded, history, cwd: root, ...(limit !== undefined ? { limit } : {}) });
        return textResult(suggestions);
      }),
  );

  server.registerTool(
    'apply_suggestion',
    {
      title: 'Apply one suggestion',
      description:
        "Apply a suggestion returned by suggest_terms after the user accepted it: 'alias' merges the alias into the term, 'term' adds the term (aliases auto-suggested when none given), " +
        "'never' records the word as never-rewrite on the term, 'stale' removes the term. Pass the suggestion object back as received.",
      inputSchema: {
        suggestion: z.object({
          kind: z.enum(SUGGESTION_KINDS),
          canonical: z.string().min(1),
          alias: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          category: z.enum(TERM_CATEGORIES).optional(),
          reason: z.string().optional(),
          confidence: z.number().optional(),
          evidence: z.array(z.string()).optional(),
          count: z.number().optional(),
        }),
        scope: z.enum(TERM_SCOPES).optional().describe("Where to write: 'global' (default) or 'project'."),
      },
    },
    async ({ suggestion, scope }) =>
      guarded(async () => {
        const { kind, canonical } = suggestion;
        const alias = suggestion.alias?.trim();
        const storeOpts = { cwd, ...(scope !== undefined ? { scope } : {}) };
        if (kind === 'stale') {
          const removed = await removeTerm(canonical, storeOpts);
          return textResult({ kind, canonical, removed, summary: removed ? `removed "${canonical}"` : `"${canonical}" was not in the lexicon` });
        }
        if ((kind === 'alias' || kind === 'never') && !alias) throw new Error(`a "${kind}" suggestion needs an alias`);
        const listed = suggestion.aliases?.map((a) => a.trim()).filter((a) => a !== '') ?? [];
        const aliases = kind === 'never' ? [] : kind === 'alias' && alias ? [alias] : listed.length > 0 ? listed : alias ? [alias] : suggestAliases(canonical);
        const term: Term = {
          canonical,
          aliases,
          source: 'user',
          ...(kind === 'term' && suggestion.category !== undefined ? { category: suggestion.category } : {}),
          ...(kind === 'never' && alias ? { never: [alias] } : {}),
          ...(scope !== undefined ? { scope } : {}),
        };
        const saved = await addTerm(term, storeOpts);
        const summary =
          kind === 'alias'
            ? `"${alias}" -> "${saved.term.canonical}" saved`
            : kind === 'never'
              ? `"${alias}" will never be rewritten to "${saved.term.canonical}"`
              : `added "${saved.term.canonical}" (${saved.term.aliases.length} alias${saved.term.aliases.length === 1 ? '' : 'es'})`;
        return textResult({ kind, canonical: saved.term.canonical, term: saved.term, path: saved.file.path, created: saved.created, summary });
      }),
  );

  server.registerTool(
    'setup_lexicon',
    {
      title: 'One-shot onboarding',
      description:
        "One-shot onboarding: seed the lexicon with the user's company and name, register the MCP server and hooks in their agent clients, optionally start the local API. " +
        'Ask the user for their company/product spelling and which clients they use, then call this. Runs non-interactively and returns a SetupSummary; tell the user what was installed and where the lexicon lives.',
      inputSchema: {
        company: z.string().optional().describe('Company or product name, spelled exactly as it should appear.'),
        person: z.string().optional().describe("The user's own name as they write it."),
        clients: z
          .array(z.enum(INSTALL_CLIENT_VALUES))
          .optional()
          .describe('Agent clients to register the server in. Omit to let setup pick the ones it detects.'),
        serve: z.boolean().optional().describe('Also install the local API (`lexicon serve`) as a login service.'),
      },
    },
    async ({ company, person, clients, serve }) =>
      guarded(async () => {
        const io = bufferIO();
        const cliDir = cliDirForInstall();
        const { code, summary } = await runSetup(
          {
            cwd,
            yes: true,
            json: true,
            ...(company !== undefined ? { company } : {}),
            ...(person !== undefined ? { person } : {}),
            // runSetup takes the CLI's comma-separated form; an empty list means "none".
            ...(clients !== undefined ? { clients: clients.length > 0 ? clients.join(',') : 'none' } : {}),
            ...(serve !== undefined ? { serve } : {}),
          },
          io,
          cliDir !== undefined ? { cliDir } : {},
        );
        const stderr = io.err().trim();
        return textResult({ ok: code === 0, summary, ...(stderr ? { stderr } : {}) });
      }),
  );

  server.registerTool(
    'serve_status',
    {
      title: 'Local API status',
      description:
        'Check whether the local lexicon API (`lexicon serve`, used by the browser extension, Claude Desktop, Shortcuts and the menu bar app) is running on 127.0.0.1:41733. ' +
        'Returns { up: true, version, terms, ... } or { up: false }. Call when a non-MCP surface is not correcting text.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        try {
          const res = await fetch(SERVE_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) return textResult({ up: false, url: SERVE_HEALTH_URL, status: res.status });
          const body: unknown = await res.json();
          return textResult({ up: true, url: SERVE_HEALTH_URL, ...(isRecord(body) ? body : { body }) });
        } catch (err) {
          return textResult({
            up: false,
            url: SERVE_HEALTH_URL,
            error: errorMessage(err),
            hint: 'Start it with `lexicon serve`, or `lexicon serve --install` to keep it running at login (setup_lexicon with serve: true does the same).',
          });
        }
      }),
  );

  // ------------------------------------------------------------ resources

  server.registerResource(
    'Personal voice lexicon',
    'lexicon://me',
    {
      title: 'Personal voice lexicon',
      description:
        'Canonical spellings of names the user dictates and how STT mishears them. Read this before interpreting dictated input.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const loaded = await load();
      let text = exportLexicon(loaded.merged, 'claude-md');
      if (loaded.skippedProject) {
        // Surface only the path, never the untrusted file's contents.
        text += `\n\nNote: this repo has an ${loaded.projectTrust === 'changed' ? 'edited' : 'untrusted'} project lexicon at ${loaded.skippedProject.path} that was not loaded. The user can review it and run \`lexicon trust\`.`;
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    },
  );

  server.registerResource(
    'Lexicon JSON',
    'lexicon://json',
    {
      title: 'Lexicon JSON',
      description: 'The merged lexicon (global + project) as raw JSON.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const loaded = await load();
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: exportLexicon(loaded.merged, 'json') },
        ],
      };
    },
  );

  // -------------------------------------------------------------- prompts

  server.registerPrompt(
    'voice-context',
    {
      title: 'Voice context',
      description:
        "Load the user's canonical spellings into the conversation so dictated input is interpreted correctly for the rest of the session.",
    },
    async () => {
      const loaded = await load();
      const snippet = exportLexicon(loaded.merged, 'claude-md');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `${snippet.trimEnd()}\n\n${VOICE_CONTEXT_INSTRUCTION}` },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'onboard',
    {
      title: 'Set up the voice lexicon',
      description:
        'Walk a new user through onboarding: collect the names STT gets wrong, register the server in their clients with setup_lexicon, add the names, and give them a test sentence.',
    },
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: ONBOARD_PROMPT } }],
    }),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  const shutdown = (): void => {
    server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(transport);
  log('server started (stdio)');
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // realpath both sides so a `bin` symlink still matches the resolved module URL.
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    log('fatal:', errorMessage(err));
    process.exit(1);
  });
}
