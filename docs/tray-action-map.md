# Windows and Linux tray action map

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) requests a tray with
push-to-talk and clipboard repair, using the existing Lexicon behavior. This is
an implementation map for contributors, not a claim that the proposed tray is
available. The [contract's tray proposal](CONTRACT.md#windows-and-linux-tray-proposal-issue-13)
and the linked module contracts describe the current source tree.

| Issue request | Existing capability | Remaining tray work |
|---|---|---|
| Dictate, `lexicon voice --toggle --paste` | The first invocation starts a detached recorder; the next stops it, transcribes and normalizes. On Windows and Linux `--paste` copies the result and reports that automatic paste is unsupported. [Voice contract](CONTRACT.md#srcvoice-processts-devicests-modelsts-recorderts-transcribets-historyts-voicets-and-srcclicmd-voicets), [voice guide](VOICE.md#hotkey-mode---toggle). | Windows has no tray push-to-talk and Linux has no tray app. A tray must invoke the toggle and present recording, completion and failure states. Automatic paste and its target are platform integration decisions. |
| Fix clipboard, `lexicon daemon --once --paste` | `--once` reads text, normalizes it and writes changed text back. The CLI only sends a paste keystroke on macOS; on Windows and Linux the user can paste the clipboard manually. [Clipboard contract](CONTRACT.md#srcdaemonclipboardts), [daemon guide](DAEMON.md). | The Windows tray already has Fix clipboard now and Ctrl+Alt+V, using its local API client rather than the CLI; its desktop integration is unverified. Linux has no tray app. A platform paste action needs separate design and verification. [Windows app](WINDOWS-APP.md#the-menu), [verification status](WINDOWS-APP.md#what-is-verified-and-what-is-not). |
| Global Fix clipboard hotkey | The Windows app registers Ctrl+Alt+V; registration can fail if another app owns it. Existing shortcut recipes also invoke the CLI. [Windows menu](WINDOWS-APP.md#the-menu), [daemon guide](DAEMON.md). | Decide how to report conflicts on Windows and which desktop-provided shortcuts are available on Linux, including X11 and Wayland. Issue #13 leaves Linux hotkeys to the desktop environment. |
| Open lexicon, Preferences, Quit; missing CLI | The Windows app has these menu entries and uses `lexicon path` to open the lexicon. The issue proposes disabling actions except Preferences when the CLI is missing. [Windows menu](WINDOWS-APP.md#the-menu), [issue #13](https://github.com/ashlrai/lexicon/issues/13). | Decide how a new tray locates the CLI, reports its absence and recovers after Preferences changes. The issue's proposed disabled-state behavior is not a statement about the existing Windows app. |

## Invocation and result handling

Invoke the CLI with an argument array and handle stdout, stderr and exit status;
the issue specifies the CLI as the boundary for its proposed tray. The existing
Windows clipboard implementation is an exception to that proposed approach,
not evidence that it invokes `daemon --once`. CLI calls use the merged lexicon,
honor the project trust gate and record correction hits as documented in the
[store](CONTRACT.md#srccorestorets), [clipboard](CONTRACT.md#srcdaemonclipboardts)
and [voice](CONTRACT.md#srcvoice-processts-devicests-modelsts-recorderts-transcribets-historyts-voicets-and-srcclicmd-voicets) contracts.

For Dictate, pass the same delivery and model options on both toggle calls: the
stop call uses its own options, not those from the start. `--toggle --json`
returns a `recording` or `stopping` status on an intermediate call and a result
or failure on completion. Exit 0 alone does not mean a transcript is ready to
paste. Voice exits 1 for errors, 2 for missing tools and 3 for nothing heard;
`--status --json` reports recording or idle separately. ffmpeg, whisper.cpp, a
model and a working microphone are prerequisites; a missing named model may be
downloaded. History is written by default and can be disabled with `--no-history`.
See [voice setup and output](VOICE.md#how-it-works) and the
[voice contract](CONTRACT.md#srcvoice-processts-devicests-modelsts-recorderts-transcribets-historyts-voicets-and-srcclicmd-voicets).

For Fix clipboard, `--once` can return successfully with no changes, including
an empty, oversized, binary or letterless clipboard. Do not infer that a paste
occurred from exit 0. `--paste` cannot be combined with `--dry-run`; clipboard
backend and display errors must be shown to the user. Backend detection and the
one-shot output are specified in the [clipboard backend](CONTRACT.md#srcdaemonclipboard-backendsts)
and [clipboard](CONTRACT.md#srcdaemonclipboardts) contracts.

## Open decisions and verification

- Should the tray offer copy-only delivery or an opt-in native paste? How will
  it avoid pasting stale clipboard contents on a start, no-op, failed copy or
  changed focus, and report permission or desktop restrictions?
- How should simultaneous actions, recording state, long transcription and
  failures be presented? How should the app find the CLI and dependencies, and
  which settings should apply to both toggle invocations?
- Which Windows and Linux desktop environments, clipboard backends, shortcut
  mechanisms and packaging targets will be supported? Linux X11 and Wayland
  behavior needs separate validation; no Linux tray is supplied today.

The issue asks for a real desktop check: build with `lexicon` on PATH, dictate
into an app, use the clipboard hotkey, verify corrected pasted text and confirm
hits in `lexicon stats`. Exercise the no-change and failure paths as well. The
Windows tray's clipboard and desktop integration have not been verified on a
real Windows desktop, and no release ships its binary; see the
[Windows manual test script](WINDOWS-APP.md#manual-test-script) and
[platform matrix](PLATFORMS.md). CLI tests with injected dependencies do not
establish desktop, microphone, focus or paste behavior.
