# Benchmarks against comparable tools

A same-machine comparison of Lexicon with two open-source tools that cover
adjacent parts of the same job: fixing the words speech-to-text gets wrong.
The accuracy study (corpora, the 91.0% figure, failing cases) stays in
[BENCHMARK.md](BENCHMARK.md). This page is install time, latency, memory, and
a small fixed task set. Every number below is from one manual run on
this VM on 2026-10-26. The Lexicon CLI and library rows are one run of
`node scripts/bench/startup.mjs` ([usage](../scripts/bench/README.md)).
The install, espanso, whisper.cpp, and task-set rows are separate manual
commands, named in the table. None of these timings is a committed baseline:
run the script again and the startup numbers will differ.

## What each tool is

| | Lexicon | espanso | whisper.cpp |
| --- | --- | --- | --- |
| Job measured here | Rewrite a transcript after speech-to-text, using aliases, phonetic match and fuzzy match | Expand an exact trigger the user typed | Transcribe audio, with an optional text prompt that biases the decoder |
| Source | this repo, plus the published npm package `@ashlr/lexicon` 0.5.4 | [espanso/espanso](https://github.com/espanso/espanso) | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| License | MIT | GPL-3.0 | MIT |
| Release used | source tree `0.5.6` for the library and the source CLI; npm `0.5.4` for the install path | 2.4.1 (GitHub release published 2026-09-02; `espanso --version` prints `2.4.1`) | binary prints `whisper.cpp version: 1.9.5`. The GitHub release `v1.9.5` (published 2026-10-06) lists no assets. Model file `ggml-tiny.en.bin`, 77,704,715 bytes |

License identifiers are `license.spdx_id` from
`https://api.github.com/repos/espanso/espanso` and
`https://api.github.com/repos/ggml-org/whisper.cpp`, fetched 2026-10-26.

Why these two: espanso is the widely used open-source text expander (exact
trigger in, replacement out), which is the same shape as Lexicon's alias tier
and as the "exact-string substitution" row in [BENCHMARK.md](BENCHMARK.md).
whisper.cpp is the open-source recognizer Lexicon already shells out to for
`lexicon voice`, and its `--prompt` flag is the in-recognizer way to bias
proper nouns. Neither tool is a drop-in replacement. The gaps are listed
after the tables.

## Machine

- Ubuntu 24.04.5 LTS, 4 CPUs (`nproc`), `/proc/cpuinfo` model name `Intel(R) Xeon(R) Processor`, `MemTotal` 16,387,280 kB.
- Node v22.23.4, npm 10.9.9, already installed. The installer measurements do not include installing Node.
- Latency is wall time around the process, one warmup discarded, then the run count in the table. p50 is the median. Peak RSS is GNU time's "Maximum resident set size" for one run of the same command.
- No other lexicon, espanso or whisper process was part of the timed command. Homes and npm prefixes used for these runs were empty directories under `/tmp`.

## Install and first result

One manual run each. The command is the first column. These rows are not
`scripts/bench/startup.mjs`.

| step | wall time | what came back |
| --- | --- | --- |
| `curl -fsSL https://ashlrai.github.io/lexicon/install.sh \| sh`, no TTY, Node already on `PATH` | 2.977 s | exit 0, `installed lexicon 0.5.4`, then `no terminal to ask the setup questions on; run: lexicon setup` |
| `npm install -g @ashlr/lexicon@0.5.4` into an empty prefix and an empty npm cache | 2.45 s | `added 100 packages in 2s`. Peak RSS of that npm process: 179,276 kB |
| `lexicon setup --yes` (published 0.5.4), blank home, current directory not a git repo | 0.21 s | exit 0. Prints `Ashler` corrected to `Ashlr.AI` using the built-in example, and writes an empty `~/.config/lexicon/lexicon.yaml`. Peak RSS 91,376 kB |
| same `lexicon setup --yes` a second time | exit 0 | `termsAdded` is an empty list. The file is left in place |
| espanso 2.4.1 X11 AppImage, extracted, `match list` after a config directory exists | list itself 15.9 ms p50 | see below. The worker (`match exec`) did not start: no display |
| whisper.cpp binary tarball, 10,364,195 bytes | curl transfer 0.182 s | `whisper-cli --version` prints `1.9.5` |
| `ggml-tiny.en.bin`, 77,704,715 bytes | curl transfer 0.548 s | first transcription of a 2.4 s clip, below, 435 ms p50 |

The curl transfer times are what `curl` reported on this VM. They are not a
claim about a home connection. The npm figure is the one that includes
resolving and unpacking the package.

From the README one-liner to a printed correction, on this VM, with Node
already present and no TTY: 2.977 s to install, then 0.21 s for `lexicon setup --yes`.
That is under 60 s. Detail and the places the docs disagreed with that run
are in [FIRST-RUN.md](FIRST-RUN.md).

## Core operation

Lexicon source CLI and library rows: one run of `node scripts/bench/startup.mjs`
on 2026-10-26. The script's JSON for that run is what this table rounds.
Sample sizes are the script defaults (1 warmup then 11 `--version` runs, 1
warmup then 21 `normalize` runs, 20 warmup then 300 library calls). The CLI
runs used an empty temporary home, `LEXICON_PATH` unset, and that home as the
working directory. Peak RSS is `/usr/bin/time -v` on one extra run.

The published 0.5.4 row is a different manual command, not the script:
`lexicon normalize "tell Ashler to ship it"` with an empty home, 1 warmup
then 21 runs. espanso and whisper.cpp are the manual commands in the last
two rows.

| tool | command | n | p50 | min | p95 or max | peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| Lexicon source CLI | `normalize --diff` of `ask ashler to deploy kuber netties with post gressql` | 21 | 170.5 ms | 163.1 ms | p95 181.3 ms | 86,364 kB |
| Lexicon source CLI | `--version` | 11 | 157.0 ms | 154.4 ms | p95 165.5 ms | 83,440 kB |
| Lexicon 0.5.4 CLI | `normalize` of `tell Ashler to ship it`, empty lexicon (manual, not the script) | 21 | 148.3 ms | 140.6 ms | p95 191.4 ms | 83,876 kB |
| Lexicon library | `normalize()` on `bench/lexicon.yaml` (70 terms), which builds the index every call | 300 | 0.862 ms | 0.645 ms | p95 1.397 ms | in-process |
| Lexicon library | `normalizeWithIndex()` on the same sentence and a prebuilt index | 300 | 0.028 ms | 0.026 ms | p95 0.039 ms | in-process |
| espanso 2.4.1 | `match list` with two triggers (manual) | 21 | 15.9 ms | 14.5 ms | p95 17.5 ms | 34,016 kB |
| whisper.cpp 1.9.5, `tiny.en` | `whisper-cli -m ggml-tiny.en.bin -f prose.wav -nt -np` (manual) | 5 | 435 ms | 410 ms | max 462 ms | 177,872 kB |

`normalize()` calls `buildIndex` on every call (`src/core/normalize.ts`), so
the 0.862 ms figure is index build plus match. The match alone, against an
index the caller kept, is the 0.028 ms row.

On this run, `--version` (no matching) is 157.0 ms p50 and 83,440 kB.
`normalize --diff` of a sentence with three replacements is 170.5 ms p50.
The difference of those two medians is 13.5 ms. That is the work past
process startup for this sentence, on this run.

espanso's `match exec` (actually expanding a trigger) exited 1 with
`Worker process is not running, please start Espanso first.` Starting the
service needs a display. This VM has none: the binary prints
`Authorization required, but no authorization protocol specified` when
`DISPLAY` is unset. `match list` is the core operation that runs here. The
first `match list`, before `config/default.yml` existed, panicked with
`missing config directory` (exit 101). After that file and `match/base.yml`
were written, `match list` printed the two triggers.

The whisper clip is a 2.4 s, 22050 Hz mono wav from `espeak-ng -s 140 -w`
(eSpeak NG 1.51) of `I will ship the update tomorrow`. The transcript was
`I will ship the update tomorrow.`

## Quality on one fixed task set

Lexicon column: source `normalize --json` with `LEXICON_PATH` set to
`bench/lexicon.yaml` (70 terms, several of them deliberately alias-free so
phonetic and fuzzy are what can fire). Exact column: a separate longest-alias
substitution over that same alias list, word characters as boundaries. It is
the espanso-shaped job (a trigger table), not espanso's daemon, which could
not expand text here. Case-sensitive is how an espanso trigger matches by
default. Case-insensitive is the more generous reading of the same table.

| input | Lexicon output | exact, case-sensitive | exact, case-insensitive |
| --- | --- | --- | --- |
| `tell Ashler to ship it` | `tell Ashlr.AI to ship it` (alias 1.00) | `tell Ashlr.AI to ship it` | same |
| `deploy to head sner with cuban eatties` | `deploy to Hetzner with cuban eatties` (phonetic 0.87). `cuban eatties` is not a term in this file | unchanged | unchanged |
| `ping ashler about the cooper netties migration` | `ping Ashlr.AI about the Kubernetes migration` (alias 1.00, phonetic 0.85) | unchanged (`ashler` is not the cased alias `Ashler`) | `ping Ashlr.AI about the cooper netties migration` |
| `can you ask Mason Wiatt where the Ashler migration landed` | `can you ask Mason Wyatt where the Ashlr.AI migration landed` (fuzzy 0.91, alias 1.00). `Mason Wiatt` is not an alias; the aliases are `mason white`, `mason wyat`, `mason why it`, `mason wyett` | only `Ashler` changes | only `Ashler` changes |
| `I will ship the update tomorrow` | unchanged | unchanged | unchanged |
| `the sauce is off the heat` | unchanged (`sass` is on the stoplist; this file gives SaaS no aliases) | unchanged | unchanged |
| `tell the other team to use a common pattern` | unchanged | unchanged | unchanged |

Six proper-noun slots were in play (Ashlr.AI three times, Hetzner, Kubernetes,
Mason Wyatt). Lexicon recovered 6 of 6. Case-insensitive exact alias
substitution recovered 3 of 6. Case-sensitive exact recovered 2 of 6. Clean
prose wrongly changed: 0 of 3 sentences, all three ways.

That 6-of-6 number is this file and these seven sentences. It is not the
91.0% figure in [BENCHMARK.md](BENCHMARK.md), which is 330 synthesized clips
through whisper.cpp `small.en`.

### whisper.cpp `tiny.en` on four synthesized clips

Same VM, eSpeak NG 1.51, `espeak-ng -s 140 -w`, then `whisper-cli` with
`ggml-tiny.en.bin`, `-nt -np`. The prompt, when used, was the literal
`Ashlr.AI, Kubernetes, Hetzner, Mason Wyatt, SaaS`. `tiny.en` is the smallest
English model. [BENCHMARK.md](BENCHMARK.md) uses `base.en` and `small.en` and
is the study to cite for accuracy. This table is what this VM produced.

| spoken | raw transcript | with `--prompt` |
| --- | --- | --- |
| tell Ashlr to ship it | Tell Ashla to ship it. | Tellashlr to ship it. |
| deploy to Hetzner with Kubernetes | Deploy to Hats are with Cuba needs. | Deployed to Hetzner with Kubernete. |
| ping Mason Wyatt about the SaaS pricing | Being made some wire to mount the SRS rising. | being Mason Wyatt, I'm out in the SaaS rising. |
| I will ship the update tomorrow | I will ship the update tomorrow. | I will ship the update tomorrow. |

The prompt run recovered the strings `Hetzner`, `Mason Wyatt` and `SaaS`.
It did not recover `Ashlr.AI` or `Kubernetes` (`Kubernete` is one character
short, and the Ashlr clip glued the name onto `Tell`). The prose clip was
unchanged. Four clips is too few to turn into a rate. The point of the row is
the shape of the gap: a prompt can pull a name into the transcript, and it
can also rewrite the rest of the sentence while it does that.

Lexicon does not compete with that pass. It runs after a transcript exists.
On the bench lexicon, `head sner` becomes `Hetzner` and `cooper netties`
becomes `Kubernetes` with no audio and no prompt budget. A prompt cannot fix
a transcript that some other recognizer already wrote.

## Feature gaps

Lexicon does not do, and these tools do:

- espanso expands a trigger in whatever text field has focus, once its
  service is running. Lexicon does not. The surfaces that come closest
  (`lexicon daemon`, the macOS menu bar app, the browser extension) are
  separate programs, and the daemon was not what this page timed.
- espanso is a native binary, and Lexicon starts Node. For scale only (the
  two commands do different work, so this is not a like-for-like
  comparison): espanso `match list` was 34,016 kB and 15.9 ms p50, and the
  Node process behind Lexicon `--version` was 83,440 kB and 157.0 ms p50.
  The Lexicon library call, once Node is up, is 0.028 ms p50 with a built
  index.
- whisper.cpp turns audio into text. Lexicon does not, except by shelling
  out inside `lexicon voice`. A prompt biases the decoder before the
  transcript exists, which a post-pass cannot do. Stacking them is the
  result already reported in [BENCHMARK.md](BENCHMARK.md) (95.7% on
  `small.en` with prompt hints plus the lexicon).

These tools do not do, and Lexicon does:

- espanso, and the exact-alias column above, miss a hearing that was never
  written down as a trigger. On this task set that is `head sner`,
  `cooper netties` and `Mason Wiatt`.
- espanso has no agent protocol, no project trust file, and no "leave this
  prose alone" stoplist. Its match list is the whole configuration.
- whisper.cpp `tiny.en` with a five-name prompt still missed `Ashlr.AI` and
  `Kubernetes` on these clips, and it rewrote sentences that contained the
  names it did get. It will not correct a transcript that arrived from
  somewhere else.
- The Lexicon CLI and the MCP server answer an agent with `--json`, a
  `nextStep` on failure, and strict tool schemas. Neither comparison tool
  has that surface. The audit is in [FIRST-RUN.md](FIRST-RUN.md).

## Reproduce

Lexicon CLI and library rows:

```bash
npm run build
node scripts/bench/startup.mjs
```

Usage, sample sizes, and what the JSON fields are:
[scripts/bench/README.md](../scripts/bench/README.md). The numbers above are
the one run taken for this page, not a checked-in result file.

espanso 2.4.1 here was the X11 AppImage extracted with `--appimage-extract`,
then one manual timing of `match list` (1 warmup, then 21 runs) with `HOME`
pointed at a directory that already contains `config/default.yml` and
`match/base.yml`. Peak RSS was `/usr/bin/time -v` on one extra `match list`.
whisper.cpp was one manual timing of `whisper-cli` from the Ubuntu x64
binary build that prints version 1.9.5, model `ggml-tiny.en.bin`, audio from
`espeak-ng -s 140 -w` of `I will ship the update tomorrow` (1 warmup, then
5 runs). The 0.5.4 CLI row is one manual timing of the `lexicon` binary
`npm install -g` put on `PATH`.
