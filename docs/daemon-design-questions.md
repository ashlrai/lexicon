# Resident expander design questions

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes an
espanso-style resident system-wide expander as a separate surface from the
CLI: it would expand text in the focused field across applications without an
agent in the loop. A resident process avoids a Node cold start per interaction.
The issue's espanso `list` figures are context, not a Lexicon measurement or
an interactive performance target.

This is a discovery list of open product and integration questions, not an
implementation plan or a promise of support. The issue does not settle the
choices below.

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
  client and server? Should either start at login or on demand, and how does
  a user tell whether expansion is active?
- How can a user pause, resume, or stop expansion and verify that it stopped?
- Should they remain running without active clients, and what should happen
  on logout, sleep, shutdown or an upgrade?
- What happens on a crash, disconnect, restart, protocol mismatch or revoked
  permission? Should input pass through unchanged while the server or client
  is unavailable? When should buffered state be discarded, and how does the
  user recover without losing or unexpectedly changing text?
- What is the instance boundary: per user, login session, project, or socket?
  How do concurrent sessions, multiple clients and updates interact with the
  server's per-connection buffers and socket ownership?

## Configuration and trust

- Where should users configure enablement, startup, per-app exclusions,
  sensitive-field handling and undo? What are the defaults, precedence,
  validation and migration rules for those settings?
- Which global and project lexicon, and which working directory, applies when
  focus moves between apps? How is project context selected without bypassing
  the existing trust gate or treating focus as implicit trust?
- When should configuration, lexicon and trust changes take effect while
  running? What happens to active input and cached state if a reload fails,
  configuration is invalid or the context changes?
- Which applications and fields should be excluded, especially secure fields
  or fields that cannot be identified safely? How are permissions requested,
  revoked, and reflected in the user's controls?
- What input, diagnostics or usage data, if any, may the client retain, and
  for how long? How can sensitive text be excluded before capture and kept
  out of logs?

## Interaction with existing surfaces

- How should live expansion coexist with clipboard watching, `--once` and
  `--paste`, including when text is copied or pasted during an expansion?
- What happens when the browser extension, an app's focused-field correction,
  a dictation tool, or an agent hook also processes the same text? How can
  duplicate corrections, feedback loops, and conflicting undo behavior be
  avoided?
- Should the expander share lifecycle, configuration, or transport with
  `lexicon serve`, the MCP server, or the tray apps, or remain independent?
  How would a failure or restart in one surface affect the others?
- How should CLI edits, imports, trust changes, and hit counts be reflected
  across processes without surprising users or bypassing the trust gate?
- What compatibility and fallback behavior should clients use across server
  versions? How can existing CLI and agent workflows continue when the
  expander is disabled or unavailable?

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

These questions do not assert that the proposed client, startup integration,
or cross-surface coordination has been implemented. For the server's current
behavior and the daemon half of the question list see
[daemon-surface-questions.md](daemon-surface-questions.md); platform-specific
input and editing questions are in
[expander-platform-questions.md](expander-platform-questions.md). Existing
platform coverage is described in [PLATFORMS.md](PLATFORMS.md).

Back to [the docs index](README.md).
