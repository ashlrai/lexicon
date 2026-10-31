# Resident expander boundary map

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes a resident,
system-wide expander for a focused text field across applications, without an
agent in the loop. The issue describes a separate surface and a cold-start
motivation, not a platform implementation or performance guarantee. The
existing core and server are building blocks; **system-wide expansion through
them is not yet available**. See [resident-expander-scope.md](resident-expander-scope.md)
for the issue's scope and [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220)
for the current module contract.

## Existing surfaces

| Surface | Input and output boundary | Relationship to the proposal |
| --- | --- | --- |
| [Core and CLI](CONTRACT.md#srccorenormalizets) | The core normalizes supplied text; `lexicon normalize` takes arguments or stdin and returns output through a short-lived command. | Neither observes nor edits a focused field. |
| [Clipboard daemon](DAEMON.md) | The default `lexicon daemon` polls copied text and writes corrections back to the clipboard. `--once --paste` is a separate one-shot workflow; automatic paste is macOS-only. | Copy and paste is a distinct workflow from live expansion in a field. |
| [MCP and hook](CONTRACT.md) | MCP accepts requests from a client; the Claude Code hook adds correction context without rewriting the prompt. | Agent interfaces do not capture system input. |
| [Local API](LOCAL-API.md) and [browser extension](EXTENSION.md) | The loopback API responds to explicit requests; the extension operates in browser pages under its settings and permissions. | Their request and editing paths do not provide a system-wide expander client. |
| [macOS app](MACOS-APP.md#fix-everywhere) and [Windows app](WINDOWS-APP.md#fix-everywhere) | Fix everywhere uses the local API and platform accessibility interfaces for dictation bursts. The macOS live path has limited manual verification; the Windows UI Automation path is unverified and no release ships it. | These are separate focused-field integrations, not clients of the expander socket. Their coverage and limits do not establish support for the proposed typing workflow. |
| [Resident server](DAEMON.md#resident-expander-opt-in) | `lexicon daemon --expander` opts into a long-lived process and local socket (Windows named pipe). It loads a lexicon, maintains an index and returns responses; it neither captures input nor applies edits. | The available server is only part of the proposed surface. |

The resident server uses newline-delimited JSON, responds in order on each
connection, and echoes an optional `id`. `type`, `key` and `reset` drive a
separate expansion buffer per connection. The pure core defaults to exact
aliases, expands when whitespace finishes words, and returns a backspace count
in grapheme clusters and text to insert. Immediate Backspace can return an undo
action. The client must actually apply an action; a response alone edits
nothing. For example, with `Ashler` configured as an alias for `Ashlr.AI`,
the action produced by typing `Ashler ` is:

```json
{"kind":"expand","backspaces":7,"insert":"Ashlr.AI ","replacements":[{"original":"Ashler","replacement":"Ashlr.AI","canonical":"Ashlr.AI"}]}
```

The socket also offers explicit normalization, clipboard and other operations;
the full protocol and access details are in [DAEMON.md](DAEMON.md#resident-expander-opt-in).
The CLI already attempts a resident `cli-read` for eligible read commands and
falls back to direct dispatch on failure. That existing optimization neither
starts the server nor defines lifecycle or fallback for a future input client.

## Integration boundaries still to resolve

```text
OS input and focus -> platform client -> local socket -> expansion core
                         |                                  |
                         +---- apply or reject action <-----+
```

The platform client and arrows involving OS input and field edits are a design
boundary, not an implemented integration. Decisions and validation remain:

| Boundary | Open questions |
| --- | --- |
| Capture and scope | Which APIs and applications are supportable on macOS, Windows, X11 and Wayland compositors? How are focus, selection, navigation, paste, shortcuts, composition and IME events represented, and when must the buffer reset? |
| Safe edits and undo | How does a client verify that focus, caret and text still match before applying an action? How are partial edits, dropped events, application undo, immediate Backspace undo and self-generated input handled? Grapheme counts alone do not prove that an application's Backspace behaves as expected. |
| Privacy and permissions | Which permissions are required and how are denial and revocation handled? How are secure or sensitive fields and excluded applications identified before reading input, including when the platform cannot identify them? |
| State and trust | Which working directory and project lexicon should a system-wide client use? The server loads with its own `cwd` and the existing project trust gate; focus on an application does not select a project. How should reload failures, per-connection buffers and reconnection affect pending input? |
| Lifecycle and transport | Who starts, discovers, supervises and stops the server and client? What happens on a missing server, disconnect, restart, incompatible protocol or unavailable permission? Existing socket access controls and limits are documented in [CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220); they do not decide client recovery. |
| Product and validation | What controls, supported-app matrix, platform tests and latency and memory measurements are required? Issue #220's espanso `list` numbers are context for a separate measurement, not a target or a measurement of this daemon. |

Installing the CLI or starting the server does not supply a system-wide input
client. The issue does not settle the questions above, and the current protocol
does not promise successful edits in every application.
