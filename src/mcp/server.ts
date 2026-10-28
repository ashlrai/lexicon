#!/usr/bin/env node
/**
 * stdio MCP server exposing the personal lexicon to agents.
 *
 * The tools themselves live in ./tools/*.ts and are registered through
 * ./tools/index.ts; what is left here is the server object, the resources, the
 * prompts and the stdio wiring.
 *
 * Invariants:
 *  - Nothing is ever written to stdout except MCP protocol frames (stdio transport
 *    owns stdout). All diagnostics go through `log()` -> stderr.
 *  - The lexicon is re-read from disk on every tool/resource/prompt call so edits
 *    made by the CLI or by hand show up without restarting the server.
 *  - Tool handlers never throw; failures come back as `{ isError: true }` results so
 *    the calling agent sees a readable message instead of a protocol error.
 */
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, McpError, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LoadOptions, LoadedLexicon } from '../core/index.js';
import { SERVER_NAME, core, loadCore, log, readPackageVersion, skippedProjectFields, withLexiconFix } from './shared.js';
import { errorMessage } from '../util/errors.js';
import { TOOL_REGISTRARS } from './tools/index.js';
import { toolAnnotations } from './annotations.js';
import { MCP_NORMALIZE_BUDGET_MS, MCP_NORMALIZE_MAX_CHARS } from './tools/terms.js';
import { cliCommand } from '../util/cli-hint.js';

export interface ServerOptions {
  /**
   * Directory used to locate the project `.lexicon.yaml`. Defaults to
   * $LEXICON_CWD, else the client's first `file://` MCP root (when the client
   * supports roots), else process.cwd().
   */
  cwd?: string;
  /** How long to wait for the client's `roots/list` answer. Default ROOTS_TIMEOUT_MS. */
  rootsTimeoutMs?: number;
  /** normalize_transcript's matching budget per call. Default MCP_NORMALIZE_BUDGET_MS. */
  normalizeBudgetMs?: number;
  /** Characters of `text` normalize_transcript matches. Default MCP_NORMALIZE_MAX_CHARS. */
  normalizeMaxChars?: number;
}

/**
 * A tool config whose raw `inputSchema` shape is replaced by a strict
 * z.object of the same shape, so undeclared arguments are refused instead of
 * silently dropped. A schema that is already a zod type is left alone.
 */
export function strictInput(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config;
  const shape = (config as { inputSchema?: unknown }).inputSchema;
  if (shape === undefined || shape instanceof z.ZodType) return config;
  return { ...config, inputSchema: z.object(shape as z.ZodRawShape).strict() };
}

/**
 * A tool config with its `annotations` from TOOL_ANNOTATIONS, unless it
 * names its own. Throws for a tool the table does not list.
 */
export function withAnnotations(name: string, config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config;
  const own = (config as { annotations?: unknown }).annotations;
  return { ...config, annotations: own ?? toolAnnotations(name) };
}

/**
 * A prompt's `argsSchema`: strict, so an undeclared argument is refused with
 * -32602 (the SDK's InvalidParams) and a message naming it and the arguments
 * the prompt does take, the way a tool refuses an unknown key. Without one the
 * SDK passed nothing through and never looked, so `voice-context` with
 * `{ "scope": "project" }` answered as if the argument had been applied.
 * Omitted arguments and `{}` still pass.
 */
export function strictPromptArgs(name: string, shape: z.ZodRawShape = {}): z.ZodObject {
  const declared = Object.keys(shape);
  const takes =
    declared.length > 0
      ? `it takes only ${declared.map((k) => JSON.stringify(k)).join(', ')}`
      : 'it takes no arguments; omit arguments or pass {}';
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === 'unrecognized_keys'
        ? `unknown argument${iss.keys.length === 1 ? '' : 's'} ${iss.keys.map((k) => JSON.stringify(k)).join(', ')} for prompt ${name}: ${takes}`
        : undefined,
  });
}

/** Upper bound on one `roots/list` round trip; past it the server keeps the directory it has. */
export const ROOTS_TIMEOUT_MS = 2000;

/**
 * The directory of the first `file://` root that exists, or undefined.
 *
 * A client launches the server wherever it likes (Claude Desktop and Cursor
 * use the app's own directory, not the project), so process.cwd() rarely
 * names the repository whose `.lexicon.yaml` should apply. MCP roots are the
 * client saying which workspace is open. Only a `file:` URI naming an existing
 * directory is taken; anything else is ignored. Exported for tests.
 */
