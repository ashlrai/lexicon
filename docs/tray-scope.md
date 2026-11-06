# Windows and Linux tray scope

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) proposes a tray app
for Windows and Linux. This page is the scope of that proposal: the
capabilities it names, the contract it sets for an implementation, what already
exists and what it leaves undecided. It describes a proposal, and nothing on
this page is a shipped feature or a release commitment.

## The proposal

LexiconBar gives macOS users a menu bar surface for push-to-talk, clipboard
correction and supervision of the daemon and the local API. Windows and Linux
users get the CLI and the clipboard daemon, and wire their own hotkey through
AutoHotkey or a GNOME custom shortcut, both documented in
[DAEMON.md](DAEMON.md). The issue proposes that a tray app carrying the same
two actions would close that gap. It is labeled `help wanted` and `platform`,
described as a larger piece of work than most issues, and marked as on the
roadmap. It is also explicit that the work can land in pieces: a tray app for
one platform, with one action, is a complete and mergeable contribution.

## Proposed capabilities

The issue names two capabilities. Both are proposed, and neither has shipped as
part of a Windows or Linux tray.

- **Push-to-talk (Dictate):** run `lexicon voice --toggle --paste` from the
  tray. The command is a toggle: one invocation starts recording and another
  stops it, transcribes and normalizes. See
  [VOICE.md](VOICE.md#hotkey-mode---toggle). No Windows or Linux tray offers
  this today.
- **Fix clipboard:** run `lexicon daemon --once --paste` from the tray and
  from a global hotkey. The command normalizes clipboard text; see
  [DAEMON.md](DAEMON.md). The existing Windows tray offers this action through
  its local API client rather than the proposed CLI path, and Linux has no
  tray app.
- **Menu shell around them:** Open lexicon, Preferences and Quit. If `lexicon`
  is not on `PATH`, explain that plainly and disable everything except
  Preferences, the way LexiconBar does.

On Windows and Linux the CLI's `--paste` copies the corrected text back to the
clipboard rather than sending a paste keystroke, so a successful command does
not by itself deliver text into the target application.

## The contract the issue sets

- Match what [LexiconBar](MACOS-APP.md) does, and no more. The app has no
  logic of its own: it runs a `lexicon` subcommand with an argument array,
  reads stdout and shows the result, which keeps the trust gate, hit counting
  and file handling identical to every other surface.
- No Electron dependency. The repo is currently Node plus Swift and nothing
  else.
- Source goes under `apps/windows/` or `apps/linux/`, beside `apps/macos/`;
  a build script goes in `scripts/` following `scripts/build-macos-app.sh`;
  a platform doc plus a documentation index row and a surfaces table row are
  part of the change.
- On Linux, hotkeys are the desktop environment's job: keep shipping the
  GNOME/KDE shortcut recipe and register only what the environment allows.
- Add a release workflow only once the app builds reproducibly; packaging and
  signing must not block the first contribution.
- Contributors say which platform they are taking on the issue before
  starting.

## What exists today

- Windows has a tray app in `apps/windows/` with Fix clipboard and a
  Ctrl+Alt+V shortcut through its local API client. It has no tray
  push-to-talk, its desktop integration has not been verified on a real
  Windows desktop and no release ships its binary. See
  [WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not).
- Linux has no tray app. The documented answer there is the clipboard daemon
  behind a desktop shortcut; see
  [DAEMON.md](DAEMON.md#linux-gnome-custom-shortcut).
- The complete proposed support is unimplemented: the contract section
  [Windows and Linux tray proposal](CONTRACT.md#windows-and-linux-tray-proposal-issue-13)
  records the capability boundary, and [PLATFORMS.md](PLATFORMS.md) records
  per-platform verification status.

## What the issue leaves open

These are decisions for whoever builds it, not requirements the issue states:

- Toolkit and supported platform set: suggested toolkits (`NotifyIcon` or
  `pystray` on Windows, `libappindicator`/`StatusNotifierItem` on Linux) are
  suggestions. Which distributions, desktop environments, tray hosts and
  clipboard backends are supported, and how X11 and Wayland differ, is open.
- How the existing API-based Windows app relates to the proposed CLI boundary.
- Copy-only delivery versus opt-in native paste, and how focus changes,
  clipboard changes, failed copies and unavailable paste are handled.
- Shortcut registration and conflict reporting, recording and transcription
  states, no-change results, errors and concurrent actions, and which settings
  apply to both voice toggle invocations.
- How a desktop launcher finds the CLI and voice dependencies, and what
  packaging, signing and distribution each platform uses.

## Verification the issue asks for

Build the app, put `lexicon` on `PATH`, dictate into an application, press the
clipboard hotkey and confirm the pasted text is corrected and `lexicon stats`
counted the hits. That is a real desktop check: unit tests cannot verify
microphone, focus, clipboard or paste integration. A partial contribution
verifies the action and platform it delivers and records what remains
untested.

## Where the detail lives

| Page | What it pins down |
|---|---|
| [tray-request-scope.md](tray-request-scope.md) | The requested platforms and interactions, current context and open implementation details |
| [tray-app-scope.md](tray-app-scope.md) | The request alongside existing behavior, unresolved decisions and verification |
| [tray-platform-scope.md](tray-platform-scope.md) | Each line of the issue marked as a stated requirement or an open question |
| [tray-action-map.md](tray-action-map.md) | Each requested action mapped to the code it would invoke and the work left |
| [tray-interaction-questions.md](tray-interaction-questions.md) | Open push-to-talk and clipboard interaction questions |
| [tray-platform-questions.md](tray-platform-questions.md) | Per-platform surfaces and platform-specific open questions |
| [CONTRACT.md](CONTRACT.md#windows-and-linux-tray-proposal-issue-13) | The capability boundary as a module contract |
| [MACOS-APP.md](MACOS-APP.md) | LexiconBar, the specification the tray is asked to match |
| [WINDOWS-APP.md](WINDOWS-APP.md) | The existing Windows tray app and its verification status |
| [PLATFORMS.md](PLATFORMS.md) | Per-platform support and clipboard backend status |

Back to [the docs index](README.md).
