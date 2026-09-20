# FAQ

<!-- Generated from web/lib/site.ts by web/scripts/gen-faq-doc.mjs. Edit the FAQ array there and re-run it; the same answers are at https://lexicon.ashlr.ai#faq and /llms-full.txt. -->

Plain answers about Lexicon, the personal lexicon for voice-to-agents. Each one
stands on its own, so quoting a single answer somewhere else still makes sense.

## Why does dictation get my company name wrong?

Because the name is out-of-vocabulary. A speech recognizer scores candidate words against a language model built from ordinary text, and an invented name has no prior in it, so the decoder picks the nearest common-sounding sequence it does know: "Ashlr.AI" becomes "Ashler", "Kubernetes" becomes "Cuban eats", "Vercel" becomes "versal". The audio was fine and the microphone was fine; the vocabulary was missing. Lexicon fixes it afterwards by mapping the spellings you actually get back to the one you meant.

## How do I install Lexicon?

One command: `curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh`. It checks for Node 20 or newer, installs the `@ashlr/lexicon` CLI and then runs `lexicon setup`, which writes `~/.config/lexicon/lexicon.yaml`, asks how your company and your own name should be spelled, and registers the MCP server with every agent client it finds. `brew install ashlrai/tap/lexicon` and `npm i -g @ashlr/lexicon` install the same CLI, and `npx @ashlr/lexicon@latest setup` runs the wizard with no global install at all.

## How do I fix a brand name in ChatGPT, Claude, Claude Code, Codex or Cursor?

Add the term once and Lexicon applies it everywhere. `lexicon setup` registers the Lexicon MCP server in the config file of every client it detects (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code), and in Claude Code it also installs SessionStart and UserPromptSubmit hooks so the correction reaches the model before it reads your prompt. For ChatGPT, Claude.ai, Gemini, Grok, Perplexity, Copilot and Poe in a browser, the Lexicon extension rewrites the composer before you press send. You can add the term from the terminal with `lexicon add "Ashlr.AI"`, or just tell the agent "it is Ashlr.AI, not Ashler" and it calls the `learn_correction` tool.

## Does Lexicon work with Wispr Flow, Superwhisper or macOS dictation?

Yes, and in both directions. Lexicon runs after whatever produced the transcript, so it corrects the text those apps write before an agent or a text field sees it. It also exports into their own dictionaries: `lexicon export wispr` writes the CSV that Wispr Flow’s Dictionary > Import reads, `lexicon export superwhisper` writes its replacements JSON, and `lexicon export macos` writes a Text Replacement `.plist` for System Settings. `lexicon import` reads all three back, so a dictionary you have already trained comes over in one command instead of being retyped.

## Does Lexicon work in Slack, Mail, Notes and other Mac apps?

Yes, through the macOS menu bar app. It watches the focused text field through the Accessibility API and rewrites dictated text in place, so it works in Slack, Mail, Notes, your editor, anywhere there is a text field, and you grant Accessibility permission once in System Settings > Privacy & Security. Local push-to-talk with whisper.cpp is built in, and so is a loopback HTTP API on 127.0.0.1 if you would rather call it from your own script. Windows and Linux have everything except this. The CLI, the MCP server, the Claude Code hooks and plugin, the local API, the clipboard daemon, the exports and the browser extension are all tested in CI on both. In-place correction is the gap: the Windows tray app is written and unit-tested but has never been run on Windows, and Linux has none at all. [PLATFORMS.md](PLATFORMS.md) breaks it down feature by feature.

## Is my text sent anywhere?

No. Your lexicon is a plain YAML file at `~/.config/lexicon/lexicon.yaml`: there is no account, no sync and no telemetry, and the CLI, the hooks, the MCP server, the local API and the browser extension make no network request beyond the loopback interface. The only outbound request anywhere in the codebase is `lexicon voice` downloading a whisper.cpp model the first time you use local push-to-talk; audio itself never leaves the machine. The full threat model, including how an untrusted project lexicon is kept out of model context, is in SECURITY.md.

## What is an MCP server, and do I need one?

MCP, the Model Context Protocol, is a standard way for an AI agent to call tools that run on your own machine. Lexicon ships one, named `lexicon`, over stdio, with nineteen tools, two resources and two prompts, so an agent can normalize a transcript, add a term, learn a correction or run setup without you opening a terminal. You want it if you talk to an agent and need the names fixed before the agent acts. You do not need it for the browser extension, the menu bar app or the CLI, which read the same file directly.

## How is this different from a dictation app’s custom dictionary?

A dictation app’s dictionary only applies to the text that app produced. Agents increasingly own their own speech-to-text, so a transcript made inside ChatGPT, Claude Code or a phone keyboard never passes through Wispr Flow or Superwhisper, and the same name breaks again in every new place. Lexicon is one file you own, applied at three points instead: before an agent reads a prompt, before you press send in a browser chat, and in any macOS text field. It exports into those dictionaries too, so it replaces none of them and reaches where they cannot.

## What does Lexicon cost?

Nothing. Lexicon is free and MIT-licensed, with no paid tier, no account and no telemetry. The matcher, the CLI, the MCP server, the Claude Code plugin, the browser extension and the macOS menu bar app are all in one public repository at github.com/ashlrai/lexicon.

## Anything else

- [Quickstart](QUICKSTART.md): nothing to working, in five minutes.
- [Install into your agents](CLIENTS.md): the per-client commands.
- [MCP server reference](MCP.md): the nineteen tools, two resources and two prompts.
- [For agents](AGENTS.md): how an agent installs and verifies Lexicon for its user.
- [Security](../SECURITY.md): the threat model and the trust gate.
- [Benchmark](BENCHMARK.md): the measurements, the method and what still fails.
- Issues and questions: https://github.com/ashlrai/lexicon/issues

Back to [the docs index](README.md).
