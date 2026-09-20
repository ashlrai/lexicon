# Quickstart: five minutes to a lexicon your agents read

`@ashlr/lexicon` fixes the words speech-to-text gets wrong (Ashler -> Ashlr.AI) before your agent sees the prompt. This is the shortest path from nothing to "it just works in Claude Code".

## 0. See it work first (no install, five seconds)

```bash
npx @ashlr/lexicon normalize "ping ashler about the cooper netties migration"
```

```text
lexicon: no terms yet, so this is the built-in example (Ashlr.AI, Kubernetes, PostgreSQL, Pydantic, SaaS).
lexicon: run `lexicon setup` to build your own; nothing was written.
ping Ashlr.AI about the Kubernetes migration
```

With no lexicon of your own, a sentence typed as arguments is corrected against the built-in example terms so you can see what the tool does before deciding to keep it. (Piped input is never touched by the example: `cat notes.md | lexicon normalize` passes through byte-exact until you have terms of your own.) Nothing is written, and nothing is installed globally: `npx` runs it from a cache.

## 1. Install

```bash
npx @ashlr/lexicon@latest setup
```

That is the whole thing: no global install, and `setup` asks before it does anything that writes outside your lexicon. When it notices it is running from an npx cache it writes `npx -y @ashlr/lexicon@<version> mcp` into your client configs rather than a path npm will eventually delete, so what it sets up keeps working.

If you would rather have it installed properly, which starts faster and stops the Claude Code hook paying npx's ~1s per prompt:

```bash
npm i -g @ashlr/lexicon && lexicon setup
```

Or `brew install ashlrai/tap/lexicon` (pulls in node; ffmpeg + whisper.cpp recommended for `lexicon voice`), or `curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh`, which checks for Node 20+, installs globally and starts `lexicon setup` for you.

## 2. `lexicon setup`

One interactive pass, seven numbered steps, ending in a live correction. Every step prints a one-line result and is safe to rerun (nothing is duplicated), and the starter packs arrive as a checklist you can untick ([PACKS.md](PACKS.md) has what is in each).

`lexicon setup --yes` runs without prompting: it creates the lexicon and installs into every agent client it detects, but the three steps that write a lot or install a service stay opt-in even then, so add `--packs developer,ai,voice-tools`, `--harvest` and `--serve` for those. `--dry-run` prints what a run would do and writes nothing, `--clients none` / `--no-packs` / `--no-harvest` / `--no-serve` / `--app none` skip steps, and `--json` prints a machine-readable summary.

```text
$ lexicon setup
lexicon setup

1. Global lexicon
   created ~/.config/lexicon/lexicon.yaml
   add "Mason Wyatt" as a person term (how you want your name spelled)? [Y/n]
   added Mason Wyatt (person): Mason Wyat
   Your company or product name (as you want it spelled; Enter to skip) [Ashlr] Ashlr.AI
   STT will likely write: Ashlr AI, Ashler, Ashlar, Ashler AI
   phonetic hint (e.g. ASH-ler, Enter for none) ASH-ler
   added Ashlr.AI (brand): Ashlr AI, Ashler, Ashlar, Ashler AI
   add another term? [y/N]

2. Starter packs
   add starter packs to the global lexicon (Enter keeps the checked ones):
     [x] 1) developer (70 terms)  [x] 2) ai (36)  [ ] 3) business (35)  [x] 4) voice-tools (14)
   installed developer: 70 added, 0 merged
   installed ai: 36 added, 0 merged
   installed voice-tools: 14 added, 0 merged

3. Repo harvest
   found 4 names in ~/code/lexicon:  (table of canonical, category, count, aliases)
   add them to the project lexicon (~/code/lexicon/.lexicon.yaml)? [Y/n]
   added 4 new terms, merged 0 in ~/code/lexicon/.lexicon.yaml (trusted)

4. Agent clients
   install the lexicon MCP server (and hooks) into:  [x] 1) claude  [x] 2) cursor
   claude: installed updated ~/.claude/settings.json: added UserPromptSubmit + SessionStart hooks
   cursor: installed created ~/.cursor/mcp.json: mcpServers.lexicon

5. Local API (lexicon serve)
   install the local API (browser extension, Claude Desktop, menu bar app) as a login service? [Y/n]
   installed ai.ashlr.lexicon.serve; check with: lexicon serve --status

6. Dictation app
   which dictation app do you use?  1) Wispr Flow  2) Superwhisper  3) macOS Text Replacement  4) none
   wrote ~/Desktop/lexicon-wispr.csv (6 terms)
   import it in Wispr Flow > Dictionary > Import

7. Does it work?
   you dictate:  can you ask Mason Wiatt where the Ashler migration landed
   your agent sees: can you ask Mason Wyatt where the Ashlr.AI migration landed
   fixed: "Mason Wiatt" -> "Mason Wyatt", "Ashler" -> "Ashlr.AI"

Done.
   lexicon: ~/.config/lexicon/lexicon.yaml   terms added: Mason Wyatt, Ashlr.AI, Playwright, ...
   clients: claude, cursor   local API: installed   exports: ~/Desktop/lexicon-wispr.csv

Next: open Claude Code and dictate a sentence with "Ashlr.AI" in it. That is the whole thing.
   later: lexicon suggest (names you keep correcting), lexicon stats, lexicon voice (local push-to-talk)
```

Step 7 is not a canned example: it takes the terms the run just seeded, writes the sentence speech-to-text would have produced for them, and runs the real normalizer over it. If you skipped everything and the lexicon has nothing to show off, it falls back to the example terms and says so, so the run always ends with the product working.

## 3. Say a sentence in Claude Code

Open a new Claude Code session (the `SessionStart` hook loads the lexicon) and dictate something with your company name in it: "tell Ashler to ship it". The `UserPromptSubmit` hook rewrites it to `Ashlr.AI` before Claude reads it and tells Claude what changed. Corrections you make in chat ("it's Ashlr.AI, not Ashler") are learned via the `learn_correction` tool.

## 4. Check it is working

`lexicon normalize "tell Ashler to ship it"` prints `tell Ashlr.AI to ship it`; `lexicon stats` shows hits per term and never-hit terms.

`lexicon doctor` checks the files, hooks, MCP registration, clipboard and whisper, and ends with the two lines that matter: a one-sentence verdict and the single next thing to do. Agents get the same two as the `summary` and `nextStep` fields of the `lexicon_doctor` tool, alongside `ready`, the boolean answer to "is this set up?".

## Next

Your client page is the one to read after this: [CLIENTS.md](CLIENTS.md) covers installing into Claude Code (plugin, hooks, headless) and into Codex, Cursor, Windsurf, Gemini CLI, VS Code and Claude Desktop, with what each one writes and how to check it took.

Then, depending on where else your voice lands:

- Browser chats (ChatGPT, Claude, Grok, Gemini, ...): the extension, [EXTENSION.md](EXTENSION.md).
- Local push-to-talk with whisper.cpp: `lexicon voice`, [VOICE.md](VOICE.md).
- macOS menu bar app with a hotkey and clipboard fixing: [MACOS-APP.md](MACOS-APP.md).
- More starter terms: [PACKS.md](PACKS.md), or `lexicon pack list`.
- The full CLI: [CLI.md](CLI.md); the file format: [LEXICON-FILE.md](LEXICON-FILE.md); the trust model: [TRUST.md](TRUST.md).

Back to [the docs index](README.md).
