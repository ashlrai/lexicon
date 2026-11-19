# Windows and Linux tray scope

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) proposes a Windows or
Linux tray app that brings LexiconBar's push-to-talk and clipboard correction
to those desktops. This page is the scope of that proposal: the capabilities
it names, which of its lines are requirements a contribution is held to, what
already exists and which decisions it leaves open. It describes a proposal,
and nothing on this page is a shipped feature or a release commitment.

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
  from a global shortcut. The command normalizes clipboard text; see
  [DAEMON.md](DAEMON.md). The existing Windows tray offers this action
  through its local API client rather than the proposed CLI path, and Linux
  has no tray app.
- **Menu shell around them:** Open lexicon, Preferences and Quit. If `lexicon`
  is not on `PATH`, explain that plainly and disable everything except
  Preferences, the way LexiconBar does.

On Windows and Linux the CLI's `--paste` copies the corrected text back to the
clipboard rather than sending a paste keystroke, so a successful command does
not by itself deliver text into the target application. The voice toggle can
also return a recording or stopping status before a transcript is ready.

## Stated requirements and open decisions

Two marks label every line below:

- **Stated.** The issue requires or explicitly requests it: an action, a
  boundary, a process step or a verification a contribution is asked to
  follow.
- **Open.** The issue names the need and leaves the decision to whoever
  builds it, or does not address it at all. Open here means open, not a
  decision waiting to be announced.

### Platforms

- **Stated.** Windows and Linux are the requested platforms. Both have the
  CLI and the clipboard daemon today and wire their own hotkey as described
  above.
- **Stated.** macOS is the specification, not a target. The issue caps scope
  at matching what [LexiconBar](MACOS-APP.md) does and no more.
- **Stated.** One platform and one action is a complete contribution. The two
  platforms, and the individual actions within one platform, do not have to
  land together.
- **Stated.** New source goes under `apps/windows/` or `apps/linux/`, beside
  `apps/macos/`; a build script goes in `scripts/` following
  `scripts/build-macos-app.sh`; a `docs/WINDOWS-APP.md` or
  `docs/LINUX-APP.md` page plus a row in the [documentation index](README.md)
  and the [surfaces table](../README.md) are part of the change.
- **Stated.** No Electron dependency. The repo is currently Node plus Swift
  and nothing else.
- **Stated.** Contributors say on the issue which platform they are taking
  before starting.
- **Open.** Which toolkit a contribution uses. The issue suggests a C#
  WinForms/WPF `NotifyIcon` app or a Python `pystray` app on Windows and a
  `libappindicator`/`StatusNotifierItem` tray on Linux, but these are
  suggestions, not picks.
- **Open.** Which Linux distributions, desktop environments, tray hosts and
  clipboard backends are supported. X11 and Wayland do not share clipboard or
  shortcut mechanisms, and the issue does not choose a subset or say how
  each is tested.

### Actions and boundary

- **Stated.** A tray icon with Fix clipboard
  (`lexicon daemon --once --paste`), Dictate
  (`lexicon voice --toggle --paste`), Open lexicon, Preferences and Quit.
- **Stated.** A global hotkey for Fix clipboard. On Linux, hotkeys are the
  desktop environment's job: keep shipping the GNOME/KDE shortcut recipe and
  register only what the environment allows.
- **Stated.** When the `lexicon` CLI is not on `PATH`, the tray says so
  plainly and disables everything except Preferences.
- **Stated.** The app has no logic of its own: it runs a `lexicon`
  subcommand with an argument array, reads stdout and shows the result, so
  the trust gate, hit counters and file handling stay identical across
  every surface.
- **Stated.** Verification is a real desktop check (see
  [below](#verification-the-issue-asks-for)).
- **Open.** How corrected text reaches the target application. The CLI's
  `--paste` sends a paste keystroke only on macOS; on Windows and Linux it
  copies the result and reports that automatic paste is unsupported. The
  issue suggests `SendInput` for Windows native paste and says nothing for
  Linux, so copy-only delivery versus native paste, failed copies, and how
  to avoid pasting stale clipboard contents or into a changed focus are
  tray decisions.
- **Open.** Windows shortcut registration and shortcut conflicts. The issue
  suggests `RegisterHotKey`, which fails rather than stealing a combination
  another app owns; what the user sees after such a failure is undecided.
  On Linux, which desktop-provided shortcuts work, including under X11 and
  Wayland, is also undecided.
- **Open.** How the tray presents recording, transcription progress,
  no-change and failure states, and how it serializes a Dictate and a Fix
  clipboard triggered together.
- **Open.** CLI discovery: how a desktop launcher locates the CLI and the
  voice dependencies, reports their absence, and which settings apply to
  both halves of the voice toggle.
- **Open.** Packaging, signing and release distribution for each platform.
  The issue asks for a release workflow only once the app builds
  reproducibly and says not to block the first contribution on it, so every
  distribution question is deferred rather than answered.

## What exists today

- The Windows tray already offers Fix clipboard, through a tray app in
  `apps/windows/` with Ctrl+Alt+V, Open lexicon, Preferences and Quit, driven
  by its local API client rather than the CLI the issue names as the
  boundary. It has no tray push-to-talk, its desktop integration has not been
  verified on a real Windows desktop and no release ships its binary. See
  [WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not).
- **Open.** Whether a contribution extends that app or starts a separate one,
  and how its local API path relates to the CLI boundary: the issue describes
  the target behavior and does not mention the existing app.
- That app also implements Fix everywhere, in-place correction through UI
  Automation. The issue's minimum does not call for a field watcher: the
  request names the menu-driven CLI actions.
- Linux has no tray app. The documented answer there is the clipboard daemon
  behind a desktop shortcut; see
  [DAEMON.md](DAEMON.md#linux-gnome-custom-shortcut). Every Linux line above
  is open work on top of the existing CLI.
- The complete proposed support is unimplemented. The per-action behavior a
  tray must reproduce (toggle semantics, exit codes, no-change results,
  CLI-missing handling) is mapped command by command in
  [tray-action-map.md](tray-action-map.md); the contract section
  [Windows and Linux tray proposal](CONTRACT.md#windows-and-linux-tray-proposal-issue-13)
  records the capability boundary, and [PLATFORMS.md](PLATFORMS.md) records
  per-platform verification status.

## Verification the issue asks for

Build the app, put `lexicon` on `PATH`, dictate into an application, press the
clipboard hotkey and confirm the pasted text is corrected and `lexicon stats`
counted the hits. That is a real desktop check: unit tests cannot verify
microphone, focus, clipboard or paste integration. Record the platform and
desktop session, and distinguish a successful copy from a verified paste,
since `--paste` copies the result rather than sending a paste keystroke
outside macOS. A partial contribution verifies the action and platform it
delivers and records what remains untested.

## Where the detail lives

| Page | What it pins down |
|---|---|
| [tray-action-map.md](tray-action-map.md) | Each requested action mapped to the code it would invoke and the work left |
| [tray-interaction-questions.md](tray-interaction-questions.md) | Open push-to-talk and clipboard interaction questions |
| [tray-platform-questions.md](tray-platform-questions.md) | Per-platform surfaces and platform-specific open questions |
| [CONTRACT.md](CONTRACT.md#windows-and-linux-tray-proposal-issue-13) | The capability boundary as a module contract |
| [MACOS-APP.md](MACOS-APP.md) | LexiconBar, the specification the tray is asked to match |
| [WINDOWS-APP.md](WINDOWS-APP.md) | The existing Windows tray app and its verification status |
| [PLATFORMS.md](PLATFORMS.md) | Per-platform support and clipboard backend status |

Back to [the docs index](README.md).
