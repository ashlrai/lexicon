# Growing the lexicon

Four ways terms get in after the first one, and one way to take them out again: a starter pack, your repo, your corrections, your own voice history, and a review pass over what never fires.

- [Starter packs](PACKS.md) are one command and 272 curated terms.
- [Harvest your repo](#harvest-your-repo) mines the names already in your code.
- [Learn from corrections](#learn-from-corrections) turns "it's Ashlr.AI, not Ashler" into an alias, and [`lexicon pending`](#review-what-the-hook-queued) reviews the corrections the hook queued.
- [Suggestions](SUGGEST.md) mine your voice history for what to add next.
- [Review what you have](#review-what-you-have) prunes what never fires.

## Harvest your repo

Most of the words STT mangles are already in your codebase.

```bash
lexicon harvest .          # list candidates
lexicon harvest . --add    # add them to the project lexicon
```

It scans package and module names (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), git author names, the project directory name and proper nouns in README prose. Common words and generic identifiers (`String`, `Error`, `Component`) are filtered out.

A name is proposed only when the repo says it somewhere other than its own code. PascalCase identifiers are read, and they count towards a name the README or a manifest also names, but a class that exists nowhere but source is something you type rather than something you say, and adding it teaches the lexicon to rewrite ordinary dictation: `InlineData` would arrive with the alias `inline data`. `lexicon harvest . --symbols --interactive` proposes those too, as `identifier` candidates with no suggested aliases, for reviewing one at a time.

For the same reason a candidate's suggested aliases never invent a word boundary the name does not already have. `Ashlr.AI` and `pasture-notes` say where their words break, so `Ashlr AI` and `pasture notes` are offered; `LexiconBar` does not, so `Lexicon Bar` is not.

```text
canonical      category    count  suggested aliases                                      evidence
-------------  ----------  -----  -----------------------------------------------------  -----------------
openclaw       product     4                                                             package.json#name
Ashlr.AI       brand       2      Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI, Ashlar AI  README.md
```

`--limit N` caps candidates (default 50, at most 1000), `--min-count N` sets the minimum occurrences for a name found only in file text (default 2; the directory name, git authors, package names and dot-TLD brands count at any number), `--json` prints candidates as JSON, and `--add --dry-run` reports what it would add without writing. It never reads `node_modules`, `dist`, `.git`, `vendor` or `build`.

### Pick candidates one by one

On a terminal, `--add` walks the candidates instead of adding them blindly (`--yes` adds every candidate without asking; `--interactive` / `-i` forces the walkthrough without `--add`). Each candidate shows its category, count, evidence and suggested aliases; one key decides it:

```text
$ lexicon harvest . --add
12 candidates [y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit

[1/12] pasture-notes  product, seen 3x
  evidence: package.json#name, README.md
  aliases:  pasture notes
  add? [y/n/e/c/a/q] y
  added pasture-notes

[2/12] Ashlr.AI  brand, seen 2x
  evidence: README.md
  aliases:  Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI, Ashlar AI
  add? [y/n/e/c/a/q] e
  aliases (comma-separated, replaces the suggestions) [Ashlr AI, Ashlr, Ashler, Ashlar, Ashler AI, Ashlar AI] Ashler, Ashlar, Ashley our AI
  aliases:  Ashler, Ashlar, Ashley our AI
  add? [y/n/e/c/a/q] y
  added Ashlr.AI

[3/12] Mason Wyatt  person, seen 40x
  evidence: git log
  aliases:  Mason Wiatt, Mason Wyat
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

If `Ashlr.AI` already exists (as a canonical or an alias) the heard form becomes one more alias of it; otherwise a new term is created with `source: learned` plus auto-suggested aliases. Recognized phrasings: "it's X not Y", "I said X not Y", "I meant X not Y", "not Y, X", "replace Y with X", "Y -> X" (also `=>` or `→`), "Y should be X", plus quoted forms. A phrase that names only the right spelling ("that should be X", "spelled X") is refused with a hint to run `lexicon learn <heard> X`. `--project` writes to `.lexicon.yaml`.

### Review what the hook queued

The hook never learns a correction itself. Besides asking the model to call `learn_correction`, it queues every correction it notices in `pending-aliases.yaml` next to the global lexicon. Nothing in that file changes matching until you accept it:

```bash
lexicon pending                          # list the queue (same as: lexicon pending list)
lexicon pending accept 8e411c5c          # learn one, as lexicon learn does
lexicon pending reject 8e411c5c          # drop it without learning
lexicon pending accept --all --dry-run   # show what would be learned; nothing is written
```

```text
2 pending aliases in ~/.config/lexicon/pending-aliases.yaml; none of them changes matching until accepted:
id        heard           meant       seen  last
--------  --------------  ----------  ----  ----------  -------------
8e411c5c  cooper netties  Kubernetes  1     2026-11-22
c828fd47  Ashlar          Ashlr.AI    1     2026-11-22  already known
```

- **Ids** are eight hex characters derived from the heard and meant spellings, so the same correction keeps the same id; `seen` counts how often it was noticed. Name several ids at once, or pass `--all`. An id the queue does not hold is reported on stderr and exits 1; naming none without `--all` is refused.
- **Skipped at queue time:** a correction the lexicon already resolves (Ashler when Ashler is already an alias of Ashlr.AI) and one you rejected before. A rejected id is remembered (the last 500) so the hook does not queue it again; `lexicon learn` still works for it.
- **`already known`** marks an entry learned some other way after it was queued (the model called `learn_correction`, or you ran `lexicon learn`). Accepting it adds nothing; accept or reject it to clear it from the queue.
- **Accept** goes through the same path as `lexicon learn` and prints the file it wrote. An entry that fails stays queued.
- The queue holds at most 200 entries (the least recently seen are dropped). `--json` on `pending`, `list`, `accept` and `reject` prints a JSON document for agents. `LEXICON_QUEUE_CORRECTIONS=0` in the hook's environment stops the queueing; the `learn_correction` prompt still appears.

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
