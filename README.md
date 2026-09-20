# @ashlr/lexicon

[![CI](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40ashlr%2Flexicon)](https://www.npmjs.com/package/@ashlr/lexicon)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=20](https://img.shields.io/node/v/%40ashlr%2Flexicon)](package.json)

**One YAML file of the words speech-to-text gets wrong, applied everywhere your voice lands.**

![The live demo correcting a dictated sentence in the browser](docs/assets/demo.gif)

**[lexicon.ashlr.ai](https://lexicon.ashlr.ai)** is the live demo, the benchmarks and the install commands.

```text
You said:        "tell Ashlr.AI to deploy the Kubernetes auth service"
STT heard:       "tell Ashler to deploy the Cooper Nettie's off service"
Agent received:  "tell Ashlr.AI to deploy the Kubernetes auth service"
```

[Try it in your browser.](https://ashlrai.github.io/lexicon/) No install: the page runs this repo's real matcher on your text, in your browser. (The Dictate button uses your browser's own speech recognizer, which in Chrome sends audio to Google.)

## Measured

Method and full tables are in [docs/BENCHMARK.md](docs/BENCHMARK.md). Reproduce with `npm run bench:audio`.

| corpus | proper nouns recovered, raw STT | after lexicon | clean prose wrongly changed |
| --- | --- | --- | --- |
| real audio, whisper.cpp base.en (330 clips) | 41.9% | 86.4% | 0 of 72 |
| real audio, whisper.cpp small.en with prompt hints | 76.0% | 95.7% | 0 of 72 |
| synthetic STT errors (398 sentences, 70 terms) | 5.1% | 96.5% | 0 of 95 |

Latency is about 0.3 ms per sentence. The real-audio rows use macOS text-to-speech read into whisper.cpp, so they are cleaner than a phone microphone.

The last column counts ordinary prose only. Each corpus also contains sentences deliberately built to trip the matcher (a bare "llama" next to an Ollama term, sound-alikes, code spans), marked `expected-hard`; with those included the false-positive rate is 15% (18 of 120) synthetic and 20% (18 of 90) on audio. Both numbers, and every failing case, are in [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Install

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh   # CLI + the setup wizard
brew install ashlrai/tap/lexicon                               # or Homebrew (macOS, Linux)
npm i -g @ashlr/lexicon                                        # or npm (Node 20+)
```

Then open Claude Code and say a sentence with your company name in it. Done.

The install script runs `lexicon setup` for you (`LEXICON_NO_SETUP=1` skips it); after a Homebrew or npm install, run it yourself. It is six steps: seed the lexicon with your name and company, install starter packs, harvest the current repo, register the MCP server and hooks in every agent client it detects, install the local API as a login service, and export to your dictation app. Every step is optional and safe to rerun, and `lexicon setup --dry-run` prints the whole plan without writing anything. The walkthrough is in [docs/QUICKSTART.md](docs/QUICKSTART.md).

Or skip the wizard and add one term by hand. The first argument is the canonical spelling, the rest are what STT actually produces:

```bash
lexicon add Ashlr.AI Ashler Ashlar "Ashler AI" --phonetic ASH-ler
lexicon normalize "tell Ashler to ship it"
# tell Ashlr.AI to ship it
```

**Claude Code plugin**, if you would rather not install a CLI at all. No Node install step, no build:

```bash
claude plugin marketplace add ashlrai/lexicon
claude plugin install lexicon@ashlrai
```

`lexicon doctor` checks the install. There is no telemetry and all state is local files: the CLI, hooks, MCP server, local API and extension make no request beyond loopback. The one outbound request in the codebase is `lexicon voice` fetching a whisper model on first use. The install script, npm and Homebrew fetch the package itself. See [SECURITY.md](SECURITY.md).

## Why

Speech-to-text is about 95% accurate on ordinary English and much worse on invented names. In the benchmark above, raw whisper.cpp base.en transcribed 117 of 279 dictated proper nouns correctly. "Ashlr.AI" becomes "Ashler", "Kubernetes" becomes "Cooper Nettie's", "SaaS" becomes "sauce", "auth" becomes "off". Those are exactly the words an agent needs to get right.

Dictation apps (Wispr Flow, Superwhisper, Aqua) each keep their own dictionary and none of them share it. Agents (Claude Code `/voice`, ChatGPT voice, Codex, local Whisper) run their own recognizer with no user vocabulary at all. This is the portable layer in between: corrections happen after STT and before the model, wherever the text passes through.

This is not a dictation app. It sits between whatever dictation you already use and whatever agent you talk to. The research behind that call, including the kill criteria, is in [docs/RESEARCH.md](docs/RESEARCH.md).

## What you get

- **Nineteen MCP tools**, two resources and two prompts, for Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code and Claude Desktop. Your agent can run its own setup: `setup_lexicon`, `lexicon_doctor`, `install_client`, `trust_project`, `import_dictionary` and `suggest_terms` mean "set up my lexicon" works without a terminal. The tools that change your machine preview first: `setup_lexicon` and `install_client` return a plan and write nothing until the agent passes `apply: true`, `trust_project` shows the file's terms before pinning it, and `import_dictionary` takes `dryRun`.
- **A Claude Code plugin**: MCP server, `SessionStart` and `UserPromptSubmit` hooks, a `lexicon` skill and a `/lexicon` command. Installs from this repo's marketplace with no build step.
- **A CLI with 26 commands**, from `lexicon add` to `lexicon voice`.
- **155 starter terms** in four packs (developer, AI, business, voice tools), one command each.
- **Fifteen export formats** (Wispr Flow, Superwhisper, macOS Text Replacement, espanso, Whisper and OpenAI prompts, Deepgram, AssemblyAI, Azure, Google, CLAUDE.md, markdown, text, CSV, JSON) and **seven importers** for the dictionary you already trained.
- **Repo harvesting**, correction learning ("it's Ashlr.AI not Ashler"), usage stats, suggestions mined from your voice history, and a trust gate for project lexicons.
- **A plain library.** `normalize()` is a pure function: text plus lexicon in, corrected text and a replacement list out.

## Where it applies

| Surface | How | Docs |
|---|---|---|
| Claude Code | Plugin, or MCP server plus two hooks that correct the prompt before the model reads it | [CLIENTS.md](docs/CLIENTS.md) |
| Codex, Cursor, Windsurf, Gemini CLI, VS Code, Claude Desktop | `lexicon install <client> --apply` registers the MCP server | [CLIENTS.md](docs/CLIENTS.md) |
| Any MCP client | stdio server, nineteen tools | [MCP.md](docs/MCP.md) |
| ChatGPT, Claude.ai, Grok, Gemini, Perplexity, Poe, Copilot | Browser extension: rewrites the composer when you press send | [EXTENSION.md](docs/EXTENSION.md) |
| Any macOS app, any dictation tool | LexiconBar menu bar app: rewrites dictated text in the focused field through Accessibility, with an undo bubble | [MACOS-APP.md](docs/MACOS-APP.md) |
| Shortcuts, Raycast, scripts, your own app | `lexicon serve`: loopback HTTP API on `127.0.0.1:41733` behind a bearer token | [LOCAL-API.md](docs/LOCAL-API.md) |
| Dictation without a dictation app | `lexicon voice`: ffmpeg records, whisper.cpp transcribes with your canonicals as prompt hints, the lexicon corrects | [VOICE.md](docs/VOICE.md) |
| Any text field, any OS | `lexicon daemon --once --paste` on a hotkey | [DAEMON.md](docs/DAEMON.md) |
| Wispr Flow, Superwhisper, macOS Text Replacement, espanso, Deepgram, Azure, Google | Export into their own dictionaries and biasing parameters | [EXPORTS.md](docs/EXPORTS.md) |
| Your own STT pipeline | `npm i @ashlr/lexicon`, call `normalize()` between transcription and the model | [LIBRARY.md](docs/LIBRARY.md) |

## How it works

Three tiers over token windows: exact alias first, then double-metaphone phonetic, then Damerau-Levenshtein fuzzy above a confidence floor. Exact hits win the span; matches never overlap. A stoplist of about 3400 common English words, per-term `never` lists, and (with the default `skipCode`) code spans, URLs, emails, paths and glued identifiers are all off limits. That is why zero clean sentences changed in the benchmark. Every replacement reports its `reason` and `confidence`.

```bash
lexicon normalize --diff "deploy to head sner with cooper netties"
# stderr:  "head sner" -> "Hetzner" (alias, 1.00)
#          "cooper netties" -> "Kubernetes" (phonetic, 0.85)
# stdout:  deploy to Hetzner with Kubernetes
```

The rules in full, including every guard, are in [docs/MATCHING.md](docs/MATCHING.md).

## Documentation

**Start here**

| Page | What it covers |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Five minutes from nothing to corrections in Claude Code, with what each setup step writes |
| [CLIENTS.md](docs/CLIENTS.md) | Installing into Claude Code (plugin, hooks, headless) and every other agent client |
| [PACKS.md](docs/PACKS.md) | The four starter packs, how install and remove behave, how the aliases were chosen |

**Reference**

| Page | What it covers |
|---|---|
| [CLI.md](docs/CLI.md) | Every command and flag, generated from `--help` |
| [MCP.md](docs/MCP.md) | The MCP server: nineteen tools, two resources, two prompts |
| [LEXICON-FILE.md](docs/LEXICON-FILE.md) | File locations, the term schema, settings, `never` |
| [MATCHING.md](docs/MATCHING.md) | The three matching tiers and every guard against a false positive |
| [EXPORTS.md](docs/EXPORTS.md) | Fifteen export formats and seven importers |
| [LIBRARY.md](docs/LIBRARY.md) | Using `normalize()` and the store functions from your own code |
| [TRUST.md](docs/TRUST.md) | Why a project `.lexicon.yaml` is off until you approve it |

**Surfaces**

| Page | What it covers |
|---|---|
| [EXTENSION.md](docs/EXTENSION.md) | The browser extension for ChatGPT, Claude, Grok, Gemini, Perplexity, Poe and Copilot |
| [MACOS-APP.md](docs/MACOS-APP.md) | LexiconBar, the macOS menu bar app and its Accessibility rewrite |
| [LOCAL-API.md](docs/LOCAL-API.md) | The loopback HTTP API, its routes and its token |
| [VOICE.md](docs/VOICE.md) | Local push-to-talk with ffmpeg and whisper.cpp |
| [DAEMON.md](docs/DAEMON.md) | The clipboard daemon and hotkey recipes for macOS, Linux and Windows |

**Growing and measuring**

| Page | What it covers |
|---|---|
| [GROWING.md](docs/GROWING.md) | Harvesting a repo, learning from corrections, stats, reviewing terms |
| [SUGGEST.md](docs/SUGGEST.md) | What `lexicon suggest` mines from your voice history, and how it scores |
| [BENCHMARK.md](docs/BENCHMARK.md) | The accuracy benchmark: corpora, metrics, results and the fix log |
| [RESEARCH.md](docs/RESEARCH.md) | Why this layer exists, the market read, and the kill criteria |

**Internals**

| Page | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map and the design decisions behind it |
| [CONTRACT.md](docs/CONTRACT.md) | The per-module API contract every change is written against |
| [AGENT-NATIVE.md](docs/AGENT-NATIVE.md) | The agent-as-UI design: which tool an agent calls when |
| [DOGFOOD.md](docs/DOGFOOD.md), [DOGFOOD-AGENT-NATIVE.md](docs/DOGFOOD-AGENT-NATIVE.md) | Two live runs against the real Claude Code CLI, and the bugs they found |
| [RELEASING.md](docs/RELEASING.md) | Cutting a release: npm, GitHub assets, the Homebrew bump |

Also at the root: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md).

## Downloads

Every [GitHub release](https://github.com/ashlrai/lexicon/releases/latest) attaches the browser extension for Chrome/Edge/Brave and for Firefox, `LexiconBar.app.zip` for macOS, the npm tarball for offline installs, and `SHA256SUMS`. The Homebrew formula lives in [ashlrai/homebrew-tap](https://github.com/ashlrai/homebrew-tap); `npm i -g github:ashlrai/lexicon#v0.4.0` installs a tag straight from GitHub and builds on install.

## Roadmap and non-goals

Non-goals: this is not a dictation app, and there are no hosted accounts and no sync service. It is a file.

- Chrome Web Store and Firefox AMO listings for the extension. Today it installs from the release zip.
- Notarized macOS app. LexiconBar is ad-hoc signed, so the first launch needs right-click and Open.
- Windows and Linux tray app with the same push-to-talk and fix-clipboard actions.
- Non-English phonetics. Double metaphone is tuned for English; names in other languages fall back to fuzzy matching.
- Real-microphone benchmark. The audio corpus is macOS text-to-speech read into whisper.cpp, not recorded speech.

## Contributing

Good first issues are [labelled and scoped](https://github.com/ashlrai/lexicon/labels/good%20first%20issue): a new starter pack, an exporter, an importer, a harvester source. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the test layout and a recipe for each.

Found a name it gets wrong? [Open a misheard term issue](https://github.com/ashlrai/lexicon/issues/new?template=misheard_term.yml).

## License

MIT. Copyright 2026 Ashlr.AI.
