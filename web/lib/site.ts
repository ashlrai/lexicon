/*
 * One source of truth for everything this site says about Lexicon.
 *
 * The same facts have to appear in five places that are read by five different
 * kinds of reader: the rendered page (a person), the JSON-LD (a search engine),
 * /llms.txt and /llms-full.txt (a model fetching the site), /mcp.json (an agent
 * about to write a config file) and the <meta> tags (a link preview). When those
 * drift, the answer-engine copy is the one that goes stale silently, because
 * nobody ever looks at it. So they all import from here.
 *
 * Every number below is derived from the repo and checked by
 * `node scripts/check-facts.mjs`: nineteen MCP tools, two resources, two
 * prompts, fifteen export formats, seven importers, four packs, 155 terms.
 */

export const SITE_URL = 'https://lexicon.ashlr.ai';
export const REPO = 'https://github.com/ashlrai/lexicon';
export const NPM = 'https://www.npmjs.com/package/@ashlr/lexicon';
export const DEMO = 'https://ashlrai.github.io/lexicon/';
export const VERSION = '0.5.0';

export const DOC = (file: string) => `${REPO}/blob/main/${file}`;
export const BENCHMARK = DOC('docs/BENCHMARK.md');

/** One-click download of the asset on whatever the latest release is. */
export const LATEST_ASSET = (name: string) => `${REPO}/releases/latest/download/${name}`;

export const TAGLINE = 'the words your dictation keeps getting wrong';

export const DESCRIPTION =
  'Speech-to-text is excellent at English and wrong about your vocabulary. ' +
  'Lexicon is one YAML file of the names, products and acronyms you say out loud, ' +
  'applied to every transcript before an agent reads it.';

/**
 * The single best first command. It works on macOS and Linux, checks for Node,
 * installs the CLI and then runs the setup wizard, so one paste ends with a
 * configured lexicon rather than an installed binary and no idea what is next.
 */
export const PRIMARY_COMMAND = 'curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh';

/** What happens after you run it, in one line. */
export const PRIMARY_RESULT =
  'Takes about a minute: it writes ~/.config/lexicon/lexicon.yaml, asks how your ' +
  'company and your own name should be spelled, and registers the MCP server with ' +
  'every agent client it finds on the machine.';

export const INSTALL_COMMANDS = {
  script: PRIMARY_COMMAND,
  npx: 'npx @ashlr/lexicon@latest setup',
  brew: 'brew install ashlrai/tap/lexicon',
  npm: 'npm i -g @ashlr/lexicon',
  claudePlugin: 'claude plugin marketplace add ashlrai/lexicon',
  claudePluginInstall: 'claude plugin install lexicon@ashlrai',
} as const;

/** The block an MCP client needs, verbatim. Mirrors docs/MCP.md. */
export const MCP_SERVER_CONFIG = {
  mcpServers: {
    lexicon: {
      command: 'lexicon-mcp',
      args: [] as string[],
    },
  },
} as const;

/** Nineteen tools. Order and names from the running server (scripts/check-facts.mjs). */
export const MCP_TOOLS: { name: string; summary: string }[] = [
  { name: 'normalize_transcript', summary: 'Correct a dictated transcript and report what changed.' },
  { name: 'add_term', summary: 'Add a canonical spelling, with aliases suggested when omitted.' },
  { name: 'remove_term', summary: 'Remove a term.' },
  { name: 'list_terms', summary: 'List or search the merged lexicon.' },
  { name: 'export_lexicon', summary: 'Export to any of the fifteen formats.' },
  { name: 'learn_correction', summary: 'Record "heard X, meant Y" as a new alias.' },
  { name: 'suggest_canonical', summary: 'Closest existing terms to a garbled word, for "did you mean".' },
  { name: 'lexicon_stats', summary: 'Hits per term, totals, never-hit terms.' },
  { name: 'harvest_repo', summary: 'Find proper nouns in a repository worth adding.' },
  { name: 'suggest_terms', summary: 'Propose aliases, terms and stale entries from usage.' },
  { name: 'apply_suggestion', summary: 'Apply one accepted suggestion.' },
  { name: 'trust_project', summary: 'Show, trust or untrust a project .lexicon.yaml.' },
  { name: 'lexicon_doctor', summary: 'The doctor checks as structured data.' },
  { name: 'install_client', summary: 'Preview or write the MCP config for a named client.' },
  { name: 'setup_lexicon', summary: 'Plan or run first-time setup non-interactively.' },
  { name: 'serve_status', summary: 'Whether the loopback API on 127.0.0.1:41733 is up.' },
  { name: 'list_packs', summary: 'The four starter packs and which are installed.' },
  { name: 'add_pack', summary: 'Install a starter pack.' },
  { name: 'import_dictionary', summary: 'Import a Wispr, Superwhisper, macOS, espanso, CSV or JSON dictionary.' },
];

