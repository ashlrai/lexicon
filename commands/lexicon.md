---
description: Show, add, harvest, import, export, set up, diagnose or improve the user's personal voice lexicon (STT spelling corrections).
argument-hint: "[add <canonical> as <alias>, <alias> | remove <canonical> | remove <alias> from <canonical> | learn <heard> -> <meant> | stats | harvest [path] | export <format> | setup | doctor | suggest [n] | trust [path] | trust off [path] | normalize <text> | packs [add <name>] | import <file|contacts|calendar|github> | install <client>]"
---

Manage the user's voice lexicon through the `lexicon` MCP server. Arguments: `$ARGUMENTS`

Decide what to do from the arguments:

1. **No arguments** - call `list_terms` with no filters and show the result as a
   compact table: canonical, aliases, category, scope. Include the file paths in use
   underneath so the user knows where the data lives.

2. **`add <canonical> as <alias>[, <alias>...]`** - call `add_term` with
   `canonical` set to the text before `as` and `aliases` set to the comma-separated
   list after it. If there is no `as`, call `add_term` with only `canonical` so the
   aliases are auto-suggested. Report the saved term, its aliases and the file path.

3. **`harvest`** (optionally followed by a path) - call `harvest_repo` with that
   path (or none for the current repo) and no `add`. Show the candidates with their
   counts and suggested aliases, then ask whether to save them. If the user says
   yes, call `harvest_repo` again with `add: true` and relay its `nextStep`: the file
   is not trusted until the user runs `lexicon trust` (or `npx @ashlr/lexicon trust`).

4. **`export <format>`** - call `export_lexicon` with that format and print the
   returned text verbatim inside a fenced code block. Valid formats: `claude-md`,
   `wispr`, `superwhisper`, `whisper-prompt`, `macos`, `deepgram`, `espanso`,
   `assemblyai`, `speechmatics`, `azure`, `google`, `openai`, `text`, `markdown`, `csv`, `json`. If the format is missing or unknown, list the valid ones instead.

5. **`remove <canonical>`** - call `remove_term` and confirm whether it was found.
   `remove <alias> from <canonical>` - call `remove_term` with `alias` to drop just
   that alias. If the result has `foundIn`, retry with that `scope`.

6. **`learn <heard> -> <meant>`** (also `learn <heard> => <meant>` or a sentence
   such as `learn it's Ashlr.AI not Ashler`) - call `learn_correction` with
   `heard` set to the wrong spelling and `meant` set to the right one. Confirm in
   one line: "Got it, Ashler → Ashlr.AI, saved." If only one spelling is given,
   ask which form was heard before calling the tool.

7. **`stats`** - call `lexicon_stats` and show: term/alias counts and total hits
   on one line, a small table of the top terms by hits, the never-hit list, and
   the files in use with their term counts.

8. **`setup`** - first-run onboarding, no terminal needed. Ask, one question at
   a time: the company/product names spelled exactly as they should appear and
   how they are pronounced; the user's own name; which agent clients they use
   (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code).
   Call `setup_lexicon { company, person }` without `apply` and show the plan it
   returns (what it would seed, the clients it detected, whether it would
   install the login service). Only after a clear yes call it again with
   `apply: true`, `clients` set to the ones the user agreed to, `packs` set to
   any starter packs they picked (`list_packs` describes each), `harvest: true`
   only if they want the repo's names added, and `serve: true` only if they want
   the login service. Report the lexicon path, which clients
   were installed, skipped or failed, and the exports it wrote. For every other name the user gave, call `add_term` (aliases omitted)
   and show each term with its aliases on one line. End with one sentence the
   user can dictate in a new session to test it.

9. **`doctor`** - call `lexicon_doctor` and show the `fail` and `warn` checks
   first, each with the fix its message names, then a one-line verdict. When a
   fix is an `install_client` call, offer to preview it. When everything is
   `ok`, say so in one line.

10. **`suggest`** - call `suggest_terms` (pass `limit` if the user gave a
    number). Show each suggestion on one line: kind, canonical, alias, reason,
    count, and the file applying it would write (its `scope` and `path`). Ask which to apply; call `apply_suggestion` once
    with every accepted suggestion object, exactly as returned, in `suggestions`.
    Report what was written (`applied`) and anything refused (`failures`), and
    skip the rest. With no suggestions, say the lexicon looks healthy.

11. **`trust [path]`** - call `trust_project { action: 'status', path? }` and
    show the user the file path, its status and the summary (term, alias and
    note counts, the sample canonicals), and say `lexicon trust` in a terminal
    shows every term. Ask whether to trust it. Only on a clear yes
    call `trust_project { action: 'trust', path? }`; the client asks the user to
    confirm. Report the result in one line (if it says the client cannot ask,
    tell them to run `lexicon trust` in a terminal).
    `trust off [path]` or `untrust` calls `action: 'untrust'`. Never trust a
    file whose summary the user has not just seen.

12. **`normalize <text>`** - call `normalize_transcript { text }` and print
    `output` in a fenced code block, then one line per entry in `replacements`.
    With no replacements, say the text needed no correction. If the result has
    a `note` or `skippedProject`, relay it (an untrusted project lexicon was not
    applied). Add `dryRun: true` only when the user asks what would change.

13. **`packs`** - call `list_packs` and show each pack on one line: name,
    title, term count and whether it is installed. **`packs add <name>`** -
    name the pack and its term count and ask first; only on a clear yes call
    `add_pack { name }` and report its `summary`. A community ref
    (`<author>/<name>`) also needs `registry`: call without `confirm`, show
    the returned term list, and only after a yes call again with
    `confirm: true` and the returned `previewDigest`.

14. **`import <file>`** - call `import_dictionary { path, dryRun: true }`
    (format `auto` unless the user named one: `wispr`, `superwhisper`,
    `macos`, `espanso`, `markdown`, `text`, `csv`, `json`) and show what would
    be added. Only after a yes call it again without `dryRun`.
    **`import contacts`**, **`import calendar`** or **`import github`** (one
    or more) - call `import_vocabulary { sources }` without `apply`, show the
    candidates with their ids, then, after the user picks, call again with
    `apply: true`, the same `sources`, the returned `previewToken` and only the
    approved ids in `approvedCandidateIds`. The token lasts five minutes.

15. **`install <client>`** (`claude`, `codex`, `cursor`, `windsurf`,
    `gemini`, `vscode` or `claude-desktop`) - call `install_client { client }`
    without `apply` and show the file and entry it would change. Only after a
    clear yes call it again with `apply: true`. If `ok` is false, relay
    `nextStep` instead of reporting success; otherwise relay `reload`.

When a write to a project file that is not trusted yet returns
`trusted: false`, relay its `nextStep`.

Anything else: explain the forms above in one short paragraph.
