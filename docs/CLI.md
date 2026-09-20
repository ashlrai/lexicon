# CLI reference

Every command and flag, for when you know what you want to do and need the exact spelling. If you are still deciding, [QUICKSTART.md](QUICKSTART.md) and the task pages in [the docs index](README.md) are better starting points.

Generated from `lexicon --help` (v0.5.1) by `npm run docs:cli`. Do not edit by hand; change the command definitions in `src/cli/` and re-run the generator.

Global option: `--cwd <dir>` sets the directory used to find the project `.lexicon.yaml`.

## Commands

| Command | Does |
|---|---|
| [`lexicon init [options]`](#lexicon-init) | create the lexicon file (global by default) if it does not exist |
| [`lexicon add [options] <canonical> [aliases...]`](#lexicon-add) | add a term, or merge aliases into an existing one |
| [`lexicon remove\|rm [options] <canonical>`](#lexicon-remove) | remove a term (project lexicon first, then global) |
| [`lexicon list\|ls [options]`](#lexicon-list) | list terms from the merged global + project lexicon |
| [`lexicon normalize [options] [text...]`](#lexicon-normalize) | correct dictated text (from arguments, or stdin when omitted); always exits 0 |
| [`lexicon harvest [options] [path]`](#lexicon-harvest) | scan a repository for names worth adding to the lexicon |
| [`lexicon export [options] [format]`](#lexicon-export) | export the merged lexicon for another tool (run without a format to list them) |
| [`lexicon path`](#lexicon-path) | print the resolved global and project lexicon paths |
| [`lexicon doctor`](#lexicon-doctor) | check lexicon files, term conflicts and the Claude Code integration |
| [`lexicon mcp`](#lexicon-mcp) | start the stdio MCP server (what `claude mcp add` points at) |
| [`lexicon hook`](#lexicon-hook) | run as a Claude Code UserPromptSubmit hook (reads JSON from stdin) |
| [`lexicon daemon [options]`](#lexicon-daemon) | watch the clipboard (macOS, Linux, Windows) and correct dictated text in place |
| [`lexicon import [options] <file> [format]`](#lexicon-import) | import an existing dictionary (Wispr Flow, Superwhisper, macOS, espanso, text, csv, json) into the lexicon |
| [`lexicon install [options] [client]`](#lexicon-install) | print (or with --apply, write) the MCP config for an agent client; no client lists them |
| [`lexicon trust [options] [path]`](#lexicon-trust) | approve a project .lexicon.yaml so its terms are merged (shows a preview first) |
| [`lexicon untrust [path]`](#lexicon-untrust) | revoke approval for a project .lexicon.yaml |
| [`lexicon learn [options] [words...]`](#lexicon-learn) | record a spelling correction: what STT heard and what you meant |
| [`lexicon stats [options]`](#lexicon-stats) | show term/alias counts, most-used terms and terms that never fired |
| [`lexicon serve [options]`](#lexicon-serve) | run the local HTTP API on http://127.0.0.1:41733 for extensions, Shortcuts, Raycast and desktop apps |
| [`lexicon voice [options]`](#lexicon-voice) | dictate locally: record the microphone, transcribe with whisper.cpp, correct with the lexicon |
| [`lexicon setup [options]`](#lexicon-setup) | guided first-run: seed the lexicon, harvest the repo, install into your agents and dictation app |
| [`lexicon suggest [options]`](#lexicon-suggest) | suggest aliases, new terms, never-words and stale terms from your voice history |
| [`lexicon review [options]`](#lexicon-review) | walk through existing terms and keep, delete or edit each one |
| [`lexicon edit [options]`](#lexicon-edit) | open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it afterwards |
| [`lexicon pack`](#lexicon-pack) | starter term packs (developer, ai, business, voice-tools): list, add, remove, show |

## `lexicon`

```text
Usage: lexicon [options] [command]

Personal lexicon for voice-to-agents: fixes the words STT gets wrong before your
agent sees them.

Options:
  -V, --version                           output the version number
  --cwd <dir>                             directory used to find the project .lexicon.yaml (default: current directory)
  -h, --help                              display help for command

Commands:
  init [options]                          create the lexicon file (global by default) if it does not exist
  add [options] <canonical> [aliases...]  add a term, or merge aliases into an existing one
  remove|rm [options] <canonical>         remove a term (project lexicon first, then global)
  list|ls [options]                       list terms from the merged global + project lexicon
  normalize [options] [text...]           correct dictated text (from arguments, or stdin when omitted); always exits 0
  harvest [options] [path]                scan a repository for names worth adding to the lexicon
  export [options] [format]               export the merged lexicon for another tool (run without a format to list them)
  path                                    print the resolved global and project lexicon paths
  doctor                                  check lexicon files, term conflicts and the Claude Code integration
  mcp                                     start the stdio MCP server (what `claude mcp add` points at)
  hook                                    run as a Claude Code UserPromptSubmit hook (reads JSON from stdin)
  daemon [options]                        watch the clipboard (macOS, Linux, Windows) and correct dictated text in place
  import [options] <file> [format]        import an existing dictionary (Wispr Flow, Superwhisper, macOS, espanso, text, csv, json) into the lexicon
  install [options] [client]              print (or with --apply, write) the MCP config for an agent client; no client lists them
  trust [options] [path]                  approve a project .lexicon.yaml so its terms are merged (shows a preview first)
  untrust [path]                          revoke approval for a project .lexicon.yaml
  learn [options] [words...]              record a spelling correction: what STT heard and what you meant
  stats [options]                         show term/alias counts, most-used terms and terms that never fired
  serve [options]                         run the local HTTP API on http://127.0.0.1:41733 for extensions, Shortcuts, Raycast and desktop apps
  voice [options]                         dictate locally: record the microphone, transcribe with whisper.cpp, correct with the lexicon
  setup [options]                         guided first-run: seed the lexicon, harvest the repo, install into your agents and dictation app
  suggest [options]                       suggest aliases, new terms, never-words and stale terms from your voice history
  review [options]                        walk through existing terms and keep, delete or edit each one
  edit [options]                          open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it afterwards
  pack                                    starter term packs (developer, ai, business, voice-tools): list, add, remove, show
  help [command]                          display help for command
```

## `lexicon init`

```text
Usage: lexicon init [options]

create the lexicon file (global by default) if it does not exist

Options:
  --project   create a project .lexicon.yaml at the git root (or cwd) instead
  -h, --help  display help for command
```

## `lexicon add`

```text
Usage: lexicon add [options] <canonical> [aliases...]

add a term, or merge aliases into an existing one

Arguments:
  canonical              the correct spelling, e.g. "Ashlr.AI"
  aliases                what STT actually writes, e.g. Ashler Ashlar

Options:
  --phonetic <hint>      pronunciation hint, e.g. ASH-ler
  --category <category>  brand|person|product|acronym|identifier|place|other
  --notes <text>         free text shown to the agent
  --project              write to the project lexicon instead of the global one
  --suggest              append auto-generated likely misspellings (automatic
                         when no aliases are given)
  -i, --interactive      confirm suggested aliases as a checklist, then ask for
                         phonetic hint and category
  --never <word...>      words that must never be rewritten to this term even if
                         they sound alike, e.g. --never sauce
  -h, --help             display help for command
```

## `lexicon remove`

```text
Usage: lexicon remove|rm [options] <canonical>

remove a term (project lexicon first, then global)

Options:
  --project   only look in the project lexicon
  -h, --help  display help for command
```

## `lexicon list`

```text
Usage: lexicon list|ls [options]

list terms from the merged global + project lexicon

Options:
  --json                 print terms as JSON
  --category <category>  only this category
  --query <text>         only terms whose canonical or aliases contain this text
  -h, --help             display help for command
```

## `lexicon normalize`

```text
Usage: lexicon normalize [options] [text...]

correct dictated text (from arguments, or stdin when omitted); always exits 0

Options:
  --json                print the full NormalizeResult as JSON
  --diff                print a summary of replacements to stderr
  --dry-run             report replacements without applying them
  --min-confidence <n>  minimum confidence (0..1) for fuzzy/phonetic matches
  --no-phonetic         disable phonetic matching
  --no-fuzzy            disable fuzzy (edit-distance) matching
  --include-untrusted   merge the project .lexicon.yaml even if it has not been
                        trusted
  -h, --help            display help for command
```

## `lexicon harvest`

```text
Usage: lexicon harvest [options] [path]

scan a repository for names worth adding to the lexicon

Arguments:
  path               repository root (default: cwd)

Options:
  --limit <n>        max candidates
  --min-count <n>    minimum occurrences
  --add              add candidates (with suggested aliases) to the project
                     lexicon; on a terminal this walks them one by one
  -i, --interactive  walk candidates one by one: y add, n skip, e edit aliases,
                     c category, a add all, q quit
  --yes              with --add: add every candidate without prompting
  --json             print candidates as JSON
  -h, --help         display help for command
```

## `lexicon export`

```text
Usage: lexicon export [options] [format]

export the merged lexicon for another tool (run without a format to list them)

Options:
  --out <file>                write to a file instead of stdout
  --category <categories...>  only these categories
  --limit <n>                 cap the number of terms
  -h, --help                  display help for command
```

## `lexicon path`

```text
Usage: lexicon path [options]

print the resolved global and project lexicon paths

Options:
  -h, --help  display help for command
```

## `lexicon doctor`

```text
Usage: lexicon doctor [options]

check lexicon files, term conflicts and the Claude Code integration

Options:
  -h, --help  display help for command
```

## `lexicon mcp`

```text
Usage: lexicon mcp [options]

start the stdio MCP server (what `claude mcp add` points at)

Options:
  -h, --help  display help for command
```

## `lexicon hook`

```text
Usage: lexicon hook [options]

run as a Claude Code UserPromptSubmit hook (reads JSON from stdin)

Options:
  -h, --help  display help for command
```

## `lexicon daemon`

```text
Usage: lexicon daemon [options]

watch the clipboard (macOS, Linux, Windows) and correct dictated text in place

Options:
  --once            correct the clipboard once and exit (for a keyboard shortcut
                    after dictating)
  --paste           with --once: send Cmd+V afterwards (macOS only; needs
                    Accessibility permission)
  --interval <ms>   poll interval in milliseconds (default: 250)
  --dry-run         report corrections without writing to the clipboard
  --quiet           do not print corrections
  --backend <name>  force a clipboard backend: pbcopy|wl|xclip|xsel|powershell
  --which           print the detected clipboard backend and exit
  -h, --help        display help for command
```

## `lexicon import`

```text
Usage: lexicon import [options] <file> [format]

import an existing dictionary (Wispr Flow, Superwhisper, macOS, espanso, text,
csv, json) into the lexicon

Arguments:
  file                   file to import, or - for stdin
  format                 one of: auto, wispr, superwhisper, macos, espanso,
                         text, csv, json (default: auto)

Options:
  --format <format>      same as the positional format argument
  --project              write to the project lexicon instead of the global one
  --dry-run              print what would be added without writing
  --source <source>      source recorded on each term (default: import)
  --category <category>  category applied to imported terms that lack one
  --json                 print the result as JSON
  -h, --help             display help for command
```

## `lexicon install`

```text
Usage: lexicon install [options] [client]

print (or with --apply, write) the MCP config for an agent client; no client
lists them

Arguments:
  client           one of: claude, codex, cursor, windsurf, gemini,
                   claude-desktop, vscode, generic

Options:
  --apply          write the config file (merge; existing keys are kept)
  --scope <scope>  user|project (project = the repo-level config file)
  --project        same as --scope project
  --home <dir>     treat <dir> as the home directory (mainly for tests)
  -h, --help       display help for command
```

## `lexicon trust`

```text
Usage: lexicon trust [options] [path]

approve a project .lexicon.yaml so its terms are merged (shows a preview first)

Arguments:
  path        lexicon file (default: the project .lexicon.yaml for the current
              directory)

Options:
  --list      list trusted project lexicons and whether they still match
  -h, --help  display help for command
```

## `lexicon untrust`

```text
Usage: lexicon untrust [options] [path]

revoke approval for a project .lexicon.yaml

Arguments:
  path        lexicon file (default: the project .lexicon.yaml for the current
              directory)

Options:
  -h, --help  display help for command
```

## `lexicon learn`

```text
Usage: lexicon learn [options] [words...]

record a spelling correction: what STT heard and what you meant

Arguments:
  words              <heard> <meant>, or a sentence like "Ashler -> Ashlr.AI"

Options:
  --from <sentence>  parse a natural-language correction, e.g. "it's Ashlr.AI
                     not Ashler"
  --project          write to the project lexicon instead of the global one
  --json             print the result as JSON
  -h, --help         display help for command
```

## `lexicon stats`

```text
Usage: lexicon stats [options]

show term/alias counts, most-used terms and terms that never fired

Options:
  --json      print the stats as JSON
  -h, --help  display help for command
```

## `lexicon serve`

```text
Usage: lexicon serve [options]

run the local HTTP API on http://127.0.0.1:41733 for extensions, Shortcuts,
Raycast and desktop apps

Options:
  --port <n>     port to listen on (default 41733; 0 picks a free port)
  --host <host>  interface to bind (default 127.0.0.1; anything else is exposed
                 to the network)
  --json         print the listening info (or --show/--status result) as JSON
  --quiet        do not log requests
  --show         print the URL and bearer token (for the extension options page)
                 and exit
  --status       check whether the server is up and exit
  --pair         open http://127.0.0.1:41733/pair in your browser so the
                 extension pairs itself, and exit
  --install      install as a login service (launchd on macOS, systemd --user on
                 Linux, a Scheduled Task on Windows)
  --uninstall    remove the login service
  -h, --help     display help for command
```

## `lexicon voice`

```text
Usage: lexicon voice [options]

dictate locally: record the microphone, transcribe with whisper.cpp, correct
with the lexicon

Options:
  --toggle               hotkey mode: first call starts recording in the
                         background, second call stops and transcribes
  --status               print "recording since <time>" (exit 0) or "idle" (exit
                         1)
  --list-devices         print the audio input devices ffmpeg can see
  --seconds <n>          stop recording after n seconds instead of waiting for
                         Enter
  --device <name|index>  input device (default: the system default microphone)
  --model <name|path>    whisper model: a name like base.en or small.en
                         (auto-downloaded) or a ggml file (default: "base.en")
  --lang <code>          spoken language (default: "en")
  --translate            translate to English (whisper -tr)
  --no-prompt            do not pass the lexicon canonicals as the whisper
                         initial prompt
  --no-history           do not append to voice/history.jsonl
  --copy                 also put the corrected text on the clipboard
  --paste                copy and paste into the frontmost app (macOS; needs
                         Accessibility permission)
  --json                 print { raw, output, replacements, summary, model,
                         seconds, ms } as JSON
  --quiet                no status lines on stderr
  -h, --help             display help for command
```

## `lexicon setup`

```text
Usage: lexicon setup [options]

guided first-run: seed the lexicon, harvest the repo, install into your agents
and dictation app

Options:
  -y, --yes           take every default without prompting
  --clients <list>    comma-separated clients to install into, or none (default:
                      detect; one of claude, codex, cursor, windsurf, gemini,
                      claude-desktop, vscode)
  --company <name>    company or product name to seed (as you want it spelled)
  --person <name>     your name to seed (default: git config --global user.name)
  --phonetic <hint>   pronunciation hint for the company term, e.g. ASH-ler
  --app <app>         dictation app to export for: wispr|superwhisper|macos|none
  --export-dir <dir>  where to write the dictation export (default: ~/Desktop)
  --harvest           add the repo names to the project lexicon (with --yes it
                      is skipped unless this is passed)
  --packs <list>      comma-separated starter packs to install, or none
                      (default: a checklist on a terminal, nothing with --yes;
                      one of developer, ai, business, voice-tools)
  --no-packs          skip the starter packs (no prompt)
  --no-harvest        skip the repo harvest (no prompt)
  --serve             install the local API login service (with --yes it is
                      skipped unless this is passed)
  --no-serve          skip installing the local API login service (no prompt)
  --dry-run           detect and suggest only; write nothing and print what a
                      run would do
  --reseed            seed person/company terms even if the lexicon already has
                      terms
  --home <dir>        treat <dir> as the home directory (mainly for tests)
  --json              print a machine-readable summary on stdout (progress goes
                      to stderr)
  -h, --help          display help for command
```

## `lexicon suggest`

```text
Usage: lexicon suggest [options]

suggest aliases, new terms, never-words and stale terms from your voice history

Options:
  --json           print the suggestions as JSON
  --apply          walk the suggestions one by one: y apply, n skip, a apply all
                   remaining, q quit
  --yes            apply every suggestion at or above 0.80 confidence without
                   asking
  --harvest [dir]  also harvest a repository for new-term candidates (default:
                   the --cwd directory); an explicit --cwd harvests too
  --limit <n>      max suggestions (default 20)
  --project        write new terms to the project lexicon instead of the global
                   one
  -h, --help       display help for command
```

## `lexicon review`

```text
Usage: lexicon review [options]

walk through existing terms and keep, delete or edit each one

Options:
  --never-hit            only terms that have never fired (0 hits)
  --project              review the project .lexicon.yaml instead of the global
                         file
  --global               review the global lexicon (the default)
  --category <category>  only this category
  -h, --help             display help for command
```

## `lexicon edit`

```text
Usage: lexicon edit [options]

open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it
afterwards

Options:
  --project   open the project .lexicon.yaml instead of the global file
  -h, --help  display help for command
```

## `lexicon pack`

```text
Usage: lexicon pack [options] [command]

starter term packs (developer, ai, business, voice-tools): list, add, remove,
show

Options:
  -h, --help                  display help for command

Commands:
  list|ls [options]           list the available packs and which are installed
  add [options] <name...>     install one or more packs into the global lexicon
                              (existing terms only gain aliases)
  remove|rm [options] <name>  remove a pack; terms you edited since (hits, extra
                              aliases) are kept
  show [options] <name>       print the terms and aliases a pack contains
```

## See also

- [QUICKSTART.md](QUICKSTART.md) — the commands you actually need on day one, in order.
- [LEXICON-FILE.md](LEXICON-FILE.md) — the file these commands read and write.
- [MCP.md](MCP.md) — the same capabilities as tools your agent can call.