export function cwdFromRoots(roots: ReadonlyArray<{ uri: string }>): string | undefined {
  return dirsFromRoots(roots)[0];
}

/** Every `file://` root that names an existing directory, in order. Exported for tests. */
export function dirsFromRoots(roots: ReadonlyArray<{ uri: string }>): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    if (typeof root?.uri !== 'string' || !root.uri.startsWith('file:')) continue;
    try {
      const dir = fileURLToPath(root.uri);
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      // not a usable local path; try the next root
    }
  }
  return dirs;
}

/**
 * Most characters of lexicon table `lexicon://me` and `voice-context` put into
 * model context (about 4000 tokens); the closing notes (a skipped project
 * file, bounded by pathForModel, and the empty-lexicon note) and the
 * voice-context instruction come on top. The server instructions tell every
 * agent to read lexicon://me at session start, and with no cap a 3000-term
 * lexicon put about 236 KB into the conversation. Rows past it are left out,
 * the most used kept (see exportClaudeMdWithin), and a line says how many and
 * where the rest are. Four times the SessionStart hook's cap, because an
 * agent asked for this text and the hook sends its own on every session.
 */
export const MODEL_CONTEXT_MAX_CHARS = 16_000;

/** The line after the kept rows when `MODEL_CONTEXT_MAX_CHARS` left some out. */
function moreTermsLine(omitted: number): string {
  return (
    `... ${omitted} more term${omitted === 1 ? '' : 's'} left out to keep this short (the most used, then brand, person and product names, are kept). ` +
    'Call list_terms with a query (it matches canonical spellings and aliases) to look one up, or with offset and limit to page through every term, or export_lexicon with format claude-md for the whole table.'
  );
}

/**
 * The model-facing claude-md table: capped at MODEL_CONTEXT_MAX_CHARS, then
 * neutralizeMarkup (`<` / `>` in a canonical or note must not open or close a
 * tag; it keeps the length, so the cap still holds).
 */
function lexiconForModel(loaded: LoadedLexicon): string {
  const { exportClaudeMdWithin, exportLexicon, neutralizeMarkup } = core();
  const full = exportLexicon(loaded.merged, 'claude-md');
  const text = full.length <= MODEL_CONTEXT_MAX_CHARS ? full : exportClaudeMdWithin(loaded.merged, MODEL_CONTEXT_MAX_CHARS, moreTermsLine).text;
  return neutralizeMarkup(text);
}

/**
 * Most characters of `lexicon://json`. It is the merged lexicon pretty-printed,
 * about four times the size of the same terms as the claude-md table, so the
 * cap is four times MODEL_CONTEXT_MAX_CHARS. With no cap a 3000-term lexicon
 * was about 1 MB of JSON in one resource read. Past it the most used terms are
 * kept (the order `export_lexicon`'s `limit` uses), `omittedTerms` counts the
 * rest and `note` says how to get them.
 */
export const LEXICON_JSON_MAX_CHARS = MODEL_CONTEXT_MAX_CHARS * 4;

/** The `note` sentence when LEXICON_JSON_MAX_CHARS left terms out of lexicon://json. */
function jsonOmittedNote(omitted: number, total: number): string {
  return (
    `${omitted} of ${total} term${total === 1 ? '' : 's'} left out to keep this resource under ${LEXICON_JSON_MAX_CHARS} characters (the most used, then brand, person and product names, are kept). ` +
    'Call export_lexicon with format json for the whole lexicon, list_terms with a query to look one up, or list_terms with offset and limit to page through every term.'
  );
}

/**
 * The lexicon://json text: `merged` with `extra` (skipped-file fields and the
 * note), whole when it fits in LEXICON_JSON_MAX_CHARS, otherwise with the most
 * terms that fit (selectExportTerms order) plus `omittedTerms` and a note.
 */
