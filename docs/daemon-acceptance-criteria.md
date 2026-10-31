# Daemon acceptance criteria (issue #220)

Checked against `dec2288652157e9b0246bcabc99e7fb642757b17`, 2026-10-31. The
issue is [#220](https://github.com/ashlrai/lexicon/issues/220): a resident,
system-wide text expander as a separate surface
([FIRST-RUN.md](FIRST-RUN.md) follow-up 6).
[CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220) records what
the issue proposes and is the wording this page keeps honest.

**The system-wide surface is not implemented.** What exists, and is tested,
is an opt-in resident process (`lexicon daemon --expander`), its socket
protocol and the pure expansion core behind it. The criteria below are split
on that line: rows under "Observable today" are behavior you can run now,
each naming the file and the test that prove it; the "Unresolved" section is
the operating-system integration work the issue leaves undecided. Nothing
here presents a design as shipped code, and the contract tests listed at the
end hold the same line.

## What the issue asks for

- A resident, system-wide text expander, separate from the CLI and the agent
  integrations. The proposed surface targets a focused text field across
  applications, without an agent in the loop: observe text input, match
  completed words against the lexicon, apply the replacement in the field.
- Latency context supplied with the issue: an espanso `list` baseline of
  15.9 ms p50, against which paying a Node cold start per correction looks
  slow ([BENCH-DAEMON.md](BENCH-DAEMON.md)). It is a number the issue gave,
  not one remeasured here.

## Observable today

Every row is met by running code. A row is only counted met with a file and a
proof named; the file is where the behavior lives, the test (or reproduction
command) is what keeps it true.

| Criterion | File evidence | Test evidence |
|---|---|---|
| A resident process exists and is opt-in: `lexicon daemon --expander` starts a separate, long-lived process holding the lexicon and matcher index in memory. Nothing starts it but the flag; combining `--expander` with the clipboard-only flags (`--once`, `--paste`, `--which`) is refused, as is a `--socket` given without `--expander`. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts), [src/daemon/clipboard.ts](../src/daemon/clipboard.ts) (`runDaemonCommand`) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `is refused with the clipboard-only flags and --socket alone`, `parses --expander and --socket in the standalone entry` |
| Same-user transport: a Unix socket at `defaultExpanderSocketPath()` (`$XDG_RUNTIME_DIR/lexicon/expander.sock`, else the XDG state home), mode 0600 inside a 0700 directory; a per-user named pipe `\\.\pipe\lexicon-expander-<user>` on Windows. No TCP port and no token; file permissions are the access control. A live socket or a non-socket path is refused, never removed; a stale socket left by a crash is replaced; the socket file is removed on stop. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) (`prepareSocketPath`), [src/daemon/fast-client.ts](../src/daemon/fast-client.ts) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `makes the socket and its directory private, and removes the socket on stop`, `refuses a second expander on the same socket, and replaces a stale one`, `refuses a socket path that is a regular file, and tightens a loose directory`, `prefers an absolute XDG_RUNTIME_DIR, else the XDG state home`, `uses a per-user named pipe on Windows` |
| The protocol is newline-delimited JSON, one response per request line in order on a connection, an `id` echoed back. Ops: `ping`, `normalize`, `type`, `key`, `reset`, `clipboard`, `cli-read`. A malformed line gets `{ ok: false, error }` and the connection survives; a request line over 80000 characters is answered with an error and the connection ended; a `type` chunk over 4096 or a `normalize` text over 20000 characters is an error. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) (`createExpanderSession`, `MAX_EXPANDER_REQUEST_CHARS`, `MAX_EXPANDER_TYPE_CHARS`) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `answers ping, normalize, type and key on one connection, in order`, `answers bad requests with an error and keeps the connection`, `closes a connection whose request line never ends`, `answers the normalization example in the separate-process contract` |
| Expansion is exact and explainable: `type` appends text and only whitespace finishes a word, so URLs, emails and domains are left alone; a finished alias becomes `{ kind: 'expand', backspaces, insert, replacements }` with `backspaces` counted in grapheme clusters. Backspace straight after an expansion returns `{ kind: 'undo' }` and that word is never re-expanded; other Backspaces edit the buffer; Enter, Tab and every navigation key drop the buffer instead of expanding, since the field may have been submitted or the cursor moved. Matching is alias-exact by default: no phonetic or fuzzy guessing while typing. | [src/daemon/expander.ts](../src/daemon/expander.ts) | [expander.test.ts](../tests/daemon/expander.test.ts): `expands an alias when the space after it is typed`, `never fires inside a URL, an email or a domain as it is typed`, `undoes on Backspace right after an expansion and never re-expands that word`, `leaves non-alias words alone: no phonetic or fuzzy guessing by default`, `counts Backspaces in graphemes`, `keeps a bounded buffer cut at whitespace, and still expands after it` |
| One expansion buffer per connection: each connection is one keyboard source and connections never share typed text. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `keeps one buffer per connection` |
| The resident lexicon stays fresh: reloaded when a lexicon file or `trust.json` changes, checked before a correction runs, with a 5-second backstop; a reload failure keeps serving the previous lexicon and is reported on stderr; a lexicon that fails its first load fails the process before the socket listens. A keystroke with no whitespace cannot expand and skips the file check. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) (`lexiconCache`), [src/daemon/clipboard.ts](../src/daemon/clipboard.ts) (`lexiconFilesStamp`, `LEXICON_RELOAD_MS`) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `reloads the lexicon when its file changes`, `fails before listening when the lexicon will not load` |
| Clipboard correction without a cold start: the `clipboard` op runs `lexicon daemon --once [--paste]` inside the resident process against the cached lexicon, serialized so two shortcuts pressed together cannot interleave clipboard reads and writes. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `corrects the clipboard in-process, sharing the resident lexicon` |
| The CLI already prefers the socket for reads: command-first `list` (`ls`), `path`, `stats` and stdout-only `export` probe the default socket through `tryFastRead`; the opaque context (version, cwd, home, lexicon and config overrides, colour) must match or the server declines. A missing daemon, an older protocol, a bad response or the 100 ms total deadline falls back silently with stdout, stderr and status preserved. File exports, help, mutations and stdin commands never take this path. | [src/daemon/fast-client.ts](../src/daemon/fast-client.ts) | [fast-client.test.ts](../tests/daemon/fast-client.test.ts): `uses fresh files and caller cwd, leaving untrusted projects unparsed`, `declines different configuration and never dispatches mutations`, `treats synchronous transport failures as misses`, `keeps invalid CLI request diagnostics off daemon streams` |
| Resident latency is measured, not assumed: on the recorded run (macOS arm64, 2026-10-30, loaded host) a socket request is p50 3.19 ms / p95 85.04 ms, the CLI with the daemon up p50 215.30 ms, daemon-absent fallback p50 1240.82 ms and the direct CLI p50 1396.03 ms. The espanso 15.9 ms p50 baseline came with the issue and was not remeasured; this is a latency comparison, not a same-machine competitive claim. Daemon probes carry a 100 ms deadline and fall back silently. | [BENCH-DAEMON.md](BENCH-DAEMON.md), [bench/daemon-latency.mjs](../bench/daemon-latency.mjs) | `npm run build && node bench/daemon-latency.mjs` reproduces it |
| Typed text is never logged: a key source sees passwords too, so nothing the expander observes is written to a log or stdout. | [src/daemon/expander-server.ts](../src/daemon/expander-server.ts) (module comment) | [expander-server.test.ts](../tests/daemon/expander-server.test.ts): `never writes typed text to its output or error streams` |

