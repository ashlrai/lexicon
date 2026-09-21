# Accuracy benchmark results

The accuracy numbers behind every claim in the README, with the method, the corpora and every case that still fails. For anyone deciding whether to trust the matcher, or changing it.

Measured 2026-09-19 against `src/core/matcher.ts` after the precision fixes described in
"Fix log" below, with the naive `bench/lexicon.yaml` (70 terms, 21 without aliases, no `never`
lists, default settings). Reproduce with `npm run bench -- --sweep`; the raw output including
every failing case is `bench/results.json`. How the metrics are defined:
[`bench/README.md`](../bench/README.md).

## Reproducing every number on this page

Nothing here is hand-copied from a run we no longer have. Each command below regenerates the
section next to it, and the first one needs nothing but a clone and `npm ci`.

| command | regenerates | needs |
|---|---|---|
| `npm run bench` | ["Headline"](#headline), ["By category"](#by-category), ["By reason"](#by-reason), and `bench/results.json` | Node 20+. Nothing else. |
| `npm run bench -- --sweep` | ["Sweep: minConfidence vs accuracy and false positives"](#sweep-minconfidence-vs-accuracy-and-false-positives) | Node 20+. |
| `npm run bench -- --verbose` | the list of failing cases behind ["What still fails"](#what-still-fails) | Node 20+. |
| `npm run bench:audio` | ["Real audio"](#real-audio-macos-tts---whispercpp) and `bench/audio/results.md` | macOS (`say`), whisper.cpp (`brew install whisper-cpp`). Downloads 636 MB of models on first run; about six minutes cold, seconds warm. |
| `npm run bench:compare` | ["Against the alternatives"](#against-the-alternatives) | One `npm run bench:audio` first, to fill the transcript cache. |
| `npm test` | the test count quoted in the docs | Node 20+. |

Two notes on honesty, because they change how the numbers should be read:

- `bench/audio/out/` and `bench/audio/models/` are gitignored, so `npm run bench:compare` cannot
  run straight from a clone: it re-scores the cached transcripts that `npm run bench:audio`
  produces and will tell you so if they are missing. That is deliberate. Re-scoring a fixed set
  of transcripts is what makes the comparison a controlled experiment rather than five separate
  recognizer runs.
- `bench/results.json` and `bench/audio/results.md` are committed, so you can diff your run
  against ours without running anything. If they disagree, ours is wrong.

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
| term precision | 95.0% (302/318) |
| term F1 | **95.7%** |
| sentence accuracy, positives | **94.2%** (262/278) |
| sentence accuracy, positives excl. expected-hard | 99.6% (255/256) |
| prose false-positive rate | **12.5%** (15/120) |
| prose false-positive rate excl. expected-hard | **0.0%** (0/95) |
| sentence accuracy, all cases | 92.2% (367/398) |
| mean latency per case, `normalize()` incl. `buildIndex()` (warm) | about 290 us |
| mean latency per case, `findReplacements()` with prebuilt index (warm) | about 55 us |

The README-ready sentence, stated honestly:

> On 313 dictated proper nouns the recognizer got 5% right; after the lexicon 96% are recovered
> (term F1 96%). 94% of dictated sentences come out exactly right, 99.6% once the cases we
> label as corpus ambiguities are excluded. Clean prose that merely sounds like a lexicon term
> is left alone (0 of 95 sentences changed). The remaining damage is confined to the 25
> adversarial negatives where the canonical itself is an English word (`drizzle`, `neon`,
> `playwright`) or the user listed a phrase as an alias (`super base`, `jot`): 15 of those
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
| G and H. 0.88 bar applied case-blind; initial-vowel guard; similarity floors tiered by key length; glue guard for `@`, `/` and `_`; mostly-stopword windows refused; stoplist additions, which is where `graphical` and `tropic` went | 94.2% | 96.5% | 0.0% | 12.5% |
| I. rewrites declined when they would collapse a sentence that quotes two spellings | 94.2% | 96.5% | 0.0% | 12.5% |

The one positive lost between C and D is `sas` -> SaaS (pos-128): SaaS keys to `SS`, two
characters, and the key-length rule that removes 22 spurious hits also removes it. An explicit
`sas` alias restores it. E and F change no headline number on this corpus: `bjorn halvorsen`
was already recovered by fuzzy at 0.93 and is now an exact hit at 1.0; `levenshtien` was
rescued by the phonetic pass and is now a fuzzy hit at 0.91 instead of 0.82 under plain
Levenshtein.

G and H share a row because they landed together and the benchmark was run once across both.
I moves nothing, which is the point of it: it only declines rewrites in sentences that are
quoting a misspelling rather than committing one, and this corpus contains none. Its effect on
the real-audio corpus is nil too, verified by running that benchmark with the guard bypassed
and diffing the report.

## Configurations

| config | positive sentence acc | term recall | term precision | term F1 | prose FP | prose FP excl. hard |
|---|---|---|---|---|---|---|
| default (phonetic + fuzzy) | 94.2% | 96.5% | 95.0% | 95.7% | 12.5% | 0.0% |
| `--no-fuzzy` | 93.5% | 94.9% | 95.2% | 95.0% | 11.7% | 0.0% |
| `--no-phonetic` | 80.6% | 85.0% | 94.3% | 89.4% | 12.5% | 0.0% |
| `--no-phonetic --no-fuzzy` (alias only) | 74.8% | 77.6% | 94.6% | 85.3% | 10.8% | 0.0% |

Reading: the phonetic pass is worth 11.5 points of recall and, since the step G guards landed,
costs nothing in prose false positives. It used to cost 2.5 points, all of it on `expected-hard`
sentences (`pedantic`, `graphical`, `tropic`, `email`), and those are the cases the guards
close. Fuzzy adds 1.6 points of recall for 0.8 points of prose FP, a single wrong hit
(`llama` -> Ollama, expected-hard). Alias-only still
changes 13 negatives, every one an `expected-hard` case where the canonical is a common word
(`drizzle`, `neon`, `whisper`, `playwright`, `prometheus`, `docker`) or a user-listed alias
collides with prose (`jot`, `jason`, `tail wind`, `super base`, `okay are`).

## Sweep: minConfidence vs accuracy and false positives

| minConfidence | positive acc | positive acc excl. hard | term recall | term precision | term F1 | prose FP | prose FP excl. hard |
|---|---|---|---|---|---|---|---|
| 0.70 | 94.2% | 99.6% | 96.5% | 94.7% | 95.6% | 13.3% | 1.1% |
| 0.75 | 94.2% | 99.6% | 96.5% | 94.7% | 95.6% | 13.3% | 1.1% |
| 0.80 | 94.2% | 99.6% | 96.5% | 95.0% | 95.7% | 12.5% | 0.0% |
| **0.82** (default) | **94.2%** | **99.6%** | **96.5%** | 95.0% | **95.7%** | 12.5% | **0.0%** |
| 0.85 | 91.7% | 96.9% | 93.9% | 95.1% | 94.5% | 11.7% | 0.0% |
| 0.90 | 82.0% | 86.7% | 85.0% | 94.7% | 89.6% | 11.7% | 0.0% |
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

31 failing cases: 1 ordinary positive and 30 of the 47 `expected-hard` cases (17 hard cases now
pass, up from 10). Nothing in the ordinary negatives fails. Fix G below (a production false
positive, `Inter` the font -> Entire.io) changed no headline number except the expected-hard
prose rate: `email` -> YAML (neg-116) no longer fires. Fix H (a second production false
positive, `lacks` -> Locus) again left the positives untouched (99.6% excl. hard, term recall
96.5%) and dropped two more expected-hard negatives: `graphical` -> GraphQL (neg-038, now a
stoplist word) and `tropic` -> tRPC (neg-039, keyed via the alias `tea rpc` at 0.90 but only
0.33 alike). Prose FP incl. hard is 12.5% (15/120), term precision 95.0% and F1 95.7%. The
tables above have since been regenerated and now include G and H.

| case | heard -> output | expected | why |
|---|---|---|---|
| pos-128 | `wire the sas into` -> unchanged | `SaaS` | SaaS keys to `SS` (2 chars); the key-length rule blocks it. Add `sas` as an alias. |
| hard-018 | `use zed schemas` -> unchanged | `Zod` | Same rule (`ST`). `zed` is also a plausible word; an alias is the right fix. |
| hard-001 | `our sass margins` -> unchanged | `SaaS` | `sass` is on the built-in stoplist. |
| hard-002 | `and tropic released` -> unchanged | `Anthropic released` | `anthropic` keys to `AN0RPK` (th = theta), `andtropic` to `ANTRPK`. Before H the output was `and tRPC released`; the lone-token similarity floor now refuses `tropic` -> tRPC, but nothing recovers Anthropic. |
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
| 15 negatives (neg-012, 027, 028, 029, 030, 033, 034, 035, 036, 041, 042, 054, 060, 073, 077) | `drizzle`, `neon`, `whisper`, `docker`, `playwright`, `prometheus` case-fixed; `jot`, `jason`, `okay are`, `tail wind`, `super base` aliased; `llama`, `pedantic` guessed | unchanged | Corpus ambiguities: the canonical or a user alias is itself an English word or phrase (`tail wind` is the collapsed implicit alias of Tailwind, and `tail` is deliberately kept off the stoplist so pos-058 `tail wind's docs` still fires). Only `never` lists resolve these; see recommendations. `email` -> YAML (neg-116) is gone since G; `graphical` -> GraphQL (neg-038) and `tropic` -> tRPC (neg-039) are gone since H. `pedantic` -> Pydantic survives H: the key is 5 consonants and the words are 0.88 alike, so it is indistinguishable from a garble. |

Bugs A-H are fixed and each has a unit test in `tests/matcher.test.ts` (search for `bug A` ..
`bug H`); A-F also have an end-to-end test in `tests/normalize.test.ts`. G is the case seen in
production on 2026-09-19: the global term `Entire.io` (aliases `entire i o`, `entire dot io`)
rewrote the capitalised, sentence-internal font name `Inter` to `Entire.io` as `phonetic 0.86`.
`inter` and `entire` both key to `ANTR`, and the 0.88 aliased plain-word bar from D only applied
to lowercase tokens. H is the second production case from the same day: the alias-less term
`Locus` rewrote the ordinary word `lacks` (`the process lacks ...`) as `phonetic 0.90`. Both key
to `LKS`; the term had no aliases, so the 0.88 bar from D and G did not apply, and `lacks` was
not among the ~600 words of the old stoplist.

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
  letters: `j w t`, `ay ar ar`) get no phonetic key at all; and a lone token matched against a
  term that has explicit aliases must clear 0.88.
- **Case and the 0.88 bar (G).** In the phonetic pass the 0.88 aliased-term bar applies to any
  single-token window regardless of case: phonetic confidence is a length formula with no
  spelling evidence in it, and a capital at the start of a sentence or on a proper noun is not
  evidence of a garble (`Inter` -> Entire.io at 0.86 is blocked; `Ashlur is down` -> Ashlr.AI at
  0.90 still passes). In the fuzzy pass only an all-lowercase token is held to 0.88, as before:
  fuzzy confidence is an edit similarity, and a capitalised token one edit from a listed alias
  (`Ashlet` -> Ashlr.AI at 0.83) is what the alias was listed for. Applying the case-blind bar
  to fuzzy as well would have lost that headline case, so it was not.
- **Initial-vowel guard (G).** Double metaphone folds every initial vowel to `A`, which is why
  `inter` and `entire` share a key while agreeing on nothing else (similarity 0.5). A lone
  phonetic candidate whose window or alias starts with a vowel (`a e i o u y`) must start with
  the same letter (diacritics folded) or reach similarity 0.6 against the alias it keyed to.
  Two different initial consonants (`coopernetties` / `kubernetes`, `c`/`k`) already agreed on
  the key's first consonant and are exempt; the guard as first drafted (any differing first
  letter) would have lost that headline case. Multi-token windows are exempt. Terms with and
  without aliases are both covered, so `the inter font` stays put even for a bare `Entire.io`.
- **Stoplist (H).** The built-in stoplist moved to `src/core/stoplist.ts` and grew from about
  600 to 3398 words: function words, the common verbs, nouns, adjectives and adverbs in the
  inflections STT produces (`lack`, `lacks`, `lacked`, `lacking`, `looked`, `looking`, `users`,
  ...), calendar words and everyday tech vocabulary. It still only blocks the phonetic and fuzzy
  passes and the implicit (canonical-derived) exact alias; an alias the user listed explicitly
  fires on any of them. Product names that double as words (`docker`, `neon`, `whisper`,
  `playwright`, `prometheus`, `drizzle`) are deliberately absent so a bare canonical is still
  case-fixed in prose, and `tail`/`tale`/`dock`/`transcript` stay off it so the multi-token
  garbles the corpus contains (`tail wind`, `tale wind`, `dock her`, `normal eyes transcript`)
  can still be reassembled. One consequence worth knowing: the implicit domain stem of
  `Entire.io` is the word `entire`, so a bare `entire` is no longer rewritten; list `entire` as
  an alias to opt in.
- **Lone-token similarity floors (H).** A single-token phonetic candidate must also resemble
  the alias in spelling, and the shorter the metaphone key the more it must: `similarity() >=
  0.8` on a 3-consonant key (`lokus`/`locus` 0.8 and `doker`/`docker` 0.83 pass; `lacks`/`locus`
  0.6 and `tucker`/`docker` 0.67 fail), `>= 0.65` on a 4-consonant key (`playwrite`/`playwright`
  0.7 passes; `inter`/`entire` 0.5 fails), and no floor beyond the initial-vowel guard from G on
  5 or more consonants, since that many consonants agreeing in order is spelling evidence in
  itself (`coopernetties`/`kubernetes` at 0.46 still matches). The floors apply to terms with
  and without aliases. A flat "key >= 4 for lone tokens" rule was measured first and lost two
  headline positives, `doker` -> Docker (`TKR`) and `olama` -> Ollama (`ALM`), both alias-less,
  so restricting it to alias-less terms would not have saved them either; the tiers keep both
  at 99.6% / 96.5%. Multi-token windows are exempt (`dock her`, `oh llama`).
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


## Real audio (macOS TTS -> whisper.cpp)

Everything above feeds the matcher hand-written STT errors. This section measures the same
matcher on transcripts from an actual recognizer, so the "before" number is what Whisper really
produced, not what we assumed it would. Measured 2026-09-20 with `npm run bench:audio`; the full
report including every failing clip is [`bench/audio/results.md`](../bench/audio/results.md).

The audio numbers moved between the 2026-09-19 run and this one, and they moved in both
directions: recall on `base.en` fell from 86.4% to 82.8% and on `small.en` from 93.5% to 91.0%,
while precision rose from 91.6% to 93.9% and from 92.6% to 94.4%, and the prose false-positive
rate fell from 20.0% to 16.7%. Concretely, the precision work gave up `SQ light` -> SQLite
(3 clips) and `Olima` -> Ollama (2 clips) and took back `graphical` -> GraphQL (3 clips). F1 is
roughly flat (88.9% to 88.0% on `base.en`, 93.0% to 92.7% on `small.en`).

**The cause is fixes G and H, not the enumeration guard**, and the distinction matters because
both landed on the same day. This report had simply not been regenerated since the precision
guards went in, so the older figures described a matcher that no longer existed. The enumeration
guard changes nothing here at all: running the whole audio benchmark with it bypassed returns a
byte-identical report, and it declines no rewrite in any of the 239 transcripts. The synthetic
corpus is likewise identical to the case before and after it.

### Method

- **Sentences.** `bench/audio/sentences.jsonl`: 80 dictation-style sentences that contain
  `bench/lexicon.yaml` terms (93 term slots per voice: brands, products, acronyms, the invented
  people, camelCase identifiers, 13 with two terms) and 30 clean-prose negatives, 6 of them
  `expected-hard` because the canonical is an English word (`drizzle`, `neon`, `whisper`,
  `playwright`) or a known phonetic collision (`graphical`, `pedantic`). Each sentence has the
  ground truth `expected` and, where the spelling would be mispronounced by TTS, a `spoken`
  form that is how a person actually says it: `Ashlr.AI` is read as "Ashler A I", `tRPC` as
  "T R P C", `Nginx` as "Engine X", `PostgreSQL` as "Postgres", `YAML` as "yammel", `JSON` as
  "jason", `Siobhan` as "Shivawn", `LexiconStore` as "lexicon store".
- **Audio.** macOS `say` with three voices (Samantha en_US, Daniel en_GB, Karen en_AU) to 16 kHz
  mono PCM WAV. 110 sentences x 3 voices = 330 clips.
- **Recognizer.** whisper.cpp (`brew install whisper-cpp`, `whisper-cli` with default beam
  search) with `base.en` and `small.en`, each run twice: plain, and with `--prompt` set to
  `lexicon export whisper-prompt` (the 70 canonicals, comma-separated, 654 chars). That is the
  recognizer-side fix the exporters exist for, so the table answers "hints alone vs hints plus
  lexicon".
- **Metrics** are `bench/lib.ts` applied to the transcript as `heard`: term recall is exact and
  case-sensitive on the canonical, prose false positives count negatives with any replacement.
  Sentence accuracy is "loose": case and edge punctuation are folded because Whisper
  capitalizes and punctuates on its own; internal punctuation still has to match (`Ashlr AI` is
  not `Ashlr.AI`). Sentence accuracy after the lexicon also counts Whisper errors on ordinary
  words (`commas` -> `commerce`), so it is a whole-pipeline number and a ceiling for the matcher,
  not a measurement of it.
- **Runtime.** About six minutes cold on an M5 Max (synthesis dominates; the four whisper passes
  take 19 s, 25 s, 42 s and 50 s), a couple of seconds when audio and transcripts are cached.

### Caveats

- TTS is far cleaner than a microphone: no room, no disfluency, no accent variation beyond the
  three voice packs, and the same prosody every time. Expect lower raw recall on real speech.
  The value here is that the *shapes* of the errors are real (`Cuban eats`, `Superbase`,
  `Versal`, `user prompt, submit`), which the synthetic corpus could only guess at.
- The `spoken` hints decide the outcome for spelled acronyms and invented names. "T R P C"
  comes out as `TRPC` every time; a speaker who says "trip-see" would get something else.
- `base.en` and `small.en` are the two smallest English models. Larger models and cloud STT
  will sit above `small.en`; the lexicon's job is the gap that remains.
- Three voices, one run, no temperature sampling: the numbers are reproducible but the
  per-term counts are small (3 or 6 slots each). Treat the per-term table as qualitative.

### Headline

| metric | base.en | base.en + prompt | small.en | small.en + prompt |
|---|---|---|---|---|
| term recall, raw Whisper | 41.9% (117/279) | 66.7% (186/279) | 45.9% (128/279) | 76.0% (212/279) |
| term recall, after lexicon | **82.8%** (231/279) | **90.3%** (252/279) | **91.0%** (254/279) | **95.7%** (267/279) |
| term precision | 93.9% | 95.5% | 94.4% | 95.7% |
| term F1 | 88.0% | 92.8% | 92.7% | 95.7% |
| sentence accuracy, raw Whisper (positives, loose) | 37.9% | 51.2% | 45.4% | 72.5% |
| sentence accuracy, after lexicon (positives, loose) | 65.8% | 67.1% | 78.8% | 83.8% |
| prose false-positive rate (negatives changed) | 16.7% (15/90) | 13.3% (12/90) | 16.7% (15/90) | 13.3% (12/90) |
| prose false-positive rate excl. expected-hard | **0.0%** (0/72) | **0.0%** (0/72) | **0.0%** (0/72) | **0.0%** (0/72) |

The README-ready sentence:

> On 279 proper nouns dictated through macOS TTS, whisper.cpp `base.en` spelled 42% correctly;
> after the lexicon 83% are correct (`small.en`: 46% -> 91%). Passing the lexicon to Whisper as
> an initial prompt gets `base.en` to 67% on its own; prompt plus lexicon reaches 90%
> (`small.en`: 76% -> 96%). Clean prose without a lexicon term was never changed except the six
> sentences that contain a canonical spelled as an English word (0 of 72 ordinary negatives, in
> every configuration).

Every one of the 15 prose false positives is one of the six `expected-hard` sentences, five of
them across three voices each: `drizzle`, `neon`, `whisper`, `playwright` case-fixed and
`pedantic` -> Pydantic at 0.90. The synthetic benchmark predicted exactly this set. The sixth,
`graphical` -> GraphQL, no longer fires: fix H put it on the stoplist, which removed it in all
three voices and accounts for most of the drop from 20.0% to 16.7%.

### By voice and category (base.en, plain)

| voice | term recall raw | term recall after | sentence acc raw | sentence acc after |
|---|---|---|---|---|
| Samantha (en_US) | 44.1% | 88.2% | 42.5% | 73.8% |
| Daniel (en_GB) | 41.9% | 83.9% | 38.8% | 68.8% |
| Karen (en_AU) | 39.8% | 76.3% | 32.5% | 55.0% |

| category | term slots | raw | after | raw with prompt | after with prompt |
|---|---|---|---|---|---|
| brand | 54 | 14.8% | 81.5% | 37.0% | 85.2% |
| product | 111 | 48.6% | 80.2% | 73.0% | 88.3% |
| acronym | 54 | 88.9% | 94.4% | 100.0% | 100.0% |
| person | 33 | 21.2% | 75.8% | 54.5% | 90.9% |
| identifier | 27 | 0.0% | 81.5% | 48.1% | 88.9% |

Reading: Whisper is good at spelled-out acronyms ("A P I" -> `API` every time) and hopeless at
camelCase (no recognizer emits `normalizeTranscript`; 0 of 27 raw), which is where the collapsed
lookup earns its keep (`normalize transcript` -> `normalizeTranscript`, 6 of 6). Brands and
people are where an alias list matters most: without one the phonetic pass recovers `Versal`
and `Olima` but not `vessel`, `versatile` or `erupts`.

### What the prompt does and does not do

`--prompt` with the canonicals is worth 25 points of raw recall on `base.en` and 30 on
`small.en`, and it is the only thing that gets `Ashlr.AI`, `Hetzner` and `Kubernetes` spelled
right at the source. It is not a substitute for the lexicon: 20 points (`small.en`, 76.0% to
95.7%) to 24 points (`base.en`, 66.7% to 90.3%) remain for the lexicon to close after the prompt
has done its work, and the prompt introduces its own errors. Seen in this run:

- Casing the prompt does not control: `DeepGram` (3 of 6 base.en clips, 5 of 6 small.en; the
  prompt says `Deepgram`), `Saas` (3 of 3, small.en), `NormalizeTranscript`, `UserPrompt Submit`.
- Possessives: `Kubernete's` twice. Brand names the prompt did not fix: `Superbase` stays
  `Superbase` in 5 of 6 small.en clips, `Postgres` stays `Postgres` (fine, the alias catches it).
- Regressions on words that were right without the prompt: `Prometheus` -> `from Etheus`,
  `Grafana` -> `Grafaneur`, `Anthropic` -> `Anthropik`, `Vite` -> `Vit`/`Veid`; `Upstash`
  dropped from the transcript entirely in 2 of 3 small.en clips.
- One hallucination into clean prose: `Our graphical report` -> `Our GraphQL report` (Karen,
  base.en + prompt). The matcher metrics cannot see this because it happens before the matcher;
  it is the reason "hints alone" should not be the only line of defence.

The lexicon runs after all of that and still recovers most of it (`DeepGram` and `Saas` are
exact hits because the alias pass is case-insensitive; `Kubernete's` is a possessive view), which
is why "prompt + lexicon" is the best column in every row.

### What Whisper wrote (base.en, plain; 25 worst terms by raw recall)

Outcome per spelling: `alias`, `phonetic`, `fuzzy` = recovered by that pass; `MISSED` = the
lexicon left it. The span is recovered by word-aligning the transcript to the ground truth, so a
few entries are alignment artifacts (`now` for Hetzner comes from `off-heads now`). The complete
table for all 70 terms is in `bench/audio/results.md`.

| canonical | category | raw | after | what Whisper wrote (count, outcome) |
| --- | --- | --- | --- | --- |
| Anthropic | brand | 0.0% (0/3) | 0.0% (0/3) | `and Thropic` x2 MISSED; `and Tropic` x1 MISSED |
| Ashlr.AI | brand | 0.0% (0/6) | 100.0% (6/6) | `Ashler AI` x3 alias; `Ashler AI's` x3 alias |
| Bjørn Halvorsen | person | 0.0% (0/3) | 66.7% (2/3) | `Byorn Halverson` x1 fuzzy; `By-on Halverson` x1 MISSED; `Byron Halvorsen` x1 fuzzy |
| Cloudflare | brand | 0.0% (0/3) | 66.7% (2/3) | `CloudFloor` x1 phonetic; `Cloudflour` x1 phonetic; `Cloudflow` x1 MISSED |
| Drizzle | product | 0.0% (0/3) | 100.0% (3/3) | `drizzle` x3 alias |
| harvestRepo | identifier | 0.0% (0/6) | 83.3% (5/6) | `Harvest repo` x3 alias; `harvest repo` x2 alias; `Harvest read per` x1 MISSED |
| JSON | acronym | 0.0% (0/3) | 100.0% (3/3) | `Jason` x3 alias |
| Kwame Mensah | person | 0.0% (0/6) | 100.0% (6/6) | `Kwame Mensa` x3 alias; `Kwame Mensa's` x2 alias; `Kwame mens's` x1 fuzzy |
| LangChain | product | 0.0% (0/3) | 66.7% (2/3) | `LANG chain` x1 alias; `landshane` x1 MISSED; `Langshane` x1 phonetic |
| Levenshtein | product | 0.0% (0/3) | 33.3% (1/3) | `Leventtien` x1 MISSED; `Levenstein` x1 fuzzy; `Leventstein` x1 MISSED |
| LexiconStore | identifier | 0.0% (0/6) | 83.3% (5/6) | `lexicon store` x3 alias; `lexicon story` x1 phonetic; `Lexi can store` x1 phonetic; `Lexic and` x1 MISSED |
| Nginx | product | 0.0% (0/3) | 100.0% (3/3) | `Engine X` x2 alias; `Enginex` x1 alias |
| normalizeTranscript | identifier | 0.0% (0/6) | 100.0% (6/6) | `normalize transcript` x3 alias; `Normalize transcript` x3 alias |
| Ollama | product | 0.0% (0/3) | 33.3% (1/3) | `Olima` x2 MISSED; `all Emma` x1 phonetic |
| OpenClaw | brand | 0.0% (0/3) | 100.0% (3/3) | `open claw` x3 alias |
| Playwright | product | 0.0% (0/6) | 100.0% (6/6) | `playwright` x6 alias |
| PostgreSQL | product | 0.0% (0/6) | 100.0% (6/6) | `Postgres` x6 alias |
| Puppeteer | product | 0.0% (0/3) | 66.7% (2/3) | `puppeteer` x2 alias; `pup hitear` x1 MISSED |
| Pydantic | product | 0.0% (0/3) | 66.7% (2/3) | `pedantic` x2 phonetic; `Adipidantic` x1 MISSED |
| Siobhan Reilly | person | 0.0% (0/6) | 83.3% (5/6) | `Shiv on Riley` x2 alias; `Shivorn really` x1 fuzzy; `Shivorn Riley` x1 fuzzy; `Shivorn rally` x1 MISSED; `Sheve-On-Rally` x1 phonetic |
| SQLite | product | 0.0% (0/3) | 0.0% (0/3) | `SQ light` x2 MISSED; `SQ light fall` x1 MISSED |
| Supabase | brand | 0.0% (0/6) | 100.0% (6/6) | `Superbase` x6 alias |
| Superwhisper | brand | 0.0% (0/3) | 100.0% (3/3) | `Super Whisper` x3 alias |
| Tadeusz Wróblewski | person | 0.0% (0/3) | 66.7% (2/3) | `Tadayush Vrooblefsky` x1 phonetic; `Tadayushvublefsky` x1 MISSED; `Ted Ayushvroob Lefsky` x1 phonetic |
| tRPC | product | 0.0% (0/3) | 100.0% (3/3) | `TRPC` x3 alias |

Most instructive rows:

- `Kubernetes` -> `Cuban eats`, `Cuban needs`, `cuba needs` (3 of 6 without prompt). Two
  English words with a different key each; nothing short of an alias (or the prompt) fixes it.
- `UserPromptSubmit` -> `user prompt, submit` and `prompt submithook`. Whisper puts a comma
  inside the identifier, which breaks the exact alias `user prompt submit`. A matcher that
  ignored punctuation inside a multi-word alias window would recover 2 more of 27 identifier
  slots; this is the one matcher change this benchmark suggests.
- `Pydantic` -> `pedantic` (2 of 3) is recovered by the phonetic pass at 0.90, and `pedantic`
  in prose is rewritten by the same rule. The two cannot be separated by the matcher; the
  lexicon owner picks a side with `never: [pedantic]`.
- `Priyanka Raghunathan` -> `Priyanka Regunath and`: Whisper splits the final `-an` into the
  word `and`, so the fuzzy window ends on a function word and is refused by design.
- `Vercel` -> `Versal` (phonetic, recovered), `vessel`, `versatile` (missed): the same voice
  pack produces three different English words for one brand.
- `Vite` -> `VEED`, `V8`: a one-syllable brand loses every time; `V8` is a real engine name and
  should not become an alias.

### Aliases this run suggests for `bench/lexicon.yaml`

Not applied (the naive lexicon is the point of the benchmark). Mechanical list in
`bench/audio/results.md`; the ones worth keeping, grouped by what they buy:

| canonical | add | why |
|---|---|---|
| Vercel | `versal`, `vessel` | `versal` x4 recovered only by phonetic; `vessel` missed. `versatile` is a real word, leave it out. |
| Kubernetes | `cuban eats`, `cuban needs`, `cuba needs` | 3 misses; both models. |
| Anthropic | `and thropic`, `and tropic`, `anthropik` | 3 of 3 missed on base.en; `and tropic` currently lands on tRPC. |
| Hetzner | `tetsner`, `hetzena` | 3 misses (the third, `off-heads now`, is not alias-shaped); the phonetic key of `hetzner` never matched anything. |
| Vite | `veed` | 2 misses. |
| Vitest | `v test`, `vtest` | Recovered by phonetic (0.88); an alias makes it exact. |
| SQLite | `sq light`, `sq lite`, `sq-like` | Same. |
| Ollama | `olima` | Same. |
| Levenshtein | `leventstein`, `leventtien`, `levenshtine` | 2 of 3 missed. |
| Cloudflare | `cloudflow`, `cloudfloor`, `cloudflour` | 1 missed, 2 recovered by phonetic. |
| LangChain | `langshane`, `landshane` | 1 missed. |
| Siobhan Reilly | `shivorn riley`, `shivorn reilly`, `shivon reilly`, `shiv on reilly` | `Shiv on Riley` was already an alias hit; the `-orn` spellings are new. |
| Xiuying Zhao | `shaoying zhao`, `showing zhao`, `shawing zhao` | 1 missed per model. |
| Bjørn Halvorsen | `byorn halverson`, `byron halvorsen`, `by-on halverson` | Fuzzy gets two; the third is missed. |
| Priyanka Raghunathan | `priyanka regunathan`, `priyanka regunath and` | See above. |
| Kwame Mensah | (none needed) | `Kwame Mensa` is already an alias and matched 6 of 6. |
| YAML | `yannell`, `yemil` | 1 missed. |
| Kafka | `calf care` | 1 missed. |
| Mason Wyatt | `mason wired` | 1 missed. |
| SaaS, Zod | `sas`, `sod` | Predicted by the synthetic benchmark; confirmed here (`SAS` x1, `sod` x1 missed). |
| Pydantic | `pedantic` only in a dev-only lexicon | Trades the prose collision for 2 of 3 recoveries; the phonetic pass already gets them. |

Not suggested: `DeepGram`, `Superbase`, `Postgres`, `Jason`, `jot`, `Engine X`, `TRPC`,
`playwright` (lowercase): all already exact hits through existing aliases or the case-insensitive
canonical, which is the alias list in `bench/lexicon.yaml` doing what it was written to do.

## Against the alternatives

Everything above measures Lexicon against doing nothing. This section measures it against the
three things a reader would otherwise reach for. Every row is scored on the **same cached
whisper.cpp transcripts**, so the audio, the three voices and the recognizer are identical and
the only variable is the fix. Reproduce with `npm run bench:compare` (after one
`npm run bench:audio` to fill the transcript cache).

The conditions:

- **raw whisper.cpp** with no help at all.
- **whisper.cpp `--prompt`**, the recognizer's own hint list, set to
  `lexicon export whisper-prompt` (the 70 canonicals, 654 chars). This changes what Whisper
  writes in the first place rather than fixing it afterwards.
- **exact substitution**, the macOS Text Replacement baseline: a flat table of "this exact
  phrase becomes that one", applied on word boundaries, longest first, one pass. It is given
  exactly the same 175 aliases the matcher has, so the only thing being compared is the matching
  strategy. Reported case-insensitively, which is the generous reading and how Text Replacement
  actually behaves; the case-sensitive row is shown because the aliases in `bench/lexicon.yaml`
  are written lowercase while Whisper capitalizes freely, and that alone costs 8 points.
- **exact substitution + canonical casing rules**, the same table plus a `drizzle -> Drizzle`
  rule per term, which is what a determined person adds once they notice the recognizer heard
  the word but lower-cased it. This is the strongest honest version of the hand-rolled approach.
- **Lexicon**: `normalize()`, alias > phonetic > fuzzy, with the guardrails.

### small.en

| condition | proper nouns recovered | sentences exactly right | clean prose wrongly changed |
|---|---|---|---|
| raw whisper.cpp | 45.9% (128/279) | 45.4% (109/240) | n/a, nothing runs |
| exact substitution | 62.0% (173/279) | 59.2% (142/240) | 0 of 72 |
| exact substitution + canonical casing rules | 71.3% (199/279) | 59.2% (142/240) | 0 of 72 |
| whisper.cpp `--prompt` | 76.0% (212/279) | 72.5% (174/240) | n/a, nothing runs |
| **Lexicon** | **91.0% (254/279)** | **78.8% (189/240)** | **0 of 72** |

### base.en

| condition | proper nouns recovered | sentences exactly right | clean prose wrongly changed |
|---|---|---|---|
| raw whisper.cpp | 41.9% (117/279) | 37.9% (91/240) | n/a, nothing runs |
| exact substitution, case-sensitive | 49.8% (139/279) | 45.4% (109/240) | 0 of 72 |
| exact substitution | 58.1% (162/279) | 49.6% (119/240) | 0 of 72 |
| exact substitution + canonical casing rules | 65.6% (183/279) | 49.6% (119/240) | 0 of 72 |
| whisper.cpp `--prompt` | 66.7% (186/279) | 51.2% (123/240) | n/a, nothing runs |
| **Lexicon** | **82.8% (231/279)** | **65.8% (158/240)** | **0 of 72** |

### Reading this table honestly

- **The last column is unmeasured for the top two rows, which is not the same as zero.** Raw
  Whisper genuinely cannot change prose, because nothing runs; that is the absence of the feature
  rather than a safety advantage, since it also cannot fix anything after the fact. `--prompt` is
  a different case and the `n/a` flatters it. It biases the recognizer itself, so any damage it
  does is already in the transcript before scoring begins, while this metric counts sentences that
  a post-pass altered. Measuring it would mean diffing the prompted transcript against the
  unprompted one for the ninety prose clips, which this harness does not do, so the honest word
  for that cell is unmeasured rather than zero. An earlier version of this paragraph offered two
  clips as evidence that the prompt damages prose. That was wrong and is withdrawn: both are
  term-carrying clips where the word in question is the expected term, not prose negatives, and
  one of them reads the same way with no prompt at all. The column that compares all five
  conditions fairly is the first one.
- **`--prompt` is a complement, not a competitor.** It is the strongest non-Lexicon condition on
  `small.en` (76.0%), and it composes: the headline table above reports prompt plus lexicon at
  95.7%, higher than either alone. The exporters exist so you can use both.
- **The hand-rolled table is not free either.** Once it is strong enough to be worth having
  (the casing-rules row), it starts changing prose it should not: 13.3% (12 of 90) with the
  `expected-hard` sentences included, against Lexicon's 16.7% (15 of 90). Both are zero on the
  72 ordinary prose clips. So Lexicon buys roughly 20 more points of recall for about 3 points
  of adversarial false positives, not for a free lunch.
- **The gap is the phonetic and fuzzy tiers.** Exact substitution recovers what an alias already
  covers and nothing else. It cannot reach `Versal` -> Vercel, `Superbase` -> Supabase,
  `CloudFloor` -> Cloudflare, `pedantic` -> Pydantic or `Leventstein` -> Levenshtein, because no
  table a person writes by hand contains the spelling they have not seen yet. That is the whole
  argument for the matcher. Sized honestly, the two inexact tiers recover 31 of the 279 term slots
  by themselves on `small.en`, which is 11.1 points, and 24 slots or 8.6 points on `base.en`; the
  by-reason tables above are where those counts come from. The rest of the 29-point distance from
  plain exact substitution is case-insensitive matching of the canonical, which is worth 9.3
  points and is already included in the 71.3% row, and the alias tier's tolerance for how the
  recognizer splits a name into words, which is the remaining 8.6. Both are real advantages over a
  hand-written replacement table, and neither is the phonetic matcher, so attributing the whole
  gap to it overstates the case by roughly threefold.

### Caveats specific to this table

- The exact-substitution baseline is a faithful model of macOS Text Replacement's *matching*,
  not of its *deployment*. Real Text Replacement fires while you type in Cocoa text fields; it
  does not run over an agent's stdin. The comparison is about what the strategy can recover,
  not about where it can be installed.
- It is given the lexicon's aliases, which were written by someone who had already seen these
  errors. A person starting from scratch would have fewer, so this row flatters the baseline.
- Every caveat from the real-audio section applies: TTS is cleaner than a microphone, three
  voices, one run, small per-term counts.

## See also

- [RESEARCH.md](RESEARCH.md) explains why accuracy on proper nouns is the thing worth measuring.
- [ARCHITECTURE.md](ARCHITECTURE.md) covers what got built, and the decisions behind it.
- [LANDING.md](LANDING.md) is where these numbers get quoted to a stranger.

Back to [the docs index](README.md).
