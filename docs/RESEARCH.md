# Research memo: personal vocabulary for voice-to-agents

Decision memo, condensed from the founder's market research. Written 2026. Numbers are as of the research date; verify before quoting externally.

## Problem

Speech-to-text is about 95% accurate on ordinary English and close to zero on invented names, acronyms and technical terms. The failures are not random. They land on exactly the words an agent needs to act on: company names, product names, people, identifiers.

Observed transcriptions:

| Said | Heard |
|---|---|
| Ashlr.AI | Ashler, Ashlar, Ashley our AI |
| Kubernetes | Cooper Nettie's, cube or netties |
| SaaS | sauce |
| Pydantic | pie dentic |
| Hetzner | head sner |
| auth | off |

When the transcript goes to a human, they read through it. When it goes to a coding agent, the agent searches the repo for "Ashler", finds nothing, and guesses.

## Evidence

- Argmax reports keyword F1 improving from 64% to 92% when custom vocabulary is supplied to the recognizer. The fix works when you can reach the recognizer.
- Aqua Voice markets a "custom dictionary of up to 800 terms" directly against Claude Code `/voice`. The dictionary is the differentiator.
- Open Claude Code issues ask for custom vocabulary in `/voice`. Users notice the gap and there is no first-party answer yet.
- Existing MCP attempts are dead or capped: `dictionary-mcp` (8 stars, idea stage), Whisper Dict for OpenClaw (100-term cap), HyperWhisper ships an MCP but it is tied to its own app.

## Market

- Wispr Flow raised a $280M Series B at a $2B valuation, $361M total.
- The dictation category is estimated at $1.1B to $2.2B for 2025.
- Every serious player (Wispr Flow, Superwhisper, Aqua) ships a per-app dictionary. None ship a portable one.

The money is in dictation apps. That market is funded, crowded and converging on system-wide dictation as the product. We should not enter it.

## Existing solution layers

| Layer | Example | Reach | Limit |
|---|---|---|---|
| In-recognizer hotwords | Whisper `initial_prompt`, Deepgram keyword boost, Argmax custom vocab | Best accuracy | Only when you control the recognizer; agents do not expose it |
| In-app dictionary | Wispr Flow, Superwhisper, Aqua replacements | Works system-wide for that app | Trapped in that app; does nothing for agent voice |
| Post-transcript LLM rewrite | "Fix this transcript" prompts, Wispr's own cleanup | Any text | Needs the vocabulary to be in the prompt; unpredictable; costs a model call |
| Social hacks | macOS Contacts phonetic name fields, spelling names letter by letter | Free | Does not scale past a few names; does not reach agents |

## The gap

Two facts together:

1. Dictionaries are trapped per app. Your Wispr dictionary does not help your Superwhisper setup, your phone, or a teammate.
2. Agents own their STT. Claude Code `/voice`, ChatGPT voice, Claude voice, Grok, Codex and local models each run their own recognizer with no user vocabulary and no hook into any dictation app.

So the user who has carefully trained one dictation app still gets "Ashler" the moment they talk to an agent. Nobody owns the layer between "whatever transcribed this" and "whatever model reads it".

## Verdict

Do not build a dictation app. Build the portable lexicon layer, open source, MIT.

- One YAML file the user owns.
- Applied post-STT and pre-model through every channel that exists today: MCP tool, Claude Code hook, agent memory snippet, dictation app exports, clipboard daemon.
- Dogfood for one to two weeks before deciding anything else.
- Do not raise on it. It is a utility, and its best outcome may be that platforms adopt the idea.

Positioning: "Name the job, not the protocol: personal lexicon for voice-to-agents."

## Kill criteria

Stop or shrink the project if either happens:

- Claude Code ships `voice.vocabulary` or equivalent first-party custom vocabulary. The hook and MCP paths lose most of their value for the primary user. Exports and the file format may still be worth keeping.
- Wispr Flow (or another system-wide app) keeps winning to the point that it captures agent voice input too, and its dictionary follows the user everywhere. Then the portable layer is redundant.

Watch for: Claude Code changelog, Wispr Flow feature announcements, OpenAI and Anthropic voice product updates.

## What we shipped

Each recommendation above, mapped to what exists in the repo today.