To see it run:

```bash
lexicon daemon --expander --socket /tmp/lx.sock &
echo '{"op":"ping"}' | nc -U /tmp/lx.sock
echo '{"op":"normalize","text":"tell Ashler to ship it"}' | nc -U /tmp/lx.sock
echo '{"op":"type","text":"see Ashler "}' | nc -U /tmp/lx.sock
```

The last line answers an `expand` action: the backspace count and the
corrected insert a client would apply. Applying it is the client's job,
which leads to what is still open.

## Unresolved operating-system integration decisions

Each row is a decision the issue leaves open. None of them has shipped code;
a design that lands before the decision is validated per platform does not
count, and docs and release notes must keep saying so.

| Decision | What is unresolved |
|---|---|
| Input observation | How to observe keystrokes or text system-wide on each platform: macOS, Windows, and Linux across both X11 and Wayland compositors. No code captures input today; `type`, `key` and `reset` exist so a future client can feed what it observes. |
| Applying edits | How to press Backspace and insert text into the focused field of another application on each platform, including that platform's undo conventions. The server emits `expand`/`undo` actions; nothing applies them to a field. |
| Permissions | Which OS consent each observation or edit approach needs, and the behavior when permission is denied or revoked mid-run. |
| Sensitive-field exclusion | Password and secure-input fields must never be observed or rewritten; the exclusion mechanism per platform is undecided. Never logging typed text is already true, but exclusion is more than logging. |
| Focus and composition | Focus changes mid-word, IME and composition input, a cursor moved by click or shortcut (`reset` is the protocol hook for these), and stale or partial edits when the field changed under the daemon. |
| Lifecycle | Automatic startup, supervision, discovery of an existing instance, reconnects and fallback to the CLI when the server is down. These are proposed client-owned behavior, not guarantees; today nothing starts the server but the flag. |
| Latency and memory targets | Neither the issue nor the socket protocol establishes a guarantee for the end-to-end loop. Only the component numbers in [BENCH-DAEMON.md](BENCH-DAEMON.md) exist. |
| Application coverage | Even with a client, support in every application is not promised; per-application validation is part of the work before the surface can be called available. |

## What done means

The "Observable today" rows stay met as the code moves. The issue can be
described as resolved only when a platform client exists that observes input,
applies the core's actions to a focused field, respects sensitive-field
exclusions and runs inside that platform's permissions model, validated on
the platform it claims and documented without promising support in every
application. Until then "the expander" means the opt-in socket server and
nothing else; installing the CLI or starting it does not put a system-wide
expander on a machine.

## The split is itself tested

- [tests/daemon-contract.test.ts](../tests/daemon-contract.test.ts) holds
  [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220) to the same
  implemented-versus-proposed line.
- `issue #220 contract scope` in
  [tests/daemon/expander-server.test.ts](../tests/daemon/expander-server.test.ts)
  requires the contract to keep saying the complete surface is not
  implemented and that the server does not capture system-wide input or apply
  changes to a focused field.
- [tests/daemon-acceptance.test.ts](../tests/daemon-acceptance.test.ts) holds
  this page to the same split and to real file and test names.

Back to [the docs index](README.md).
