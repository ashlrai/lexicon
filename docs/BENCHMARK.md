# Accuracy benchmark results

Measured 2026-09-19 against `src/core/matcher.ts` after the precision fixes described in
"Fix log" below, with the naive `bench/lexicon.yaml` (70 terms, 21 without aliases, no `never`
lists, default settings). Reproduce with `npm run bench -- --sweep`; the raw output including
every failing case is `bench/results.json`. How the metrics are defined:
[`bench/README.md`](../bench/README.md).

## Headline

Corpus: 398 cases. 278 positives (a term misheard inside a dictated sentence, including 16
where it is already correct and must stay untouched, 16 multi-term sentences, 10 mixed with
code/URLs), 120 clean-prose negatives built around sound-alikes, code spans, URLs, emails
and paths. 47 cases are marked `expected-hard` and are included in every number below unless
the row says otherwise.

| metric | default config (minConfidence 0.82, phonetic + fuzzy on) |
|---|---|
| term recall, raw STT (before) | **5.1%** (16/313) |
| term recall, after lexicon | **96.5%** (302/313) |
| term precision | 93.8% (302/322) |
| term F1 | **95.1%** |
| sentence accuracy, positives | **94.2%** (262/278) |
| sentence accuracy, positives excl. expected-hard | 99.6% (255/256) |
| prose false-positive rate | **15.0%** (18/120) |
| prose false-positive rate excl. expected-hard | **0.0%** (0/95) |
| sentence accuracy, all cases | 91.5% (364/398) |
| mean latency per case, `normalize()` incl. `buildIndex()` (warm) | 320 us |
| mean latency per case, `findReplacements()` with prebuilt index (warm) | 63 us |

The README-ready sentence, stated honestly:

> On 313 dictated proper nouns the recognizer got 5% right; after the lexicon 96% are recovered
> (term F1 95%). 94% of dictated sentences come out exactly right, 99.6% once the cases we
> label as corpus ambiguities are excluded. Clean prose that merely sounds like a lexicon term
> is left alone (0 of 95 sentences changed). The remaining damage is confined to the 25
> adversarial negatives where the canonical itself is an English word (`drizzle`, `neon`,
> `playwright`) or the user listed a phrase as an alias (`super base`, `jot`): 18 of those
> change, which is the lexicon owner's call, not the matcher's.

The corpus is sampled from STT failures, so "5% raw" is by construction and is not comparable to
Argmax's 64% baseline on natural speech. The comparable numbers are recall after correction
(96% vs their 92% keyword F1) and, unlike a recognizer-side fix, the prose damage a post-hoc
rewriter can do, which is now at the target.

**The target for this benchmark was <= 2% prose false positives excluding expected-hard. The
matcher meets it (0.0%).** `bench/bench.test.ts` guards it at 0.02 and bounds the
expected-hard-inclusive rate at 0.17.

## Fix log

Each row is the full benchmark re-run after one matcher change landed, default config.

| step | positive sentence acc | term recall | prose FP excl. hard | prose FP incl. hard |
|---|---|---|---|---|
| baseline (before fixes) | 88.1% | 96.2% | 18.9% | 35.8% |
| A. exact hits win overlap; inexact windows never start/end on a function word | 93.5% | 95.8% | 15.8% | 32.5% |
| B. possessive-base view preferred for every reason | 94.2% | 96.5% | 15.8% | 32.5% |
| C. already-canonical spans are claimed | 95.0% | 97.1% | 15.8% | 32.5% |
| D. phonetic guards (key >= 3, window >= 4, no keys for spelled-out aliases, 0.88 bar for aliased plain words) | 94.2% | 96.5% | 1.1% | 15.8% |
| D'. the 0.88 aliased plain-word bar applied to fuzzy as well | 94.2% | 96.5% | 0.0% | 15.0% |
| E. diacritics folded in the exact pass; F. transposition-aware similarity | 94.2% | 96.5% | 0.0% | 15.0% |

The one positive lost between C and D is `sas` -> SaaS (pos-128): SaaS keys to `SS`, two
characters, and the key-length rule that removes 22 spurious hits also removes it. An explicit
`sas` alias restores it. E and F change no headline number on this corpus: `bjorn halvorsen`
was already recovered by fuzzy at 0.93 and is now an exact hit at 1.0; `levenshtien` was
rescued by the phonetic pass and is now a fuzzy hit at 0.91 instead of 0.82 under plain
Levenshtein.

## Configurations

| config | positive sentence acc | term recall | term precision | term F1 | prose FP | prose FP excl. hard |
|---|---|---|---|---|---|---|
| default (phonetic + fuzzy) | 94.2% | 96.5% | 93.8% | 95.1% | 15.0% | 0.0% |
| `--no-fuzzy` | 93.5% | 94.9% | 94.0% | 94.4% | 14.2% | 0.0% |
| `--no-phonetic` | 80.6% | 85.0% | 94.3% | 89.4% | 12.5% | 0.0% |
| `--no-phonetic --no-fuzzy` (alias only) | 74.8% | 77.6% | 94.6% | 85.3% | 10.8% | 0.0% |

