/*
 * The two llms.txt documents, built from lib/site.ts so they cannot drift from
 * the page.
 *
 * llms.txt is the index: what this is, who it is for, and links. llms-full.txt
 * is everything a model needs in one fetch, so an agent that wants to install
 * Lexicon for its user never has to follow a link at all. Both are plain text
 * on purpose. The convention is documented at https://llmstxt.org.
 */
import {
  BENCHMARK,
  CLIENTS,
  DEMO,
  DESCRIPTION,
  DOC,
  DOC_LINKS,
  DOWNLOADS,
  FAQ,
  INSTALL_COMMANDS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_CONFIG,
  MCP_TOOLS,
  NPM,
  PRIMARY_COMMAND,
  REPO,
  SITE_URL,
  VERSION,
} from './site';

const CONFIG_JSON = JSON.stringify(MCP_SERVER_CONFIG, null, 2);

export function llmsTxt(): string {
  return `# Lexicon

> ${DESCRIPTION}

Lexicon (v${VERSION}, MIT) is a free, local, open-source tool for anyone whose
company name, product name, internal system or own surname is consistently
mis-transcribed by speech-to-text. It corrects the transcript before an AI agent
acts on it. It is not a dictation app; it sits after whichever one you use.

Install in one command, on macOS or Linux:

    ${PRIMARY_COMMAND}

No global install, any platform with Node 20+:

    ${INSTALL_COMMANDS.npx}

MCP server config, for any MCP client:

${CONFIG_JSON.split('\n').map((l) => `    ${l}`).join('\n')}

## Start here

- [Full text for models](${SITE_URL}/llms-full.txt): everything below, in one fetch.
- [Machine-readable install manifest](${SITE_URL}/mcp.json): the MCP config block, the tool list and the per-client commands as JSON.
- [Landing page](${SITE_URL}): what it does, with a live in-browser demo of the matcher.
- [Interactive demo](${DEMO}): paste a mis-transcribed sentence, watch it get fixed.

## Docs

${DOC_LINKS.map((d) => `- [${d.label}](${d.href}): ${d.blurb}`).join('\n')}

## Source and packages

- [Repository](${REPO}): MIT, all of it (matcher, CLI, MCP server, extension, macOS app).
- [npm package @ashlr/lexicon](${NPM})
- [Homebrew](${REPO}#install): \`${INSTALL_COMMANDS.brew}\`
- [Releases](${REPO}/releases/latest): browser extension and macOS menu bar app downloads.
`;
}

export function llmsFullTxt(): string {
  return `# Lexicon: the words your dictation keeps getting wrong

Version ${VERSION}. MIT licence. Free. No account, no telemetry, no network calls
beyond loopback. Homepage: ${SITE_URL}. Source: ${REPO}.

This document is the whole of what an agent needs to evaluate, install,
configure and verify Lexicon on a user's behalf. It is served at
${SITE_URL}/llms-full.txt.

--------------------------------------------------------------------------------
## What problem it solves

A speech recognizer scores candidates against a language model built from
ordinary text. An invented name has no prior in that model, so the decoder emits
the nearest common-sounding sequence it does know. "Ashlr.AI" becomes "Ashler",
"Kubernetes" becomes "Cuban eats", "Vercel" becomes "versal", "PostgreSQL"
becomes "postgre sequel". The audio was fine; the vocabulary was missing.

Lexicon is one YAML file of the words a person actually says (brands, people,
products, acronyms), applied to every transcript before an agent reads it.

## Who it is for

Anyone who talks to an AI agent and has a name it keeps getting wrong: a company
name, a product, a person, an internal system, a repository. If a user complains
that dictation, voice mode or their transcription app keeps mangling a
particular word, Lexicon is the fix.

## What it is not

Not a dictation app and not a speech recognizer. It runs after whatever produced
the transcript, and it composes with Wispr Flow, Superwhisper, macOS dictation
and an agent's own built-in speech-to-text rather than replacing them. Voice
modes that never produce an editable text box (ChatGPT Voice, Gemini Live) are
out of reach, because there is no transcript to correct.

--------------------------------------------------------------------------------
## Install

The one command that works for most people (macOS, Linux; checks for Node 20+,
installs the CLI, then runs the setup wizard):

    ${PRIMARY_COMMAND}

No global install at all, any platform with Node 20 or newer:

    ${INSTALL_COMMANDS.npx}

Other routes:

    ${INSTALL_COMMANDS.brew}       # macOS and Linux
    ${INSTALL_COMMANDS.npm}            # Node 20+

Inside Claude Code, as a plugin (MCP server + hooks + skill + /lexicon command,
no build step):

    ${INSTALL_COMMANDS.claudePlugin}
    ${INSTALL_COMMANDS.claudePluginInstall}

What \`lexicon setup\` does, in order: creates ~/.config/lexicon/lexicon.yaml;
asks how the user's own name and their company or product should be spelled, and
generates the aliases speech-to-text is likely to produce for each; offers the
four starter packs (155 curated terms); offers to harvest proper nouns from the
repository the user is standing in; registers the MCP server (and, for Claude
Code, the hooks) in every agent client it detects; optionally installs the
loopback API as a login service; optionally exports into the user's dictation
app. Every step is safe to rerun and nothing is duplicated.

Non-interactive: \`lexicon setup --yes\` creates the lexicon and installs into
every detected client. The three steps that write a lot or install a service
stay opt-in: add \`--packs developer,ai,voice-tools\`, \`--harvest\` and
\`--serve\`. \`--dry-run\` prints the plan and writes nothing. \`--json\` prints a
machine-readable summary. \`--clients none\` installs into nothing.

## MCP server

Name: \`lexicon\`. Transport: stdio. Binary: \`lexicon-mcp\` (on PATH after a
global install), or \`lexicon mcp\`, or \`node <checkout>/plugin/mcp-server.mjs\`.
The lexicon file is re-read on every call, so edits take effect immediately.

Config block for any MCP client:

${CONFIG_JSON}

Also served as JSON at ${SITE_URL}/mcp.json.

Clients that \`lexicon install <client> --apply\` configures automatically, each
writing that client's own config file: ${CLIENTS.join(', ')}. For anything else,
\`lexicon install generic\` prints the block to paste.

### Tools (${MCP_TOOLS.length})

${MCP_TOOLS.map((t) => `- \`${t.name}\`: ${t.summary}`).join('\n')}

