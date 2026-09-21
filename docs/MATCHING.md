# How matching works

What the matcher does to a sentence, and why it so rarely touches ordinary prose. Read this before tuning `minConfidence` or reporting a false positive.

Matching runs in three tiers over token windows. Exact hits are resolved first (longest span, earliest start); phonetic and fuzzy hits only get the spans left over, and matches never overlap.

1. **Exact alias.** Word-boundary, multi-word, case-insensitive and diacritic-insensitive (`bjorn halvorsen` hits `Bjørn Halvorsen`) unless the term sets `caseSensitive`. Confidence 1.0, except for a boundary the matcher invented (below), which is 0.95.
2. **Phonetic.** Double metaphone of a token window equals that of an alias or the canonical. Confidence about 0.9, scaled by length similarity.
3. **Fuzzy.** Normalized Damerau-Levenshtein (adjacent-transposition-aware) similarity at or above `minConfidence`. Confidence equals the similarity.

## Guards

Checked before any replacement:

- The built-in stoplist of about 3400 common English words in their usual inflections, plus `settings.protectedWords`, plus each term's `never`.
- Spans already equal to the canonical. They are also claimed, so no other term can rewrite a word inside `Tadeusz Wróblewski` or `Wispr Flow's`.
- Text inside code spans, fences, URLs, emails and paths when `skipCode` is on, and names glued to an identifier (`@ashlr/lexicon`, `ashlr_core`, `#ashlr`) in every mode.
- Tokens shorter than three characters, and metaphone keys shorter than three characters (`Zod`, `SSO`, `Neon`, `SaaS`), are only ever matched by exact alias. Spelled-out aliases such as `j w t` never get a phonetic key.
- A phonetic or fuzzy window of two or more words never starts or ends on a function word (`to`, `is`, `a`, `the`), so `normalizeTranscript to` cannot swallow the `to`.
- A lone word matched against a term that has explicit aliases must score at least 0.88. In the phonetic pass that bar applies whatever the case (`Inter` is held to it as much as `inter`), and the candidate must also resemble the alias in spelling; in the fuzzy pass only an all-lowercase word (`prism`, `email`, `gram`, and a hyphenated compound such as `per-category`) is held to it. A term with no aliases is not held to it at all: see below.
- A phonetic window of two or more words never starts or ends on a token with no word sound of its own: a bare numeral (`2`, `3.5`) or an abbreviation spelled out with periods (`i.e`, `a.m`). Confidence there is a ratio of letter counts, so such a token is free, and the window grew over it and then won on span length (`cooper netties i.e. Terraform` came out as `Kubernetes. Terraform`). The test is against the alias, not the window alone: when the term's own name carries one in the same place, the window covers it instead of swallowing it, so `clawd 4` still reaches `Claude 4` and `cooper netties 1` gives `Kubernetes 1` rather than `Kubernetes 1 1`. Phonetic pass only, so `b 2 b`, `auth 0` and `11 labs` still work as exact aliases.
- A trailing possessive is kept: `ashler ai's` becomes `Ashlr.AI's`.
- An implicit alias that had to invent a word boundary scores 0.95, not 1.0, and has to clear `minConfidence` like anything else. See below.

## Boundaries the matcher invented

The exact pass strips every separator before comparing, which is why `ashlrai`, `ashlr ai`, `ashlr-ai` and `Ashlr.AI` all reach the same term. The same stripping means a window can match by breaking a word the canonical never breaks: `lexicon file` reaches `LexiconFile`, `open ai` reaches `OpenAI`, `tail wind` reaches `Tailwind`. The split is read off a case hump, which is a convention of written code and not a sound anyone makes.

Those two claims are not alike, so they no longer score alike.

- The window breaks where the canonical's own spelling breaks, or joins where it separates: `ashlr ai` and `ashlrai` for `Ashlr.AI`, `next js` and `nextjs` for `Next.js`, `wispr flow` and `wisprflow` for `Wispr Flow`, `vertex ai` and `vertexai` for `Vertex AI`. Only punctuation differs. Confidence stays 1.0.
- The window breaks where the canonical has no separator at all: `lexicon file` for `LexiconFile`, `open ai` for `OpenAI`. Confidence 0.95, and `minConfidence` can now refuse it. This is the only place `minConfidence` reaches the exact pass.

An alias you listed yourself is exempt, for the same reason it beats the stoplist: you wrote the string down, so it is not a guess.

Set `minConfidence` above 0.95 to turn invented boundaries off. Nothing else in the exact pass moves, because nothing else scores below 1.0.

**This is a score, not a verdict.** It does not decide that `the lexicon file` is English and `lexicon store` is a symbol. Those two sentences are the same shape, and the stoplist, the casing and the category say the same thing about both: `lexicon` is absent from the stoplist while `file` and `store` are both in it, neither phrase is capitalised, and both terms are `category: identifier`. A guard that refuses one refuses the other, and the benchmark asks for `lexicon store` by name. What decides it is whether `LexiconFile` belongs in your lexicon at all, which is `lexicon harvest`'s problem and yours, not the matcher's. If a term of yours reads as ordinary English, give it a `never` list or drop it.

**Explicit aliases always beat the stoplist.** If you list `off` as an alias for `auth`, "off" is rewritten. The stoplist exists to stop phonetic and fuzzy guessing, not to override what you wrote down. Use `never` if a term needs its own exceptions.

**The stoplist does not catch a word pair either.** It blocks a window only when *every* token is on the list, so `set up` -> `SetUp` and `check list` -> `CheckList` are refused while `tail wind` -> `Tailwind` and `open claw` -> `OpenClaw` are not: `wind` and `open` are on the list, `tail` and `claw` are not. Adding the missing halves was measured and is not the fix. It costs term recall 96.5% to 96.2% for precision 93.8% to 94.1% (F1 unchanged at 95.1%), because "tail wind's docs say this should just work" is the same shape as the sentence it fixes; and it does not reach the class, since `lexicon file` -> `LexiconFile` escapes on `lexicon`, a word no list of ordinary English can hold. The 0.95 score above is the lever for this class, and `minConfidence` is how you pull it.

## The 0.88 bar is off for a term with no aliases

The lone-word bar above is conditioned on the term having explicit aliases, on the reasoning that the inexact passes are then a fallback rather than the only way in. `lexicon harvest` and `lexicon add <Canonical>` both write `aliases: []`, so for every term either one proposes the bar is off and a lone word is held only to `minConfidence`.

Applying it to every term regardless was measured and is not taken: term recall 96.5% to 93.6%, sentence accuracy on positives 94.2% to 91.4%, F1 95.1% to 93.8%, for a precision move of 93.8% to 93.9%. Restricting it to one pass is cheaper and still a loss (recall 95.8% either way). Nine positives go for one false positive, and every one of the nine is a term with no aliases: `doker` -> Docker, `olama` -> Ollama, `wisper` -> Whisper, `kubernetties` -> Kubernetes, `tailwin` -> Tailwind, `playwrite` -> Playwright, `metafone` -> Metaphone. The prose false-positive rate excluding expected-hard is 0.0% before and after, so nothing in the measurement asks for the change.

What the bar means, then, is "this term has another way in, so make the guess earn it" rather than "a lone word is suspicious". If a term of yours is being reached by a guess you do not want, list its aliases, raise `minConfidence`, or give it a `never` list.

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
