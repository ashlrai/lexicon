---
description: Show, add, harvest or export the user's personal voice lexicon (STT spelling corrections).
argument-hint: "[add <canonical> as <alias>, <alias> | learn <heard> -> <meant> | stats | harvest | export <format>]"
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

Anything else: explain the forms above in one short paragraph.
