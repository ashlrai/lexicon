# How matching works

What the matcher does to a sentence, and why it so rarely touches ordinary prose. Read this before tuning `minConfidence` or reporting a false positive.

Matching runs in three tiers over token windows. Exact hits are resolved first (longest span, earliest start); phonetic and fuzzy hits only get the spans left over, and matches never overlap.

1. **Exact alias.** Word-boundary, multi-word, case-insensitive and diacritic-insensitive (`bjorn halvorsen` hits `Bjørn Halvorsen`) unless the term sets `caseSensitive`. Confidence 1.0.
2. **Phonetic.** Double metaphone of a token window equals that of an alias or the canonical. Confidence about 0.9, scaled by length similarity.
3. **Fuzzy.** Normalized Damerau-Levenshtein (adjacent-transposition-aware) similarity at or above `minConfidence`. Confidence equals the similarity.

## Guards

Checked before any replacement:

- The built-in stoplist of about 3400 common English words in their usual inflections, plus `settings.protectedWords`, plus each term's `never`.
- Spans already equal to the canonical. They are also claimed, so no other term can rewrite a word inside `Tadeusz Wróblewski` or `Wispr Flow's`.
- Text inside code spans, fences, URLs, emails and paths when `skipCode` is on, and names glued to an identifier (`@ashlr/lexicon`, `ashlr_core`, `#ashlr`) in every mode.
- Tokens shorter than three characters, and metaphone keys shorter than three characters (`Zod`, `SSO`, `Neon`, `SaaS`), are only ever matched by exact alias. Spelled-out aliases such as `j w t` never get a phonetic key.
- A phonetic or fuzzy window of two or more words never starts or ends on a function word (`to`, `is`, `a`, `the`), so `normalizeTranscript to` cannot swallow the `to`.
- A lone word matched against a term that has explicit aliases must score at least 0.88. In the phonetic pass that bar applies whatever the case (`Inter` is held to it as much as `inter`), and the candidate must also resemble the alias in spelling; in the fuzzy pass only an all-lowercase token (`prism`, `email`, `gram`) is held to it.
- A trailing possessive is kept: `ashler ai's` becomes `Ashlr.AI's`.

**Explicit aliases always beat the stoplist.** If you list `off` as an alias for `auth`, "off" is rewritten. The stoplist exists to stop phonetic and fuzzy guessing, not to override what you wrote down. Use `never` if a term needs its own exceptions.

## Seeing what it did

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

`--diff` goes to stderr so stdout stays pipeable. `--min-confidence 0.9`, `--no-phonetic` and `--no-fuzzy` override the file settings for one run. If the lexicon fails to load, `normalize` prints the reason to stderr, passes the text through stdout byte-exactly so a pipeline never loses input, and exits 1. The exit code is the only channel left: without it "no corrections were applied" and "nothing needed correcting" look identical.

The three tiers are colour-coded in the [live demo](https://ashlrai.github.io/lexicon/), which runs this same matcher in your browser.

## See also

- [BENCHMARK.md](BENCHMARK.md) measures how well the tiers and guards actually do, and where they fail.
- [RESEARCH.md](RESEARCH.md) explains why accuracy on proper nouns is the thing worth measuring.
- [CONTRACT.md](CONTRACT.md) has the matcher's exact signatures and every tuning constant.

Back to [the docs index](README.md).
