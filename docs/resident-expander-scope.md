# Resident expander scope

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes a
system-wide text expander as a separate surface from the CLI and agent
integrations. This outline separates the requested experience from existing
building blocks and decisions that still need platform validation.

## Requested behavior

- Run a resident process so corrections do not require a new Node process for
  every interaction.
- Expand text in the focused text field across applications, without an agent
  in the loop. A platform client would observe input, consult the lexicon and
  apply corrections in the field.
- Treat this as a distinct product surface with its own lifecycle, rather than
  assuming that using the CLI or an agent integration starts it.

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

The current core expands exact aliases when whitespace completes a word and
supports immediate Backspace undo. These are existing core behaviors, not a
complete specification for every application's input and editing model.

## Open platform and product questions

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
- **Validation:** What platform and application matrix, performance measures,
  and user-visible controls are needed before claiming support?

## Limits of the issue description

The issue asks for the resident, focused-field experience and explains the
cold-start motivation. It does not specify operating systems, APIs, permission
policy, matching rules, packaging, startup behavior, supported applications,
privacy policy, performance targets, or acceptance tests. The questions above
are design work to resolve, not requirements attributed to the issue. The
existing server and protocol do not settle those decisions or promise support
in every application.
