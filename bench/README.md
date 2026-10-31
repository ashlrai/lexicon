# Accuracy benchmark

Measures how well `normalize()` recovers proper nouns that speech-to-text mangles,
and how often it damages clean prose that merely sounds like a lexicon term.
Numbers from the last run are in [`docs/BENCHMARK.md`](../docs/BENCHMARK.md).

## Run

```bash
npm run bench                              # default config -> markdown on stdout + bench/results.json
npm run bench -- --verbose                 # also print every failing case (heard / expected / output / replacements)
npm run bench -- --sweep                   # minConfidence 0.70..0.95: accuracy vs false-positive rate per step
npm run bench -- --filter person           # one category: brand | product | acronym | person | identifier | prose
npm run bench -- --min-confidence 0.9      # override the threshold
npm run bench -- --no-phonetic --no-fuzzy  # alias pass only
npm run bench -- --json                    # machine-readable report on stdout
npx vitest run bench                       # regression guard (thresholds in bench/bench.test.ts)
```

`--out`, `--corpus` and `--lexicon` point the runner at other files.

## Repeat the non-English-name benchmark

For the focused 35-name, five-language YAML fixture and side-by-side English baseline,
run `npm run bench:non-english` (`node --import tsx scripts/bench-non-english.mjs`).
Add `--json` for all scored cases.
Generated results: [BENCH-NON-ENGLISH.md](../docs/BENCH-NON-ENGLISH.md).

From the repository root, with dependencies installed, run:

```bash
npm run bench -- --out /tmp/lexicon-name-benchmark.json
```

This uses the committed `bench/corpus.jsonl` and `bench/lexicon.yaml` with the
default matcher settings. The corpus includes generated name cases from
`bench/gen-corpus.ts` and the hand-written edges in `bench/cases/nonenglish.jsonl`.
Run the full corpus, rather than the edges file alone, to retain the generated
cases and the untagged baseline. The command prints a Markdown report and saves
JSON to the specified path, leaving `bench/results.json` untouched.

In the `Non-English subset` table, compare the untagged baseline, all
`lang`-tagged cases, and each language family. It reports case counts, positive
sentence accuracy (with and without expected-hard cases), raw and post-lexicon
term recall, precision, F1, and the prose false-positive rate. `--verbose` also
lists failing cases; the saved JSON includes failures. Repeat with the same
inputs and settings to compare accuracy; latency varies with the machine and
load. These are synthetic text cases, so the report does not measure real
dictation accuracy.

## Files

