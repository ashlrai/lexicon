# Daemon surface questions

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes a
resident, system-wide text expander. This page is the question list for the
daemon half of that proposal: what `lexicon daemon --expander` already is
today and every decision the resident process still has open before a
platform client could rely on it. The client half, asked per platform, is
[expander-platform-questions.md](expander-platform-questions.md); the issue's
scope is [resident-expander-scope.md](resident-expander-scope.md) and the
surface boundaries are [expander-boundary-map.md](expander-boundary-map.md).

It is a list of questions, not a plan or a spec, and it is discovery work
rather than requirements attributed to the issue. Two marks label every line:

- **Decided.** Behavior that exists in the repository today, named with where
  it is proved. A decided line still constrains the questions around it: a
  client that speaks the socket protocol inherits them.
- **Undecided.** Genuinely open. Neither the issue nor any code answers it.
  Undecided here means undecided, not a decision waiting to be announced.

## The surface the issue requests

- A resident process, so a correction does not cost a Node cold start per
  interaction.
- Expansion in the focused text field across applications, with no agent in
  the loop.
- A surface distinct from the CLI and the agent integrations: the issue calls
  the system-wide expander a different product and names `lexicon daemon` as
  the start of it.
- The espanso `list` figures it quotes (15.9 ms p50, 34,016 kB) are context
  for a separate measurement, not a target, a measurement of this daemon, or
  a latency promise. [BENCH-DAEMON.md](BENCH-DAEMON.md) has the resident
  server's own numbers and method.

## What the daemon surface already decides

The flags are wired in `src/cli/program.ts`; the server is
`src/daemon/expander-server.ts`, the fast client `src/daemon/fast-client.ts`
and the pure core `src/daemon/expander.ts`, covered by `tests/daemon/`.

- **Decided.** The resident server starts only from `lexicon daemon
  --expander`. Nothing starts it automatically, including the `cli-read` fast
  path, which falls back to direct dispatch when no socket answers.
- **Decided.** Transport is newline-delimited JSON on a Unix socket, mode
  0600 in a 0700 directory owned by the user, or a per-user named pipe on
  Windows. There is no TCP port and no token; file permissions are the access
  control, as for ssh-agent.
- **Decided.** The ops are `ping`, `normalize`, `type`, `key`, `reset`,
  `clipboard` and `cli-read`. Requests on one connection are answered in
  order with an optional `id` echoed; anything else is `ok:false` with an
  error.
- **Decided.** Request limits: a request line over 80,000 characters is
  answered then the connection ends; a `type` chunk over 4,096 characters and
  `normalize` text over 20,000 are refused.
- **Decided.** Each connection is one key source with its own expansion
  buffer. Only whitespace finishes a word, only exact aliases match, an
  action is a backspace count in grapheme clusters plus text to insert, and
  Backspace straight after an expansion is the undo.
- **Decided.** A stale socket file is replaced; a live listener or a path
  that is not a socket is refused, never removed. The socket file is unlinked
  on a clean stop, and SIGINT, SIGTERM or abort end the process with the same
  exit statuses as the clipboard watcher (130, 143, 0).
- **Decided.** The lexicon reloads when the global file, the project file or
  `trust.json` changes, checked when a `type` chunk contains whitespace and
  on `ping`, `normalize` and `clipboard` (a lone keystroke cannot expand, so
  it skips the check), and at least every five seconds. A failed reload keeps
  serving the previous load and says so on stderr. `setIndex` keeps the typed
  buffer across the swap, so a term learned mid-sentence applies from the
  next word.
- **Decided.** `cli-read` serves only `list`, `ls`, `stats`, `path` and
  stdout-only `export`, only when the caller's context (version, working
  directory, home, lexicon environment, terminal colour) matches the resident
  process, and the CLI abandons it after a 100 ms total deadline.
- **Decided.** Typed text is never logged server-side, since a key source
  sees passwords too.

## Open daemon-surface questions

### Command shape and lifecycle

