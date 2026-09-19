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

## Files

| file | what |
|---|---|
| `lexicon.yaml` | 70 terms a founder/dev would keep. ~30% deliberately have no aliases so the phonetic and fuzzy passes are what gets measured for them. No `never` lists, no settings: the naive out-of-the-box configuration. |
| `gen-corpus.ts` | Deterministic generator (seeded PRNG, templates x heard-variants). Writes `corpus.jsonl`. |
| `cases/negatives.jsonl` | Hand-written clean prose that must not change: sound-alikes (`pass the sauce`, `red is my favorite color`), code spans, fences, URLs, emails, paths. |
| `cases/hard.jsonl` | Hand-written cases we expect to fail, each with a diagnosis in `note`. |
| `cases/positives.jsonl` | Hand-written positives that mix code/URLs with prose, punctuation, multi-line input. |
| `corpus.jsonl` | Generated output. Committed so the numbers are reproducible without regenerating. |
| `lib.ts` | Loading + metrics. `run.ts` (CLI) and `bench.test.ts` both import it so they cannot disagree. |
| `results.json` | Last run: summary, sweep, every failing case. |

## Case format

One JSON object per line:

```json
{"id":"pos-042","category":"product","heard":"add a pie dantic model for the sync job","expected":"add a Pydantic model for the sync job","terms":["Pydantic"],"note":"optional"}
```

- `category`: `brand | person | product | acronym | identifier | prose`
- `heard`: what STT produced. `expected`: what the user meant.
- `terms`: canonicals that must appear in `expected`. Empty array = negative (nothing may change).
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
- **Latency**: warm mean per case over 5 rounds; `normalize()` includes `buildIndex()` (what the hook
  pays per prompt), `findReplacements()` uses a prebuilt index.

The corpus is sampled from STT failures by construction, so raw recall is low by design; the
meaningful before/after number is term recall, and the honesty check is the prose FP rate.

## Adding cases

- A new misheard spelling of an existing term: add it to that term's `heard` list in
  `gen-corpus.ts` (and to `lexicon.yaml` if you want the alias pass to handle it), then
  `node --import tsx bench/gen-corpus.ts`.
- A new term: add it to `lexicon.yaml` and to `TERMS` in `gen-corpus.ts`.
- A negative or hard case: append a line to `cases/negatives.jsonl` or `cases/hard.jsonl`,
  then regenerate. Prefix `note` with `expected-hard: ` if you expect it to fail.
- Templates must be inert: the generator fails loudly if a template mutates on its own with a
  neutral placeholder, because that would contaminate every case built from it. Words that have
  tripped it so far: `suite`, `said the`, `email`, `noon` (see BENCHMARK.md).

After a matcher change: `npm run bench -- --sweep`, commit the new `results.json`, update the
numbers in `docs/BENCHMARK.md`, and move the thresholds in `bench.test.ts` if they changed
deliberately.
