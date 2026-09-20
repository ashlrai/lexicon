# Suggestions: what the lexicon should learn next

`lexicon suggest` reads the voice history that `lexicon voice` keeps
(`<config dir>/voice/history.jsonl`, one `{ raw, output }` pair per dictation,
capped at 1000 lines) and the lexicon itself, and proposes the edits that
would have made the last few weeks of transcripts come out right. Nothing is
written unless you say so. The same engine backs the `suggest_terms` MCP tool,
so an agent can run the routine for you.

```
$ lexicon suggest
kind   canonical       alias   count  confidence  reason
-----  --------------  ------  -----  ----------  ------------------------------------------------------------------
alias  Vercel          versal  3      0.90        the matcher would guess this as Vercel (3 times in history); make it an exact alias
term   Siobhan Reilly          3      0.65        capitalized name seen 3 times in transcripts and not in the lexicon
alias  Ashlr.AI        ashlur  2      0.78        "ashlur" was left uncorrected 2 times and sounds like Ashlr.AI
never  Locus           lacks   1      0.55        ordinary word rewritten by guess 1 time under earlier rules
stale  Zebrafish Labs          0      0.30        never matched in 110 days
5 suggestions. `lexicon suggest --apply` walks them; `--yes` applies those at or above 0.80.
```

## The four kinds

### alias: a spelling STT produces for a term you already have

Three signals feed it.

- **Left uncorrected.** A one-to-three word stretch of a raw transcript that
  survived into the output unchanged, sounds like an existing term (same
  double-metaphone key, or edit similarity of 0.7 or more against the
  canonical or one of its aliases) and came back at least twice. The matcher
  did not dare to rewrite it; you can. `"ashlur" was left uncorrected 2 times
  and sounds like Ashlr.AI`.
- **Corrected by guess.** The matcher fixed it, but only through the phonetic
  or fuzzy pass, three times or more. An explicit alias is exact (confidence
  1), cheaper, and immune to the guards the inexact passes have to apply.
  `the matcher would guess this as Vercel (3 times in history); make it an
  exact alias`. These start at 0.80, so
  `--yes` picks them up.
- **Rewritten under earlier rules.** The recorded output shows a rewrite to
  a canonical that the current matcher no longer makes (the rules got
  stricter, or the term lost an alias). Capped at 0.75: some of those old
  rewrites were the false positives the stricter rules were meant to stop,
  so a human looks first.

Ordinary words (the built-in stoplist, function words) are never proposed as
aliases; that is what `never` is for.

Applying adds the alias to the term's own file (`addTerm`, merge).

### term: a name that is not in the lexicon yet

A capitalized or CamelCase word, or a run of them (`Siobhan Reilly`), that
appears in the corrected output of three or more dictations and is not a
lexicon spelling, not a word of an existing multi-word canonical, not a
common word, and does not merely sound like a term you already have (that
would be an alias). A lone capitalized word at the start of a sentence does
not count. The suggestion carries `aliases` from `suggestAliases()` so the
new term starts with the misspellings STT is likely to produce.

With `--harvest [dir]` (or an explicit `--cwd`) the top ten repository
harvest candidates seen five times or more join the list, with the
harvester's aliases and category. They never exceed 0.70 confidence: repo
identifiers are review material, and `lexicon harvest --add` exists for
bulk imports.

Applying creates the term in the global file (`--project` for the project
`.lexicon.yaml`) with `source: learned`.

### never: an ordinary word that got rewritten

A rewrite in the history whose original is a single everyday word
(`lacks` -> `Locus`) made by a phonetic or fuzzy guess, not by an alias you
listed. Confidence 0.70 when the current matcher would still do it, 0.50 to
0.65 when only an older version did. Applying adds the word to that term's
`never` list, which blocks every inexact pass for that pair from then on.

### stale: a term that never earned its keep

Older than 30 days, zero hits, and none of its spellings (canonical or
aliases) ever occur in the history. Confidence is a flat 0.30: the term may
simply belong to a project you have not dictated about lately. Applying
removes it; in `--apply` the default answer for a stale term is `n`, and
`a` (apply all remaining) skips them, so a removal always takes a deliberate
`y`.

## Ranking and confidence

Suggestions are ranked by `confidence * log(1 + count)`: a 0.78 seen twice
sorts below a 0.65 seen four times. Duplicates (same kind, canonical and
alias) merge into one row with the larger count and the stronger reason.
`--limit` caps the list (default 20).

`0.80` is the line for unattended use. `--yes` (and any agent applying
suggestions on its own) takes everything at or above it: promoted guesses,
well-attested uncorrected garbles and names seen five or more times. Harvest
candidates and stale removals never reach it.

## The weekly routine

1. Dictate as usual. `lexicon voice` appends every transcription to the
   history; the hook and the clipboard daemon record hits.
2. Once a week, in a terminal:

   ```
   lexicon suggest --apply
   ```

   Read each card (kind, confidence, how often, up to three evidence lines
   from your own transcripts), answer `y`, `n`, `a` for the rest, or `q`.
   Inside a repository add `--harvest` to pick up its names too.
3. In a hurry: `lexicon suggest --yes` applies the safe ones and tells you
   how many are left for a proper review.
4. `lexicon stats` afterwards shows the new aliases starting to score hits.
   Terms that keep showing up as stale are candidates for `lexicon review
   --never-hit`.

`lexicon suggest --json` prints the same list as JSON (`TermSuggestion[]`,
see `CONTRACT.md` in this directory) for scripts and for the MCP tool.

## Privacy

Everything runs locally over your own history file. Evidence snippets are
trimmed to 120 characters and stripped of control characters before they are
printed, so a hostile line in the history cannot recolour your terminal.
Nothing leaves the machine.

## See also

- [GROWING.md](GROWING.md) — the other ways terms get in, and where suggestions sit among them.
- [VOICE.md](VOICE.md) — the command that writes the history this reads.
- [MATCHING.md](MATCHING.md) — the scoring these suggestions are trying to improve.
