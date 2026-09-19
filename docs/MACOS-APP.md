# LexiconBar: the macOS menu bar app

LexiconBar is a small native menu bar app that fronts the `lexicon` CLI. It has no logic of its own: every action runs a `lexicon` subcommand with an argument array, reads stdout, and shows the result. If the CLI is not installed the app says so and disables everything except Preferences.

Source: `apps/macos/LexiconBar` (Swift Package, macOS 13+, AppKit + SwiftUI, no third-party dependencies).

## What it does

| Menu item | Runs | Notes |
| --- | --- | --- |
| Push to talk (⌃⌥Space) | `lexicon voice --toggle --json --model <model> [--paste]` | Press once to start recording (the icon turns red), again to stop. The stop call transcribes with whisper.cpp, normalizes, pastes (or copies) and reports the corrections. The app also polls `lexicon voice --status` every 2 s while recording so the icon follows the CLI if recording stops on its own. |
| Fix clipboard now (⌃⌥V) | `lexicon daemon --once [--paste]` | Corrects whatever is on the clipboard and, in paste mode, sends Cmd+V. |
| Watch clipboard | `lexicon daemon --quiet` (child process) | Runs the clipboard watcher while checked. Restarted on unexpected exit after 5 s, at most 5 times in a row (a run longer than a minute resets the counter). Killed on quit. |
| Local API | `lexicon serve` (child process) | Same supervision as above. "Show API URL and token" runs `lexicon serve --show`. |
| Last correction | | Submenu with the `original → canonical` pairs from the most recent voice or clipboard run. Clicking one copies the canonical spelling. |
| Open lexicon file | `lexicon path` | Opens the global lexicon in your default YAML editor. |
| Stats… | `lexicon stats --json` | Term, alias and hit counts plus the top terms, in an alert. |
| Run doctor | `lexicon doctor` | Output in a scrollable window. |
| Start at login | `SMAppService.mainApp` | Only shown when running from the packaged `.app`. |
| Preferences… | | CLI path, whisper model (`base.en` / `small.en`), paste vs copy, both hotkeys. |

After each voice or clipboard run the app posts a notification such as "Corrected 2 words" listing the replacements. Notification permission is requested on first use; if you decline, the app stays quiet.

Timeouts: 60 s for the voice stop call (transcription), 10 s for everything else. A call that times out is terminated (SIGTERM, then SIGKILL) and the error appears at the bottom of the menu.

## Build from source

Requirements: Xcode 15 or newer (Swift 5.9+), macOS 13+.

```bash
scripts/build-macos-app.sh
open apps/macos/build/LexiconBar.app
```

The script runs `swift build -c release` in `apps/macos/LexiconBar`, assembles `apps/macos/build/LexiconBar.app` (Info.plist with `LSUIElement`, the microphone and Apple Events usage strings, and `CFBundleShortVersionString` taken from `package.json`), renders an `.icns` from the SF Symbol "waveform" with `sips` and `iconutil`, ad-hoc signs the bundle (`codesign --sign -`) and zips it with `ditto`. `SKIP_ICON=1` skips the icon step.

For development, `swift build` and `swift run` inside `apps/macos/LexiconBar` also work; the bare binary shows the status item but has no bundle, so notifications and Start at login are disabled. `swift test` runs the pure tests (hotkey encoding, CLI output parsing, restart backoff, CLI discovery).

The `macOS app` GitHub workflow (`.github/workflows/macos-app.yml`) builds, tests and packages on `macos-latest` and uploads `LexiconBar.app.zip` as an artifact.

### Opening an unsigned build

The app is ad-hoc signed and not notarized. The first launch of a downloaded copy is blocked by Gatekeeper. Either right-click the app and choose Open, or clear the quarantine flag:

```bash
xattr -d com.apple.quarantine apps/macos/build/LexiconBar.app
```

A build made on the same Mac (via the script above) is not quarantined and opens normally.

## Finding the CLI

On first launch, and whenever you press Re-detect in Preferences, the app asks your login shell for `command -v lexicon` and its `PATH`. Then it tries, in order:

