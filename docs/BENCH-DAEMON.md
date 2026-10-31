# Resident daemon read latency

Measured on 2026-10-30, macOS arm64, Apple M5 Max, Node v22.22.3.
The fixture contains 20 synthetic terms with one alias each, no project lexicon,
and an isolated temporary HOME/config/runtime directory. No user vocabulary is read.
Lexicon samples run `list --json`; espanso invocation details were not supplied.

| Path | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| CLI, resident daemon up, including fresh Node startup | 215.30 | 381.71 |
| Resident socket request, existing Node process | 3.19 | 85.04 |
| CLI, daemon absent (automatic fallback) | 1240.82 | 1615.73 |
| Original direct CLI entry point | 1396.03 | 2461.56 |
| espanso list baseline supplied in issue #220 | 15.9 | not supplied |

These are 50 sequential samples per path after 10 warmups, using nearest-rank
percentiles. CLI samples start a new Node process every time and capture stdout
and stderr through process exit, including normal deadline/fallback behavior.
The socket probe has a 1 s measurement ceiling and includes the same CLI
handler and fresh file/trust reads, but has no process startup. The benchmark
checks direct/daemon output equality before timing and also measures the CLI
with the daemon absent and the original direct entry point.

The host was shared with test workloads. A subsequent load snapshot was about
110 load-average tasks for 18 available CPUs, so these are loaded-host measurements. The espanso figure was supplied with
the task and was not remeasured on this machine. This is a latency comparison,
not evidence of a same-machine competitive win: the resident request is below
15.9 ms at p50, while the full CLI still pays for Node startup. Daemon probes
have a 100 ms total deadline; a slow or unavailable daemon falls back silently.

Reproduce from the repository root:

```bash
npm run build
node bench/daemon-latency.mjs
```

The script starts and stops its own resident server, prints only timing metrics,
and deletes its fixture. It measures daemon-up CLI, resident socket, daemon-absent
CLI, and direct CLI in that order. File exports, writes, help, stdin commands,
and incompatible daemon contexts retain the ordinary CLI path. See
[DAEMON.md](DAEMON.md#resident-expander-opt-in) for supported reads and fallback.