function lexiconJsonWithin(merged: LoadedLexicon['merged'], extra: { note?: string; [key: string]: unknown }): string {
  const render = (terms: LoadedLexicon['merged']['terms'], more: Record<string, unknown>): string =>
    `${JSON.stringify({ ...merged, terms, ...extra, ...more }, null, 2)}\n`;
  const full = render(merged.terms, {});
  if (full.length <= LEXICON_JSON_MAX_CHARS) return full;
  const total = merged.terms.length;
  const capped = (keep: number): string => {
    const omitted = total - keep;
    const note = [extra.note, jsonOmittedNote(omitted, total)].filter((n): n is string => n !== undefined).join(' ');
    return render(core().selectExportTerms(merged, { limit: keep }), { omittedTerms: omitted, note });
  };
  // The most terms that fit: the text grows with every term kept.
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (capped(mid).length <= LEXICON_JSON_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return capped(lo);
}

const VOICE_CONTEXT_INSTRUCTION =
  'Apply these canonical spellings to everything I say for the rest of this session. ' +
  'If you see a word that looks like a garbled version of one of them, use the canonical form without asking.';

/**
 * What `voice-context`, `lexicon://me` and `lexicon://json` (its `note`, without the leading `Note: `) say when the merged lexicon has no
 * terms: an empty table under "apply these spellings" read as a lexicon that
 * was loaded and simply had nothing to correct.
 */
function emptyLexiconNote(): string {
  return (
    `Note: ${core().noTermsYet({ lower: true, so: 'there are no spellings to apply and dictated names are not being corrected' })}. ` +
    'If the user dictates, offer once to set it up (the onboard prompt, or setup_lexicon, which previews before it writes).'
  );
}

/** The `onboard` prompt: a user-role script that drives the model through first-run setup. */
const ONBOARD_PROMPT = [
  'Help me set up my voice lexicon so the names I dictate come out spelled right. Go in this order, one question at a time, and keep each message short:',
  '1. Ask for my company or product names, spelled exactly as they should appear (capitalization and punctuation included), and how I pronounce each one.',
  '2. Ask for my own name as I write it, then for the names of teammates or people I mention often, spelled the way they write them.',
  '3. Ask which agent clients I use: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI or VS Code.',
  '4. Call setup_lexicon with my company, my name and those clients, show me its plan, and apply it only after I say yes. Tell me what it installed and where the lexicon file lives.',
  '5. For every other name I gave you, call add_term with aliases omitted, which generates likely misspellings when it can. It often generates none (the aliases in the result are empty), so show each term with its aliases on one line so I can veto any, and for a term with no aliases propose two or three spellings speech-to-text is likely to write from how I pronounce it, or ask me what it writes. Add the ones I accept with add_term and aliases.',
  '6. Offer the starter packs once (list_packs; say in one line what each contains) and add only the ones I pick.',
  '7. Finish by proving it works: write one test sentence I can dictate that contains two of my names, then run normalize_transcript on that same sentence with those names spelled the way speech-to-text gets them wrong (use their aliases), so I can see the before and after. Then tell me to try it in a new session.',
  'Never install anything or trust a project file without telling me first. If a step fails, show me the error and continue with the rest.',
].join('\n');

/**
 * What to do when the user is clearly dictating but has no lexicon. Offered as
 * part of the server instructions rather than as its own prompt, because the
 * moment it applies is mid-conversation, not at a slash command.
 *
 * The line to walk: an agent that silently sets things up has installed
 * software the user did not ask for; an agent that pitches on every message is
 * an ad. So: notice, finish the actual request first, then one sentence,
 * once -- and take "no" as permanent for the session.
 */
const PROACTIVE_OFFER = [
  'OFFERING SETUP UNPROMPTED: if a message looks dictated and contains a proper noun you do not recognise, and lexicon_doctor says ready is false,',
  'you may offer to set this up on your own initiative -- but answer what the user actually asked first, then add at most one short sentence, once per session,',
  'naming the word that looked wrong ("Ashler" looked like a name STT mangled -- want me to set up a lexicon so it comes out right?).',
  'Do not offer twice, do not offer when the user is busy with something failing, and never run setup_lexicon with apply: true, install_client, add_pack or trust_project without an explicit yes.',
  'If the user says no, drop it for the session and just keep calling normalize_transcript.',
].join(' ');

/** Sent to the client at initialize; the one-screen summary of how an agent should use this server. */
const SERVER_INSTRUCTIONS = [
  "Personal voice lexicon: the canonical spellings of names the user dictates and the misspellings STT produces for them.",
  'Read the lexicon://me resource once at session start and keep its canonical forms in mind for the whole session.',
  'Call normalize_transcript on any input that looks dictated (run-on prose, no code, a garbled proper noun) and act on its output.',
  "Call learn_correction whenever the user corrects a spelling ('it's Ashlr.AI not Ashler', 'I said X', or fixes a name you wrote) so it is corrected automatically next time.",
  'If a word looks like a garbled name and normalize_transcript did not change it, call suggest_canonical before guessing.',
  'Never rewrite text inside code blocks, inline code, file paths, URLs or emails.',
  "If the lexicon is empty, offer to set it up: ask for the company/product spelling, the user's own name and the clients in use, then call setup_lexicon (or use the onboard prompt).",
  'lexicon_doctor answers "is this set up, and what fixes it" in one call: read its ready, summary and nextStep fields and relay those rather than the whole check list.',
  PROACTIVE_OFFER,
  'setup_lexicon previews by default: call it without apply to get the plan (what it would seed, the starter packs it would offer, the repo names it could harvest, the clients it detected, whether it would install the login service), show the plan to the user, then call again with apply: true, clients: [...], packs: [...], harvest: true and serve: true only for what the user agreed to. Omitted clients install nothing; omitted packs, harvest and serve do nothing.',
  'Starter packs (list_packs: developer, ai, business, voice-tools) give a new user dozens of curated names each (list_packs has the count); offer them once, name what a pack contains, and call add_pack only for the packs the user picked.',
  'When corrections are not happening, call lexicon_doctor. When the user asks how to improve corrections, call suggest_terms, present the proposals (including pronunciation hints, kind "phonetic") and apply the accepted ones with apply_suggestion.',
  'Preview install_client (and dry-run uninstall_client) before applying it, and never trust a project lexicon (trust_project) before showing the user its preview and getting a yes. Never install into a client or create a login service the user did not name.',
].join('\n');

export function createServer(opts: ServerOptions = {}): McpServer {
  // An explicit directory (option or LEXICON_CWD, which `lexicon install`
  // writes) always wins; otherwise the client's roots may replace the default.
  const explicit = opts.cwd ?? (process.env.LEXICON_CWD?.trim() || undefined);
  let cwd = explicit ?? process.cwd();
  // Every usable directory the client named as a root: tools that read a
  // model-chosen path (harvest_repo, suggest_terms, trust_project, import_dictionary) may read inside these.
  let clientRoots: string[] = [];
  let rootsPending: Promise<void> | undefined;
  const load = async (loadOpts: Pick<LoadOptions, 'parseSkipped'> = {}): Promise<LoadedLexicon> => {
    // A call that races the first roots/list answer waits for it (bounded by the timeout).
    if (rootsPending) await rootsPending;
    const { loadLexicon } = await loadCore();
    return loadLexicon({ cwd, ...loadOpts });
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: readPackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  if (explicit === undefined) {
    const refreshRoots = (): Promise<void> => {
      const pending = server.server
        .listRoots(undefined, { timeout: opts.rootsTimeoutMs ?? ROOTS_TIMEOUT_MS })
        .then(({ roots }) => {
          clientRoots = dirsFromRoots(roots);
          const dir = clientRoots[0];
          if (dir !== undefined && dir !== cwd) {
            cwd = dir;
            log('project directory from MCP roots:', dir);
          }
        })
        .catch((err: unknown) => log('roots/list failed; keeping', cwd, '-', errorMessage(err)))
        .finally(() => {
          if (rootsPending === pending) rootsPending = undefined;
        });
      rootsPending = pending;
      return pending;
    };
    server.server.oninitialized = () => {
      if (server.server.getClientCapabilities()?.roots) void refreshRoots();
    };
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      void refreshRoots();
    });
  }

  // ---------------------------------------------------------------- tools

  // Every tool waits for an in-flight roots/list too, not only the ones that
  // call load(): a handler that resolved the project path before the answer
  // and named it after would describe two different directories.
  //
  // Each tool's argument shape is also made strict here. The SDK wraps a raw
  // shape in a stripping z.object, so a misspelt key (`alias` for `aliases`,
  // `txt` for `text`) was dropped without a word and the call went ahead as if
  // the argument had never been given: add_term then auto-suggested aliases the
  // agent did not ask for. A strict object refuses the unknown key by name and
  // advertises `additionalProperties: false` in tools/list.
  const registerTool = server.registerTool.bind(server);
  const registeredTools = new Set<string>();
  // The SDK installs its tools/call handler lazily during the first registration.
  // Validate the envelope outside its execution-error catch: malformed requests
  // and unknown tools are protocol errors, unlike a known tool's invalid inputs.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if ((schema as unknown) === CallToolRequestSchema) {
      setRequestHandler(z.object({ method: z.literal('tools/call') }).passthrough(), async (request, extra) => {
        const parsed = CallToolRequestSchema.safeParse(request);
        if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call request: ${parsed.error.message}`);
        if (!registeredTools.has(parsed.data.params.name)) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${parsed.data.params.name}`);
        }
        return handler(parsed.data as never, extra);
      });
    } else {
      setRequestHandler(schema, handler);
    }
  };
  const gatedRegisterTool = (name: string, config: unknown, cb: (...args: unknown[]) => unknown): unknown => {
    const tool = registerTool(name, withAnnotations(name, strictInput(config)) as never, (async (...args: unknown[]) => {
      if (rootsPending) await rootsPending;
      return cb(...args);
    }) as never);
    registeredTools.add(name);
    return tool;
  };
  server.registerTool = gatedRegisterTool as typeof server.registerTool;

  // `cwd` is a getter so every handler reads the directory as it is now.
  const ctx = {
    get cwd(): string {
      return cwd;
    },
    get roots(): readonly string[] {
      return clientRoots;
    },
    load,
    normalizeBudgetMs: opts.normalizeBudgetMs ?? MCP_NORMALIZE_BUDGET_MS,
    normalizeMaxChars: opts.normalizeMaxChars ?? MCP_NORMALIZE_MAX_CHARS,
  };
  for (const register of TOOL_REGISTRARS) register(server, ctx);
  server.server.setRequestHandler = setRequestHandler;

  // Resources and prompts have no isError result: a thrown error becomes the
  // JSON-RPC error message. For a lexicon file that does not parse, that was
  // the bare parse error; it now carries the fix, as a tool's error does.
  const loadForContext = async (): Promise<LoadedLexicon> => {
    try {
      // Resources and prompts name a skipped project file by path only
      // (skippedProjectSuffix, skippedProjectFields), so it is never parsed.
      return await load({ parseSkipped: false });
    } catch (err) {
      const message = errorMessage(err);
      const fixed = withLexiconFix(message);
      if (fixed === message) throw err;
      log('lexicon unreadable:', message);
      throw new Error(fixed);
    }
  };

  server.registerResource(
    'Personal voice lexicon',
    'lexicon://me',
    {
      title: 'Personal voice lexicon',
      description:
        'Canonical spellings of names the user dictates and how STT mishears them, as markdown (the claude-md export of the global lexicon plus the project .lexicon.yaml when it is trusted). Read this before interpreting dictated input. ' +
        'An untrusted (or changed) project file is left out and named by path in a closing note, never quoted; with no terms at all, a closing note says so and how to set the lexicon up. ' +
        `The table is capped at ${MODEL_CONTEXT_MAX_CHARS} characters: past that the most used terms (then brand, person and product names) are kept and a line says how many were left out; list_terms (with a query, or offset and limit to page) and export_lexicon (format claude-md) reach the rest.`,
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const loaded = await loadForContext();
      // Capped and markup-neutralized: this text is read as context (lexiconForModel).
      const text = lexiconForModel(loaded) + skippedProjectSuffix(loaded) + emptyLexiconSuffix(loaded);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    },
  );

  for (const glossary of [false, true]) server.registerResource(
    glossary ? 'Agent glossary' : 'Lexicon JSON',
    glossary ? 'lexicon://glossary' : 'lexicon://json',
    {
      title: glossary ? 'Agent glossary' : 'Lexicon JSON',
      description:
        (glossary ? 'Read-only team glossary for coding agents: activePacks lists installed global and trusted project packs; terms contains the current canonical spellings, aliases and notes, including custom terms. Read on demand to use the team vocabulary. ' : '') +
        'The merged lexicon as raw JSON: the global file plus the project .lexicon.yaml when it is trusted. An untrusted (or changed) project file is left out; the JSON then adds `projectTrust`, `skippedProject` (its path, never its contents) and `note`. With no terms at all, `note` says so (after the skipped-file sentence, when there is one) and how to set the lexicon up. ' +
        `The text is capped at ${LEXICON_JSON_MAX_CHARS} characters: past that the most used terms (then brand, person and product names) are kept, \`omittedTerms\` counts the rest and \`note\` says so; export_lexicon (format json) and list_terms (with a query, or offset and limit to page) reach them.`,
      mimeType: 'application/json',
    },
    async (uri) => {
      const loaded = await loadForContext();
      // Additive keys, present only when a project file was skipped (path
      // only, never its contents), as list_terms and lexicon_stats report it.
      // The lexicon JSON importer strips unknown keys, so the text still imports.
      // With no terms (and no skipped file to name), the `note` lexicon://me
      // carries, so an empty `terms` does not read as a loaded lexicon that
      // simply has nothing to correct.
      // Both when both apply: a skipped project file and no terms at all
      // (lexicon://me and voice-context say both too).
      const skipped = skippedProjectFields(loaded);
      const empty = loaded.merged.terms.length === 0 ? emptyLexiconNote().replace(/^Note: /, '') : undefined;
      const note = [skipped.note, empty].filter((n): n is string => n !== undefined).join(' ');
      const extra = note ? { ...skipped, note } : skipped;
      // The merged view, `scope` and `hits` included (the json export leaves
      // them out), capped at LEXICON_JSON_MAX_CHARS like lexicon://me.
      const text = lexiconJsonWithin(loaded.merged, glossary ? { ...extra, activePacks: core().installedPacks(loaded) } : extra);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text }],
      };
    },
  );

  // -------------------------------------------------------------- prompts

  // registerPrompt takes a raw shape and wraps it in a stripping z.object, so
  // the strict schema goes on the registered prompt itself (as the SDK stores
  // it). With a schema the callback gets (args, extra); both ignore them.
  server.registerPrompt(
    'voice-context',
    {
      title: 'Voice context',
      description:
        "Load the user's canonical spellings into the conversation so dictated input is interpreted correctly for the rest of the session: the lexicon://me text and an instruction to apply it. " +
        'Takes no arguments. With no terms it says there is nothing to apply and how to set the lexicon up instead; an untrusted project file is left out and named by path. ' +
        `The table is capped at ${MODEL_CONTEXT_MAX_CHARS} characters as lexicon://me is, with a line saying how many terms were left out and how to get them.`,
    },
    async () => {
      const loaded = await loadForContext();
      // The same path-only note lexicon://me carries, so the session knows the
      // repo's own spellings are missing and why.
      const snippet = lexiconForModel(loaded).trimEnd() + skippedProjectSuffix(loaded);
      // Nothing to apply: say so instead of asking the model to apply an empty table.
      const instruction = loaded.merged.terms.length === 0 ? emptyLexiconNote() : VOICE_CONTEXT_INSTRUCTION;
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `${snippet}\n\n${instruction}` },
          },
        ],
      };
    },
  ).argsSchema = strictPromptArgs('voice-context');

  server.registerPrompt(
    'onboard',
    {
      title: 'Set up the voice lexicon',
      description:
        'Walk a new user through onboarding: collect the names STT gets wrong, register the server in their clients with setup_lexicon, add the names, offer the starter packs, and give them a test sentence run through normalize_transcript. ' +
        'Takes no arguments; it reads nothing and returns the script for the model to follow, which installs nothing without the user saying yes.',
    },
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: ONBOARD_PROMPT } }],
    }),
  ).argsSchema = strictPromptArgs('onboard');

  return server;
}

