# Daemon scope questions

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) asks for an
espanso-style resident process that expands text in focused fields across
applications without an agent. It describes a separate surface from the CLI
and a way to avoid a Node cold start for each interaction. The issue's espanso
`list` measurement is context, not a measurement or performance target for
Lexicon.

These are open product and integration questions, not a specification or
commitments made by the issue. The default `lexicon daemon` watches the
clipboard; the opt-in `lexicon daemon --expander` runs a local server that
returns actions to clients. Neither supplies the platform client needed to
observe input and apply edits in focused fields. System-wide expansion is not
available today. See [resident-expander-scope.md](resident-expander-scope.md)
and [DAEMON.md](DAEMON.md#resident-expander-opt-in) for the existing boundary.

## Process lifetime

- Who starts and stops the platform client and server: the user, a login
  service, an app, or another mechanism? Should either start on demand?
- Should they remain running without active clients, and what should happen
  on logout, sleep, shutdown, crash, restart, or an upgrade?
- What is the instance boundary: per user, login session, project, or socket?
  How should concurrent starts and multiple clients be handled?
- When the server or client is unavailable or disconnects, should input pass
  through unchanged, and how are recovery, pending state, and status exposed?
- How can a user pause, resume, or stop expansion and verify that it stopped?

## Configuration and state

- Where would enablement, startup, exclusions, and platform-specific settings
  live? What are their defaults, precedence, validation, and migration rules?
- Which lexicon and working directory should a system-wide client use? How
  could a project be selected without treating focus as implicit trust in a
  project file? How would trust changes and invalid configuration be reported?
- When should settings and lexicon changes take effect? What happens to active
  input and cached state on reload failure or a change of context?
- Which applications and fields should be excluded, especially secure fields
  or fields whose sensitivity cannot be determined? How are permissions
  requested, revoked, and reflected in the user's controls?
- What information is needed for diagnostics without recording typed text,
  and where would any diagnostic data be stored and retained?

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

These questions do not assert that the proposed client, startup integration,
or cross-surface coordination has been implemented. For the server's current
behavior and more detailed questions, see
[daemon-surface-questions.md](daemon-surface-questions.md); platform-specific
input and editing questions are in
[expander-platform-questions.md](expander-platform-questions.md).

Back to [the docs index](README.md).
