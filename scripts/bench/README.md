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
