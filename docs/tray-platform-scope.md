# Tray platform scope

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) requests a tray app
on Windows and Linux with push-to-talk and clipboard repair, matching what
the macOS menu bar app already does. It is labeled `help wanted`, described
as a larger piece of work than most issues, and marked as on the roadmap.
This page is the scope of that request: which platforms and actions the
issue names, which of its lines are requirements a contribution is held to,
and which decisions it leaves open. It is an analysis of the issue, not a
claim that a tray exists; [tray-action-map.md](tray-action-map.md) is the
companion that maps each requested action to the code it would invoke.

Two marks label every line:

- **Stated.** The issue requires or explicitly requests it: an action, a
  boundary, a process step or a verification a contribution is asked to
  follow.
- **Open.** The issue names the need and leaves the decision to whoever
  builds it, or does not address it at all. Open here means open, not a
  decision waiting to be announced.

## Platforms

- **Stated.** Windows and Linux are the requested platforms. Both have the
  CLI and the clipboard daemon today and must wire their own hotkey through
  AutoHotkey or a GNOME custom shortcut, both documented in
  [DAEMON.md](DAEMON.md).
- **Stated.** macOS is the specification, not a target. LexiconBar already
  provides the menu bar surface there; the issue caps scope at matching
  what LexiconBar does and no more, and [MACOS-APP.md](MACOS-APP.md) is the
  document a tray is asked to conform to.
- **Stated.** A tray app for one platform, with one action, is a complete
  and mergeable contribution. The two platforms, and the individual actions
  within one platform, do not have to land together.
- **Stated.** New source goes under `apps/windows/` or `apps/linux/`, beside
  `apps/macos/`; a build script goes in `scripts/` following
  `scripts/build-macos-app.sh`; a `docs/WINDOWS-APP.md` or
  `docs/LINUX-APP.md` page plus a row in the [documentation index](README.md)
  and the [surfaces table](../README.md) are part of the change.
- **Stated.** No Electron dependency.
- **Open.** Which toolkit a contribution uses. The issue suggests a C#
  WinForms/WPF `NotifyIcon` app or a Python `pystray` app on Windows and a
  `libappindicator`/`StatusNotifierItem` tray on Linux, but these are
  suggestions, not picks.
- **Open.** Which Linux distributions, desktop environments and clipboard
  backends are supported. X11 and Wayland do not share clipboard or
  shortcut mechanisms, and the issue does not choose a subset.
- **Open.** Packaging, signing and release distribution. The issue asks for
  a release workflow only once the app builds reproducibly and says not to
  block the first PR on it, so every distribution question is deferred
  rather than answered.

## Actions

- **Stated.** A tray icon with Fix clipboard
  (`lexicon daemon --once --paste`), Dictate
  (`lexicon voice --toggle --paste`), Open lexicon, Preferences and Quit.
- **Stated.** A global hotkey for Fix clipboard. On Linux the issue assigns
  hotkeys to the desktop environment, so the stated boundary there is to
  keep shipping the GNOME/KDE shortcut recipe and register only what the
  environment allows.
- **Stated.** When the `lexicon` CLI is not on `PATH`, the tray says so
  plainly and disables everything except Preferences.
- **Stated.** The app has no logic of its own: it runs a `lexicon`
  subcommand with an argument array, reads stdout and shows the result, so
  the trust gate, hit counters and file handling stay identical across
  every surface.
- **Stated.** Contributors say on the issue which platform they are taking
  before starting.
- **Stated.** Verification is a real desktop check: build the app, put
  `lexicon` on `PATH`, dictate into an application, press the hotkey and
  confirm the pasted text is corrected and `lexicon stats` counted the
  hits.
- **Open.** How corrected text reaches the target application. The CLI's
  `--paste` sends a paste keystroke only on macOS; on Windows and Linux it
  copies the result and reports that automatic paste is unsupported. The
  issue suggests `SendInput` for Windows paste and says nothing for Linux,
  so copy-only delivery versus a native paste, and how to avoid pasting
  stale clipboard contents or into a changed focus, are tray decisions.
- **Open.** How the tray presents recording, transcription progress,
  no-change and failure states, and how it serializes a Dictate and a Fix
  clipboard triggered together.
- **Open.** How the tray locates the CLI and its dependencies, reports
  their absence, and which settings apply to both halves of the voice
  toggle.
- **Open.** Windows hotkey registration and conflict reporting. The issue
  suggests `RegisterHotKey`, which fails rather than stealing a combination
  another app owns; what the user sees after such a failure is undecided.

## Relationship to code that already exists

- Windows has a tray app in `apps/windows/` with Fix clipboard now,
  Ctrl+Alt+V, Open lexicon, Preferences and Quit, driven through its local
  API client rather than the CLI the issue names as the boundary. It has no
  tray push-to-talk, its desktop integration has never run on a real
  Windows desktop, and no release ships its binary; see
  [WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not). Whether
  a contribution extends that app or starts a separate one is open: the
  issue describes the target behavior and does not mention the existing
  app.
- That app also implements Fix everywhere, in-place correction through UI
  Automation. The issue's minimum does not call for a field watcher: the
  request names the menu-driven CLI actions, and a contribution with one
  action is already mergeable.
- Linux has no tray app at all, so the Linux lines above are entirely open
  work on top of the existing CLI.
- The per-action behavior a tray must reproduce (toggle semantics, exit
  codes, no-change results, CLI-missing handling) is mapped command by
  command in [tray-action-map.md](tray-action-map.md); the proposed
  capability boundary is in
  [CONTRACT.md](CONTRACT.md#windows-and-linux-tray-proposal-issue-13);
  per-platform verification status is in [PLATFORMS.md](PLATFORMS.md) and
  [WINDOWS-APP.md](WINDOWS-APP.md).

## Limits of the issue description

The issue asks for the two actions behind a tray icon, one global hotkey,
the menu shell around them and the real-desktop verification. It does not
specify toolkits, paste delivery, supported desktop environments or
clipboard backends, packaging or signing, UI states for recording and
failure, CLI discovery details, or how the work relates to the unverified
Windows app already in the tree. The open lines above are design work to
resolve, not requirements attributed to the issue.

Back to [the docs index](README.md).
