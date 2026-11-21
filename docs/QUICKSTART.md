# Quickstart: five minutes to a lexicon your agents read

`@ashlr/lexicon` fixes the words speech-to-text gets wrong (Ashler -> Ashlr.AI) before your agent sees the prompt. This is the shortest path from nothing to "it just works in Claude Code".

## 0. See it work first (no install, five seconds)

```bash
npx @ashlr/lexicon normalize "ping ashler about the cooper netties migration"
```

```text
lexicon: no terms yet, so this is the built-in example (Ashlr.AI, Kubernetes, PostgreSQL, Pydantic, SaaS, Hetzner).
lexicon: run `lexicon setup` to build your own; nothing was written.
ping Ashlr.AI about the Kubernetes migration
```

With no lexicon of your own, a sentence typed as arguments is corrected against the built-in example terms so you can see what the tool does before deciding to keep it. (Piped input is never touched by the example: `cat notes.md | lexicon normalize` passes through byte-exact until you have terms of your own.) Nothing is written, and nothing is installed globally: `npx` runs it from a cache.

## 1. Install

```bash
npm i -g @ashlr/lexicon && lexicon setup
```

Requires Node 20+. This puts `lexicon` on PATH and starts setup, which asks before it writes outside your lexicon.

For no global install, use the command below and replace later `lexicon` commands with `npx @ashlr/lexicon@latest`. Setup pins the MCP and hook commands to this package version so they survive cache cleanup:

```bash
npx @ashlr/lexicon@latest setup
```

Or `brew install ashlrai/tap/lexicon` (pulls in node; ffmpeg + whisper.cpp recommended for `lexicon voice`), or `curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh`, which checks for Node 20+, installs globally and starts `lexicon setup` for you when it runs in a terminal (not under `sudo`, in CI or with `LEXICON_NO_SETUP=1`: then run `lexicon setup` yourself).

## 2. `lexicon setup`

One interactive pass, seven numbered steps, ending in a live correction. Every step prints a one-line result and is safe to rerun (nothing is duplicated), and the starter packs arrive as a checklist you can untick ([PACKS.md](PACKS.md) has what is in each).

`lexicon setup --yes` runs without prompting: it creates the lexicon and installs into every agent client it detects, but the three steps that write a lot or install a service stay opt-in even then, so add `--packs developer,ai,voice-tools`, `--harvest` and `--serve` for those. `--dry-run` writes nothing and describes the run you would get from this same command without it: on a terminal every step that would stop and ask is marked `asks`, with the answer Enter gives it, so the login service and the export to your Desktop show up as the questions they are and the repo harvest shows up as a question whose default is no; with `--yes` or off a terminal the same plan shows the opt-in steps doing nothing until you pass their flag. `--clients none` / `--no-packs` / `--no-harvest` / `--no-serve` / `--app none` skip steps, and `--json` prints a machine-readable summary.

The current steps are:

1. Global lexicon

   Creates the global file if needed and offers person/company spellings and aliases.

2. Starter packs

   Offers `developer`, `ai` and `voice-tools` as the default checklist, then asks separately about the other available packs. Already-installed packs are left alone.

3. Repo harvest

   Previews names from the current repository and asks before adding them to its project lexicon.

4. Agent clients

   Detects supported clients and installs the selected MCP registrations and Claude Code hooks.

5. Local API (lexicon serve)

   Offers a login service for the browser extension and desktop apps.

6. Dictation app

   Offers a dictionary export for Wispr Flow, Superwhisper or macOS Text Replacement, or lets you skip it.

7. Does it work?

   Runs a correction with the terms just seeded and shows what changed.

Pack names and counts come from the installed version. Inspect them before choosing:

```bash
lexicon pack list --json
lexicon setup --dry-run --json
```

The [terminal recording](assets/cli-setup.cast) and [setup GIF](assets/cli-setup.gif)
show a historical 0.5.1 run. Their client list and pack counts are records of that
build; the current [CLI reference](CLI.md) lists today's flags.

Repo harvest (step 3) defaults to no. It proposes only names the repo says out loud somewhere other than its own code: what the manifests declare, what the README names, the git authors, the directory. A class or a type is something you type rather than say, and its name split into words ("InlineData" into "inline data") would rewrite ordinary dictation, so the harvest leaves those alone; `lexicon harvest --symbols --interactive` adds them to the list and walks it one name at a time when you do want them.

Step 7 is not a canned example: it takes the terms the run just seeded, writes the sentence speech-to-text would have produced for them, and runs the real normalizer over it. If you skipped everything and the lexicon has nothing to show off, it falls back to the example terms and says so, so the run always ends with the product working.

## 3. Say a sentence in Claude Code

Open a new Claude Code session (the `SessionStart` hook loads the lexicon) and dictate something with a name you added. If you added Ashlr.AI with the alias Ashler, try "tell Ashler to ship it". The `UserPromptSubmit` hook supplies an `additionalContext` note telling Claude that "Ashler" means "Ashlr.AI"; the submitted prompt stays unchanged. Corrections you make in chat ("it's Ashlr.AI, not Ashler") are flagged for the [`learn_correction`](MCP.md#tools) tool and queued for review with `lexicon pending`; the hook never changes active terms on its own.

## 4. Check it is working

With that alias saved, `lexicon normalize "tell Ashler to ship it"` prints `tell Ashlr.AI to ship it`; `lexicon stats` shows hits per term and never-hit terms.

`lexicon doctor` checks the files, hooks, MCP registration, clipboard and whisper, and ends with the two lines that matter: a one-sentence verdict and the single next thing to do. Agents get the same two as the `summary` and `nextStep` fields of the [`lexicon_doctor`](MCP.md#tools) tool, alongside `ready`, the boolean answer to "is this set up?".

## Next

Your client page is the one to read after this: [CLIENTS.md](CLIENTS.md) covers installing into Claude Code (plugin, hooks, headless) and into Codex, Cursor, Windsurf, Gemini CLI, VS Code and Claude Desktop, with what each one writes and how to check it took.

Then, depending on where else your voice lands:

- Browser chats (ChatGPT, Claude, Grok, Gemini, ...): the extension, [EXTENSION.md](EXTENSION.md).
- Local push-to-talk with whisper.cpp: `lexicon voice`, [VOICE.md](VOICE.md).
- macOS menu bar app with a hotkey and clipboard fixing: [MACOS-APP.md](MACOS-APP.md).
- More starter terms: [PACKS.md](PACKS.md), or `lexicon pack list`.
- The full CLI: [CLI.md](CLI.md); the file format: [LEXICON-FILE.md](LEXICON-FILE.md); the trust model: [TRUST.md](TRUST.md).

Back to [the docs index](README.md).
