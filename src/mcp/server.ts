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
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { exportLexicon, loadLexicon } from '../core/index.js';
import type { LoadedLexicon } from '../core/index.js';
import { SERVER_NAME, log, readPackageVersion } from './shared.js';
import { errorMessage } from '../util/errors.js';
import { TOOL_REGISTRARS } from './tools/index.js';

export interface ServerOptions {
  /** Directory used to locate the project `.lexicon.yaml`. Defaults to $LEXICON_CWD or process.cwd(). */
  cwd?: string;
}

const VOICE_CONTEXT_INSTRUCTION =
  'Apply these canonical spellings to everything I say for the rest of this session. ' +
  'If you see a word that looks like a garbled version of one of them, use the canonical form without asking.';

/** The `onboard` prompt: a user-role script that drives the model through first-run setup. */
const ONBOARD_PROMPT = [
  'Help me set up my voice lexicon so the names I dictate come out spelled right. Go in this order, one question at a time, and keep each message short:',
  '1. Ask for my company or product names, spelled exactly as they should appear (capitalization and punctuation included), and how I pronounce each one.',
  '2. Ask for the names of teammates or people I mention often, spelled the way they write them.',
  '3. Ask which agent clients I use: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI or VS Code.',
  '4. Call setup_lexicon with my company, my name and those clients, show me its plan, and apply it only after I say yes. Tell me what it installed and where the lexicon file lives.',
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
  "If the lexicon is empty, offer to set it up: ask for the company/product spelling, the user's own name and the clients in use, then call setup_lexicon (or use the onboard prompt).",
  'setup_lexicon previews by default: call it without apply to get the plan (what it would seed, the starter packs it would offer, the repo names it could harvest, the clients it detected, whether it would install the login service), show the plan to the user, then call again with apply: true, clients: [...], packs: [...], harvest: true and serve: true only for what the user agreed to. Omitted clients install nothing; omitted packs, harvest and serve do nothing.',
  'Starter packs (list_packs: developer, ai, business, voice-tools) give a new user sixty-odd curated names each; offer them once, name what a pack contains, and call add_pack only for the packs the user picked.',
  'When corrections are not happening, call lexicon_doctor. When the user asks how to improve corrections, call suggest_terms, present the proposals and apply the accepted ones with apply_suggestion.',
  'Preview install_client before applying it, and never trust a project lexicon (trust_project) before showing the user its preview and getting a yes. Never install into a client or create a login service the user did not name.',
].join('\n');

export function createServer(opts: ServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.env.LEXICON_CWD ?? process.cwd();
  const load = (): Promise<LoadedLexicon> => loadLexicon({ cwd });

  const server = new McpServer(
    { name: SERVER_NAME, version: readPackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ---------------------------------------------------------------- tools

  for (const register of TOOL_REGISTRARS) register(server, { cwd, load });

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
