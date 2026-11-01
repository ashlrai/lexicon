# Windows and Linux tray platform questions

[Issue #13](https://github.com/ashlrai/lexicon/issues/13) requests tray access
to clipboard repair and push-to-talk on Windows and Linux. This page separates
its platform suggestions from questions that remain open; it does not announce
a design decision or claim the requested behavior has shipped. One platform
and one action can be a complete contribution. The
[platform scope](tray-platform-scope.md), [action map](tray-action-map.md) and
[interaction questions](tray-interaction-questions.md) cover the shared
contract and user experience in more detail.

Both surfaces are asked to match [LexiconBar](MACOS-APP.md): a tray menu with
Fix clipboard (`lexicon daemon --once --paste`), Dictate
(`lexicon voice --toggle --paste`), Open lexicon, Preferences and Quit, plus a
global Fix clipboard shortcut. The issue specifies invoking CLI subcommands with
argument arrays and showing their output, so the CLI retains the trust gate,
hit counting and file handling. If `lexicon` is absent from PATH, the issue
asks for a plain explanation and for everything except Preferences to be
disabled. It excludes Electron. The voice command is a start/stop toggle, not
hold-to-talk. On Windows and Linux the CLI's `--paste` currently copies and
reports that automatic paste is unsupported; it does not send a paste key.

## Windows surface

The issue suggests a C# WinForms/WPF `NotifyIcon` or Python `pystray` app,
`RegisterHotKey` for the shortcut and `SendInput` for paste. These are
suggestions, not a selected implementation. Source belongs under
`apps/windows/`.

The existing [Windows tray](WINDOWS-APP.md) already offers Fix clipboard and
a shortcut through its local API client, rather than the issue's CLI boundary;
it does not offer tray push-to-talk. Its desktop integration has not been
verified on a real Windows desktop and no release ships the binary. The issue
does not resolve how this existing app relates to its proposed surface.

Open questions:

- Extend the existing tray or build a separate CLI-driven surface? How should
  the local API implementation and the requested CLI boundary coexist?
- Which toolkit and supported Windows versions should be chosen? How will a
  GUI launch find the CLI and its dependencies with a different PATH, and
  recover after Preferences changes?
- Which shortcut should be the default, and how should a registration conflict
  be reported and resolved? What remains usable when registration fails?
- Should paste be opt-in? How can `SendInput` avoid a stale clipboard or changed
  focus, and how should failure or an elevated target be communicated? Sending
  input alone does not prove that the intended field accepted it.
- Which microphone and audio devices need real-machine checks, including audio
  potentially lost at the end of the Windows recording toggle?

## Linux surface

The issue suggests a `libappindicator`/`StatusNotifierItem` tray and assigns
hotkeys to the desktop environment: retain GNOME/KDE shortcut recipes and
register only what the environment permits. Source belongs under `apps/linux/`.
There is currently no Linux tray app. The existing
[daemon guide](DAEMON.md#linux-gnome-custom-shortcut) documents a GNOME
shortcut; a KDE recipe remains to be established.

Open questions:

- Which distributions, desktop environments, tray hosts and sessions are in
  scope? What should happen when a desktop has no compatible tray host?
- Which GNOME and KDE shortcut recipes work in the supported environments,
  and how should conflicts or unavailable registration be surfaced without
  assuming the app can own a global shortcut?
- How will X11 and Wayland clipboard ownership, backend availability and
  focus changes affect delivery? The CLI uses `wl-clipboard` on Wayland and
  `xclip` or `xsel` on X11; real Wayland clipboard round trips remain unverified
  in CI. See [platform status](PLATFORMS.md#clipboard-backends).
- Should delivery stay copy-only or support native paste where permitted? What
  should the user do when synthesized input is unavailable or the target has
  changed? Which PulseAudio/ALSA and microphone configurations need testing?
- How will desktop launchers find the CLI and voice dependencies, and what
  package formats and desktop integration will each supported distribution use?

## Evidence and remaining decisions

For either platform, decide packaging and signing after a reproducible build;
the issue does not require a release workflow for the first contribution. It
also asks for a build script, a platform app guide and documentation index and
surface-table entries when an app is contributed. Choose supported environments
and record the result rather than treating the questions above as settled.

The issue's desktop check is to build the app with `lexicon` on PATH, dictate
into an application, use the clipboard hotkey, and confirm corrected pasted
text and counted hits with `lexicon stats`. Record OS, session and clipboard
backend; also check a missing CLI, shortcut conflict, no-change result, changed
focus and failure to copy. Distinguish a copied result from a verified paste.
Headless tests alone cannot verify the tray, microphone, focus or target app.

Back to [the docs index](README.md).
