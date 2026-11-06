# Daemon surface scope

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) asks for an
espanso-style system-wide expander as a separate product surface: a resident
process expands text in the focused field across applications, without an
agent in the loop. The resident process addresses the cost of a Node cold
start for each interaction. The issue calls `lexicon daemon` a start, not a
completed system-wide expander.

The issue cites espanso's `list` result of 15.9 ms p50 and 34,016 kB. It did
not measure the Lexicon daemon. Those numbers are context for a different
operation, not a target or an end-to-end expansion guarantee. See
[BENCH-DAEMON.md](BENCH-DAEMON.md) for the resident server's own measurements.

## Existing behavior and the gap

| Surface | What exists today | Relationship to the request |
| --- | --- | --- |
| `lexicon daemon` | By default it polls and corrects the clipboard. `--once` handles one clipboard value; `--paste` can paste it on macOS. | Copying and pasting is a separate workflow from expansion in a focused field. |
| `lexicon daemon --expander` | An opt-in resident process keeps a lexicon in memory and serves newline-delimited JSON over a local Unix socket or Windows named pipe. | It supplies a server, not a system-wide input or editing client. Nothing starts it automatically. |
| Expansion core | Each connection has a buffer. By default, exact aliases expand when whitespace completes a word; the server returns a backspace count and insertion text. Immediate Backspace can undo an expansion. | A client must observe input and apply the returned action. Neither the core nor the server captures system-wide input or edits a field. |
| CLI, agent and desktop integrations | CLI and MCP accept supplied text; the hook adds context. The desktop apps have their own focused-field paths. | These are separate integrations, not clients of the expander socket, and do not establish the requested typing experience. |

System-wide expansion through the resident server is not yet an available
feature: a platform client and its integration with the server are still
needed. The current protocol and security details are documented in
[DAEMON.md](DAEMON.md#resident-expander-opt-in); the other surfaces and their
limits are mapped in [expander-boundary-map.md](expander-boundary-map.md).

## Decisions still open

The issue does not specify platforms, supported applications, input APIs,
matching rules, permissions, lifecycle, or performance targets. In particular,
future work must decide and validate:

- How to observe focus and input and safely edit fields across operating
  systems, applications, input methods, selections and cursor changes.
- How to exclude sensitive fields, handle permission denial and revocation,
  avoid processing injected input, and recover from failed or stale edits.
- How to install, start, pause and stop the client and server, choose lexicon
  and trusted project context, and recover from disconnection or restart.
- Which platform and application tests and end-to-end latency and memory
  measurements support a future availability claim.

These are questions for design and validation, not requirements settled by
the issue or promises made by the existing server. See
[daemon-surface-questions.md](daemon-surface-questions.md) and
[expander-platform-questions.md](expander-platform-questions.md) for the
server and platform discovery lists.

Back to [the docs index](README.md).
