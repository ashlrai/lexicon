# Resident expander design questions

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes an
espanso-style resident system-wide expander as a separate surface from the
CLI: it would expand text in the focused field across applications without an
agent in the loop. A resident process avoids a Node cold start per interaction.
The issue's espanso `list` figures are context, not a Lexicon measurement or
an interactive performance target.

This is a discovery list, not an implementation plan or a promise of support.
The issue does not settle the choices below.

## What exists today

The default `lexicon daemon` watches the clipboard. The opt-in
`lexicon daemon --expander` runs a resident local socket server that returns
expansion actions to a client. The core matches exact aliases on whitespace
and supports immediate Backspace undo. Neither the server nor the core
captures system input or applies edits to a focused field; a system-wide
expander client is not implemented. Starting the server does not install or
start one. See [DAEMON.md](DAEMON.md#resident-expander-opt-in) for the
current protocol and [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220)
for its boundary.

## Lifecycle

- Who installs, starts, discovers, pauses, resumes, supervises and stops the
  client and server? Should either start at login, and how does a user tell
  whether expansion is active?
- What happens on a crash, disconnect, restart, protocol mismatch or revoked
  permission? When should buffered state be discarded, and how does the user
  recover without losing or unexpectedly changing text?
- How do concurrent sessions, multiple clients and updates interact with the
  server's per-connection buffers and socket ownership?

## Configuration and trust

- Which global and project lexicon applies when focus moves between apps? How
  is project context selected without bypassing the existing trust gate?
- How are configuration changes and trust revocation picked up while running,
  and what should happen if a reload fails or configuration is invalid?
- Where should users configure enablement, per-app exclusions, sensitive-field
  handling and undo? What happens when a field cannot be identified safely?
- What input, diagnostics or usage data, if any, may the client retain? How
  can sensitive text be excluded before capture and kept out of logs?

## Platform support and safe editing

- Which macOS, Windows, Linux X11 and Wayland environments and applications
  should be supported? Which capture and edit APIs and permissions work in
  each, and how are permission denial and revocation surfaced?
- How are focus changes, selections, cursor movement, paste, shortcuts and
  IME composition reflected in the buffer? How does a client avoid processing
  its own injected input?
- How can the client verify focus and text before applying an action, handle
  partial edits and provide undo when a field's Backspace behavior differs
  from the core's grapheme count?
- What automated and real-desktop checks, application matrix, latency and
  memory measurements would justify a support claim? Server-only benchmarks
  do not measure the complete focused-field interaction.

For deeper questions see [daemon-surface-questions.md](daemon-surface-questions.md)
and [expander-platform-questions.md](expander-platform-questions.md). Existing
platform coverage is described in [PLATFORMS.md](PLATFORMS.md).

Back to [the docs index](README.md).
