# Platform support

Which parts of Lexicon work on macOS, Windows and Linux, and what each answer is based on. Read this before installing on a machine that is not a Mac, or before filing a bug that turns out to be a platform gap rather than a defect.

Every cell in the table below carries one of three marks. The sections after it
go into the cases where the mark alone would mislead.

- **Tested in CI**. A GitHub Actions job exercises this on that operating system on every push. The reason column says what the job actually does, because "tested" covers a wide range.
- **Works, untested on real hardware**. The code path exists and its logic is covered by unit tests, but nobody has run it against the real device, desktop session or API it drives. Treat it as a first draft.
- **Not available**. There is nothing to run. The reason column says why, and what to do instead.

The matrix is `ubuntu-latest`, `windows-latest` and `macos-latest`, with Node 20, 22 and 24 on Linux and Node 22 on the other two.

## The table

| Feature | macOS | Windows | Linux | What the mark rests on |
|---|---|---|---|---|
| CLI: all twenty-five `lexicon` commands | **Tested in CI** | **Tested in CI** | **Tested in CI** | The 844 TypeScript tests run on every matrix job, followed by a smoke test that drives the built binary rather than the source. Only the jsdom extension file is conditional, and only on Node 20. |
| MCP server (stdio, nineteen tools) | **Tested in CI** | **Tested in CI** | **Tested in CI** | The smoke step starts the real server as a child process and speaks stdio JSON-RPC to it on every job. |
| Claude Code hooks and the plugin bundle | **Tested in CI** | **Tested in CI** | **Tested in CI** | The end-to-end suite spawns the real hook and the real CLI as child processes; a separate gate fails if the committed plugin bundle has drifted from source. |
| `lexicon install <client> --apply` | **Tested in CI** | **Tested in CI** | **Tested in CI** | Covered by the portable suite everywhere. On Windows all five client configs are additionally written into a scratch `%USERPROFILE%` and read back off disk, so the paths are checked against the filesystem rather than against our own constant. |
| Config and data file locations | **Tested in CI** | **Tested in CI** | **Tested in CI** | Linux checks that `XDG_CONFIG_HOME` moves the lexicon and that a relative value is ignored per the spec; Windows checks `%APPDATA%\Claude` and `%APPDATA%\Code\User` against the real directories. |
| Local HTTP API (`lexicon serve`) | **Tested in CI** | **Tested in CI** | **Tested in CI** | The loopback bind, the bearer token file and all eleven routes are in the portable suite. The 0600 mode check is skipped on Windows, which has no POSIX mode bits. |
| Start the API at login (`serve --install`) | **Tested in CI** | **Tested in CI** | **Tested in CI** | Three different mechanisms with three different levels of proof. See [Start at login](#start-at-login). |
| Clipboard daemon (`lexicon daemon`) | **Tested in CI** | **Tested in CI** | **Tested in CI** | Windows drives the real `Get-Clipboard` and `Set-Clipboard` through `daemon --once`, including the CRLF round trip the backend promises. Linux drives real `xclip` and `xsel` under an Xvfb display. macOS `pbcopy` is covered by unit tests with an injected exec, not by a runner. |
| Paste after correcting (`daemon --once --paste`) | **Tested in CI** | **Not available** | **Not available** | On macOS the platform gate and the fallback notice are unit-tested; the `osascript` keystroke itself needs a logged-in desktop, so it is exercised by hand. Elsewhere there is nothing to test: the command prints a notice and leaves the corrected text on the clipboard, and you bind the paste key in your launcher, as [DAEMON.md](DAEMON.md) shows for AutoHotkey and GNOME. |
| Exports and imports (fifteen out, seven in) | **Tested in CI** | **Tested in CI** | **Tested in CI** | Pure file rendering and parsing, with no platform surface beyond line endings, and the whole set runs on all three. |
| Browser extension | **Tested in CI** | **Tested in CI** | **Tested in CI** | The extension suite runs under jsdom, which needs Node 22, which is the version macOS and Windows run. The extension is a browser artefact rather than an OS one: the host operating system only has to run `lexicon serve`. |
| `lexicon voice` (ffmpeg plus whisper.cpp) | **Tested in CI** | **Works, untested on real hardware** | **Works, untested on real hardware** | No runner has a microphone. The pipeline is unit-tested on all three with injected processes, and the macOS path is measured against 330 real clips in [BENCHMARK.md](BENCHMARK.md); the Windows and Linux capture arguments (`dshow`, `pulse` with an ALSA fallback) have never met real audio hardware. Windows CI checks only that a missing ffmpeg produces the `winget` install hint instead of a crash. |
| In-place correction in any app | **Tested in CI** | **Works, untested on real hardware** | **Not available** | macOS: 175 Swift tests plus a release build in CI, and the live Accessibility path verified by hand in TextEdit, the Codex desktop app and Safari. Windows: 158 headless C# tests run in CI on both Linux and `windows-latest` and the binary cross-builds from macOS, but every line that touches UI Automation is unrun. Linux: no tray app exists. See [System-wide in-place correction](#system-wide-in-place-correction). |

## System-wide in-place correction

This is the one feature where the three platforms are genuinely different products, so it is worth spelling out.

**macOS.** [LexiconBar](MACOS-APP.md) is a Swift menu bar app built on the Accessibility API. It watches the focused text field in whatever app you are typing into, decides whether the text that just arrived was dictated or typed, corrects it in place and offers an undo bubble. It is the reference implementation: the behaviour contract, the burst detector and the splice maths were all written here first. It needs an Accessibility grant, and the signing trap that keeps revoking that grant is documented at length on its own page.

**Windows.** [The tray app](WINDOWS-APP.md) is a C# port of the same design onto UI Automation. The porting is finished and the portable half is well covered: 158 unit tests carry the burst detector, the splice and alignment maths, the secret-field heuristic, bubble content and placement, and `serve.json` resolution, and they pass headless on macOS, Linux and Windows. What has never executed is everything on the other side of the line: COM activation, the MTA threading model, focus events, reading text through `TextPattern`, the caret offset, `SendInput`, SAFEARRAY and BSTR handling, the bubble window, the tray icon, hotkey registration and the registry write. That page lists them one by one, names the three most likely to be wrong on first contact, and ships a ten-minute manual test script. The `Windows app` workflow builds the solution, runs the 158 tests and publishes `LexiconBar.exe` as an artifact, but it cannot close this gap: a GitHub runner has no interactive desktop session, so there is no focused element, no foreground window and no caret to test against. Only a person at a real machine can, and no release ships the binary yet.

**Linux.** There is nothing. No tray app is written, and there is no plan that makes one cheap: X11 and Wayland do not share an accessibility story, AT-SPI on Wayland has no equivalent of the single global focus observer both the other implementations are built on, and every compositor answers differently. Until then the Linux route to correcting text anywhere is the clipboard: dictate, copy, press a hotkey bound to `lexicon daemon --once`, paste. [DAEMON.md](DAEMON.md) has the GNOME shortcut.

## Start at login

`lexicon serve --install` registers the local API to start with your session. It does something different on each platform, and the three are proved to different depths.

| Platform | What it writes | How far CI goes |
|---|---|---|
| macOS | `~/Library/LaunchAgents/ai.ashlr.lexicon.serve.plist` | The plist is generated under test, and `lexicon doctor` reports whether the agent is loaded. `launchctl bootstrap` itself is run by hand on a Mac, not on a runner. |
| Windows | A Scheduled Task with a logon trigger | A CI job creates the task, queries it back out of the Task Scheduler store, asserts the trigger and the program path, confirms `lexicon doctor` sees it, then deletes it and confirms it is gone. This is the most thoroughly proved of the three. |
| Linux | `~/.config/systemd/user/lexicon-serve.service` | The unit is written and then handed to `systemd-analyze verify`, which is the authority on whether it parses and whether `ExecStart` points at something runnable. The `systemctl --user enable --now` step is not verified: a GitHub runner has no user session bus, so `--install` writes the unit and then fails to enable it. |

On any other platform the command refuses and tells you to run `lexicon serve` from your own session startup.

## Clipboard backends

The daemon picks its backend from the platform and the environment, and `lexicon daemon --which` prints the choice. X11 is covered end to end; Wayland is not.

| Platform | Backend | Proof |
|---|---|---|
| macOS | `pbpaste` / `pbcopy` | Unit tests with an injected exec. Both binaries ship with the OS, so there is nothing to install and nothing to detect. |
| Linux, X11 | `xclip`, else `xsel` | Both drive the real clipboard under an Xvfb display in CI, through a two-line value, and the corrected text is read back out. |
| Linux, Wayland | `wl-paste` / `wl-copy` | Partial. CI proves that setting `WAYLAND_DISPLAY` selects this backend and that a missing compositor surfaces as an error rather than being swallowed as an empty clipboard. No runner has a compositor, so the round trip itself is unproved. |
| Windows | `Get-Clipboard` / `Set-Clipboard` | A real round trip in CI, asserting both that the text was corrected and that CRLF survived it. |

## What is the same everywhere

Worth saying plainly, because the differences above can make the project look more platform-dependent than it is. The lexicon file, the matcher, the trust gate, the hit counters, the nineteen MCP tools, the twenty-five CLI commands, the hooks, the starter packs and every export format behave identically on all three operating systems, and the same test suite proves it on all three. The platform-specific surface is narrow: how text gets into a field, how the clipboard is read, how a service starts at login, and whether an accessibility API exists to write through.

## Reporting a platform bug

Include `lexicon doctor` output, which already names your platform, your clipboard backend, whether the local API is reachable and whether the login service is registered. If the bug is in the Windows tray app, say so explicitly and include the app's own Run doctor output instead, since that half of the project is unverified by construction and a report from a real desktop is worth more than anything CI can produce.

## See also

- [WINDOWS-APP.md](WINDOWS-APP.md) is the full account of what the tray app does, what is unverified in it, and the manual test script to run before trusting it.
- [MACOS-APP.md](MACOS-APP.md) is the menu bar app the Windows one is a port of, including the Accessibility permission trap.
- [DAEMON.md](DAEMON.md) is the clipboard route, which is what you use on Linux and the fallback anywhere else.

Back to [the docs index](README.md).
