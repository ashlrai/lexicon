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
| [FIRST-RUN.md](FIRST-RUN.md) | First-run report measured October 26, 2026 on one Linux VM with Node already installed: install and setup demo timings (the first printed correction is the setup demo), a separate npx normalization timing, documentation findings, non-interactive agent behavior, write gates, JSON errors, MCP schemas and ranked follow-ups; compares npm 0.5.4 with source 0.5.6 | |
| [CLIENTS.md](CLIENTS.md) | Installing into Claude Code (plugin, hooks, headless) and every other agent client. Read this one second | Use it with |
| [FAQ.md](FAQ.md) | The questions people ask before installing | |
| [PACKS.md](PACKS.md) | The seven starter packs, what is in each, and how install and remove behave | |
| [LEXICON-FILE.md](LEXICON-FILE.md) | Where the file lives, the term schema, the settings, `never` | Reference |
| [PLATFORMS.md](PLATFORMS.md) | What works on macOS, Windows and Linux, what is tested in CI, and what is not there at all | |

## Use it with

One lexicon, applied wherever your voice lands. Pick your surface. Which of these
exist on your operating system is [PLATFORMS.md](PLATFORMS.md).

| Page | Surface | Also listed under |
|---|---|---|
| [CLIENTS.md](CLIENTS.md) | Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code, Claude Desktop | Get started |
| [MCP.md](MCP.md) | Any MCP client: the stdio server's tools, resources and prompts | Reference |
| [EXTENSION.md](EXTENSION.md) | ChatGPT, Claude.ai, Grok, Gemini, Perplexity, Poe and Copilot in the browser | |
| [firefox-extension-readiness.md](firefox-extension-readiness.md) | Firefox packaging evidence and open review questions | |
| [firefox-addon-submission-checklist.md](firefox-addon-submission-checklist.md) | Verification steps for a listed Firefox AMO submission | |
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
| [BENCH-NON-ENGLISH.md](BENCH-NON-ENGLISH.md) | The generated non-English name report: per-language hit rates beside the English baseline |
| [BENCHMARKS.md](BENCHMARKS.md) | Install time, latency and memory next to espanso and whisper.cpp, measured on one Linux VM |
| [RESEARCH.md](RESEARCH.md) | Why this layer exists at all, the market read, and the kill criteria |
| [GROWING.md](GROWING.md) | The four ways terms get in after the first one: a starter pack, your repo, your corrections, your voice history |
| [harvest-markers.md](harvest-markers.md) | How harvest treats TODO-style markers and their casing |
| [harvest-marker-reference.md](harvest-marker-reference.md) | Configured marker literals and links to their source |
| [SUGGEST.md](SUGGEST.md) | What `lexicon suggest` mines from your voice history, and how it scores |

## Reference

Look up an exact name, flag or field. Some pages also appear above, listed
twice because you may reach them for different reasons.

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
| [aliases-onboarding-reference.md](aliases-onboarding-reference.md) | Suggesting and reviewing aliases in an onboarding form | |
| [aliases-query-examples.md](aliases-query-examples.md) | Local API alias suggestion queries and responses | |
| [LEXICON-FILE.md](LEXICON-FILE.md) | Where the file lives, the term schema, the settings, `never` | Get started |
| [schema-limit-reference.md](schema-limit-reference.md) | File schema limits and their relationship to the contract | |
| [schema-text-limits.md](schema-text-limits.md) | Notes and phonetic text limits, counting and examples | |
| [contract-term-limits.md](contract-term-limits.md) | Contract term limits, affected fields and counting rules | |
| [contract-limit-examples.md](contract-limit-examples.md) | Executable examples at and beyond the schema limits | |
| [schema-error-examples.md](schema-error-examples.md) | Reading invalid code unit errors and shortened term names | |
| [schema-first-invalid-unit.md](schema-first-invalid-unit.md) | Which invalid code unit a schema error reports first | |
| [schema-error-preview.md](schema-error-preview.md) | How schema errors escape and shorten term-name previews | |
| [schema-error-preview-reference.md](schema-error-preview-reference.md) | Exact term-name preview construction and UTF-16 boundaries | |
| [EXPORTS.md](EXPORTS.md) | Every export format and every importer | Use it with |
| [voice-cleaning-reference.md](voice-cleaning-reference.md) | How local voice transcription removes tags and collapses whitespace | |
| [transcript-cleaning-scope.md](transcript-cleaning-scope.md) | Which transcript tags are removed or preserved, with examples | |
| [transcript-cleaning-examples.md](transcript-cleaning-examples.md) | Input and output examples for voice transcript cleaning | |

## Contribute

| Page | What it covers |
|---|---|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, the test layout, and a recipe for each kind of contribution |
| [setup-cast-outline.md](setup-cast-outline.md) | Reproducible, synthetic-data setup recording plan |
| [setup-contract-summary.md](setup-contract-summary.md) | Guided first-run responsibilities, preview boundaries and open questions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The module map and the design decisions behind it |
| [CONTRACT.md](CONTRACT.md) | The per-module API every change is written against |
| [tray-platform-scope.md](tray-platform-scope.md) | Issue #13 tray scope: the requested platforms and actions, separated into stated requirements and open questions |
| [tray-action-map.md](tray-action-map.md) | Issue #13 tray actions, existing CLI and Windows capabilities, and open platform decisions |
| [tray-interaction-questions.md](tray-interaction-questions.md) | Open push-to-talk and clipboard interaction questions for Windows and Linux trays |
| [RELEASING.md](RELEASING.md) | Cutting a release: npm, GitHub assets, the Homebrew bump |
| [DISTRIBUTION.md](DISTRIBUTION.md) | Where Lexicon gets listed so people and agents find it |
| [LANDING.md](LANDING.md) | The `web/` landing page: what it claims and how it deploys |

## Internals

Design notes and live records. You do not need these to use Lexicon.

| Page | What it covers |
|---|---|
| [AGENT-NATIVE.md](AGENT-NATIVE.md) | The agent-as-UI design: which tool an agent calls when, and why each one previews first |
| [expander-boundary-map.md](expander-boundary-map.md) | Existing correction surfaces, the resident expander and open platform integration boundaries |
| [DOGFOOD.md](DOGFOOD.md) | A live run of the hooks and MCP server against the real Claude Code CLI, and the bugs it found |
| [DOGFOOD-AGENT-NATIVE.md](DOGFOOD-AGENT-NATIVE.md) | The same treatment for the agent-native onboarding tools |
| [resident-expander-scope.md](resident-expander-scope.md) | The scope outline for issue #220: the proposed system-wide expander, the pieces that exist, and the boundary left to build |
| [daemon-scope-questions.md](daemon-scope-questions.md) | Open questions on process lifetime, configuration and interactions with existing surfaces |
| [expander-platform-questions.md](expander-platform-questions.md) | The per-platform discovery questions behind that boundary, each marked decided or undecided |
| [daemon-surface-questions.md](daemon-surface-questions.md) | The daemon half of the same list: the requested resident-expander surface and the open server-side questions, marked decided or undecided |
| [daemon-design-constraints.md](daemon-design-constraints.md) | Issue #220's requested surface, current boundary and open design decisions |

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