- **Undecided.** Whether the resident expander stays a flag on
  `lexicon daemon`, becomes its own command, or merges with `lexicon serve`:
  two opt-in resident processes exist today with different protocols,
  endpoints and clients.
- **Undecided.** Who starts and supervises it if it grows into the surface
  the issue asks for. `lexicon serve --install` proves a user-scoped login
  service (launchd, a systemd unit, a Scheduled Task); nothing equivalent
  exists for the expander, and socket activation is unexplored.
- **Undecided.** Idle behavior: the server runs until killed today. Whether
  it should exit when no client is attached, and what a client does while it
  is down, is open.
- **Undecided.** Instance scope: the already-listening refusal is per socket
  path, so two `--socket` values run two daemons with two lexicon caches.
  Whether one expander per user should be enforced, and how a second start
  should report it, is undecided.
- **Undecided.** Whether the expander and the clipboard watcher ever share
  one process, or remain the separate surfaces they are today; `clipboard` is
  already an op on the expander socket.

### Protocol and ops

- **Undecided.** Protocol versioning: `ping` returns the package version but
  nothing negotiates a protocol revision. How an older or newer client learns
  which ops exist, and what a graceful mismatch looks like beyond `ok:false`,
  is unsettled.
- **Undecided.** Whether a field-level client needs ops the protocol lacks:
  a snapshot op to seed the buffer from a field's existing text, an
  applied-or-failed acknowledgement so the server can roll back its idea of
  the buffer when an action does not land, and a focus op distinct from
  `reset`. The platform list flags the snapshot gap; the rest are the same
  shape of question.
- **Undecided.** Whether `cli-read` belongs on this socket long-term: it is a
  CLI cold-start optimization, not part of the issue's surface, and it is the
  only op that returns whole command output.
- **Undecided.** Whether a pure key-capture client should get a reduced
  surface: every op shares the same owner-only socket today, and a mode
  without `normalize`, `clipboard` and `cli-read` does not exist.
- **Undecided.** Limits beyond line length: connection count, request rate,
  and the behavior for a client that never reads its responses.

### Lexicon context and state

- **Undecided.** Which project lexicon a system-wide expander should serve.
  The server binds one working directory at start and applies the existing
  trust gate; a focused application does not select a project, and a resident
  process cannot ask about an untrusted `.lexicon.yaml` the way the CLI can.
- **Undecided.** Whether expansions through `type` should count in
  `lexicon stats`: the clipboard watcher records hits in the background; the
  expander server records none today.
- **Undecided.** How far the per-connection buffer model stretches: 256
  characters of typed context assumes the client saw every keystroke, and
  `reset` is the only reconciliation when it did not.

### Measurement and support

- **Undecided.** The end-to-end figure that would close the issue's gap
  honestly: [BENCH-DAEMON.md](BENCH-DAEMON.md) measures the server alone.
  There is no measurement that includes a real client, and none is claimed.
- **Undecided.** What observability a resident server gets while upholding
  "typed text is never logged": request counts, reload failures and error
  rates are candidates; none exists today.
- **Undecided.** Where the surface is documented for users: it lives as a
  section of the clipboard watcher's page
  ([DAEMON.md](DAEMON.md#resident-expander-opt-in)); whether it graduates to
  its own page is the same decision as the command shape above.

None of the undecided lines describes behavior that exists. The resident
server today is exactly the decided list above; the platform client, startup
integration and system-wide expansion the issue asks for are proposed, not
implemented or shipped.

## See also

- [resident-expander-scope.md](resident-expander-scope.md): what the issue asks, the pieces that exist, and the boundary left to build.
- [expander-platform-questions.md](expander-platform-questions.md): the client half of the question list, per platform.
- [expander-boundary-map.md](expander-boundary-map.md): how the existing surfaces relate to the proposal.
- [DAEMON.md](DAEMON.md#resident-expander-opt-in): the socket, the ops and the access rules as they exist.
- [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220): the module contract for the same boundary.
- [BENCH-DAEMON.md](BENCH-DAEMON.md): the resident server's measured latency and memory.

Back to [the docs index](README.md).
