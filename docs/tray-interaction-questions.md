# Tray interaction questions

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) asks for Windows and
Linux tray access to push-to-talk and clipboard repair. This is a set of open
questions for contributors, not a specification or a claim that the proposed
interactions are implemented. The [platform scope](tray-platform-scope.md)
separates the issue's requests from open decisions; the
[action map](tray-action-map.md) links those requests to existing behavior.

The issue proposes a CLI boundary: run a `lexicon` subcommand with an argument
array and show its result. It permits one platform and one action to land on
their own. It requests Fix clipboard, Dictate, Open lexicon, Preferences, Quit,
and a global Fix clipboard hotkey. Missing CLI handling is also requested:
explain the problem and disable everything except Preferences.

## What exists today

- Dictate is proposed as `lexicon voice --toggle --paste`. The first toggle
  starts recording and the next stops and transcribes; this is a toggle, not
  hold-to-talk. The stop call uses its own options. On Windows and Linux the
  CLI copies the result instead of automatically pasting it. See
  [VOICE.md](VOICE.md#hotkey-mode---toggle).
- Fix clipboard is proposed as `lexicon daemon --once --paste`. The one-shot
  command corrects clipboard text; on Windows and Linux it leaves the result on
  the clipboard for manual paste. Empty, binary, oversized or letterless
  content is left alone. See [DAEMON.md](DAEMON.md).
- The existing Windows tray has Fix clipboard and a hotkey through its local
  API client, not the proposed CLI path; it has no tray push-to-talk. Its
  desktop integration, including clipboard and hotkey behavior, is unverified
  on a real Windows desktop. Linux has no tray app. See
  [WINDOWS-APP.md](WINDOWS-APP.md#what-is-verified-and-what-is-not).

## Push-to-talk

- How should the tray show recording, stopping, transcription, completion,
  nothing heard and errors? An exit code of 0 on the first toggle means
  recording started, not that a transcript is ready.
- Which model, device, language, history and delivery settings should be used
  on each invocation? How should the tray recover if the recorder stops on its
  own, the app quits during recording, or a second request arrives while
  transcription is running?
- What feedback and recovery should be offered for missing ffmpeg,
  whisper.cpp, model or microphone access? How should users understand that
  voice history is written by default and can be disabled?
- On Windows, how should real-device tests measure audio lost at the end of a
  toggle when the detached recorder is terminated? On Linux, which audio
  systems and desktop environments need verification?

## Clipboard and delivery

- Should delivery remain copy-only, or should a user opt in to native paste?
  How should the tray distinguish a completed copy from a failed copy, a
  no-change or skipped clipboard, and an intermediate recording status before
  sending any paste keystroke?
- How can the original target and focus be checked after the tray menu opens
  or transcription finishes? What happens if the clipboard or target changes
  in the meantime, another application holds the clipboard, or a paste is
  blocked? How is the user told what remains on the clipboard?
- How should simultaneous Dictate and Fix clipboard requests be serialized so
  neither overwrites or pastes the other's text? What feedback should a
  no-change result receive without exposing clipboard contents in notifications?

## Platform and shortcut questions

- **Windows:** Should a contribution extend the existing tray or build a
  separate CLI-driven surface? The issue suggests `RegisterHotKey` and
  `SendInput`; how should shortcut conflicts, elevated target windows and
  failed input delivery be reported and tested?
- **Linux:** Which distributions, tray hosts and clipboard backends are in
  scope? How do X11 and Wayland differ for clipboard ownership, focus and
  paste? The issue assigns shortcuts to the desktop environment: which GNOME
  and KDE recipes can be supported, and what happens when registration or
  synthesized input is unavailable?
- **Both:** How is the CLI discovered when a desktop launcher has a different
  PATH, and how does the app recover after Preferences changes? Which shortcut
  choices, accessibility needs and packaging or signing requirements remain
  platform decisions?

## Evidence needed

For each supported desktop, record the OS, desktop session and clipboard
backend, then test the requested actions in a real target application. Include
start and stop, successful correction, no change, missing dependencies, failed
copy, changed focus, shortcut conflict and concurrent requests. Confirm the
corrected text and `lexicon stats` when a correction is made. Distinguish a
successful copy from a verified paste, and record unsupported or untested
cases. Unit tests with injected dependencies cannot establish desktop focus,
microphone or paste behavior; the issue's real-desktop check remains necessary.
