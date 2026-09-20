---
description: Show, add, harvest, export, set up, diagnose or improve the user's personal voice lexicon (STT spelling corrections).
argument-hint: "[add <canonical> as <alias>, <alias> | learn <heard> -> <meant> | stats | harvest | export <format> | setup | doctor | suggest | trust [path]]"
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
   yes, call `harvest_repo` again with `add: true`.

4. **`export <format>`** - call `export_lexicon` with that format and print the
   returned text verbatim inside a fenced code block. Valid formats: `claude-md`,
   `wispr`, `superwhisper`, `whisper-prompt`, `macos`, `deepgram`, `espanso`,
   `assemblyai`, `azure`, `google`, `openai`, `text`, `markdown`, `csv`, `json`. If the format is missing or unknown, list the valid ones instead.

5. **`remove <canonical>`** - call `remove_term` and confirm whether it was found.

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
   `apply: true`, `clients` set to the ones the user agreed to and `serve: true`
   only if they want the login service. Report the lexicon path, which clients
   were installed, skipped or failed, and the exports it wrote. For every other name the user gave, call `add_term` (aliases omitted)
   and show each term with its aliases on one line. End with one sentence the
   user can dictate in a new session to test it.

9. **`doctor`** - call `lexicon_doctor` and show the `fail` and `warn` checks
   first, each with the fix its message names, then a one-line verdict. When a
   fix is an `install_client` call, offer to preview it. When everything is
   `ok`, say so in one line.

10. **`suggest`** - call `suggest_terms` (pass `limit` if the user gave a
    number). Show each suggestion on one line: kind, canonical, alias, reason,
    count. Ask which to apply; for each accepted one call `apply_suggestion`
    with the suggestion object exactly as returned. Report what was written
    and skip the rest. With no suggestions, say the lexicon looks healthy.

11. **`trust [path]`** - call `trust_project { action: 'status', path? }` and
    show the user the file path, its status and the preview table (canonical,
    first alias, alias count). Ask whether to trust it. Only on a clear yes
    call `trust_project { action: 'trust', path? }` and confirm in one line.
    `trust off [path]` or `untrust` calls `action: 'untrust'`. Never trust a
    file whose preview the user has not just seen.

Anything else: explain the forms above in one short paragraph.
