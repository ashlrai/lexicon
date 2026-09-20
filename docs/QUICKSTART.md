# Quickstart: five minutes to a lexicon your agents read

`@ashlr/lexicon` fixes the words speech-to-text gets wrong (Ashler -> Ashlr.AI) before your agent sees the prompt. This is the shortest path from nothing to "it just works in Claude Code".

## 1. Install (one line)

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
```

The script checks for Node 20+, installs `@ashlr/lexicon` globally (from npm, falling back to GitHub at the latest tag if the registry is unreachable) and starts `lexicon setup`. Prefer `brew install ashlrai/tap/lexicon` (pulls in node; ffmpeg + whisper.cpp recommended for `lexicon voice`) or `npm i -g @ashlr/lexicon`? Then run `lexicon setup` yourself.

## 2. `lexicon setup`

One interactive pass, six steps. Every step prints a one-line result and is safe to rerun (nothing is duplicated). `lexicon setup --yes` runs without prompting: it creates the lexicon and installs into every agent client it detects, but the three steps that write a lot or install a service are opt-in even then, so add `--packs developer,ai,voice-tools` for the starter packs, `--harvest` for the repo scan and `--serve` for the login service; `--dry-run` prints what a run would do and writes nothing; `--clients none`, `--no-packs`, `--no-harvest`, `--no-serve`, `--app none` skip steps; `--packs developer,ai` picks the starter packs without a prompt; `--json` prints a machine-readable summary.

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

Done.
   lexicon: ~/.config/lexicon/lexicon.yaml   terms added: Mason Wyatt, Ashlr.AI, Playwright, ...
   clients: claude, cursor   local API: installed   exports: ~/Desktop/lexicon-wispr.csv

Next:
   1. Open Claude Code and dictate a sentence with "Ashlr.AI" in it; the hook fixes it before Claude reads it.
   2. After a week: lexicon suggest (finds names you keep correcting) and lexicon stats.
   3. Local push-to-talk: lexicon voice --list-devices, then lexicon voice --copy.
```

## 3. Say a sentence in Claude Code

Open a new Claude Code session (the `SessionStart` hook loads the lexicon) and dictate something with your company name in it: "tell Ashler to ship it". The `UserPromptSubmit` hook rewrites it to `Ashlr.AI` before Claude reads it and tells Claude what changed. Corrections you make in chat ("it's Ashlr.AI, not Ashler") are learned via the `learn_correction` tool.

## 4. Check it is working

`lexicon normalize "tell Ashler to ship it"` prints `tell Ashlr.AI to ship it`; `lexicon stats` shows hits per term and never-hit terms; `lexicon doctor` checks the files, hooks, MCP registration, clipboard and whisper.

## Next

- Browser chats (ChatGPT, Claude, Grok, Gemini, ...): the extension, [EXTENSION.md](EXTENSION.md).
- Local push-to-talk with whisper.cpp: `lexicon voice`, [VOICE.md](VOICE.md).
- macOS menu bar app with a hotkey and clipboard fixing: [MACOS-APP.md](MACOS-APP.md).
- Other agents (Codex, Cursor, Windsurf, Gemini CLI, VS Code, Claude Desktop): `lexicon install <client> --apply`.
- More starter terms: [PACKS.md](PACKS.md), or `lexicon pack list`.
- The full CLI: [CLI.md](CLI.md); the file format: [LEXICON-FILE.md](LEXICON-FILE.md); the trust model: [TRUST.md](TRUST.md).
