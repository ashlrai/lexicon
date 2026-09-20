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
| Fix everywhere | the local API (`POST /normalize`) | Rewrites dictated text in the focused field of any app, through Accessibility. See [Fix everywhere](#fix-everywhere). |
| Show the correction bubble | | Whether a fix puts a small panel near the caret. See [Correction bubble](#correction-bubble). |
| Last correction | | Submenu with the `original → canonical` pairs from the most recent voice, clipboard or Fix-everywhere run. Clicking one copies the canonical spelling. |
| Set up Lexicon… | the local API | Reopens the first-run window. See [First run](#first-run). |
| Open lexicon file | `lexicon path` | Opens the global lexicon in your default YAML editor. |
| Stats… | `lexicon stats --json` | Term, alias and hit counts plus the top terms, in an alert. |
| Run doctor | `lexicon doctor` | Output in a scrollable window. |
| Start at login | `SMAppService.mainApp` | Only shown when running from the packaged `.app`. |
| Preferences… | | CLI path, whisper model (`base.en` / `small.en`), paste vs copy, both hotkeys. |

After each voice or clipboard run the app posts a notification such as "Corrected 2 words" listing the replacements. Notification permission is requested on first use; if you decline, the app stays quiet.

Timeouts: 60 s for the voice stop call (transcription), 10 s for everything else. A call that times out is terminated (SIGTERM, then SIGKILL) and the error appears at the bottom of the menu.

## First run

The first launch opens **Set up Lexicon**, a 640×560 window with five steps. It is shown once (`UserDefaults` key `didOnboard`), and afterwards from the menu (**Set up Lexicon…**) or by launching with `--onboard`. `didOnboard` is written when the flow reaches the last step, so closing the window halfway brings it back next launch. To see it again: `defaults delete ai.ashlr.lexiconbar didOnboard`.

Every step talks to the local API (`lexicon serve`), never to the lexicon file directly.

| Step | What it shows | What it writes |
| --- | --- | --- |
| 1. Welcome | One sentence, the before/after example (you said "Ashlr.AI", dictation wrote "Ashler", Lexicon writes "Ashlr.AI"), and a live status line for Accessibility and the local API. **Grant Accessibility** opens the Privacy pane; **Start the API** turns the Local API setting on. The lines re-check every 2 s, so leaving for System Settings and coming back shows the new state. | Nothing, unless you press Start the API (`localAPI` setting). |
| 2. Your words | A table of rows: a "Correct spelling" field plus toggleable chips of what dictation is likely to write. The first row is pre-filled from your macOS full name (`NSFullUserName()`); the second is left blank rather than guessing a company wrong. 500 ms after you stop typing, or when you leave the field, the app asks `GET /aliases?canonical=…` and shows the answer as chips, all on. Switch any off, or type your own in "what dictation actually writes". A **Try it** box under the table normalizes whatever you type through `POST /normalize`, 300 ms after the last keystroke, with the corrected words in bold. | `POST /add {canonical, aliases}` per row, when you leave the field, press Return, or press Continue. |
| 3. Starter packs | A card per pack from `GET /packs`: title, description, term and spelling counts, and a switch. On a lexicon that lists no packs at all, `developer`, `ai` and `voice-tools` are switched on for you; a lexicon that already has packs is left alone. Each installed card then reads "64 terms added, 6 merged". | `POST /packs/:name` and `DELETE /packs/:name`. |
| 4. Where it works | Checkboxes that read and write the real settings: Fix everywhere, Watch clipboard, the local API, Show the correction bubble, plus the three hotkeys, and the same Try-it box. The local-API row is a checkbox only when this app could start or stop the server; when a LaunchAgent (or anything else) already owns the port it becomes a status line instead — see [Who runs the local API](#who-runs-the-local-api). | `fixEverywhere`, `watchClipboard`, `localAPI`, `bubble.show`. The clipboard watcher starts or stops with its checkbox; ticking the local API installs the LaunchAgent, falling back to a supervised child. |
| 5. Done | Term and spelling counts from `GET /stats`, the terms you added, the packs you switched on, what is enabled, and **Open the lexicon file**. | `didOnboard`. |

Writes are queued, never overlapped. `POST /add` and the pack routes are each a read-modify-write of the same YAML file on the server, so two in flight at once race and the later write wins. The window runs them strictly one at a time; reads (`/aliases`, `/normalize`, `/stats`) still go in parallel so nothing feels slow.

## Fix everywhere

With **Fix everywhere** on (the default), LexiconBar corrects dictated text in the focused field of any app, about a second after it lands, without you copying anything.

How it works: an `AXObserver` per app watches `kAXFocusedUIElementChanged` and `kAXValueChanged`, with a 500 ms poll for apps that post neither reliably. An insertion big enough to be dictation (at least `fixEverywhere.minWords` words, default 3) and quiet for the settle delay (`fixEverywhere.settleMs`, default 700 ms) becomes a *burst*; typing key by key never is. The burst goes to `POST /normalize` on the local API, and the corrected span is written back into the field, verified by re-reading it. Three strategies are tried in order: set `AXSelectedText` over the burst range (Cocoa text views, keeps the app's own undo stack); select the range and post the replacement as unicode key events (Chromium and Electron accept the selection but ignore `AXSelectedText`); write the whole spliced `AXValue` (last resort, loses undo). Nothing is written if the field changed underneath in the meantime.

- **Permission**: needs LexiconBar under System Settings > Privacy & Security > Accessibility. The menu shows "Needs Accessibility permission" until it is granted.

  Rebuilding the app changes its ad-hoc code signature, and the grant is bound to the *old* one. The row stays in the list with its switch still on, and it no longer authorises anything: TCC logs `Failed to match existing code requirement for subject ai.ashlr.lexiconbar` and denies with `auth_value=0`. **Toggling that row off and on does not help** — it keeps the stored signature. Select LexiconBar, remove it with **−**, then add the rebuilt `.app` again. `--status` will say `not granted` throughout, which is how to tell this apart from the app simply not asking.
- **Per-app exclusions**: the menu has "Fix everywhere in `<frontmost app>`", and Preferences has the full list. Terminals (`com.apple.Terminal`, iTerm2, Warp) and password managers are excluded by default: a rewrite in a shell is a command, not a sentence. A trailing `.*` matches a prefix (`com.jetbrains.*`); ids are matched case-insensitively.
- **Undo**: ⌃⌥Z, the menu's "Undo last fix", or the bubble's Undo button. It only applies while the same field still holds exactly the corrected text; edit on and the offer goes away.
- **Limitations**: apps with no Accessibility text support are invisible to it (nothing is corrected, nothing breaks). Secure text fields are refused by subrole and by a role description containing "secure" or "password". Fields over 20,000 characters are skipped, as are multi-paragraph bursts and any rewrite that would introduce a newline the burst did not have (in a chat composer that would send the message). One API call per field per 300 ms.

## Correction bubble

After a Fix-everywhere rewrite, a small floating panel appears just below and left of the caret, the way Grammarly does it. It is on by default; turn it off with the menu's **Show the correction bubble** or the Preferences row, and fixes are announced as notifications instead.

What it shows: up to three `original → canonical` lines, the heard spelling struck through and dimmed, the canonical bold, plus "+4 more" when there were more than three. Above them, "Fixed 2 words".

Three buttons:

| Button | What it does | Call |
| --- | --- | --- |
| **Undo** | Puts the dictated text back, exactly as ⌃⌥Z does. | none |
| **Never** | Records the original spelling under that term's `never` list so it is left alone from now on, and undoes the rewrite. | `POST /add {canonical, never: [original]}` |
| **Add** | Promotes the original to an explicit alias, so next time it is an exact match rather than a guess. Shown **only** when the rewrite came from a phonetic or fuzzy match; an exact alias is already explicit, so there is nothing to add. | `POST /learn {heard, meant}` |

Never and Add act on the guessed replacement when the bubble lists one, otherwise on the first.

Behaviour: fades in over 120 ms, and goes away after 4 seconds (2 to 10, or off, in Preferences). Hovering pauses the countdown so it cannot vanish on the way to Undo; leaving restarts it. Escape, a click anywhere else, switching app, or typing on dismisses it at once, and the next burst replaces it rather than stacking a second panel — there is only ever one.

The panel is a `.nonactivatingPanel` with `canBecomeKey` forced to false, at `.floating` level, joining all Spaces and staying out of the window cycle. It never takes keyboard focus, so you can keep typing straight through it; that also means Escape and clicks reach it through global event monitors rather than the responder chain.

Placement comes from Accessibility: the caret rectangle via `kAXBoundsForRangeParameterizedAttribute` over the selected range, falling back to the focused element's own frame (`AXPosition` + `AXSize`), then to the mouse. The result is clamped to the `visibleFrame` of the screen the caret is on, so it never lands under the menu bar, the notch or the Dock, and flips above the caret when there is no room below.

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

Defaults: ⌃⌥Space for push to talk, ⌃⌥V for fix clipboard, ⌃⌥Z to undo the last Fix-everywhere rewrite. All are global (they work in any app) and are registered with Carbon `RegisterEventHotKey`, which does not need Accessibility permission. Change them in Preferences: click the field, press the new combination (Escape cancels), or pick a preset. A letter or digit without any modifier is refused so the hotkey cannot swallow typing; function keys (F1 to F20) are allowed on their own. If another app already owns the combination, registration fails and the menu shows "Could not register ...".

Hotkeys are stored in `UserDefaults` under `hotkey.pushToTalk`, `hotkey.fixClipboard` and `hotkey.undoFix` as `keyCode` + `modifiers` (Carbon bits).

## How it relates to the CLI

The app is a thin remote control. Everything it shows comes from these calls and their documented output:

- `lexicon voice --toggle --json`: first call prints `recording`; the second prints `{ raw, output, replacements, summary, model, seconds, ms }`. The app treats a `pasted: false` field, a `pasteError` field, or an `--paste failed` / "Accessibility" message on stderr as a paste failure.
- `lexicon voice --status`: exit 0 while recording, 1 when idle.
- `lexicon daemon --once [--paste]`: text output (`N corrections` then one `"a" -> "b" (reason, confidence)` line each, or `no changes`). The app parses those lines; a JSON object is also accepted if a later CLI prints one.
- `lexicon path`: `global: <path>` / `project: <path>|(none)`.
- `lexicon stats --json`: the core `LexiconStats` object (`termCount`, `aliasCount`, `totalHits`, `topTerms`, ...).
- `lexicon doctor`, `lexicon serve`, `lexicon serve --show`, `lexicon daemon`: run as is.

The lexicon file, the matcher, the trust gate and stats all stay in the CLI; the app never reads or writes the lexicon itself.

## Who runs the local API

Everything the app corrects goes through `lexicon serve` on `127.0.0.1:41733`, but the app is only one of four things that can be running it. The menu's **Local API** row and step 4 of the first-run window both ask one resolver (`ServeOwnership.resolve` in `LexiconBarKit`) who owns it, so the two can never disagree:

| Who | How it is detected | What the row does |
| --- | --- | --- |
| **LaunchAgent** | `launchctl print gui/<uid>/ai.ashlr.lexicon.serve` exits 0 | Status line, "Local API: running at login (launchd)", with "Manage with `lexicon serve --uninstall`". No checkbox — a click could only start a second server that cannot bind the port. |
| **This app's child** | the app's own `ChildProcessSupervisor` has a live `lexicon serve` | Checkbox, on. Switching it off stops the child. |
| **Something else** | nothing above, but `GET /health` answers | Status line, "Local API: reachable (not managed by this app)". Usually a `lexicon serve` you started in a terminal; find it with `lsof -nP -iTCP:41733 -sTCP:LISTEN`. |
| **Nobody** | none of the above | Checkbox, off, labelled "Run the local API". |

launchd wins outright: with `KeepAlive` it takes the port back whatever else happens, so a child of ours could only thrash. A plist on disk that is *not* loaded is not ownership — it only changes the hint on the "nobody" row.

Ticking **Run the local API** installs the LaunchAgent (`lexicon serve --install`) rather than supervising a child, because that survives an app restart, a logout and a crash, which is what asking for "the local API" almost always means. If the install fails, the app falls back to a supervised child and says why.

The probes (a `launchctl print`, a `stat` of `~/Library/LaunchAgents/ai.ashlr.lexicon.serve.plist`, and a `GET /health`) run off the main thread and are cached for 5 s, so opening the menu never blocks on them. `$LEXICON_SERVE_LABEL` overrides the label, the same way the CLI does.

To see the answer without opening the menu:

```
apps/macos/build/LexiconBar.app/Contents/MacOS/LexiconBar --status --json
```

which prints `apiReachable`, `serveOwnership` (`launchAgent` / `appChild` / `foreign` / `none`), `serveTitle`, the probe inputs and the Accessibility fields described below. One caveat on ownership: `appChild` can never appear there, because a child of the *running* app is invisible to a separate process.

## Accessibility, and why `--status` will not answer for it

`AXIsProcessTrusted()` does not answer "is LexiconBar allowed to use Accessibility". It answers for the **responsible process**, and for anything started from a shell that is the terminal. A `--status` run from a terminal therefore inherits the terminal's grant, and a bare `.build/release/LexiconBar` — a binary that cannot hold a grant at all — will happily report `true` while the GUI-launched bundle is being denied.

So it does not report it. From a terminal, `--status` says:

```
Accessibility: cannot be checked from a terminal (this process inherits the terminal's grant). The menu bar app's own state is in Set up Lexicon.
```

and `--status --json` gives `"axTrusted": null`, with the inherited value kept as `"axTrustedRaw"` and the reason as `"axTrustedNote"`. Launched by the window server (`open`, a double-click, a login item) it answers for itself as before, `Accessibility: trusted` or `not trusted`. "From a terminal" means *no launchd parent, or a controlling terminal*: a script, a CI job and an agent harness all run without a TTY and still inherit the shell's grant, so the parent-process check is what actually decides.

The answer that matters comes from the running app, which writes its own state to `~/Library/Application Support/LexiconBar/state.json` (mode 0600, written atomically) at launch, when the focus watcher starts or stops, when the grant changes under it, and every 30 s otherwise:

```json
{ "axTrusted": false, "pid": 92830, "running": true, "updatedAt": "2026-09-20T03:32:31Z", "version": "0.4.0" }
```

`--status` reads it and prints a second line — this is the one to believe, and the one an agent should parse (`axAppTrusted`):

| State file | Second line |
| --- | --- |
| fresh, granted | `Accessibility (menu bar app): trusted (as of 8 seconds ago)` |
| fresh, denied | `Accessibility (menu bar app): not granted (as of 8 seconds ago) — add LexiconBar.app under …` |
| written on quit | `Accessibility (menu bar app): not running (it quit 4 seconds ago)` |
| older than 5 minutes | `Accessibility (menu bar app): not running (last heartbeat 9 minutes ago)` |
| missing | `Accessibility (menu bar app): not running (no state file at …)` |

The exit code follows whichever answer is real: the process's own when it was launched by the window server, otherwise the running app's, and 1 when nothing credible says yes.

The unified log still has the underlying decision if you want to see TCC itself refuse:

```
log show --last 5m --predicate 'process == "tccd"' --info | grep -B20 'AUTHREQ_RESULT' | grep -A6 lexiconbar
```

`auth_value=2` is granted, `auth_value=0` is denied. `auth_reason=5` next to `Failed to match existing code requirement for subject ai.ashlr.lexiconbar` is the signature trap described under [Fix everywhere](#fix-everywhere): the grant exists but is bound to a different build.

## Known limitations

- Ad-hoc signed and not notarized: right-click > Open (or `xattr -d com.apple.quarantine`) on first launch of a downloaded copy.
- Toggle, not hold-to-talk: press the hotkey once to start and once to stop, which is what `lexicon voice --toggle` implements. Hold-to-talk would need the CLI to expose separate start and stop calls.
- The app shows recordings only through `lexicon voice --status`; if the CLI is used from a terminal at the same time, both see the same recording state.
- Child processes (`daemon`, `serve`) are killed when the app quits normally. If the app is force-quit they may outlive it; `pkill -f "lexicon daemon"` cleans up.
- Start at login uses `SMAppService`, which requires the packaged `.app`; move it to `/Applications` before enabling so the path stays stable.
- One paste failure hint per install (reset with `defaults delete ai.ashlr.lexiconbar hint.accessibilityShown`).
- The status item may be hidden behind the notch on a MacBook with a crowded menu bar; macOS does this to any status item and the hotkeys keep working.
