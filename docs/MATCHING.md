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
- A phonetic window of two or more words never starts or ends on a token with no word sound of its own: a bare numeral (`2`, `3.5`) or an abbreviation spelled out with periods (`i.e`, `a.m`). Confidence there is a ratio of letter counts, so such a token is free, and the window grew over it and then won on span length (`cooper netties i.e. Terraform` came out as `Kubernetes. Terraform`). The test is against the alias, not the window alone: when the term's own name carries one in the same place, the window covers it instead of swallowing it, so `clawd 4` still reaches `Claude 4` and `cooper netties 1` gives `Kubernetes 1` rather than `Kubernetes 1 1`. Phonetic pass only, so `b 2 b`, `auth 0` and `11 labs` still work as exact aliases.
- A trailing possessive is kept: `ashler ai's` becomes `Ashlr.AI's`.

**Explicit aliases always beat the stoplist.** If you list `off` as an alias for `auth`, "off" is rewritten. The stoplist exists to stop phonetic and fuzzy guessing, not to override what you wrote down. Use `never` if a term needs its own exceptions.

## Indented code blocks

Markdown's other code block, a run of lines indented past whatever contains them, is skipped along with fences and inline code, so a bug report that pastes its repro as an indented block keeps the repro. The rule is deliberately narrower than CommonMark, because the two ways of being wrong are not equal: a missed skip leaves a correction where you can see it, an over-eager one silently stops correcting your prose. A run is code only when all of these hold.

- A blank line is directly above it. Four spaces in the middle of a paragraph is a wrapped line.
- A non-blank line is above that. Text that simply begins with an indent is prose: what this reads is a clipboard paste, a dictated transcript or a prompt, not a document.
- It is indented four columns past its container, which is the block quote it sits in and the list item it hangs under. So the repro under `1. Run this:` or `> Run this:` is code, while a list item's indented continuation and a nested bullet are list content and are still corrected. Markers that open an item: `-`, `*`, `+`, `1.`, `1)`, `a.`, `a)`, `iv.`, `IV)`.
- At least one of its lines is not itself a list item or a table row, since a run of nothing but bullets is a list someone indented. The whole run decides that together, so the answer never depends on which line happens to come first.

It ends at the first non-blank line indented less than that; a blank line inside it does not end it. Still corrected, and known to be: a run hanging under a table row, and one whose block quote depth differs from the line above it.

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
