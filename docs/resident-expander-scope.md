# Resident expander scope

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes a
system-wide text expander as a separate surface from the CLI and agent
integrations. This outline separates the requested experience from existing
building blocks and decisions that still need platform validation. It does not
approve a platform implementation or promise support.

## Requested behavior

- Run a resident process so corrections do not require a new Node process for
  every interaction.
- Expand text in the focused text field across applications, without an agent
  in the loop. A platform client would observe input, consult the lexicon and
  apply corrections in the field.
- Treat this as a distinct product surface with its own lifecycle, rather than
  assuming that using the CLI or an agent integration starts it. The issue
  calls `lexicon daemon` a start, not a completed system-wide expander.

The issue cites an espanso `list` measurement of 15.9 ms p50 and 34,016 kB;
`lexicon daemon` was not part of that measurement. These figures are context,
not a target, a daemon measurement, or a guarantee for interactive expansion.
See [BENCH-DAEMON.md](BENCH-DAEMON.md) for the separately measured resident
server and its methodology.

## Existing pieces and the missing boundary

- `lexicon normalize` accepts explicit text and exits. The default
  `lexicon daemon` watches the clipboard, not the focused field.
- The opt-in `lexicon daemon --expander` runs a long-lived local socket server
  with an in-memory lexicon. Its expansion core returns actions to clients;
  neither the core nor the server captures system-wide input or edits fields.
  See [DAEMON.md](DAEMON.md#resident-expander-opt-in) for the current protocol
  and [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220) for the
  boundary with other integrations.
- A platform client to observe input and focus, send events, and safely apply
  returned actions is still needed. Installing the CLI or starting the server
  does not supply or start that client. System-wide expansion is not yet an
  available feature.

| Surface | What exists today | Relationship to the request |
| --- | --- | --- |
| `lexicon daemon` | By default it polls and corrects the clipboard. `--once` handles one clipboard value; `--paste` can paste it on macOS. | Copying and pasting is a separate workflow from expansion in a focused field. |
| `lexicon daemon --expander` | An opt-in resident process keeps a lexicon in memory and serves newline-delimited JSON over a local Unix socket or Windows named pipe, with a separate buffer per connection. | It supplies a server, not a system-wide input or editing client. Nothing starts it automatically. |
| Expansion core | Exact aliases expand when whitespace completes a word; the core returns a grapheme-counted backspace action and insertion text. Immediate Backspace can undo an expansion. | A client must observe input and apply the returned action. |
| CLI, agent and desktop integrations | CLI and MCP accept supplied text; the hook adds context. The desktop apps have their own focused-field paths. | These are separate integrations, not clients of the expander socket, and do not establish the requested typing experience. |

The server does not log typed text. Its transport, lifecycle and security
details are current behavior, not a settled specification for every platform
client, and a grapheme count alone does not prove a field's Backspace
semantics. The current core behaviors are not a complete specification for
every application's input and editing model.

The clipboard watcher reloads its lexicon when the file or trust state changes.
If that reload fails, it does not use the previous cached view for that changed
state. A failed periodic reload with an unchanged state can keep the previous
view and reports the failure unless quiet mode is enabled. The
[boundary map](expander-boundary-map.md) compares the other surfaces and their
limits.

## Open platform and product questions

Each of these is expanded into per-platform discovery questions, marked
decided or undecided, in
[expander-platform-questions.md](expander-platform-questions.md); the
resident server's own open questions are in
[daemon-surface-questions.md](daemon-surface-questions.md).

- **Input and editing:** Which APIs can observe input and focus and apply edits
  on macOS, Windows, and Linux, including X11 and different Wayland
  compositors? Which applications and input methods can they support?
- **Permissions and privacy:** What permissions are required, how are they
  requested or revoked, and how are secure or sensitive fields excluded?
  What happens when the platform cannot identify a sensitive field?
- **Correctness:** How should focus changes, selections, cursor movement,
  composition and IME input, pasted text, undo, and partial or stale edits be
  handled? How can the client avoid processing its own injected input?
- **Lifecycle and failure:** How is the client installed, started, paused,
  stopped, and supervised? How does it discover the server, recover after a
  disconnect or crash, and behave when permissions or edits fail?
- **Configuration and coexistence:** Which lexicon and trusted project context
  apply to a focused application? How do reloads and the clipboard watcher,
  browser extension and desktop apps interact with the new surface?
- **Validation:** What platform and application matrix, performance measures,
  and user-visible controls are needed before claiming support?

## Decisions and evidence needed

A future implementation must resolve and validate these without treating the
current protocol as proof of an end-to-end experience:

| Area | Decisions and evidence needed |
| --- | --- |
| Platform and input | Which operating systems, applications and Linux display environments are supported? Choose and validate capture and edit APIs, including focus, selection, cursor movement, paste, shortcuts and IME composition. |
| Safe edits | Decide how to check that focus and text still match before applying an action, avoid processing injected input, handle partial or failed edits, reconcile buffer state and provide undo. |
| Privacy and permissions | Decide how permission requests, denial and revocation work; identify excluded applications and sensitive fields before collecting input, including when a field cannot be identified. Define client logging and retention without weakening the server's existing no-typed-text logging behavior. |
| Lexicon and trust | Choose which lexicon and project context a system-wide client uses. The server currently uses its own working directory and the existing project trust gate; focused applications do not select a project. Decide how reload failures and reconnects affect state. |
| Lifecycle and protocol | Decide who installs, starts, discovers, pauses, supervises and stops each process, and what happens on disconnect, restart or incompatible versions. Decide whether the existing operations need version negotiation, focus, snapshots or edit acknowledgement. |
| Verification and performance | Define a platform and application matrix, automated and real-desktop checks, failure and undo scenarios, and end-to-end latency and memory methods. Server-only measurements do not establish field-edit latency. |

[PLATFORMS.md](PLATFORMS.md) describes existing platform support. A future
support claim should name the tested environments and results rather than
infer them from the server or a different surface.

## Limits of the issue description

The issue asks for the resident, focused-field experience and explains the
cold-start motivation. It does not specify operating systems, APIs, permission
policy, matching rules, packaging, startup behavior, supported applications,
privacy policy, performance targets, or acceptance tests. The questions above
are design work to resolve, not requirements attributed to the issue. The
existing server and protocol do not settle those decisions or promise support
in every application.

Back to [the docs index](README.md).
