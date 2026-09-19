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
import { resolve } from 'node:path';
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
  harvestRepo,
  learnCorrection,
  loadLexicon,
  normalize,
  recordHits,
  removeTerm,
  suggestAliases,
  suggestCanonicalFor,
} from '../core/index.js';
import type {
  ExportFormat,
  LoadedLexicon,
  Term,
  TermCategory,
  TermScope,
} from '../core/index.js';

export interface ServerOptions {
  /** Directory used to locate the project `.lexicon.yaml`. Defaults to $LEXICON_CWD or process.cwd(). */
  cwd?: string;
}

const SERVER_NAME = 'lexicon';

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

/** Sent to the client at initialize; the one-screen summary of how an agent should use this server. */
const SERVER_INSTRUCTIONS = [
  "Personal voice lexicon: the canonical spellings of names the user dictates and the misspellings STT produces for them.",
  'Read the lexicon://me resource once at session start and keep its canonical forms in mind for the whole session.',
  'Call normalize_transcript on any input that looks dictated (run-on prose, no code, a garbled proper noun) and act on its output.',
  "Call learn_correction whenever the user corrects a spelling ('it's Ashlr.AI not Ashler', 'I said X', or fixes a name you wrote) so it is corrected automatically next time.",
  'If a word looks like a garbled name and normalize_transcript did not change it, call suggest_canonical before guessing.',
  'Never rewrite text inside code blocks, inline code, file paths, URLs or emails.',
].join('\n');

/** stderr-only logger. stdout belongs to the MCP transport. */
function log(...args: unknown[]): void {
  console.error(`[${SERVER_NAME}]`, ...args);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readPackageVersion(): string {
  // dist/mcp/server.js and src/mcp/server.ts sit two levels below package.json;
  // the self-contained plugin/mcp-server.mjs bundle sits one level below it.
  // The name check keeps an unrelated package.json further up from being picked.
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const { name, version } = parsed as { name?: unknown; version?: unknown };
      if (name === '@ashlr/lexicon' && typeof version === 'string') return version;
    } catch {
      // try the next candidate
    }
  }
  log('could not read package.json version');
  return '0.0.0';
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
