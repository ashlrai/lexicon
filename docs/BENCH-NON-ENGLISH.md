# Non-English name benchmark

Reproduce from the repository root after `npm install`:

```sh
node --import tsx scripts/bench-non-english.mjs > docs/BENCH-NON-ENGLISH.md
```

Add `--json` for every scored case, including misses. This report is generated; tests check drift.

35 distinct names across five languages, with 105 synthetic spelling variants curated from
[the existing generator](../bench/gen-corpus.ts) into [non-english.yaml](../bench/non-english.yaml).
All variants, including difficult misses, are scored against the unchanged [benchmark lexicon](../bench/lexicon.yaml).
Defaults: minConfidence 0.82, phonetic and fuzzy enabled. No matcher changes or user configuration.

A hit means the exact, case-sensitive canonical occurs in the output as often as expected (term recall).
Raw scores the input; aliases-only disables phonetic and fuzzy matching. Gap is English minus language in percentage points.

| Language | Names | Raw hits | Aliases-only hits | Default hits | Existing English hits | Gap (pp) |
|---|---:|---:|---:|---:|---:|---:|
| arabic | 7 | 0.00% (0/21) | 47.62% (10/21) | 90.48% (19/21) | 96.81% (303/313) | 6.33 |
| german | 7 | 0.00% (0/21) | 23.81% (5/21) | 66.67% (14/21) | 96.81% (303/313) | 30.14 |
| japanese | 7 | 0.00% (0/21) | 47.62% (10/21) | 76.19% (16/21) | 96.81% (303/313) | 20.61 |
| polish | 7 | 0.00% (0/21) | 33.33% (7/21) | 42.86% (9/21) | 96.81% (303/313) | 53.95 |
| spanish | 7 | 0.00% (0/21) | 33.33% (7/21) | 76.19% (16/21) | 96.81% (303/313) | 20.61 |

Overall default hits: 70.48% (74/105); aliases-only: 37.14% (39/105).

The English-sentence baseline is the existing 402 untagged cases (278 positives);
its proper nouns have mixed origins, so this is not a controlled English-origin-name comparison.
These are hand-written errors in English sentences, not real speech or native-language dictation.
Japanese and Arabic names use romanization. Configured aliases contribute to the score.
This focused fixture measures positive recovery only; [the full benchmark](BENCHMARK.md#non-english-names)
also measures sentence accuracy, precision and damage to clean prose.
