# Scope: resident system-wide expander

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) requests an
espanso-style expander as a separate surface from the CLI: a resident process
expands text in the focused field across applications, without an agent in the
loop. Keeping a process resident addresses repeated Node cold starts. This is
a scope for future design, not a claim that the experience is available.

The issue cites an espanso `list` measurement of 15.9 ms p50 and 34,016 kB;
the Lexicon daemon was not measured in that comparison. These numbers are
context, not targets or interactive expansion results. The separate
[daemon benchmark](BENCH-DAEMON.md) measures the existing server.

## Current boundary

| Surface | What it does | Boundary |
| --- | --- | --- |
| CLI and agent integrations | Accept supplied text or provide correction context. | They do not deliver the requested system-wide typing experience. |
| `lexicon daemon` | By default, watches and corrects the clipboard. | Copying and pasting is a different workflow from editing the focused field. |
| `lexicon daemon --expander` | Runs an opt-in resident local socket server with an in-memory lexicon and an expansion core. | It returns actions to a client; it does not capture system-wide input or edit fields. Nothing starts it automatically. |

The current core matches exact aliases on whitespace and can undo an
expansion with an immediate Backspace. A platform client must observe input
and focus, communicate with the server, and apply edits safely. That client
and its integration are not implemented by the server; system-wide expansion
is not yet available through it. The [daemon guide](DAEMON.md#resident-expander-opt-in)
and [module contract](CONTRACT.md#separate-process-boundary-issue-220) describe
the existing protocol and behavior.

## Open decisions

The issue does not specify platforms, APIs, startup policy, matching rules or
performance targets. The following are questions for design and validation,
not decisions attributed to the issue:

- **Platforms and input:** Which macOS, Windows, X11 and Wayland environments
  and applications will be supported? Which APIs can observe focus and input
  and apply edits, including during IME composition, selection and navigation?
- **Privacy and permissions:** What permissions are required and how are
  denial or revocation handled? How are sensitive fields and excluded apps
  identified before input is collected, including when identification fails?
- **Edit safety:** How are focus changes, stale responses, injected input,
  partial edits and differing Backspace semantics handled? How can users undo
  an incorrect expansion?
- **Lifecycle:** Who installs, starts, discovers, pauses, supervises and
  stops the client and server? What happens on disconnect, crash, restart,
  incompatible protocol versions or unavailable permissions?
- **Configuration and coexistence:** Which lexicon and trusted project context
  apply to a focused application? How do reloads and the clipboard watcher,
  browser extension and desktop apps interact with the new surface?
- **Validation:** What application and platform matrix, failure tests, and
  end-to-end latency and memory measurements justify a support claim?

The [platform questions](expander-platform-questions.md) and
[daemon questions](daemon-surface-questions.md) expand these choices; the
[boundary map](expander-boundary-map.md) compares existing integrations.

Back to [the docs index](README.md).