export const MCP_RESOURCES = [
  { uri: 'lexicon://me', summary: 'The merged lexicon as markdown. What an agent should read at session start.' },
  { uri: 'lexicon://json', summary: 'The merged lexicon as JSON.' },
];

export const MCP_PROMPTS = [
  { name: 'voice-context', summary: 'The lexicon plus an instruction to apply it for the rest of the session.' },
  { name: 'onboard', summary: 'Walks the agent through first-run setup, then calls setup_lexicon.' },
];

/** Clients `lexicon install <client> --apply` knows how to configure. */
export const CLIENTS = [
  'claude',
  'claude-desktop',
  'codex',
  'cursor',
  'windsurf',
  'gemini',
  'vscode',
] as const;

/* --------------------------------------------------------------------- faq */

/**
 * Written to be quotable standalone: each answer names Lexicon, avoids "it" as
 * the opening subject, and states something a reader can check against the repo.
 * Nothing here is a claim the docs do not already make.
 */
export type Faq = { q: string; a: string };

export const FAQ: Faq[] = [
  {
    q: 'Why does dictation get my company name wrong?',
    a:
      'Because the name is out-of-vocabulary. A speech recognizer scores candidate words against a language model built from ordinary text, and an invented name has no prior in it, so the decoder picks the nearest common-sounding sequence it does know: "Ashlr.AI" becomes "Ashler", "Kubernetes" becomes "Cuban eats", "Vercel" becomes "versal". The audio was fine and the microphone was fine; the vocabulary was missing. Lexicon fixes it afterwards by mapping the spellings you actually get back to the one you meant.',
  },
  {
    q: 'How do I install Lexicon?',
    a:
      'One command: `curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh`. It checks for Node 20 or newer, installs the `@ashlr/lexicon` CLI and then runs `lexicon setup`, which writes `~/.config/lexicon/lexicon.yaml`, asks how your company and your own name should be spelled, and registers the MCP server with every agent client it finds. `brew install ashlrai/tap/lexicon` and `npm i -g @ashlr/lexicon` install the same CLI, and `npx @ashlr/lexicon@latest setup` runs the wizard with no global install at all.',
  },
  {
    q: 'How do I fix a brand name in ChatGPT, Claude, Claude Code, Codex or Cursor?',
    a:
      'Add the term once and Lexicon applies it everywhere. `lexicon setup` registers the Lexicon MCP server in the config file of every client it detects (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code), and in Claude Code it also installs SessionStart and UserPromptSubmit hooks so the correction reaches the model before it reads your prompt. For ChatGPT, Claude.ai, Gemini, Grok, Perplexity, Copilot and Poe in a browser, the Lexicon extension rewrites the composer before you press send. You can add the term from the terminal with `lexicon add "Ashlr.AI"`, or just tell the agent "it is Ashlr.AI, not Ashler" and it calls the `learn_correction` tool.',
  },
  {
    q: 'Does Lexicon work with Wispr Flow, Superwhisper or macOS dictation?',
    a:
      'Yes, and in both directions. Lexicon runs after whatever produced the transcript, so it corrects the text those apps write before an agent or a text field sees it. It also exports into their own dictionaries: `lexicon export wispr` writes the CSV that Wispr Flow’s Dictionary > Import reads, `lexicon export superwhisper` writes its replacements JSON, and `lexicon export macos` writes a Text Replacement `.plist` for System Settings. `lexicon import` reads all three back, so a dictionary you have already trained comes over in one command instead of being retyped.',
  },
  {
    q: 'Does Lexicon work in Slack, Mail, Notes and other Mac apps?',
    a:
      'Yes, through the macOS menu bar app. It watches the focused text field through the Accessibility API and rewrites dictated text in place, so it works in Slack, Mail, Notes, your editor, anywhere there is a text field, and you grant Accessibility permission once in System Settings > Privacy & Security. Local push-to-talk with whisper.cpp is built in, and so is a loopback HTTP API on 127.0.0.1 if you would rather call it from your own script. Windows and Linux have the CLI, the MCP server and the browser extension, but no tray app yet.',
  },
  {
    q: 'Is my text sent anywhere?',
    a:
      'No. Your lexicon is a plain YAML file at `~/.config/lexicon/lexicon.yaml`: there is no account, no sync and no telemetry, and the CLI, the hooks, the MCP server, the local API and the browser extension make no network request beyond the loopback interface. The only outbound request anywhere in the codebase is `lexicon voice` downloading a whisper.cpp model the first time you use local push-to-talk; audio itself never leaves the machine. The full threat model, including how an untrusted project lexicon is kept out of model context, is in SECURITY.md.',
  },
  {
    q: 'What is an MCP server, and do I need one?',
    a:
      'MCP, the Model Context Protocol, is a standard way for an AI agent to call tools that run on your own machine. Lexicon ships one, named `lexicon`, over stdio, with nineteen tools, two resources and two prompts, so an agent can normalize a transcript, add a term, learn a correction or run setup without you opening a terminal. You want it if you talk to an agent and need the names fixed before the agent acts. You do not need it for the browser extension, the menu bar app or the CLI, which read the same file directly.',
  },
  {
    q: 'How is this different from a dictation app’s custom dictionary?',
    a:
      'A dictation app’s dictionary only applies to the text that app produced. Agents increasingly own their own speech-to-text, so a transcript made inside ChatGPT, Claude Code or a phone keyboard never passes through Wispr Flow or Superwhisper, and the same name breaks again in every new place. Lexicon is one file you own, applied at three points instead: before an agent reads a prompt, before you press send in a browser chat, and in any macOS text field. It exports into those dictionaries too, so it replaces none of them and reaches where they cannot.',
  },
  {
    q: 'What does Lexicon cost?',
    a:
      'Nothing. Lexicon is free and MIT-licensed, with no paid tier, no account and no telemetry. The matcher, the CLI, the MCP server, the Claude Code plugin, the browser extension and the macOS menu bar app are all in one public repository at github.com/ashlrai/lexicon.',
  },
];

