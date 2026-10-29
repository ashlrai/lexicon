# Startup measurement

`startup.mjs` is one manual run of Lexicon process startup. It is the command
behind the Lexicon CLI and library rows in
[docs/BENCHMARKS.md](../../docs/BENCHMARKS.md). Those rows are a single run
on one machine. Run the script again and the timings will differ.

From the repo root, after `npm run build`:

```bash
node scripts/bench/startup.mjs
```

Stdout is one JSON document. It includes the Node version, the OS, the CPU
count and model, and total memory, then:

- `version`: wall time of `node dist/cli/index.js --version` (1 warmup, then 11 runs) and peak RSS
- `normalize`: the same for `normalize --diff` of a sentence the built-in example corrects (1 warmup, then 21 runs)
- `library`: `normalize()` and `normalizeWithIndex()` on `bench/lexicon.yaml` (20 warmup, then 300 calls)

The CLI runs use an empty temporary home, `LEXICON_PATH` unset, and that home
as the working directory, so this repo's `.lexicon.yaml` is not loaded. Peak
RSS comes from `/usr/bin/time -v` on one extra run. If that binary is missing,
`peak_rss_kb` is null.

The install, espanso, and whisper.cpp rows in the same doc are not this
script. Each of those is a separate manual command, named next to the number.

# Non-English name accuracy (issue #8)

This text-only benchmark runs locally on the committed `bench/corpus.jsonl` and
`bench/lexicon.yaml`. The corpus includes hand-written STT-like errors for
non-English names, clean prose negatives, and an untagged comparison set. The
`lang` field identifies the non-English cases and their language groups; the
untagged cases are the existing baseline. The generated corpus is already
committed, so do not regenerate it for a comparison. See
[bench/README.md](../../bench/README.md) for the case format and how to add cases.
No audio, recognizer, network access, or personal transcripts are needed.

From the repository root, with Node 20+ and dependencies installed (`npm ci`),
record a baseline in a new directory outside the worktree:

```bash
bench_dir=$(mktemp -d)
git rev-parse HEAD > "$bench_dir/revision.txt"
git status --short > "$bench_dir/worktree-status.txt"
node --version > "$bench_dir/node-version.txt"
shasum -a 256 bench/corpus.jsonl bench/lexicon.yaml > "$bench_dir/inputs.sha256"
node --import tsx bench/run.ts --corpus bench/corpus.jsonl --lexicon bench/lexicon.yaml --out "$bench_dir/results.json" > "$bench_dir/report.md"
printf 'Baseline saved in %s\n' "$bench_dir"
```

Keep that directory with the benchmark record. `report.md` contains the readable
summary; `results.json` contains the configuration, counts, language breakdown,
and failing cases. The explicit `--out` keeps this run from overwriting the
committed `bench/results.json`. Record any uncommitted matcher changes alongside
the status file, or use a clean checkout so the revision identifies the code.

In the report's **Non-English subset** table, record term recall for the
untagged baseline, the full non-English subset, and each language group, along
with their numerator and denominator. Recall is the fraction of `(case,
canonical)` slots where the output contains the canonical at least as many
times as expected; raw recall applies the same rule to `heard` before Lexicon.
Compute the gap as non-English recall minus baseline recall in percentage
points. Also record precision and prose false-positive rate (negative sentences
with at least one replacement divided by negative sentences), including the
counts. These expose false corrections alongside recovered names. The table
includes `expected-hard` cases; the separate accuracy column excluding them
is a diagnostic, not a substitute for the inclusive metrics.

For a later run, save a new directory with the same command and compare the
reports, configuration, input hashes, counts, and failures. Compare a matcher
change on identical corpus and lexicon files; if either input changes, keep the
old results and label the new run as a new baseline. The untagged and tagged
sets contain different cases and names, so their gap is descriptive, not a
controlled estimate of language bias. The input errors are synthetic, so the
results measure this matcher on these examples, not real-world STT accuracy.
