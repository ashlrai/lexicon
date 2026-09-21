# LexiconBar: the macOS menu bar app

LexiconBar is a small native menu bar app that fronts the `lexicon` CLI. It has no logic of its own: every action runs a `lexicon` subcommand with an argument array, reads stdout, and shows the result. If the CLI is not installed the app says so and disables everything except Preferences.

Source: `apps/macos/LexiconBar` (Swift Package, macOS 13+, AppKit + SwiftUI, no third-party dependencies).

## Get it

Every release attaches a built app. Download `LexiconBar.app.zip` from the
[latest release](https://github.com/ashlrai/lexicon/releases/latest), unzip it,
and drag `LexiconBar.app` into `/Applications`. That is the route to take unless
you are changing the app itself; [Build from source](#build-from-source) is the
other one.

It needs the `lexicon` CLI on your machine as well, since the app has no logic
of its own: `brew install ashlrai/tap/lexicon`, or see
[QUICKSTART.md](QUICKSTART.md).

The build is ad-hoc signed and not notarized, so macOS will not open it on a
double-click the first time. Right-click the app and choose **Open**, then
**Open** again in the dialog (or run `xattr -d com.apple.quarantine
/Applications/LexiconBar.app` once). This is what [Opening an unsigned
build](#opening-an-unsigned-build) is about, and it applies to every update,
because each release is signed with a different ad-hoc identity.

## What it does

| Menu item | Runs | Notes |
| --- | --- | --- |
| Push to talk (⌃⌥Space) | `lexicon voice --toggle --json --model <model> [--paste]` | Press once to start recording (the icon turns red), again to stop. The stop call transcribes with whisper.cpp, normalizes, pastes (or copies) and reports the corrections. The app also polls `lexicon voice --status` every 2 s while recording so the icon follows the CLI if recording stops on its own. |
| Fix clipboard now (⌃⌥V) | `lexicon daemon --once [--paste]` | Corrects whatever is on the clipboard and, in paste mode, sends Cmd+V. |
| Watch clipboard | `lexicon daemon --quiet` (child process) | Runs the clipboard watcher while checked. Restarted on unexpected exit after 5 s, at most 5 times in a row (a run longer than a minute resets the counter). Killed on quit. |
| Local API | `lexicon serve` (child process) | Same supervision as above. "Show API URL and token" runs `lexicon serve --show`. |
| Fix everywhere | the [local API](LOCAL-API.md) (`POST /normalize`) | Rewrites dictated text in the focused field of any app, through Accessibility. See [Fix everywhere](#fix-everywhere). |
| Show the correction bubble | | Whether a fix puts a small panel near the caret. See [Correction bubble](#correction-bubble). |
| Last correction | | Submenu with the `original → canonical` pairs from the most recent voice, clipboard or Fix-everywhere run. Clicking one copies the canonical spelling. |
| Set up Lexicon… | the local API | Reopens the first-run window. See [First run](#first-run). |
| Open lexicon file | `lexicon path` | Opens the global lexicon in your default YAML editor. |
| Stats… | `lexicon stats --json` | Term, alias and hit counts plus the top terms, in an alert. |
| Run doctor | `lexicon doctor` | Output in a scrollable window. |
| Start at login | `SMAppService.mainApp` | Only shown when running from the packaged `.app`. |
| Preferences… | | CLI path, whisper model (`base.en` / `small.en`), paste vs copy, all three hotkeys. |

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
| 4. Where it works | Checkboxes that read and write the real settings: Fix everywhere, Watch clipboard, the local API, Show the correction bubble, plus the three hotkeys, and the same Try-it box. The local-API row is a checkbox only when this app could start or stop the server; when a LaunchAgent (or anything else) already owns the port it becomes a status line instead. See [Who runs the local API](#who-runs-the-local-api). | `fixEverywhere`, `watchClipboard`, `localAPI`, `bubble.show`. The clipboard watcher starts or stops with its checkbox; ticking the local API installs the LaunchAgent, falling back to a supervised child. |
| 5. Done | Term and spelling counts from `GET /stats`, the terms you added, the packs you switched on, what is enabled, and **Open the lexicon file**. | `didOnboard`. |

Writes are queued, never overlapped. `POST /add` and the pack routes are each a read-modify-write of the same YAML file on the server, so two in flight at once race and the later write wins. The window runs them strictly one at a time; reads (`/aliases`, `/normalize`, `/stats`) still go in parallel so nothing feels slow.

## Fix everywhere

With **Fix everywhere** on (the default), LexiconBar corrects dictated text in the focused field of any app, about a second after it lands, without you copying anything.

How it works: an `AXObserver` per app watches `kAXFocusedUIElementChanged` and `kAXValueChanged`, with a 500 ms poll for apps that post neither reliably. An insertion big enough to be dictation (at least `fixEverywhere.minWords` words, default 3) and quiet for the settle delay (`fixEverywhere.settleMs`, default 700 ms) becomes a *burst*; typing key by key never is, because a burst also requires at least one change event that inserted four units at once, and typing arrives one unit at a time. The burst goes to `POST /normalize` on the local API, and the corrected span is written back into the field, verified by re-reading it. Three strategies are tried in order: set `AXSelectedText` over the burst range (Cocoa text views, keeps the app's own undo stack); select the range and post the replacement as unicode key events (Chromium and Electron accept the selection but ignore `AXSelectedText`); write the whole spliced `AXValue` (last resort, loses undo). Nothing is written if the field changed underneath in the meantime.

One thing the Windows app has and this one does not: a recovery for a keystroke write that half-lands. There, `SendInput` reports how much of the call it accepted and the engine watches the field to work out what actually went in, repairs it where it can and records an undo where it cannot. Here, key events are posted with no accounting at all, so an app that consumes part of the replacement and stops leaves the field holding half a correction with the original span already gone, and the engine reports that it could not write and records nothing. That is the one remaining way this app can leave text it cannot put back, and closing it means porting `PartialWrite` and `KeystrokeSettle` from the C# core.

- **Permission**: needs LexiconBar under System Settings > Privacy & Security > Accessibility. The menu shows "Needs Accessibility permission" until it is granted.

  Rebuilding the app changes its ad-hoc code signature, and the grant is bound to the *old* one. The row stays in the list with its switch still on, and it no longer authorises anything: TCC logs `Failed to match existing code requirement for subject ai.ashlr.lexiconbar` and denies with `auth_value=0`. **Toggling that row off and on does not help**: it keeps the stored signature. Select LexiconBar, remove it with **−**, then add the rebuilt `.app` again. `--status` will say `not granted` throughout, which is how to tell this apart from the app simply not asking.
- **Streamed dictation**: dictation does not always arrive as one insertion. macOS's own dictation, Wispr Flow's streaming mode and an app's built-in microphone button insert a word at a time, and the gaps between spoken words are routinely longer than the 700 ms settle delay. That used to end the run at the first pause, leaving a single word that was "too short" to correct, and then doing the same for every following word, so a dictated sentence went through completely uncorrected. A run that has produced at least one word-sized insertion is now held open until the field has been quiet for `runQuietMs` (default 1500 ms, longer than a pause between words), and the words are corrected together as one burst. Continuous dictation is capped at `maxRunMs` (default 12 s) so it is still corrected periodically. A single insertion that already reads as a burst (a paste, or a dictation tool that inserts the finished phrase) still fires at the settle delay, so pasting is no slower than before.

- **Every refusal is decided before the field's text is read, not after.** There are three guards: the secure-field check, the per-app exclusion list and the secret-label heuristic, the last two described below. The Accessibility API will tell you a field's role and subrole, its identifier, its placeholder, its title, its help and description, the title of the window it sits in and which app owns it without ever touching its contents, and that metadata is all three of them need. Only a field that passes all three is asked for its value; a refused one is never read at all, so its text is never in this process's memory, where a crash dump or an attached debugger could reach it. This is enforced in `FieldGate`, which lives in `LexiconBarKit` so it can be unit-tested, and which `FocusWatcher` consults before its first read, again on every `kAXValueChanged` notification and again on every poll tick, because the exclusion list can change while the app it now covers still has focus. A field already refused stays refused without being re-examined until that list changes. The same checks run once more before anything is sent to the local API and before anything is written back, as defence in depth rather than as the guard itself.

- **Per-app exclusions**: the menu has "Fix everywhere in `<frontmost app>`", and Preferences has the full list. A trailing `.*` matches a prefix (`com.jetbrains.*`); ids are matched case-insensitively. Switching an app off takes effect immediately, including for the field that has focus at that moment: its cached text is dropped and nothing further is read from it. Excluded by default:

  - **Terminals**, because a rewrite in a shell is a command, not a sentence: Terminal, iTerm2, Warp (stable and preview), Ghostty, kitty, Alacritty, WezTerm, Hyper.
  - **Credential stores and password managers**: Apple Passwords, Keychain Access, 1Password (`com.1password.*`, `com.agilebits.*`), Bitwarden, Dashlane, LastPass, KeePassXC, NordPass, Enpass, Proton Pass, Keeper (`com.callpod.*`, `com.keepersecurity.*`), RoboForm, Strongbox, Zoho Vault.

  Most of the manager entries are vendor prefixes rather than exact ids, because an exact list is wrong the moment a vendor ships a new bundle id. **If your manager is not on the list, add it**: focus it and use the menu's "Fix everywhere in `<app>`" to switch it off, or add its bundle id in Preferences. `osascript -e 'id of app "YourApp"'` prints the id.

- **Fields that look like they hold a secret**: a bundle-id list always lags reality, and the secure-field check only protects the literal masked password input. In any manager that is not on the list, the *ordinary* fields (an item's notes, a custom field, a TOTP seed box, a vault search field echoing a username) would otherwise be read and sent to the local API. So, independently of which app it is, a field is refused when its accessibility identifier, placeholder, title, help, description or role description (or the title of the window it sits in) contains one of `password`, `passphrase`, `passcode`, `secret`, `token`, `api key`, `private key`, `seed`, `mnemonic`, `recovery`, `pin`, `cvv`, `cvc`, `security code`, `verification code`, `otp`, `totp`, `2fa`, `mfa`, `credential`, `keychain`, `vault`, `card number`, `account number`, `routing number` or `social security`. Matching is on whole words after splitting camel case and punctuation, so `apiKeyField` and `api_key` match but "shipping" never matches "pin" and an ordinary Notes field is left alone. A refused field is never watched at all, and its value is never fetched: not when focus lands on it, not on a value-changed notification, not on the poll. The log says `not reading this field in <app>: the field's labels look like a secret (<term>)`.
- **Undo**: ⌃⌥Z, the menu's "Undo last fix", or the bubble's Undo button. It only applies while the same field still holds exactly the corrected text; edit on and the offer goes away. An undo is a read followed by a write, so it asks the same gate every other read asks, and the record of the correction is consumed only once the write has actually landed. It used to be consumed the moment the undo was attempted, so an undo whose write did nothing, because the field changed a moment earlier or the app refused the value, took the correction's only record with it: text the user never typed, and nothing left that could put theirs back. The same bug was fixed on Windows first.
- **Apps that hide their Accessibility tree**: some apps build one only once an assistive client asks, and the two opt-in switches are not the same one. Electron and most Chromium embedders take `AXManualAccessibility`, which LexiconBar sets for every app it watches. The Codex/ChatGPT desktop app rejects that one and stays dark (its whole window reads as six nested empty `AXGroup`s and `AXFocusedUIElement` answers `kAXErrorNoValue`) until AppKit's own `AXEnhancedUserInterface` is written, after which its composer turns out to be an ordinary writable `AXTextArea`. LexiconBar therefore sends that second nudge, but only to an app that has already reported no focused element, at most once per process, because enhanced mode makes AppKit animate window frame changes and window managers object to it being on globally. It is logged: `<app> reported no focused element; enabling AXEnhancedUserInterface`.

- **Limitations**: apps with no Accessibility text support are invisible to it (nothing is corrected, nothing breaks, and the log line above is the only trace). **Cursor and VS Code are in this group**: they expose no focused text element even after both nudges, because they build an Accessibility tree only when their own accessibility-support setting is on, so Fix everywhere does nothing in their editor and Quick Open. Secure text fields are refused by subrole and by a role description containing "secure" or "password". Fields over 20,000 characters are skipped, as are multi-paragraph bursts and any rewrite that would introduce a newline the burst did not have (in a chat composer that would send the message). An insertion that cannot be located (because the text around it repeats and the caret does not pin it down) is refused rather than guessed at. One API call per field per 300 ms.

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

Behaviour: fades in over 120 ms, and goes away after 4 seconds (2 to 10, or off, in Preferences). Hovering pauses the countdown so it cannot vanish on the way to Undo; leaving restarts it. Escape, a click anywhere else, switching app, or typing on dismisses it at once, and the next burst replaces it rather than stacking a second panel: there is only ever one.

The panel is a `.nonactivatingPanel` with `canBecomeKey` forced to false, at `.floating` level, joining all Spaces and staying out of the window cycle. It never takes keyboard focus, so you can keep typing straight through it; that also means Escape and clicks reach it through global event monitors rather than the responder chain.

Placement comes from Accessibility: the caret rectangle via `kAXBoundsForRangeParameterizedAttribute` over the selected range, falling back to the focused element's own frame (`AXPosition` + `AXSize`), then to the mouse. The result is clamped to the `visibleFrame` of the screen the caret is on, so it never lands under the menu bar, the notch or the Dock, and flips above the caret when there is no room below.

## Build from source

Only needed if you are changing the app. To just use it, download
`LexiconBar.app.zip` from the [latest
release](https://github.com/ashlrai/lexicon/releases/latest); see [Get
it](#get-it).

Requirements: Xcode 15 or newer (Swift 5.9+), macOS 13+.

```bash
scripts/build-macos-app.sh
open apps/macos/build/LexiconBar.app
```

The script runs `swift build -c release` in `apps/macos/LexiconBar`, assembles `apps/macos/build/LexiconBar.app` (Info.plist with `LSUIElement`, the microphone and Apple Events usage strings, and `CFBundleShortVersionString` taken from `package.json`), renders an `.icns` from the SF Symbol "waveform" with `sips` and `iconutil`, codesigns the bundle (see [Signing](#signing-and-why-the-accessibility-grant-kept-disappearing)) and zips it with `ditto`. `SKIP_ICON=1` skips the icon step.

For development, `swift build` and `swift run` inside `apps/macos/LexiconBar` also work; the bare binary shows the status item but has no bundle, so notifications and Start at login are disabled. `swift test` runs the portable tests (the burst detector, the splice and alignment maths, the secret-field heuristic, the read gate, bubble content and placement, hotkey encoding, CLI output parsing, restart backoff, CLI discovery) and the settings-to-watcher wiring, which links the executable target so the exclusion list can be driven through the real publisher and the undo hotkey driven against a field that counts every read. The undo cases are there because the hotkey is a read and a write in one: the gate has to be asked before the read, and the record of the correction has to survive a write that does not land.

The `macOS app` GitHub workflow (`.github/workflows/macos-app.yml`) builds, tests and packages on `macos-latest` and uploads `LexiconBar.app.zip` as an artifact.

### Opening an unsigned build

The app is signed ad-hoc and not notarized. A copy that arrived over the network is quarantined, so Gatekeeper blocks its first launch. That covers both `LexiconBar.app.zip` from a [release](https://github.com/ashlrai/lexicon/releases/latest) and a zip pulled from a CI run. Either right-click the app and choose Open, or clear the quarantine flag:

```bash
xattr -d com.apple.quarantine apps/macos/build/LexiconBar.app   # or /Applications/LexiconBar.app
```

A build made on the same Mac by the script above was never downloaded, so it is not quarantined and opens normally.

## Signing, and why the Accessibility grant kept disappearing

The symptom is maddening and gives you no clue what is wrong: LexiconBar is listed under **System Settings > Privacy & Security > Accessibility**, its switch is on, and Fix everywhere does nothing. `--status` says `Accessibility (menu bar app): not granted`. Toggling the switch off and on changes nothing.

### The trap

macOS does not grant Accessibility to a *path*. It grants it to a **code signature**, stored as the app's designated requirement (DR): a rule the app must keep satisfying every time it asks.

An ad-hoc signature (`codesign --sign -`) has no certificate, so there is nothing durable to name the app by, and the DR falls back to the hash of the binary itself:

```
designated => cdhash H"acff8513…"
```

Every build produces a different binary, so every build has a different cdhash, so every build fails the rule the grant was given under. `tccd` says so in the unified log, if you know to look:

```
Failed to match existing code requirement for subject ai.ashlr.lexiconbar
```

The row in System Settings stays, and keeps its switch on, because it is still a row about "LexiconBar". It just no longer describes the app on disk. The switch is UI state; the DR is the thing being checked. Nothing about the interface tells you they have come apart.

### The one-time fix

Toggling the row does not rebind the signature. Removing the row does:

1. System Settings > Privacy & Security > Accessibility
2. Select **LexiconBar**, click **−**
3. Click **+** and add `apps/macos/build/LexiconBar.app`

### Making it stick

Do that once *after* creating a local signing identity, and it never has to be done again:

```bash
scripts/make-signing-identity.sh
scripts/build-macos-app.sh
```

`make-signing-identity.sh` creates a self-signed code-signing certificate, `LexiconBar Local Signing` (RSA 2048, 10 years, `basicConstraints=critical,CA:false`, `extendedKeyUsage=codeSigning`). Builds signed with it get a DR that names the certificate instead of the bytes:

```
designated => identifier "ai.ashlr.lexiconbar" and certificate leaf = H"8f4eec66…"
```

The certificate does not change when the binary does, so this line is identical on every future build, which is exactly what the stored grant is checked against. `build-macos-app.sh` prints the cdhash and the DR on every build, so you can watch the cdhash move while the DR stays put.

The script is idempotent: run it again and it reports the identity it already made. Without it the build still works, signs ad-hoc, and prints a warning saying the grant will break again.

### Where the key lives

The certificate and its private key go in a keychain of their own, `~/Library/Keychains/lexiconbar-signing.keychain-db`, whose password is generated and kept in `~/Library/Application Support/LexiconBar/signing-keychain.password` (mode 0600). That is what makes the whole thing non-interactive: `security set-key-partition-list` must be given the keychain's password or macOS puts up a dialog, and the login keychain's password is yours, not ours. A keychain we create has a password we can supply, so `codesign` never asks for anything. The keychain is added to your `security list-keychains -d user` search list, which is how `codesign` finds the identity, and `build-macos-app.sh` unlocks it before signing (it is locked again after a reboot).

`security find-identity -v -p codesigning` will still report **0 valid identities**: `-v` means "valid" in the sense of "chains to a trusted root", and a self-signed certificate does not. That does not matter: `codesign` signs with it happily. To see it, drop the `-v`:

```bash
security find-identity -p codesigning     # 1) 8F4EEC66… "LexiconBar Local Signing" (CSSMERR_TP_NOT_TRUSTED)
scripts/make-signing-identity.sh --show   # the same, with the DR it produces
```

### Removing it

```bash
security delete-identity -c "LexiconBar Local Signing" ~/Library/Keychains/lexiconbar-signing.keychain-db
security delete-keychain ~/Library/Keychains/lexiconbar-signing.keychain-db
rm -f ~/Library/Application\ Support/LexiconBar/signing-keychain.password
```

`delete-keychain` also drops it from the search list. Builds then go back to ad-hoc signing, with the warning and the remove-and-re-add dance that comes with it.

### This is not a Developer ID

Gatekeeper does not trust this certificate, and neither will anyone else's Mac. It solves one problem (TCC forgetting the app between local builds) and nothing else. Shipping to other people needs a real Developer ID certificate and notarization; see [RELEASING.md](RELEASING.md).

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
| **LaunchAgent** | `launchctl print gui/<uid>/ai.ashlr.lexicon.serve` exits 0 | Status line, "Local API: running at login (launchd)", with "Manage with `lexicon serve --uninstall`". No checkbox: a click could only start a second server that cannot bind the port. |
| **This app's child** | the app's own `ChildProcessSupervisor` has a live `lexicon serve` | Checkbox, on. Switching it off stops the child. |
| **Something else** | nothing above, but `GET /health` answers | Status line, "Local API: reachable (not managed by this app)". Usually a `lexicon serve` you started in a terminal; find it with `lsof -nP -iTCP:41733 -sTCP:LISTEN`. |
| **Nobody** | none of the above | Checkbox, off, labelled "Run the local API". |

launchd wins outright: with `KeepAlive` it takes the port back whatever else happens, so a child of ours could only thrash. A plist on disk that is *not* loaded is not ownership: it only changes the hint on the "nobody" row.

Ticking **Run the local API** installs the LaunchAgent (`lexicon serve --install`) rather than supervising a child, because that survives an app restart, a logout and a crash, which is what asking for "the local API" almost always means. If the install fails, the app falls back to a supervised child and says why.

The probes (a `launchctl print`, a `stat` of `~/Library/LaunchAgents/ai.ashlr.lexicon.serve.plist`, and a `GET /health`) run off the main thread and are cached for 5 s, so opening the menu never blocks on them. `$LEXICON_SERVE_LABEL` overrides the label, the same way the CLI does.

To see the answer without opening the menu:

```
apps/macos/build/LexiconBar.app/Contents/MacOS/LexiconBar --status --json
```

which prints `apiReachable`, `serveOwnership` (`launchAgent` / `appChild` / `foreign` / `none`), `serveTitle`, the probe inputs and the Accessibility fields described below. One caveat on ownership: `appChild` can never appear there, because a child of the *running* app is invisible to a separate process.

## Accessibility, and why `--status` will not answer for it

(If the grant is listed and switched on but the app still is not trusted, the problem is the code signature, not this: see [Signing, and why the Accessibility grant kept disappearing](#signing-and-why-the-accessibility-grant-kept-disappearing).)

`AXIsProcessTrusted()` does not answer "is LexiconBar allowed to use Accessibility". It answers for the **responsible process**, and for anything started from a shell that is the terminal. A `--status` run from a terminal therefore inherits the terminal's grant, and a bare `.build/release/LexiconBar` (a binary that cannot hold a grant at all) will happily report `true` while the GUI-launched bundle is being denied.

So it does not report it. From a terminal, `--status` says:

```
Accessibility: cannot be checked from a terminal (this process inherits the terminal's grant). The menu bar app's own state is in Set up Lexicon.
```

and `--status --json` gives `"axTrusted": null`, with the inherited value kept as `"axTrustedRaw"` and the reason as `"axTrustedNote"`. Launched by the window server (`open`, a double-click, a login item) it answers for itself as before, `Accessibility: trusted` or `not trusted`. "From a terminal" means *no launchd parent, or a controlling terminal*: a script, a CI job and an agent harness all run without a TTY and still inherit the shell's grant, so the parent-process check is what actually decides.

The answer that matters comes from the running app, which writes its own state to `~/Library/Application Support/LexiconBar/state.json` (mode 0600, written atomically) at launch, when the focus watcher starts or stops, when the grant changes under it, and every 30 s otherwise:

```json
{ "axTrusted": false, "pid": 92830, "running": true, "updatedAt": "2026-09-20T03:32:31Z", "version": "0.5.2" }
```

`--status` reads it and prints a second line. This is the one to believe, and the one an agent should parse (`axAppTrusted`):

| State file | Second line |
| --- | --- |
| fresh, granted | `Accessibility (menu bar app): trusted (as of 8 seconds ago)` |
| fresh, denied | `Accessibility (menu bar app): not granted (as of 8 seconds ago). Add LexiconBar.app under …` |
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

## See also

- [LOCAL-API.md](LOCAL-API.md) is the server this app starts and supervises, and the API that Fix everywhere calls.
- [DAEMON.md](DAEMON.md) is the same clipboard fix without the app, on any OS.
- [VOICE.md](VOICE.md) documents the `lexicon voice` pipeline behind push to talk.

Back to [the docs index](README.md).