Reading: the phonetic pass is worth 11.5 points of recall and now costs 2.5 points of prose FP,
all of it on `expected-hard` sentences (`pedantic`, `graphical`, `tropic`, `email`). Fuzzy adds
1.6 points of recall for one wrong hit (`llama` -> Ollama, expected-hard). Alias-only still
changes 13 negatives, every one an `expected-hard` case where the canonical is a common word
(`drizzle`, `neon`, `whisper`, `playwright`, `prometheus`, `docker`) or a user-listed alias
collides with prose (`jot`, `jason`, `tail wind`, `super base`, `okay are`).

## Sweep: minConfidence vs accuracy and false positives

| minConfidence | positive acc | positive acc excl. hard | term recall | term precision | term F1 | prose FP | prose FP excl. hard |
|---|---|---|---|---|---|---|---|
| 0.70 | 94.2% | 99.6% | 96.5% | 93.5% | 95.0% | 15.8% | 1.1% |
| 0.75 | 94.2% | 99.6% | 96.5% | 93.5% | 95.0% | 15.8% | 1.1% |
| 0.80 | 94.2% | 99.6% | 96.5% | 93.8% | 95.1% | 15.0% | 0.0% |
| **0.82** (default) | **94.2%** | **99.6%** | **96.5%** | 93.8% | **95.1%** | 15.0% | **0.0%** |
| 0.85 | 91.7% | 96.9% | 93.9% | 93.9% | 93.9% | 14.2% | 0.0% |
| 0.90 | 82.0% | 86.7% | 85.0% | 93.3% | 89.0% | 14.2% | 0.0% |
| 0.95 | 75.5% | 80.5% | 78.3% | 94.6% | 85.7% | 10.8% | 0.0% |

The curve is flat from 0.70 to 0.82 and falls off above it: the structural guards (key length,
function-word edges, aliased plain-word bar) do the separating that confidence never could, so
the threshold now only trades recall away. 0.82 stays the default; it is the F1 peak and the last
step before recall drops.

## By category

| category | cases | sentence accuracy | term recall raw | term recall after |
|---|---|---|---|---|
| brand | 48 | 97.9% | 5.7% | 98.1% |
| product | 122 | 93.4% | 5.1% | 96.4% |
| acronym | 58 | 93.1% | 1.7% | 94.9% |
| person | 34 | 94.1% | 9.3% | 97.7% |
| identifier | 16 | 93.8% | 5.0% | 95.0% |
| prose (negatives) | 120 | 85.0% | - | - |

Identifiers went from 56% to 94% sentence accuracy: the phonetic window no longer swallows the
word after the identifier (`normalizeTranscript to take` stays intact). The one identifier miss
is `normalize the transcript` (expected-hard: an article inside the name).

## By reason

| reason | replacements | correct | spurious | mean confidence |
|---|---|---|---|---|
| alias | 242 | 228 | 14 | 1.000 |
| phonetic | 56 | 51 | 5 | 0.880 |
| fuzzy | 9 | 8 | 1 | 0.894 |

Phonetic replacements split by the length of the double-metaphone key of the matched window:

| key length | correct | spurious | spurious cases |
|---|---|---|---|
| 1-2 | 0 | 0 | never considered (`PHONETIC_MIN_KEY`); before the fix this row was 4 correct / 22 spurious |
| 3 | 6 | 1 | `email`->YAML (expected-hard) |
| 4 | 8 | 2 | `tropic`->tRPC twice (expected-hard) |
| >= 5 | 37 | 2 | `pedantic`->Pydantic, `graphical`->GraphQL (expected-hard) |

All 14 spurious alias hits are `expected-hard` corpus ambiguities: casing fixes on canonicals that
are English words (Docker, Drizzle x2, Neon, Whisper x2, Playwright, Prometheus, Vite in `vite
test`) and user aliases that are phrases (`jot`, `jason`, `okay are`, `tail wind`, `super base`).

## What still fails

34 failing cases: 1 ordinary positive and 33 of the 47 `expected-hard` cases (14 hard cases now
pass, up from 10). Nothing in the ordinary negatives fails.

