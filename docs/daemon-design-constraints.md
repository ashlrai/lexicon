# Resident expander design constraints

This note translates [issue #220](https://github.com/ashlrai/lexicon/issues/220)
into a boundary for future design. It distinguishes the experience requested
by the issue, behavior the repository already implements, and choices that
remain open. It does not approve a platform implementation or promise support.

## Requested surface

The issue asks for an espanso-style, resident system-wide expander: text in
the focused field across applications can be expanded without an agent in the
loop. It is a separate surface from the CLI, and `lexicon daemon` is a start,
not the whole product. Keeping a process resident addresses the motivation of
avoiding a Node cold start for each interaction.

The issue quotes espanso's `list` measurement (15.9 ms p50 and 34,016 kB),
but the Lexicon daemon was not measured there. Those figures are context, not
an interactive latency target or a claim about this implementation. See
[BENCH-DAEMON.md](BENCH-DAEMON.md) for the separately measured server.

## Existing boundary

The default `lexicon daemon` watches copied text. The opt-in
`lexicon daemon --expander` instead runs a resident local socket server and
returns expansion actions to a client. It does not capture system input or
apply edits to a focused field. Installing the CLI or starting that server
does not install a system-wide expander client; the requested end-to-end
surface is not yet available.

The current server accepts newline-delimited JSON over a local Unix socket or
Windows named pipe, with a separate buffer per connection. The pure core
matches exact aliases when whitespace completes a word and returns a
grapheme-counted backspace action and insertion text; immediate Backspace
can undo an expansion. The server does not log typed text. Its existing
transport, lifecycle and security details are in
[DAEMON.md](DAEMON.md#resident-expander-opt-in), and its module contract is in
[CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220). These are
current behavior, not a settled specification for every platform client.

The clipboard watcher, CLI, agent integrations, browser extension and existing
desktop apps have different input and editing boundaries. None establishes
that this socket server provides system-wide expansion. See the
[boundary map](expander-boundary-map.md) for the distinctions.

## Open design decisions

The issue does not decide the following. A future implementation must resolve
and validate them without treating the current protocol as proof of an
end-to-end experience:

| Area | Decisions and evidence needed |
| --- | --- |
| Platform and input | Which operating systems, applications and Linux display environments are supported? Choose and validate capture and edit APIs, including focus, selection, cursor movement, paste, shortcuts and IME composition. |
| Safe edits | Decide how to check that focus and text still match before applying an action, avoid processing injected input, handle partial or failed edits, reconcile buffer state and provide undo. A grapheme count alone does not prove a field's Backspace semantics. |
| Privacy and permissions | Decide how permission requests, denial and revocation work; identify excluded applications and sensitive fields before collecting input, including when a field cannot be identified. Define client logging and retention without weakening the server's existing no-typed-text logging behavior. |
| Lexicon and trust | Choose which lexicon and project context a system-wide client uses. The server currently uses its own working directory and the existing project trust gate; focused applications do not select a project. Decide how reload failures and reconnects affect state. |
| Lifecycle and protocol | Decide who installs, starts, discovers, pauses, supervises and stops each process, and what happens on disconnect, restart or incompatible versions. Decide whether the existing operations need version negotiation, focus, snapshots or edit acknowledgement. |
| Verification and performance | Define a platform and application matrix, automated and real-desktop checks, failure and undo scenarios, and end-to-end latency and memory methods. Server-only measurements do not establish field-edit latency. |

The detailed [daemon questions](daemon-surface-questions.md) and
[platform questions](expander-platform-questions.md) separate current behavior
from unresolved choices. [resident-expander-scope.md](resident-expander-scope.md)
records the issue's scope; [PLATFORMS.md](PLATFORMS.md) describes existing
platform support. A future support claim should name the tested environments
and results rather than infer them from the server or a different surface.

Back to [the docs index](README.md).
