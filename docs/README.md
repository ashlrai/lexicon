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
| [CLIENTS.md](CLIENTS.md) | Installing into Claude Code (plugin, hooks, headless) and every other agent client. Read this one second | Use it with |
| [FAQ.md](FAQ.md) | The questions people ask before installing | |
| [PACKS.md](PACKS.md) | The four starter packs, what is in each, and how install and remove behave | |
| [LEXICON-FILE.md](LEXICON-FILE.md) | Where the file lives, the term schema, the settings, `never` | Reference |

## Use it with

One lexicon, applied wherever your voice lands. Pick your surface.

| Page | Surface | Also listed under |
|---|---|---|
| [CLIENTS.md](CLIENTS.md) | Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code, Claude Desktop | Get started |
| [MCP.md](MCP.md) | Any MCP client: the stdio server's tools, resources and prompts | Reference |
| [EXTENSION.md](EXTENSION.md) | ChatGPT, Claude.ai, Grok, Gemini, Perplexity, Poe and Copilot in the browser | |
| [MACOS-APP.md](MACOS-APP.md) | LexiconBar: any macOS app, via the Accessibility API | |
| [LOCAL-API.md](LOCAL-API.md) | The loopback HTTP API: the browser extension is its main client, then LexiconBar, Shortcuts, Raycast, Alfred and scripts | |
| [VOICE.md](VOICE.md) | Local push-to-talk dictation with ffmpeg and whisper.cpp | |
| [DAEMON.md](DAEMON.md) | Any text field on any OS, through the clipboard and a hotkey | |
| [EXPORTS.md](EXPORTS.md) | Wispr Flow, Superwhisper, espanso, Deepgram, Azure, Google and nine more | Reference |
| [LIBRARY.md](LIBRARY.md) | Your own STT pipeline, by calling `normalize()` | |
| [AGENTS.md](AGENTS.md) | Written to the agent, not the user: how to install and verify Lexicon on someone's behalf | |

## Understand how it works

| Page | What it covers |
|---|---|
| [MATCHING.md](MATCHING.md) | The three matching tiers and every guard against a false positive |
| [TRUST.md](TRUST.md) | Why a project `.lexicon.yaml` is off until you approve it |
| [BENCHMARK.md](BENCHMARK.md) | The accuracy measurements: corpora, method, results, and what still fails |
| [RESEARCH.md](RESEARCH.md) | Why this layer exists at all, the market read, and the kill criteria |
| [GROWING.md](GROWING.md) | The four ways terms get in after the first one: a starter pack, your repo, your corrections, your voice history |
| [SUGGEST.md](SUGGEST.md) | What `lexicon suggest` mines from your voice history, and how it scores |

## Reference

Look up an exact name, flag or field. Three of these four pages appear above as
well; they are the same page either way, listed twice because you reach them for
two different reasons.

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

## Also at the repository root

[README.md](../README.md) ·
[CONTRIBUTING.md](../CONTRIBUTING.md) ·
[SECURITY.md](../SECURITY.md) ·
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) ·
[CHANGELOG.md](../CHANGELOG.md)
