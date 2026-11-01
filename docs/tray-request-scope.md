# Tray request scope

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) requests a Windows or
Linux tray app for the two actions available from the macOS LexiconBar menu bar.
This page records the request, not an implementation plan or a claim that the
requested behavior has shipped. A contribution covering one platform and one
action is explicitly considered complete and mergeable by the issue.

## Requested platforms and interactions

- **Windows and Linux:** provide a tray icon. macOS LexiconBar is the reference
  surface, described in [MACOS-APP.md](MACOS-APP.md).
- **Fix clipboard:** offer `lexicon daemon --once --paste` in the tray and a
  global shortcut for it.
- **Dictate:** offer `lexicon voice --toggle --paste` for push-to-talk. The
  command is a toggle: one invocation starts recording and another stops it.
- **Menu:** offer Open lexicon, Preferences and Quit. If `lexicon` is absent
  from `PATH`, explain that plainly and disable everything except Preferences.
- **Boundary:** invoke `lexicon` subcommands with argument arrays, read stdout
  and show the result. The issue uses this boundary to preserve shared trust,
  hit counting and file handling. It asks for no Electron dependency.
- **Linux shortcuts:** leave hotkeys to the desktop environment, retain the
  GNOME/KDE shortcut recipe and register only what the environment allows.

The issue suggests Windows `NotifyIcon` or `pystray`, `RegisterHotKey` and
`SendInput`, and a Linux `libappindicator`/`StatusNotifierItem` tray. These are
suggested approaches, not selected implementations. It asks contributors to
identify their platform on the issue, put source under `apps/windows/` or
`apps/linux/`, add a build script and platform documentation, and defer release
workflow work until builds are reproducible. Packaging and signing should not
block the first contribution.

## Current context

The existing Windows tray has a clipboard action and shortcut through its local
API client, but no tray push-to-talk; its desktop integration has not been
verified on a real Windows desktop. Linux has no tray app. See
[WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not) and
[PLATFORMS.md](PLATFORMS.md). On Windows and Linux, the CLI's `--paste` copies
the result rather than sending an automatic paste keystroke. A successful
command alone therefore does not establish that text reached the target app.
See the [action map](tray-action-map.md) for command behavior and limitations.

## Open implementation details

- **Open:** toolkit, supported Linux distributions and desktop environments,
  clipboard backends, packaging, signing and distribution.
- **Open:** whether to extend the existing Windows app or use another surface,
  and how to reconcile its local API path with the issue's CLI boundary.
- **Open:** native paste versus copy-only delivery, focus changes, clipboard
  changes and failure reporting. Windows `SendInput` is suggested; Linux paste
  delivery is not specified.
- **Open:** shortcut registration and conflict feedback on Windows, and which
  desktop-provided shortcuts work on Linux, including X11 and Wayland.
- **Open:** CLI and dependency discovery, recording and transcription feedback,
  settings across toggle calls, no-change results, errors and concurrent actions.

For further questions, see [tray-interaction-questions.md](tray-interaction-questions.md)
and [tray-platform-questions.md](tray-platform-questions.md).

## Verification requested by the issue

Build the app with `lexicon` on `PATH`, dictate into an application, use the
clipboard hotkey, and check that the pasted text is corrected and `lexicon stats`
counts the hits. This requires a real desktop check; CLI and unit tests alone do
not verify microphone, focus, clipboard or paste integration. For a partial
contribution, verify the action and platform it actually implements, and record
what remains unverified.

Back to [the docs index](README.md).