/* -------------------------------------------------------------------- links */

export const DOC_LINKS: { label: string; href: string; blurb: string }[] = [
  { label: 'Quickstart', href: DOC('docs/QUICKSTART.md'), blurb: 'Nothing to working in five minutes.' },
  { label: 'Install into your agents', href: DOC('docs/CLIENTS.md'), blurb: 'Per-client config for the seven supported clients.' },
  { label: 'MCP server reference', href: DOC('docs/MCP.md'), blurb: 'The nineteen tools, two resources and two prompts.' },
  { label: 'Agent-native usage', href: DOC('docs/AGENT-NATIVE.md'), blurb: 'How an agent is meant to chain the tools.' },
  { label: 'For agents', href: DOC('docs/AGENTS.md'), blurb: 'Install and verify Lexicon on a user’s behalf.' },
  { label: 'FAQ', href: DOC('docs/FAQ.md'), blurb: 'The same answers as this page, as markdown.' },
  { label: 'Exports and imports', href: DOC('docs/EXPORTS.md'), blurb: 'Fifteen formats out, seven in.' },
  { label: 'Browser extension', href: DOC('docs/EXTENSION.md'), blurb: 'ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot, Poe.' },
  { label: 'macOS menu bar app', href: DOC('docs/MACOS-APP.md'), blurb: 'Any text field, via the Accessibility API.' },
  { label: 'CLI reference', href: DOC('docs/CLI.md'), blurb: 'All twenty-five commands.' },
  { label: 'Benchmark and method', href: BENCHMARK, blurb: 'The numbers, the corpus and what still fails.' },
  { label: 'Security and trust model', href: DOC('SECURITY.md'), blurb: 'What is local, and how project files are gated.' },
];

export const DOWNLOADS = [
  {
    label: 'Browser extension (Chrome, Edge, Brave)',
    href: LATEST_ASSET('lexicon-extension.zip'),
    note: 'Unpacked zip; load it at chrome://extensions with Developer mode on.',
  },
  {
    label: 'Browser extension (Firefox)',
    href: LATEST_ASSET('lexicon-extension-firefox.zip'),
    note: 'Load it as a temporary add-on from about:debugging.',
  },
  {
    label: 'LexiconBar for macOS',
    href: LATEST_ASSET('LexiconBar.app.zip'),
    note: 'Menu bar app, ad-hoc signed: right-click > Open the first time.',
  },
];