| Research recommendation | Feature in this repo |
|---|---|
| One portable vocabulary the user owns | `~/.config/lexicon/lexicon.yaml` plus project `.lexicon.yaml`, merged at load; `src/core/store.ts` |
| Reach agents that own their STT | `lexicon-mcp` stdio server with seventeen tools (`normalize_transcript`, `add_term`, `learn_correction`, `suggest_canonical`, `harvest_repo`, `lexicon_stats` and the agent-native setup, doctor, install, trust, import and suggestion tools), two resources and two prompts; `lexicon install <client>` writes the config for Codex, Cursor, Windsurf, Gemini CLI, Claude Desktop and VS Code, and `lexicon setup` does it for every client it detects; `src/mcp/server.ts`, `src/cli/cmd-install.ts`, `src/cli/cmd-setup.ts` |
| Fix Claude Code `/voice` without waiting for first-party support | Claude Code plugin (`claude plugin install lexicon@ashlrai`): `UserPromptSubmit` hook injecting corrections as context, `SessionStart` hook injecting the vocabulary once per session, a skill and a `/lexicon` command; bundled as `plugin/hook.mjs` and `plugin/mcp-server.mjs` so a bare clone runs with Node alone |
| Give the model the vocabulary as memory | `lexicon://me` resource, `voice-context` prompt, `lexicon export claude-md`, and the `SessionStart` injection (capped at about 4000 characters) |
| Close the loop when the user corrects the agent | `learn_correction` tool and `lexicon learn`; the hook recognises "it's X not Y" and asks the model to call it; `suggest_canonical` for "did you mean X?" on a garble the lexicon does not know yet; `src/core/learn.ts` |
| Do not abandon existing dictation apps | Fifteen exporters (Wispr Flow, Superwhisper, macOS Text Replacement, espanso, Whisper, OpenAI, Deepgram, AssemblyAI, Azure, Google, CLAUDE.md, markdown, text, CSV, JSON) and seven importers (Wispr, Superwhisper, macOS, espanso, text, CSV, JSON) so an existing dictionary seeds the lexicon; `src/core/exporters/`, `src/core/importers/` |
| Reach recognizers that accept hotwords | `whisper-prompt`, `openai`, `deepgram`, `assemblyai`, `azure` and `google` exporters |
| Reduce setup friction (Aqua's 800 terms are hand-entered) | `lexicon harvest` pulls names from the codebase and walks them one by one; `suggestAliases()` guesses misspellings; `lexicon import` brings a dictionary over; `lexicon add -i`, `review`, `edit` for maintenance |
| Avoid false positives that make users distrust the tool | Stoplist, `protectedWords`, per-term `never`, `minConfidence`, three-character minimum, function-word and possessive guards. Benchmark: 0 of 95 clean prose sentences changed, 96.5% of misheard terms recovered (`docs/BENCHMARK.md`) |
| Work with any app before agents adopt MCP | Clipboard daemon for macOS, Linux and Windows, with `--once` for a keyboard shortcut (`src/daemon/`); the local HTTP API `lexicon serve` for Shortcuts, Raycast and desktop apps (`src/serve/`); the browser extension for ChatGPT, Claude.ai, Grok, Gemini, Perplexity, Poe and Copilot (`extension/`); the LexiconBar macOS menu bar app (`apps/macos/`) |
| Share a vocabulary with a teammate | Commit `.lexicon.yaml`; each teammate approves it with `lexicon trust`. Untrusted project files are never merged or written to (`src/core/trust.ts`, `SECURITY.md`) |
| Dogfood before deciding anything else | `lexicon stats` and `review --never-hit` show which terms fire and which never do; `hits` is recorded on every MCP, hook, API, voice and daemon correction; `lexicon suggest` turns `voice/history.jsonl` and the hit counters into alias, term, never-word and stale-term proposals (`src/core/suggestTerms.ts`); `docs/DOGFOOD.md` records the live runs |
| Not a dictation app, no hosted service | No accounts, no telemetry. `lexicon voice` is a deliberately minimal local path (ffmpeg + whisper.cpp) for people without a dictation app, not a product; the only network call in the tool is its one-time whisper model download |
| Reduce install friction | `curl -fsSL https://ashlrai.github.io/lexicon/install.sh \| sh`, `brew install ashlrai/tap/lexicon`, and `lexicon setup`, which seeds the lexicon, harvests the repo, installs into detected agents and the dictation app in one pass; the agent can run the same setup through `setup_lexicon` and the `onboard` prompt (`docs/AGENT-NATIVE.md`) |

Still open: store listings for the browser extension, a notarized macOS app, a Windows and Linux tray app, per-app sync (pushing changes into the apps instead of exporting), non-English phonetics, and a benchmark on recorded speech rather than text-to-speech audio (`docs/BENCHMARK.md` has a real-audio benchmark, but the clips are macOS TTS).
