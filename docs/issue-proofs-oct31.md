# Issue proofs, October 31

Checked against main at `5457b3ebd9ff86d9f6fabfb2b481333f613957e5`. The issue texts are [#8](https://github.com/ashlrai/lexicon/issues/8) and [#219](https://github.com/ashlrai/lexicon/issues/219). Tests below name the relevant assertions, not just files containing related code.

## Issue 8: non-English benchmark

| Acceptance item | File evidence | Test evidence |
|---|---|---|
| Add 30 to 50 names across at least four families and garbled cases | [Lexicon](../bench/lexicon.yaml), [generator](../bench/gen-corpus.ts), [edge cases](../bench/cases/nonenglish.jsonl); [report](BENCHMARK.md#the-fixture) describes 42 terms across six groups | [bench/bench.test.ts](../bench/bench.test.ts), `has the non-English fixture: >= 30 names across >= 4 language families` and `every positive case's terms exist in bench/lexicon.yaml` |
| Prefer real transcripts when available | [Report caveat](BENCHMARK.md#the-fixture) identifies these as synthetic and points to the audio harness; audio is a suggestion in the issue, not a requirement | [bench/non-english.test.ts](../bench/non-english.test.ts), `scores every variant, retains misses, and recomputes the existing baseline` exercises the separate synthetic fixture |
| Mark expected misses as `expected-hard`, preserving comparable headline numbers | [Cases](../bench/cases/nonenglish.jsonl), [generator](../bench/gen-corpus.ts), and [report](BENCHMARK.md#measured) document hard cases and the untagged baseline | [bench/bench.test.ts](../bench/bench.test.ts), `measures the non-English gap without flattering it` requires all remaining subset failures to be hard; `keeps the baseline identical to the pre-fixture corpus` checks baseline size |
| Run the sweep and report subset recall and precision beside English numbers | [Benchmark report](BENCHMARK.md#measured) gives baseline and language breakdowns; [focused report](BENCH-NON-ENGLISH.md) separately reports term recall and its limitations | [bench/bench.test.ts](../bench/bench.test.ts), `reports comparable baseline, tagged and per-language measurements` and `measures the non-English gap without flattering it`; [bench/non-english.test.ts](../bench/non-english.test.ts), `reproduces the committed report from outside the checkout` |

The baseline is the existing untagged corpus, not a controlled English-origin name sample. The audio benchmark was not required or run for this review.

## Issue 219: mutation previews

| Command | File evidence | Test evidence |
|---|---|---|
| `add` | [commands.ts](../src/cli/commands.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `add previews new and merged terms without creating or replacing the lexicon` |
| `remove` | [commands.ts](../src/cli/commands.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `remove previews a whole term or one alias while preserving the file` |
| `learn` | [cmd-learn.ts](../src/cli/cmd-learn.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `learn previews a $action without changing persisted data` |
| `init` | [commands.ts](../src/cli/commands.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `init plans missing global and project files without creating or trusting them` |
| `untrust` | [cmd-trust.ts](../src/cli/cmd-trust.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `untrust reports the intended removal without changing trust data` |
| Built-in `pack add` | [cmd-pack.ts](../src/cli/cmd-pack.ts) | [cli-dry-run.test.ts](../tests/cli-dry-run.test.ts), `built-in pack previews preserve %s state and report independent results` |

[tests/dry-run-plans.test.ts](../tests/dry-run-plans.test.ts) checks `ok: true`, `plan: true`, `dryRun: true` and unchanged files for each command. [tests/cli-dry-run-flag.test.ts](../tests/cli-dry-run-flag.test.ts) checks both scopes and compares each preview with the subsequent write. The same test checks that pack results use an array while the other previews use a top-level object.

**Gap:** setup emits an object with top-level `ok` and `plan`; built-in `pack add --dry-run --json` emits an array of objects with those fields per result. The other command previews (add, remove, learn, init and untrust) each emit a top-level object. The pack preview therefore does not have the same top-level shape requested by the issue. Changing the established multi-pack JSON response is an API decision beyond a small proof-only change, so issue 219 is not claimed complete here.