| file | what |
|---|---|
| `lexicon.yaml` | 112 terms a founder/dev would keep. ~40% deliberately have no aliases so the phonetic and fuzzy passes are what gets measured for them. 42 of the terms are non-English person names (the issue #8 fixture). No `never` lists, no settings: the naive out-of-the-box configuration. |
| `gen-corpus.ts` | Deterministic generator (seeded PRNG, templates x heard-variants). Writes `corpus.jsonl`. |
| `cases/negatives.jsonl` | Hand-written clean prose that must not change: sound-alikes (`pass the sauce`, `red is my favorite color`), code spans, fences, URLs, emails, paths. |
| `cases/hard.jsonl` | Hand-written cases we expect to fail, each with a diagnosis in `note`. |
| `cases/positives.jsonl` | Hand-written positives that mix code/URLs with prose, punctuation, multi-line input. |
| `cases/nonenglish.jsonl` | Hand-written non-English edges: name-lookalike prose negatives, first-name-only and diminutive misses, multi-name sentences. Every case carries `lang`. |
| `corpus.jsonl` | Generated output. Committed so the numbers are reproducible without regenerating. |
| `lib.ts` | Loading + metrics. `run.ts` (CLI) and `bench.test.ts` both import it so they cannot disagree. |
| `results.json` | Last run: summary, sweep, every failing case. |

## Case format

One JSON object per line:

```json
{"id":"pos-042","category":"product","heard":"add a pie dantic model for the sync job","expected":"add a Pydantic model for the sync job","terms":["Pydantic"],"note":"optional"}
{"id":"ne-003","category":"person","heard":"ask your gin meyer if the invoice went out","expected":"ask Jürgen Meyer if the invoice went out","terms":["Jürgen Meyer"],"lang":"german","note":"expected-hard: ..."}
```

- `category`: `brand | person | product | acronym | identifier | prose`
- `heard`: what STT produced. `expected`: what the user meant.
- `terms`: canonicals that must appear in `expected`. Empty array = negative (nothing may change).
- `lang`: optional language-family tag (`german`, `spanish`, `polish`, `japanese`, `arabic`,
  `nordic` today). Tagged cases are additionally reported as the `non-English` subset, broken
  down per family; untagged cases form the `baseline` subset.
- `note`: free text. A note starting with `expected-hard` marks a case we expect to fail; those are
  reported separately so the headline is not flattered by dropping them.

## Metrics

- **Sentence accuracy**: `output === expected`, exact. Reported for all cases, positives, negatives,
  and with expected-hard cases excluded.
- **Term recall**: a term slot is `(case, canonical)`; it is recovered when the canonical occurs in
  the output at least as often as in `expected`. `raw STT` recall is the same test applied to `heard`
  (what the recognizer got right on its own).
- **Term precision / F1**: false positives are replacements whose canonical is not in the case's
  `terms` (every replacement in a negative counts). Precision = TP / (TP + FP).
- **Prose false-positive rate**: negatives with at least one replacement / all negatives.
- **By reason**: replacements per pass (`alias` / `phonetic` / `fuzzy`), split into correct
  (canonical expected in that case) and spurious, with mean confidence.
- **By language** (when cases carry `lang`): every metric above recomputed on the untagged
  `baseline` subset, the whole `non-English` subset, and each family separately. This is the
  issue #8 measurement: baseline and subset recall sit side by side so the gap is one number.
- **Latency**: warm mean per case over 5 rounds; `normalize()` includes `buildIndex()` (what the hook
  pays per prompt), `findReplacements()` uses a prebuilt index.

The corpus is sampled from STT failures by construction, so raw recall is low by design; the
meaningful before/after number is term recall, and the honesty check is the prose FP rate.

## Adding cases

- A new misheard spelling of an existing term: add it to that term's `heard` list in
  `gen-corpus.ts` (and to `lexicon.yaml` if you want the alias pass to handle it), then
  `node --import tsx bench/gen-corpus.ts`.
- A new term: add it to `lexicon.yaml` and to `TERMS` in `gen-corpus.ts`.
- A new non-English name: add it to `lexicon.yaml` and to `NONENGLISH_TERMS` in `gen-corpus.ts`
  with its `lang` tag; list the variants you expect to fail in its `hard` map, then regenerate
  and check whether the misses match the marks. Hand-written edges go in
  `cases/nonenglish.jsonl` with `lang` set.
- A negative or hard case: append a line to `cases/negatives.jsonl` or `cases/hard.jsonl`,
  then regenerate. Prefix `note` with `expected-hard: ` if you expect it to fail.
- Templates must be inert: the generator fails loudly if a template mutates on its own with a
  neutral placeholder, because that would contaminate every case built from it. Words that have
  tripped it so far: `suite`, `said the`, `email`, `noon` (see BENCHMARK.md).

After a matcher change: `npm run bench -- --sweep`, commit the new `results.json`, update the
numbers in `docs/BENCHMARK.md`, and move the thresholds in `bench.test.ts` if they changed
deliberately.

## CI regression gate

CI runs `npx vitest run bench/bench.test.ts` as its own step ("Benchmark regression gate (synthetic corpus)") on every push and pull request, independent of which files a PR touched. It fails when the matcher's accuracy drops below thresholds set from the numbers measured on 2026-10-26 minus a small margin. The guard runs on the `baseline` (untagged) subset, so its gates still measure the original 402 cases they were tuned on:

| Measure (baseline subset, 402 sentences) | Measured | Gate |
|---|---|---|
| Positive sentences | 95.32% (265/278) | at least 94% |
| Positives excluding expected-hard | 99.61% (255/256) | at least 98% |
| Overall sentence accuracy | 92.04% (370/402) | at least 90% |
| Term recall | 96.81% (303/313) | at least 95% |
| Term precision | 93.81% (303/323) | at least 92% |
| Prose false positives excluding expected-hard | 0.00% (0/95) | at most 2% |
| Prose false positives including expected-hard | 15.32% (19/124) | at most 16% |

Since the issue #8 fixture landed, a second set of floors guards the `lang`-tagged subset so a
matcher change cannot regress names while the baseline holds:

| Measure (non-English subset, 152 sentences) | Measured | Gate |
|---|---|---|
| Term recall | 76.35% (113/148) | at least 70% |
| Term precision | 100.00% (113/113) | at least 95% |
| Prose false positives including expected-hard | 0.00% (0/10) | at most 20% |
| Positives excluding expected-hard | 100.00% (106/106) | exactly 100% (an unmarked failure is a regression) |
| Per-family recall | arabic 92.6, german 66.7, japanese 79.2, nordic 96.0, polish 41.7, spanish 79.2 | floors at 85, 60, 70, 90, 35, 70 |

The corpus is synthetic (hand-written STT errors, text only), so the gate protects against matcher regressions; it says nothing about real dictation accuracy. If a deliberate change moves a number, re-run `npm run bench`, update `docs/BENCHMARK.md`, and move the threshold in `bench/bench.test.ts` with it.

## TTS audio (`bench/audio/`)

The corpus above is synthetic: the `heard` strings are hand-written STT errors. `bench/audio/`
produces them with an actual recognizer so the README claim is measured, not assumed. Each
sentence is synthesized with macOS `say` (three voices), transcribed with whisper.cpp, and the
transcript is what `normalize()` sees. Numbers and the "what Whisper wrote" table:
[`bench/audio/results.md`](audio/results.md); methodology and caveats: the "TTS audio (macOS TTS -> whisper.cpp)" section
of [`docs/BENCHMARK.md`](../docs/BENCHMARK.md).

```bash
brew install whisper-cpp                   # once; models download into bench/audio/models/ on first run
npm run bench:audio                        # base.en + small.en, 3 voices, with and without --prompt (~5 min cold, seconds cached)
npm run bench:audio -- --models base.en    # one model
npm run bench:audio -- --voices Samantha,Daniel
npm run bench:audio -- --no-prompt         # skip the whisper initial_prompt variants
npm run bench:audio -- --limit 10 --verbose   # smoke test, print failing clips (does not overwrite results.md)
npm run bench:audio -- --force             # re-transcribe; audio is always reused
npm run bench:compare                      # the same cached transcripts scored raw / prompt / exact substitution / lexicon
```

| file | what |
|---|---|
| `audio/sentences.jsonl` | 80 sentences with lexicon terms + 30 clean-prose negatives. `expected` is the ground truth; `spoken` (optional) is what is fed to TTS when the spelling would be mispronounced (`Ashlr.AI` -> "Ashler A I", `tRPC` -> "T R P C", `Nginx` -> "Engine X"), i.e. how a person actually says it. |
| `audio/run.ts` | Synthesis, transcription (one whisper-cli process per model/prompt variant), metrics via `bench/lib.ts`, word alignment to recover what Whisper wrote in each term slot, alias suggestions. |
| `audio/compare.ts` | `npm run bench:compare`: re-scores the transcripts `bench:audio` cached against the alternatives (raw, whisper's own `--prompt`, exact substitution, the lexicon); needs that cache, never runs `say` or whisper, and prints to stdout unless `--out` is given. |
| `audio/results.md` | Committed report from the last run: headline per variant, per voice/category/reason, per-term "what Whisper wrote", suggested aliases, every failing clip. |
| `audio/out/` | Gitignored cache: `wav/` clips, `transcripts.json` (keyed by model, prompt, voice, sentence hash), `results.json`. |
| `audio/models/` | Gitignored ggml models. |

Metrics are the same as above with two differences: `raw STT` recall is now what Whisper really
got right, and sentence accuracy is "loose" (case and edge punctuation folded, internal punctuation
kept) because Whisper capitalizes and punctuates on its own. Sentence accuracy after the lexicon
also counts Whisper errors on ordinary words, so it is the whole-pipeline number, not the matcher's.
There is deliberately no vitest guard on these numbers: they depend on a locally installed
recognizer and TTS voices.

## Hook latency

```bash
npm run bench:hook                          # plugin/hook.mjs, 2000 synthetic terms, best/median of 5
npm run bench:hook -- --terms 500 --runs 9  # other sizes
npm run bench:hook -- --hook /tmp/old.mjs   # compare another build of the hook
npm run bench:hook -- --after-write          # the first prompt after each lexicon add
npm run bench:hook -- --project-terms 200 --after-write project  # with a trusted repo lexicon, after add --project
npm run bench:hook -- --project-terms 200 --untrusted  # with a repo lexicon nobody trusted
npm run bench:hook -- --project-terms 200 --alternate  # switching between two trusted repos on every prompt
npm run bench:hook -- --terms 5000 --after-hand-edit  # the first SessionStart and prompt after editing the YAML by hand
```

Spawns a fresh `node` per run, as Claude Code does, against a lexicon in a temp
directory (HOME, XDG_CONFIG_HOME and LEXICON_PATH all point there). The cold run
is the first one after the lexicon is written and includes writing the caches;
warm runs read parse-cache.json, index-cache.json and the compile cache. Compare
best-of-N between builds on the same machine: the numbers move with load.

`--project-terms N` adds a `.lexicon.yaml` of N terms to the prompt's repo and
trusts it with `lexicon trust --yes`, so the hook matches the global and project
merge; with `--untrusted` the file is left untrusted, so the hook skips it.
`--alternate` adds a second trusted repo and alternates the warm prompts
between the two.
`--after-write` times, for each run, the first prompt after a
`lexicon add` (with `--after-write project`, `lexicon add --project`, which
needs `--project-terms`) and the add's own wall time: a first prompt slower
than the warm ones means the write left a cache stale for the hook to rebuild.
The CLI is `dist/cli/index.js` when built, else `src/cli/index.ts` through tsx.
`--after-hand-edit` appends a term to the global YAML directly, as an editor
would, and times the first SessionStart after it, then appends another and
times the first prompt; each run waits for the hook's background
`--refresh-cache` process to release its lock before the next edit.
