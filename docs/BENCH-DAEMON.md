# Resident daemon read latency

Measured on 2026-10-31, macOS arm64, Apple M5 Max, Node v26.9.0.
The fixture contains 20 synthetic terms with one alias each, no project lexicon,
and an isolated temporary HOME/config/runtime directory. No user vocabulary is read.
Lexicon samples run `list --json`; espanso invocation details are in
[BENCHMARKS.md](BENCHMARKS.md) and the figures themselves come from issue #220.

| Path | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| CLI, resident daemon up, including fresh Node startup | 2248.55 | 3114.54 |
| Resident socket request, existing Node process | 3.61 | 290.99 |
| CLI, daemon absent (automatic fallback) | 8690.57 | 13166.96 |
| Original direct CLI entry point | 8654.00 | 12086.51 |
| espanso list baseline supplied in issue #220 | 15.9 | not supplied |

These are 50 sequential samples per path after 10 warmups, using nearest-rank
percentiles. CLI samples start a new Node process every time and capture stdout
and stderr through process exit, including normal deadline/fallback behavior.
The socket probe has a 1 s measurement ceiling and includes the same CLI
handler and fresh file/trust reads, but has no process startup. The benchmark
checks direct/daemon output equality before timing and also measures the CLI
with the daemon absent and the original direct entry point.

## Gap to the espanso baseline

Issue #220 supplies the espanso side: `match list` at 15.9 ms p50 and 34,016 kB
peak RSS. The resident expander side, from the same run as the table above:

| | espanso `match list` (issue #220) | resident expander, this run |
| --- | ---: | --- |
| latency, p50 | 15.9 ms | resident socket request, 3.61 ms |
| memory, peak RSS | 34,016 kB | resident daemon, 93,904 kB |

The latency figure is `tryFastRead` against the live socket, as in the table
above. The memory figure is the peak RSS a real `lexicon daemon --expander`
child reports about itself while serving warmed `cli-read` requests. espanso's
34,016 kB is the GNU time peak of one `match list` run on the Ubuntu VM in
[BENCHMARKS.md](BENCHMARKS.md), so the memory comparison is a resident process
against a one-shot invocation, which is the trade the issue names.

The latency gap is closed at the socket: the resident request sits under the
15.9 ms p50 while every full CLI path still pays Node startup. The memory gap
runs the other way: the resident Node process holds about 2.8x espanso's
34,016 kB. Closing the latency gap is the resident process, not another Node
cold start; the standing RSS is the price of keeping it resident.

The host was shared with test workloads. Load snapshots during this run were
200 to 260 load-average tasks for 18 available CPUs, so these are loaded-host
measurements: the CLI rows are inflated far above an idle machine's, while the
socket p50 still sits under the espanso figure. The espanso figures were
supplied with the issue and were not remeasured on this machine. This is a
latency and memory comparison, not evidence of a same-machine competitive win.
Daemon probes have a 100 ms total deadline; a slow or unavailable daemon falls
back silently.

Reproduce from the repository root:

```bash
npm run build
node bench/daemon-latency.mjs
```

The script starts and stops its own in-process server for the socket samples,
spawns a real `lexicon daemon --expander` child for the peak-RSS line, prints
only timing and memory metrics, and deletes its fixture. It measures daemon-up
CLI, resident socket, resident daemon RSS, daemon-absent CLI, and direct CLI in
that order. File exports, writes, help, stdin commands, and incompatible daemon
contexts retain the ordinary CLI path. See
[DAEMON.md](DAEMON.md#resident-expander-opt-in) for supported reads and fallback.
