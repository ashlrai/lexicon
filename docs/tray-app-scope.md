# Windows and Linux tray app scope

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) requests a Windows or
Linux tray app that brings LexiconBar's push-to-talk and clipboard correction
to those desktops. This document records the request and outstanding decisions;
it does not announce a new app. The issue accepts one platform and one action
as a complete contribution.

## Requested behavior

- **Push-to-talk:** offer Dictate via `lexicon voice --toggle --paste`. One
  invocation starts recording; another stops it and transcribes and normalizes
  the result. See [VOICE.md](VOICE.md#hotkey-mode---toggle).
- **Fix clipboard:** offer `lexicon daemon --once --paste` from the tray and a
  global hotkey. The command normalizes clipboard text; see [DAEMON.md](DAEMON.md).
- Include Open lexicon, Preferences and Quit. If `lexicon` is not on `PATH`,
  explain the problem and disable everything except Preferences.
- Keep the tray thin: run `lexicon` subcommands with argument arrays, read
  stdout and show the result, preserving the shared trust, hit counting and file
  handling. Do not add an Electron dependency. On Linux, the issue leaves
  hotkeys to the desktop environment and asks to retain the GNOME/KDE recipe.

The issue uses [LexiconBar](MACOS-APP.md) as the reference, suggests platform
toolkits and asks for source, a build script and platform documentation. It
defers release workflow work until builds are reproducible; packaging and
signing need not block the first contribution.

## Existing behavior and limits

The Windows tray already offers Fix clipboard and a shortcut through its local
API client, but has no tray push-to-talk. Its desktop integration has not been
verified on a real Windows desktop. Linux has no tray app. See
[WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not).

On Windows and Linux, the CLI's `--paste` copies the result rather than
sending a paste keystroke. A successful command does not prove that text reached
the intended application. The voice toggle can also return a recording or
stopping status before a transcript is ready. The [action map](tray-action-map.md)
details command results and failure cases.

## Unresolved implementation decisions

- Which toolkit and Linux distributions, desktop environments, tray hosts and
  clipboard backends will be supported? How will X11 and Wayland be tested?
- Should Windows extend the existing API-based tray or use the issue's proposed
  CLI boundary? How will a desktop launcher find the CLI and voice dependencies?
- Should delivery remain copy-only or support native paste? How will changed
  focus or clipboard contents, failed copies and unavailable paste be handled?
- How will shortcut conflicts, recording and transcription states, no-change
  results, errors and concurrent actions be presented? Which settings apply to
  both voice toggle invocations?
- What packaging, signing and distribution approach will each platform use?

These are open questions, not choices made by the issue. See the
[platform scope](tray-platform-scope.md) and
[interaction questions](tray-interaction-questions.md) for more detail.

## Verification for an implementation

The issue asks contributors to build the app with `lexicon` on `PATH`, dictate
into an application, use the clipboard hotkey, and confirm the pasted text is
corrected and `lexicon stats` counts the hits. Record the platform and desktop
session, and distinguish a successful copy from a verified paste. For a
partial contribution, verify the action and platform delivered and record what
remains untested. Unit tests alone cannot verify desktop focus, microphone or
paste integration.

Back to [the docs index](README.md).
