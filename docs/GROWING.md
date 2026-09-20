# Growing the lexicon

Four ways terms get in after the first one: a starter pack, your repo, your corrections, and your own voice history.

- [Starter packs](PACKS.md) are one command and 155 curated terms.
- [Harvest your repo](#harvest-your-repo) mines the names already in your code.
- [Learn from corrections](#learn-from-corrections) turns "it's Ashlr.AI, not Ashler" into an alias.
- [Suggestions](SUGGEST.md) mine your voice history for what to add next.
- [Review what you have](#review-what-you-have) prunes what never fires.

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

`--limit N` caps candidates, `--min-count N` sets the minimum occurrences (default 2), `--json` prints candidates as JSON. It never reads `node_modules`, `dist`, `.git`, `vendor` or `build`.

### Pick candidates one by one

On a terminal, `--add` walks the candidates instead of adding them blindly (`--yes` adds every candidate without asking; `--interactive` / `-i` forces the walkthrough without `--add`). Each candidate shows its category, count, evidence and suggested aliases; one key decides it:

```text
$ lexicon harvest . --add
12 candidates [y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit

[1/12] LexiconStore  identifier, seen 5x
  evidence: src/store.ts, src/index.ts
  aliases:  Lexicon Store, Lexikon Store, LexikonStore
  add? [y/n/e/c/a/q] y
  added LexiconStore

[2/12] Ashlr.AI  brand, seen 2x
  evidence: README.md
  aliases:  Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI
  add? [y/n/e/c/a/q] e
  aliases (comma-separated, replaces the suggestions) [Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI] Ashler, Ashlar, Ashley our AI
  aliases:  Ashler, Ashlar, Ashley our AI
  add? [y/n/e/c/a/q] y
  added Ashlr.AI

[3/12] Mason Wyatt  person, seen 40x
  add? [y/n/e/c/a/q] q

added 2 new terms, merged 0, skipped 10 in /repo/.lexicon.yaml
project lexicon trusted (/repo/.lexicon.yaml)
```

`y` adds, `n` skips, `e` replaces the suggested aliases with what you type, `c` changes the category, `a` adds this and every remaining candidate, `q` stops. Adds go to the project lexicon and respect the [trust gate](TRUST.md). `--interactive` without a terminal (a pipe, CI) is an error; use `--add --yes` there.

## Learn from corrections

The other source of terms is you correcting the agent. `lexicon learn` records what STT heard and what you meant; the MCP tool `learn_correction` does the same from inside a session, and the `UserPromptSubmit` hook prompts the model to call it when your prompt is a correction.

```bash
lexicon learn Ashler Ashlr.AI                       # <heard> <meant>
lexicon learn "Ashler -> Ashlr.AI"                   # or one sentence
lexicon learn --from "it's Ashlr.AI, not Ashler"     # natural language
```

If `Ashlr.AI` already exists (as a canonical or an alias) the heard form becomes one more alias of it; otherwise a new term is created with `source: learned` plus auto-suggested aliases. Recognized phrasings: "it's X not Y", "I said X not Y", "I meant X not Y", "not Y, X", "replace Y with X", "Y -> X", "Y should be X", plus quoted forms. `--project` writes to `.lexicon.yaml`.

## What is actually firing

`lexicon stats` shows term and alias counts, total hits, the ten most-used terms and up to twenty that never fired. Every replacement made by the MCP `normalize_transcript` tool, the `UserPromptSubmit` hook, the local API, `lexicon voice` or the clipboard daemon bumps the term's `hits` counter (the CLI `normalize` does not), so the numbers reflect what was actually corrected.

## Suggestions from your voice history

`lexicon suggest` reads the history `lexicon voice` keeps, the hit counters and, with `--harvest`, the repo, and proposes the edits that would have made the last few weeks of transcripts come out right: aliases to add, terms you are missing, words to protect with `never`, and terms that stopped firing. `--apply` walks them one by one; your agent gets the same list as `suggest_terms` and `apply_suggestion`. What it proposes and how it scores each one is in [SUGGEST.md](SUGGEST.md).

## Review what you have

`lexicon review` walks existing terms (`--never-hit` for only the ones that never fired, `--project` for the project file, `--category <c>`), showing each term's aliases and hit count and taking `k` keep, `d` delete, `e` edit aliases, `p` phonetic hint, `n` notes, `q` quit. The file is written once at the end.

`lexicon add <canonical> -i` turns the auto-suggested aliases into a checklist and asks for the phonetic hint and category. To edit the YAML directly, `lexicon edit` opens it safely: see [LEXICON-FILE.md](LEXICON-FILE.md#editing-it).

## See also

- [SUGGEST.md](SUGGEST.md) is the deep version of the suggestions step above.
- [LEXICON-FILE.md](LEXICON-FILE.md) is what all four of these write into.
- [MATCHING.md](MATCHING.md) explains which of the terms you just added will actually fire.

Back to [the docs index](README.md).