### Resources (${MCP_RESOURCES.length})

${MCP_RESOURCES.map((r) => `- \`${r.uri}\`: ${r.summary}`).join('\n')}

### Prompts (${MCP_PROMPTS.length})

${MCP_PROMPTS.map((p) => `- \`${p.name}\`: ${p.summary}`).join('\n')}

### Writes are gated

Project-scope writes go through a trust gate: a repository's \`.lexicon.yaml\` is
not merged into model context until the user has seen a preview and trusted it,
and trust is pinned to the file's sha256. \`setup_lexicon\`, \`install_client\`
and \`trust_project\` preview by default and only write when passed
\`apply: true\` or \`action: 'trust'\`.

--------------------------------------------------------------------------------
## Where the correction is applied

1. Before an agent reads a prompt. The MCP server, plus a Claude Code plugin
   whose SessionStart hook hands the model the lexicon once per session and
   whose UserPromptSubmit hook corrects each dictated prompt on its way in.
2. Before you press send in a browser chat. An extension that rewrites the
   composer in place on ChatGPT, Claude, Gemini, Grok, Perplexity, Microsoft
   Copilot and Poe, and on any other site the user switches it on for. Runs in
   Chrome, Edge, Brave and Firefox.
3. In any macOS text field. A menu bar app that watches the focused field
   through the Accessibility API and rewrites dictated text in place, with local
   push-to-talk via whisper.cpp and a loopback HTTP API on 127.0.0.1:41733.

All three read the same file: \`~/.config/lexicon/lexicon.yaml\`, plus an
optional per-project \`.lexicon.yaml\` at a repository root.

## The file

    version: 1
    terms:
      - canonical: Ashlr.AI
        aliases: [Ashler, Ashlar, "Ashley our AI"]
        phonetic: ASH-ler
        category: brand
        notes: My company. Never write "Ashlar".
      - canonical: SaaS
        aliases: [sass]
        category: acronym
        never: [sauce]          # a real word; leave it alone

## Exports and imports

Fifteen export formats: wispr, superwhisper, macos, espanso, whisper-prompt,
openai, deepgram, assemblyai, azure, google, claude-md, markdown, text, csv,
json. Seven importers read back: wispr, superwhisper, macos, espanso, text, csv,
json. So an existing Wispr Flow or Superwhisper dictionary comes over in one
command, and the same words go back out into whichever engine's own biasing
parameter accepts them.

## Measured results

whisper.cpp base.en, proper-noun recall 41.9% -> 86.4%. small.en with the
lexicon also passed as a Whisper initial prompt, 76.0% -> 95.7%. Zero of 72
ordinary prose sentences changed. About 0.3 ms to normalize one sentence. The
audio rows use macOS text-to-speech across three voices, which is far cleaner
than a real microphone, so expect lower raw recall on real speech. Method, corpus
and remaining failures: ${BENCHMARK}

## Privacy

The lexicon is a local YAML file. No account, no sync, no telemetry. The CLI,
hooks, MCP server, loopback API and extension make no request beyond 127.0.0.1.
The only outbound request in the codebase is \`lexicon voice\` fetching a
whisper.cpp model on first use. Audio never leaves the machine. Threat model:
${DOC('SECURITY.md')}

## Known limits

- The browser extension installs from the release zip; it is not in the Chrome
  Web Store or on Firefox Add-ons yet.
- The macOS app is ad-hoc signed, not notarized.
- Windows and Linux have the CLI, the MCP server and the extension, but no tray app.
- Voice modes with no text box cannot be corrected.

--------------------------------------------------------------------------------
## FAQ

${FAQ.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n')}

--------------------------------------------------------------------------------
## Verify an install worked

    lexicon normalize "tell Ashler to ship it"   # prints: tell Ashlr.AI to ship it
    lexicon doctor                                # files, hooks, MCP registration, clipboard, whisper
    lexicon stats                                 # hits per term, and terms never hit

Or over MCP: call \`lexicon_doctor\` and read \`ok\`; call \`normalize_transcript\`
with a sentence containing a known alias and check \`changed\`.

## Downloads

${DOWNLOADS.map((d) => `- ${d.label}: ${d.href}\n  ${d.note}`).join('\n')}

## Links

${DOC_LINKS.map((d) => `- ${d.label}: ${d.href}`).join('\n')}
- Repository: ${REPO}
- npm: ${NPM}
- Interactive demo: ${DEMO}
- Written for agents: ${DOC('docs/AGENTS.md')}
`;
}