1. the path set in Preferences (a `lexicon` binary, or a `dist/cli/index.js` which is run with `node`);
2. what the login shell reported;
3. `/opt/homebrew/bin/lexicon`, `/usr/local/bin/lexicon`;
4. `<repo>/dist/cli/index.js` when the app was built by the script and still lives in `apps/macos/build` (handy for development: `npm run build` first).

The `lexicon` shim installed by npm is a `#!/usr/bin/env node` script, so the app launches children with a PATH that includes the login shell's PATH plus the usual Homebrew, nvm, volta, fnm and `~/.local/bin` locations. If `node` lives somewhere unusual, put it on your shell's login PATH (`.zprofile`) or point Preferences at the binary directly.

## First-run permissions

macOS attributes permissions to the app at the root of the process tree, so it is LexiconBar (not `node`) that gets asked:

- **Microphone**: the first push-to-talk run prompts for microphone access (the usage string is in the app's Info.plist). Deny it and recordings are silent.
- **Accessibility**: pasting works by `lexicon` running `osascript` to send Cmd+V through System Events. That needs LexiconBar listed under System Settings > Privacy & Security > Accessibility. The app shows a one-time hint pointing there the first time a paste fails; the corrected text is on the clipboard either way, so Cmd+V by hand still works.
- **Notifications**: requested the first time a run finishes.
- **Automation (System Events)**: macOS may additionally ask once to allow LexiconBar to control System Events; that is the `NSAppleEventsUsageDescription` prompt.

If you also use the CLI from a terminal, the terminal app needs the same Microphone and Accessibility grants for its own runs.

## Hotkeys

Defaults: ⌃⌥Space for push to talk, ⌃⌥V for fix clipboard. Both are global (they work in any app) and are registered with Carbon `RegisterEventHotKey`, which does not need Accessibility permission. Change them in Preferences: click the field, press the new combination (Escape cancels), or pick a preset. A letter or digit without any modifier is refused so the hotkey cannot swallow typing; function keys (F1 to F20) are allowed on their own. If another app already owns the combination, registration fails and the menu shows "Could not register ...".

Hotkeys are stored in `UserDefaults` under `hotkey.pushToTalk` and `hotkey.fixClipboard` as `keyCode` + `modifiers` (Carbon bits).

## How it relates to the CLI

The app is a thin remote control. Everything it shows comes from these calls and their documented output:

- `lexicon voice --toggle --json`: first call prints `recording`; the second prints `{ raw, output, replacements, summary, model, seconds, ms }`. The app treats a `pasted: false` field, a `pasteError` field, or an `--paste failed` / "Accessibility" message on stderr as a paste failure.
- `lexicon voice --status`: exit 0 while recording, 1 when idle.
- `lexicon daemon --once [--paste]`: text output (`N corrections` then one `"a" -> "b" (reason, confidence)` line each, or `no changes`). The app parses those lines; a JSON object is also accepted if a later CLI prints one.
- `lexicon path`: `global: <path>` / `project: <path>|(none)`.
- `lexicon stats --json`: the core `LexiconStats` object (`termCount`, `aliasCount`, `totalHits`, `topTerms`, ...).
- `lexicon doctor`, `lexicon serve`, `lexicon serve --show`, `lexicon daemon`: run as is.

The lexicon file, the matcher, the trust gate and stats all stay in the CLI; the app never reads or writes the lexicon itself.

## Known limitations

- Ad-hoc signed and not notarized: right-click > Open (or `xattr -d com.apple.quarantine`) on first launch of a downloaded copy.
- Toggle, not hold-to-talk: press the hotkey once to start and once to stop, which is what `lexicon voice --toggle` implements. Hold-to-talk would need the CLI to expose separate start and stop calls.
- The app shows recordings only through `lexicon voice --status`; if the CLI is used from a terminal at the same time, both see the same recording state.
- Child processes (`daemon`, `serve`) are killed when the app quits normally. If the app is force-quit they may outlive it; `pkill -f "lexicon daemon"` cleans up.
- Start at login uses `SMAppService`, which requires the packaged `.app`; move it to `/Applications` before enabling so the path stays stable.
- One paste failure hint per install (reset with `defaults delete ai.ashlr.lexiconbar hint.accessibilityShown`).
- The status item may be hidden behind the notch on a MacBook with a crowded menu bar; macOS does this to any status item and the hotkeys keep working.
