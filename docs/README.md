# Lexicon documentation

Everything about [`@ashlr/lexicon`](https://www.npmjs.com/package/@ashlr/lexicon), grouped by
what you are trying to do. New here? Read [QUICKSTART.md](QUICKSTART.md), then the page for the
client you actually talk to.

The short pitch, the benchmark headline and the install commands are in the
[repository README](../README.md). The live demo is at
[lexicon.ashlr.ai](https://lexicon.ashlr.ai).

## Get started

| Page | What it covers | Also listed under |
|---|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Nothing to working corrections in Claude Code in five minutes, with what each setup step writes | |
| [FIRST-RUN.md](FIRST-RUN.md) | A 2026 Linux first-run report: install and setup demo timings, documentation findings, non-interactive agent behavior, write gates and MCP schemas, comparing npm 0.5.4 with source 0.5.6 | |
| [CLIENTS.md](CLIENTS.md) | Installing into Claude Code (plugin, hooks, headless) and every other agent client. Read this one second | Use it with |
| [FAQ.md](FAQ.md) | The questions people ask before installing | |
| [PACKS.md](PACKS.md) | The six starter packs, what is in each, and how install and remove behave | |
| [LEXICON-FILE.md](LEXICON-FILE.md) | Where the file lives, the term schema, the settings, `never` | Reference |
| [PLATFORMS.md](PLATFORMS.md) | What works on macOS, Windows and Linux, what is tested in CI, and what is not there at all | |

### Setup-cast outline

This is an outline for a future terminal recording, not a link to a recording.
It shows a repeatable source-checkout setup and correction without registering an
agent or installing a service. Use a POSIX shell, Node 20 or newer, and a checkout
with dependencies installed (`npm install`). Run `npm run build` from the checkout
first; it produces the CLI used below.

1. Start in the checkout root, then create an isolated home and enter it:

   ```sh
   cast_cli="$PWD/dist/cli/index.js"
   cast_home=$(mktemp -d)
   export HOME="$cast_home" XDG_CONFIG_HOME="$cast_home/.config" LEXICON_PATH="$cast_home/lexicon.yaml"
   cd "$cast_home"
   mkdir .git
   ```

   The temporary home and `.git` directory isolate the demonstration from your
   own global and project lexicons.
   Run the remaining commands in this same shell. Paths in the output will vary.

2. Run setup with explicit example names and the optional integrations disabled:

   ```sh
   node "$cast_cli" setup --yes --company Ashlr.AI --person "Mason Wyatt" --clients none --no-packs --no-harvest --no-serve --app none
   ```

   Expect a created lexicon, the two added names, skipped integration steps,
   and a `Does it work?` example showing `Ashler` corrected to `Ashlr.AI`.
   Setup writes the lexicon in the temporary directory; it does not configure an
   agent in this run.

3. Show a separate correction using the saved term:

   ```sh
   node "$cast_cli" normalize "ping Ashler about the launch"
   ```

   Expect `ping Ashlr.AI about the launch`. End the shell and remove the temporary
   directory when finished. For a real client setup, follow [QUICKSTART.md](QUICKSTART.md)
   and [CLIENTS.md](CLIENTS.md).

## Use it with

One lexicon, applied wherever your voice lands. Pick your surface. Which of these
exist on your operating system is [PLATFORMS.md](PLATFORMS.md).

| Page | Surface | Also listed under |
|---|---|---|
| [CLIENTS.md](CLIENTS.md) | Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code, Claude Desktop | Get started |
| [MCP.md](MCP.md) | Any MCP client: the stdio server's tools, resources and prompts | Reference |
| [EXTENSION.md](EXTENSION.md) | ChatGPT, Claude.ai, Grok, Gemini, Perplexity, Poe and Copilot in the browser | |
| [MACOS-APP.md](MACOS-APP.md) | LexiconBar: any macOS app, via the Accessibility API | |
| [WINDOWS-APP.md](WINDOWS-APP.md) | The tray app: any Windows app, via UI Automation. Built and unit-tested, never yet run on Windows | |
| [LOCAL-API.md](LOCAL-API.md) | The loopback HTTP API: the browser extension is its main client, then LexiconBar, Shortcuts, Raycast, Alfred and scripts | |
| [VOICE.md](VOICE.md) | Local push-to-talk dictation with ffmpeg and whisper.cpp | |
| [DAEMON.md](DAEMON.md) | Any text field on any OS, through the clipboard and a hotkey | |
| [EXPORTS.md](EXPORTS.md) | Wispr Flow, Superwhisper, espanso, Deepgram, Azure, Google and nine more | Reference |
| [LIBRARY.md](LIBRARY.md) | Your own STT pipeline, by calling `normalize()` | |
| [PHANTOM-USAGE.md](PHANTOM-USAGE.md) | Agents running under Phantom Secrets' `phantom exec`: what changes (nothing) and what does not | |
| [AGENTS.md](AGENTS.md) | Written to the agent, not the user: how to install and verify Lexicon on someone's behalf | |

## Understand how it works

| Page | What it covers |
|---|---|
| [MATCHING.md](MATCHING.md) | The three matching tiers and every guard against a false positive |
| [TRUST.md](TRUST.md) | Why a project `.lexicon.yaml` is off until you approve it |
| [BENCHMARK.md](BENCHMARK.md) | The accuracy measurements: corpora, method, results, and what still fails |
| [BENCHMARKS.md](BENCHMARKS.md) | Install time, latency and memory next to espanso and whisper.cpp, measured on one Linux VM |
| [RESEARCH.md](RESEARCH.md) | Why this layer exists at all, the market read, and the kill criteria |
| [GROWING.md](GROWING.md) | The four ways terms get in after the first one: a starter pack, your repo, your corrections, your voice history |
| [SUGGEST.md](SUGGEST.md) | What `lexicon suggest` mines from your voice history, and how it scores |

## Reference

Look up an exact name, flag or field. Three of these four pages appear above as
well; they are the same page either way, listed twice because you reach them for
two different reasons.

The CLI reference describes the current source tree. In the published npm package
measured in [FIRST-RUN.md](FIRST-RUN.md), `lexicon doctor --fix`,
`lexicon doctor --json`, `lexicon add --json`, `lexicon install --json`,
`lexicon uninstall` and `lexicon pending` were available only in source. Check
your installed version with `lexicon --version`, then use `lexicon --help` and
`lexicon doctor --help` to check which commands and flags it supports.

| Page | What it covers | Also listed under |
|---|---|---|
| [CLI.md](CLI.md) | Every command and flag, generated from `--help` | |
| [MCP.md](MCP.md) | Every tool, resource and prompt, with arguments and return shapes | Use it with |
| [LEXICON-FILE.md](LEXICON-FILE.md) | Where the file lives, the term schema, the settings, `never` | Get started |
| [EXPORTS.md](EXPORTS.md) | Every export format and every importer | Use it with |

## Contribute

| Page | What it covers |
|---|---|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, the test layout, and a recipe for each kind of contribution |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The module map and the design decisions behind it |
| [CONTRACT.md](CONTRACT.md) | The per-module API every change is written against |
| [RELEASING.md](RELEASING.md) | Cutting a release: npm, GitHub assets, the Homebrew bump |
| [DISTRIBUTION.md](DISTRIBUTION.md) | Where Lexicon gets listed so people and agents find it |
| [LANDING.md](LANDING.md) | The `web/` landing page: what it claims and how it deploys |

## Internals

Design notes and live records. You do not need these to use Lexicon.

| Page | What it covers |
|---|---|
| [AGENT-NATIVE.md](AGENT-NATIVE.md) | The agent-as-UI design: which tool an agent calls when, and why each one previews first |
| [DOGFOOD.md](DOGFOOD.md) | A live run of the hooks and MCP server against the real Claude Code CLI, and the bugs it found |
| [DOGFOOD-AGENT-NATIVE.md](DOGFOOD-AGENT-NATIVE.md) | The same treatment for the agent-native onboarding tools |

## Not built: commercial planning

Nothing in this section describes software you can run. Lexicon is MIT-licensed
and everything it does today is free; these three pages are the working papers
for a paid tier that does not exist, kept in the open because deciding whether
to sell, and what, is a decision the people using this deserve to watch. Each
one says so at the top. If you came here to use Lexicon, you can skip all three
and lose nothing.

| Page | What it covers |
|---|---|
| [COMMERCIAL.md](COMMERCIAL.md) | Whether to charge at all, for what, and at what price. Its own conclusion is "do not sell yet" |
| [ENTERPRISE.md](ENTERPRISE.md) | The same proposal written for someone evaluating it at a company, with the shipped part separated from the planned part |
| [TEAM-SYNC.md](TEAM-SYNC.md) | The engineering scope for the one paid feature proposed: a hosted team lexicon layer. None of it is in `src/` |

## Also at the repository root

[README.md](../README.md) ·
[AGENTS.md](../AGENTS.md) ·
[INTEGRATION.md](../INTEGRATION.md) (the Phantom contract) ·
[CONTRIBUTING.md](../CONTRIBUTING.md) ·
[SECURITY.md](../SECURITY.md) ·
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) ·
[CHANGELOG.md](../CHANGELOG.md)
