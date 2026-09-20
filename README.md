<div align="center">

<img src="docs/assets/logo-400.png" alt="" width="88" height="88">

# Lexicon

**A personal lexicon for voice-to-agents.**

One YAML file of the words speech-to-text gets wrong, applied everywhere your voice
lands: MCP, Claude Code, the browser, macOS.

[![CI](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40ashlr%2Flexicon)](https://www.npmjs.com/package/@ashlr/lexicon)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=20](https://img.shields.io/node/v/%40ashlr%2Flexicon)](package.json)

[**Live demo**](https://ashlrai.github.io/lexicon/) &nbsp;·&nbsp; [**Quickstart**](docs/QUICKSTART.md) &nbsp;·&nbsp; [**Docs**](docs/README.md) &nbsp;·&nbsp; [**lexicon.ashlr.ai**](https://lexicon.ashlr.ai)

</div>

```text
You said:        "tell Ashlr.AI to deploy the Kubernetes auth service"
STT heard:       "tell Ashler to deploy the Cooper Nettie's off service"
Agent received:  "tell Ashlr.AI to deploy the Kubernetes auth service"
```

![The browser demo, three panels. Left, what STT heard: "tell ashler to deploy cooper netties on head sner and ping mason white about the sass pricing". Middle, what the agent gets: "tell Ashlr.AI to deploy Kubernetes on Hetzner and ping Mason Wyatt about the SaaS pricing", labelled 5 corrections in 0.80 ms, above a table giving each replacement its tier and confidence. Right, the lexicon YAML driving it.](docs/assets/demo.gif)

That is the [live demo](https://ashlrai.github.io/lexicon/) running this repo's real matcher on your text, in your browser, with nothing installed. (Its Dictate button uses your browser's own speech recognizer, which in Chrome sends audio to Google.)

## Measured

Method and full tables are in [docs/BENCHMARK.md](docs/BENCHMARK.md). Reproduce with `npm run bench:audio`.

| corpus | proper nouns recovered, raw STT | after lexicon | clean prose wrongly changed |
| --- | --- | --- | --- |
| real audio, whisper.cpp base.en (330 clips) | 41.9% | 86.4% | 0 of 72 |
| real audio, whisper.cpp small.en with prompt hints | 76.0% | 95.7% | 0 of 72 |
| synthetic STT errors (398 sentences, 70 terms) | 5.1% | 96.5% | 0 of 95 |

Latency is about 0.3 ms per sentence. The real-audio rows use macOS text-to-speech read into whisper.cpp, so they are cleaner than a phone microphone.

The last column counts ordinary prose only. Each corpus also contains sentences deliberately built to trip the matcher (a bare "llama" next to an Ollama term, sound-alikes, code spans), marked `expected-hard`; with those included the false-positive rate is 12.5% (15 of 120) synthetic and 20% (18 of 90) on audio. Both numbers, and every failing case, are in [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Install

The package is [`@ashlr/lexicon`](https://www.npmjs.com/package/@ashlr/lexicon); the command is `lexicon`.

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh   # CLI + the setup wizard
brew install ashlrai/tap/lexicon                               # or Homebrew (macOS, Linux)
npm i -g @ashlr/lexicon                                        # or npm (Node 20+)
```

Then open Claude Code and say a sentence with your company name in it. Done.

The install script runs `lexicon setup` for you (`LEXICON_NO_SETUP=1` skips it); after a Homebrew or npm install, run it yourself. Every step is optional and safe to rerun, and `lexicon setup --dry-run` prints the whole plan without writing anything.

<details>
<summary>What <code>lexicon setup</code> does, in seven numbered steps</summary>

1. Seeds the lexicon with your name and your company, with the misspellings STT will produce for each.
2. Offers the starter packs as a checklist.
3. Harvests the current repo for names already in your code.
4. Registers the MCP server and hooks in every agent client it detects.
5. Installs the local API as a login service.
6. Exports to your dictation app.
7. Dictates a sentence built from the terms it just seeded, and shows you the correction.

The full walkthrough, with the real terminal output, is in [docs/QUICKSTART.md](docs/QUICKSTART.md).

</details>

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
- **A CLI with 25 commands**, from `lexicon add` to `lexicon voice`.
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
| Any of the above, on Windows or Linux | Which surfaces are tested in CI on each OS, which work but have never been run on real hardware, and which are not there at all | [PLATFORMS.md](docs/PLATFORMS.md) |

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

**[The full index is in `docs/`](docs/README.md)**, grouped by task: get started, use it
with your client, understand how it works, contribute, internals. The three pages most
people need:

| Page | What it covers |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Five minutes from nothing to corrections in Claude Code, with what each setup step writes |
| [CLIENTS.md](docs/CLIENTS.md) | Installing into Claude Code (plugin, hooks, headless) and every other agent client |
| [FAQ.md](docs/FAQ.md) | The questions people ask before installing |

Writing an agent that installs this for someone? [docs/AGENTS.md](docs/AGENTS.md) is written
to you. Changing the code? Start at [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Also at the root: [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md).

## Downloads

Every [GitHub release](https://github.com/ashlrai/lexicon/releases/latest) attaches the browser extension for Chrome/Edge/Brave and for Firefox, `LexiconBar.app.zip` for macOS, the npm tarball for offline installs, and `SHA256SUMS`. The Homebrew formula lives in [ashlrai/homebrew-tap](https://github.com/ashlrai/homebrew-tap); `npm i -g github:ashlrai/lexicon#v0.5.2` installs a tag straight from GitHub and builds on install.

## Roadmap and non-goals

Non-goals: this is not a dictation app, and there are no hosted accounts and no sync service. It is a file.

- Chrome Web Store and Firefox AMO listings for the extension. Today it installs from the release zip.
- Notarized macOS app. LexiconBar is ad-hoc signed, so the first launch needs right-click and Open.
- Linux tray app with the same push-to-talk and fix-clipboard actions. The Windows one is built: see [docs/WINDOWS-APP.md](docs/WINDOWS-APP.md).
- Non-English phonetics. Double metaphone is tuned for English; names in other languages fall back to fuzzy matching.
- Real-microphone benchmark. The audio corpus is macOS text-to-speech read into whisper.cpp, not recorded speech.

## Contributing

Good first issues are [labelled and scoped](https://github.com/ashlrai/lexicon/labels/good%20first%20issue): a new starter pack, an exporter, an importer, a harvester source. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the test layout and a recipe for each.

Found a name it gets wrong? [Open a misheard term issue](https://github.com/ashlrai/lexicon/issues/new?template=misheard_term.yml).

## License

MIT. Copyright 2026 Ashlr.AI.