/**
 * A path-only note on a skipped project lexicon, never its contents; '' when
 * none was skipped. The path goes through `pathForModel`, as in the hook's
 * note: this text is raw markdown (no JSON escaping), and the directory is
 * named by whoever published the repo, so an escape sequence, a bidi
 * override, a fake tag or kilobytes of text in it would otherwise reach the
 * conversation verbatim.
 */
function skippedProjectSuffix(loaded: LoadedLexicon): string {
  if (!loaded.skippedProject) return '';
  const where = core().pathForModel(loaded.skippedProject.path);
  return `\n\nNote: this repo has an ${loaded.projectTrust === 'changed' ? 'edited' : 'untrusted'} project lexicon at ${where} that was not loaded. The user can review it and run ${cliCommand('trust')}.`;
}

/** The empty-lexicon note after a blank line when the merged lexicon has no terms, else ''. */
function emptyLexiconSuffix(loaded: LoadedLexicon): string {
  return loaded.merged.terms.length === 0 ? `\n${emptyLexiconNote()}\n` : '';
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

/**
 * Answers `--version` / `-v` and `--help` / `-h` without starting the stdio
 * server. Returns the text to print, or undefined when the server should run.
 */
export function cliFlagOutput(argv: readonly string[]): string | undefined {
  if (argv.includes('--version') || argv.includes('-v')) return readPackageVersion();
  if (argv.includes('--help') || argv.includes('-h')) {
    return 'Usage: lexicon-mcp [--version] [--help]  (stdio MCP server for the personal lexicon; run it from an MCP client)';
  }
  return undefined;
}

if (isMainModule()) {
  const flagOutput = cliFlagOutput(process.argv.slice(2));
  if (flagOutput !== undefined) {
    process.stdout.write(`${flagOutput}\n`);
  } else {
    main().catch((err: unknown) => {
      log('fatal:', errorMessage(err));
      process.exit(1);
    });
  }
}
