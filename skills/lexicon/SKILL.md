---
name: lexicon
description: Personal voice lexicon for dictated input. Use when the user mentions dictation, voice, transcription, speech-to-text, a misspelled brand or name, says "I said X not Y", or asks you to remember how to spell something.
---

# Lexicon: correcting dictated input

Speech-to-text engines mangle invented names. The user says "Ashlr.AI" and the
transcript reads "Ashler" or "Ashlar". The `lexicon` MCP server holds the user's
canonical spellings and the misspellings STT produces for them. Your job is to
use it so the user never has to re-type a name.

## At session start

The plugin's `SessionStart` hook already put a "## Voice lexicon" table in your
context: every canonical spelling and its known aliases. Keep it in mind while
interpreting everything the user types. If that table is missing, or ends with
"... N more terms; read the lexicon://me resource", read the resource
`lexicon://me` once to get the full list.

If the current repo has no `.lexicon.yaml`, call `harvest_repo` (without `add`)
and offer to save the candidates that look like real project vocabulary
(package names, class names, teammates). Add them with `add: true` only after
the user agrees.

## When to call `normalize_transcript`

Call it before acting on any prompt that looks dictated:

- run-on sentences with little or no punctuation
- no code formatting, no backticks, no paths, all prose
- a proper noun that looks garbled or is spelled inconsistently within the prompt
- a UserPromptSubmit hook note titled "Voice lexicon corrections" (the hook
  already ran normalize; apply its corrected prompt and skip the call)

Use the `output` field as the prompt you act on. Mention corrections briefly only
when they change meaning; never ask the user to confirm an exact alias match.
If a replacement has low confidence and the sentence reads fine either way,
prefer the canonical form but do not lecture about it.

## When the user corrects you

The loop that matters: the user dictates "ping ashler", you write "Ashler",
they say "it's Ashlr.AI, not Ashler". Record it so it never happens again,
without the user opening a file.

Correction phrasing to detect: "it's X not Y", "it's X, not Y", "I said X not
Y", "I meant X", "not Y, X", "spelled X", "that should be X", "Y should be X",
"replace Y with X", "Y -> X", or the user simply retyping a name you wrote with
a different spelling. X is what they meant; Y is what was heard/written.

The `UserPromptSubmit` hook detects the explicit forms for you: when the prompt
is a correction it adds the line `The user is correcting a spelling: "Y" should
be "X". Call the lexicon learn_correction tool with these values, then
continue.` The hook only flags; it never writes. Make the call unless the
sentence clearly was not a correction (then just continue). Corrections the
hook cannot see ("spelled Zoë", a retyped name) are still yours to catch.

1. Call `learn_correction { heard: Y, meant: X }`. When the user only names
   the right spelling ("spelled Zoë", "that should be Ashlr.AI"), `heard` is
   the form you wrote in your previous message - you know what it was.
   Add `scope: "project"` only for repo-specific identifiers.
2. Confirm in one short line: "Got it, Ashler → Ashlr.AI, saved."
3. From then on use the canonical form for the rest of the session, and
   re-read the sentence that triggered the correction with it before continuing.

Do not call `add_term` for corrections; it is for brand-new terms with
categories, notes or `never` lists. Do not stop to confirm that the alias was
saved unless the call errored.

## When a word looks garbled and is not in the lexicon

If a dictated prompt contains something that looks like a mangled proper noun
and `normalize_transcript` left it unchanged:

1. Call `suggest_canonical { heard }`.
2. If the top candidate has `confidence >= 0.8`, use its canonical and mention
   it once ("reading 'ashlur' as Ashlr.AI") - do not ask.
3. Otherwise ask, offering the candidates if there are any: "did you mean
   Ashlr.AI?". When the user answers, call `learn_correction` with their answer
   so the question is never asked again.
4. If there are no candidates at all, treat it as a new name and ask how it is
   spelled; then `learn_correction { heard, meant }` with what they say.

## When the user asks how the lexicon is doing

`lexicon_stats {}` returns term/alias counts, total hits, the ten most-used
terms, up to twenty terms that never fired, and the files in use. Summarise
it in a few lines; never-hit terms are candidates for cleanup, not errors.

## Never "correct" these

- text inside code blocks, inline code, file paths, URLs or emails
- identifiers the user typed (not dictated) that already compile or resolve
- common English words that happen to sound like a term (the matcher has a
  stoplist; if it still misfires, add the word to the term's `never` list via
  `add_term` notes and tell the user)

## Tool cheat sheet

| Need | Tool |
| --- | --- |
| Fix a dictated prompt | `normalize_transcript { text }` |
| Preview without applying | `normalize_transcript { text, dryRun: true }` |
| Record a correction the user just made | `learn_correction { heard, meant, scope? }` |
| "Did you mean X?" for an unknown garble | `suggest_canonical { heard }` |
| Add a new term with metadata | `add_term { canonical, aliases?, category?, scope? }` |
| Drop a spelling | `remove_term { canonical }` |
| Usage report | `lexicon_stats {}` |
| Look something up | `list_terms { query? }` |
| Seed from a repo | `harvest_repo { path?, add? }` |
| Hand the list to another tool | `export_lexicon { format }` |

`export_lexicon` formats: `claude-md`, `wispr`, `superwhisper`, `whisper-prompt`,
`macos`, `deepgram`, `espanso`, `assemblyai`, `azure`, `google`, `openai`, `text`,
`markdown`, `csv`, `json`.