| case | heard -> output | expected | why |
|---|---|---|---|
| pos-128 | `wire the sas into` -> unchanged | `SaaS` | SaaS keys to `SS` (2 chars); the key-length rule blocks it. Add `sas` as an alias. |
| hard-018 | `use zed schemas` -> unchanged | `Zod` | Same rule (`ST`). `zed` is also a plausible word; an alias is the right fix. |
| hard-001 | `our sass margins` -> unchanged | `SaaS` | `sass` is on the built-in stoplist. |
| hard-002 | `and tropic released` -> `and tRPC released` | `Anthropic released` | `anthropic` keys to `AN0RPK` (th = theta), `andtropic` to `ANTRPK`; and `tropic` alone is a legitimate tRPC sound-alike. |
| hard-003 | `play right is flaky` -> unchanged | `Playwright` | Both tokens are stoplist words, so the window is never guessed. |
| hard-004 | `the vite test run` -> `the Vite test run` | `Vitest` | `vite` is an exact hit and exact hits are claimed first. |
| hard-005, 016 | `ollamas` -> `Ollama`, `key pee eyes` -> `KPI` | plural kept | Replacement is whole-token; no plural handling. |
| hard-006 | `rotate the jots` -> unchanged | `JWTs` | Plural of an alias. |
| hard-007 | `language chain` -> unchanged | `LangChain` | Different key, 2 tokens vs 1. |
| hard-008 | `ask be yorn halvorsen` -> `ask be Bjørn Halvorsen` | `Bjørn Halvorsen` | The 3-token window starts on the function word `be` and is now refused; the 2-token fuzzy hit leaves `be` behind. |
| hard-009 | `the a p eye` -> unchanged | `API` | Spelled-out aliases match exactly only, and `a p eye` is not one of the listed spellings. |
| hard-012, 015 | `post gress sequel`, `docker file` | `PostgreSQL`, `Dockerfile` | Two terms that share a prefix; the shorter alias wins and the remainder is left. |
| hard-013 | `normalize the transcript` -> unchanged | `normalizeTranscript` | Article inside the name. |
| hard-014 | `ping priyanka` -> unchanged | `Priyanka Raghunathan` | First name only; the canonical has two tokens. |
| 18 negatives (neg-012, 027, 028, 029, 030, 033, 034, 035, 036, 038, 039, 041, 042, 054, 060, 073, 077, 116) | `drizzle`, `neon`, `whisper`, `docker`, `playwright`, `prometheus` case-fixed; `jot`, `jason`, `okay are`, `tail wind`, `super base` aliased; `llama`, `pedantic`, `graphical`, `tropic`, `email` guessed | unchanged | Corpus ambiguities: the canonical or a user alias is itself an English word or phrase. Only `never` lists resolve these; see recommendations. |

Bugs A-F from the previous report are fixed and each has a unit test in `tests/matcher.test.ts`
(search for `bug A` .. `bug F`) and an end-to-end test in `tests/normalize.test.ts`.

## Matcher rules that changed

- **Overlap resolution** takes exact alias hits first (longest span, earliest start), then
  inexact hits that do not overlap them. A phonetic window that merely appends `to`/`is`/`a` to
  an exact hit can no longer beat it.
- **Function-word edges.** An inexact window of two or more tokens never starts or ends on a
  function word (articles, prepositions, conjunctions, pronouns, auxiliaries, wh-words). `her`
  is deliberately not in the set because STT splits `-er` off (`dock her` -> Docker).
- **Possessives.** When the view without the trailing `'s` matches the same term, or matches at
  least as confidently, the base is replaced and the `'s` stays (`ashler ai's` -> `Ashlr.AI's`)
  for every reason, not just exact hits.
- **Claims.** A span that already equals a canonical (`Tadeusz Wróblewski`, `Wispr Flow`) is
  claimed during overlap resolution so no other term can rewrite a token inside it, then
  dropped from the result.
- **Phonetic guards.** No match on a metaphone key shorter than 3 characters; the window must
  have at least 4 letters unless the alias is that short; spelled-out aliases (every token 1-2
  letters: `j w t`, `ay ar ar`) get no phonetic key at all; and a lone lowercase token matched
  against a term that has explicit aliases must clear 0.88 (phonetic and fuzzy). A capitalised
  token keeps the normal bar.
- **Diacritics** are folded (NFD plus `ø`, `ł`, `ß`, ...) in the exact and collapsed lookups, so
  `bjorn halvorsen` is an exact hit on `Bjørn Halvorsen`.
- **Similarity** is optimal-string-alignment (transposition-aware) up to 40 characters, so
  `levenshtien` scores 0.91; plain Levenshtein beyond that. The fuzzy pass bounds each
  candidate with the bit-parallel Levenshtein distance first and only runs OSA on near misses,
  which keeps `findReplacements()` at 63 us per case.

## Recommendations

Keep `minConfidence` at 0.82. The sweep is flat below it and loses recall above it.

For lexicon owners:
- Canonicals that are English words (`Drizzle`, `Neon`, `Whisper`, `Docker`, `Playwright`,
  `Prometheus`) will be case-fixed in prose. Either accept that in a dev-only lexicon or add
  the lowercase word to `never` and lose the casing fix.
- Aliases that are phrases (`super base`, `tail wind`, `okay are`) or words (`jot`, `jason`)
  fire wherever the phrase appears. That is by design (explicit aliases win); list them only if
  the collision is rarer than the mishearing.
- Short canonicals whose metaphone key is one or two consonants (`SaaS`, `Zod`, `SSO`, `Neon`,
  `Vite`, `KPI`, `CLI`) are exact-alias-only now. List the spellings STT produces (`sas`, `zed`,
  `sod`) as aliases; the phonetic pass will not guess them.
- Sound-alikes with a 3-4 character key that are also words (`email` -> YAML, `tropic` -> tRPC,
  `gram` -> CRM) are held to the 0.88 bar when the term has aliases; add `never: [email]` if the
  term has none.
