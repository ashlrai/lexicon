# LexiconBar for Windows: the tray app

LexiconBar corrects dictated text **in place, in whatever app you are typing into**, about a second after it lands. You dictate "ping ashler about the cuban eats rollout on versal"; a moment later the field reads "ping Ashlr.AI about the Kubernetes rollout on Vercel". You do not copy anything, you do not switch windows, and the app you are in does not have to know LexiconBar exists.

It is the Windows counterpart of [the macOS menu bar app](MACOS-APP.md), built on **UI Automation** where that one is built on the Accessibility API.

Source: `apps/windows` (C#, .NET 8, WinForms, no third-party runtime dependencies).

> ## Read this first
>
> **The UI Automation half of this app has never been run.** It was written on a Mac, which cross-compiles the binary perfectly well and cannot execute a single line of it. The pure logic (burst detection, splice math, the secret-field heuristic, the read gate, bubble content and placement) is covered by 199 unit tests that pass on macOS, Linux and Windows. Everything that touches UIA, SendInput, the tray, the registry or the clipboard is **unverified**, and [there is a list](#what-is-verified-and-what-is-not) rather than a vague disclaimer.
>
> Before trusting it with anything you care about, run [the manual test script](#manual-test-script). It takes about ten minutes.

---

## Contents

- [What it does](#what-it-does)
- [Install and run](#install-and-run)
- [The menu](#the-menu)
- [Fix everywhere](#fix-everywhere)
- [What it refuses to touch](#what-it-refuses-to-touch)
- [The correction bubble](#the-correction-bubble)
- [Where serve.json lives on Windows](#where-servejson-lives-on-windows)
- [How this differs from the Mac app](#how-this-differs-from-the-mac-app)
- [What is verified and what is not](#what-is-verified-and-what-is-not)
- [Manual test script](#manual-test-script)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)

---

## What it does

Four moving parts, in a straight line:

1. A **focus watcher** follows the focused text field across every app, through UI Automation's `AutomationFocusChangedEvent`, plus `Text_TextChanged` and `ValueValueProperty` change events on whatever currently has focus, plus a 250 ms poll as a safety net.
2. A **burst detector** decides whether what just arrived was dictated or typed. This is the part that had to be got exactly right, and it is ported line for line from the Mac app; see [Fix everywhere](#fix-everywhere).
3. The burst goes to **`POST /normalize`** on the local API (`127.0.0.1:41733`), with the bearer token from `serve.json`.
4. The corrected span is **written back into the field** and verified by re-reading it. Nothing is written if the field changed underneath in the meantime.

Everything in steps 1, 2 and 4 runs on one dedicated MTA thread, so a slow app never freezes the tray menu.

## Install and run

No installer. One file.

```
LexiconBar.exe
```

No release ships it yet, deliberately: every line that drives UI Automation is still unrun, and an unverified binary that synthesizes keystrokes into whatever field you have focused is not something to hand a stranger. Until someone has worked through the [manual test script](#manual-test-script), take it from CI:

```bash
gh run download --repo ashlrai/lexicon --name LexiconBar-win-x64 --dir .
```

That is the artifact from the last green run of the `Windows app` workflow, built and tested on `windows-latest`. Or build it yourself: see [Build from source](#build-from-source), which cross-compiles from a Mac just as well as it builds on Windows.

Double-click it. A waveform icon appears in the notification area and Fix everywhere is on. Nothing needs elevating, nothing is written outside your own profile, and there is no service.

You also need `lexicon serve` running on the same machine. That is the process holding your lexicon. One command registers it as a logon-triggered Scheduled Task so it is up whenever you are:

```
lexicon serve --install
```

which tells you to create a logon task:

```
schtasks /Create /SC ONLOGON /TN "lexicon serve" /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\...\dist\cli\index.js\" serve"
```

Use **Run doctor** in the tray menu to check the app can see it.

To have LexiconBar itself start with Windows, use **Start at login** in the menu. It writes one value to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which is also where Settings > Apps > Startup can turn it off; if you turn it off there, the app respects that rather than putting it back.

Settings live in `%APPDATA%\LexiconBar\settings.json`; the log is `%APPDATA%\LexiconBar\lexiconbar.log`.

## The menu

| Menu item | What it does |
| --- | --- |
| **Fix everywhere** | The main switch. On by default. Off, the watcher reads nothing at all, not merely nothing it will act on. |
| **Fix everywhere in `<app>`** | Per-app exclusion for whatever last had focus. Ticked off, it writes the executable name into the exclusion list; ticked back on, it removes that exact entry and tells you when a wildcard rule still covers the app. |
| **Fix clipboard now** (Ctrl+Alt+V) | Normalizes whatever is on the clipboard and puts the result back. |
| **Watch clipboard** | Does that automatically whenever the clipboard changes. Off by default. |
| **Last correction** | Submenu of the `original → canonical` pairs from the most recent fix. Clicking one copies the canonical spelling. |
| **Undo last fix** (Ctrl+Alt+Z) | Puts the dictated text back. Only available while the same field still holds exactly the corrected text. |
| **Show the correction bubble** | On by default. Off means corrections are announced as balloon tips instead. |
| **Open lexicon file** | Runs `lexicon path` and opens the result in your default editor. |
| **Run doctor** | A window with the app's own state (where `serve.json` was found, whether the API answers, how many terms), then `lexicon doctor`'s output, then the recent log. |
| **Start at login** | The `Run` key, above. |
| **Preferences…** | Settle delay, minimum words, streamed-run quiet, maximum field length, poll interval, bubble duration, CLI path, exclusion list. |
| **Quit** | |

The two hotkeys are registered with `RegisterHotKey`, which **fails rather than stealing** a combination another app already owns. If your IDE has Ctrl+Alt+Z, LexiconBar logs that it could not register and the menu item still works.

## Fix everywhere

### Deciding what was dictated

An insertion becomes a **burst** when it is big enough to be dictation and the field has been quiet long enough to call it finished. The rules, and the reason each exists:

- **Chunk size, not rate.** A burst requires at least one change event that inserted **four or more units at once**. Typing arrives one unit at a time no matter how fast or slow, so key-by-key typing is never a burst. Rate would have been the obvious rule and it is the wrong one: someone typing quickly looks exactly like dictation, and someone dictating slowly does not.
- **Coalescing a streamed run.** Dictation does not always arrive as one insertion. Windows Voice Access streams a word at a time, and so does Wispr Flow, and the gaps between spoken words are routinely longer than the 700 ms settle delay. Deciding at the first gap chopped a sentence into single words, each of which was "too short" to correct, so a dictated sentence went through completely uncorrected, which looks exactly like the feature not working. A run that has produced at least one word-sized insertion is now held open until the field has been quiet for **1500 ms**, longer than a pause between words, and the words are corrected together as one burst. Continuous dictation is capped at **12 s** so it is still corrected periodically. A single insertion that already reads as a burst is a paste, with nothing to wait for, so it still fires at the settle delay.
- **Anchoring the window to the caret.** This one ate somebody's paragraph on macOS. A prefix/suffix diff cannot always say *where* an insertion happened. Dictating "ping ashler about the…" into a field that already reads "ping Ashlr.AI about the…" shares the leading "ping ", so the naive diff reports the insertion five units late: a window that starts inside the new text and runs into the old. It is textually consistent, so every other guard passes, and the correction gets spliced into the middle of a word while the words outside the slid window are never corrected at all. The caret position resolves it. **When the caret cannot be read, an ambiguous insertion is refused rather than guessed at.**
- **Refusing a stale snapshot.** The field is live the whole time the API is answering. If it no longer holds exactly the text the burst was cut from, every offset we have is stale, and nothing is written.

Tunables: `SettleMs` 700, `MinWords` 3, `MinChunk` 4, `RunQuietMs` 1500, `MaxRunMs` 12000, `MaxFieldLength` 20000. The first five are in Preferences.

### Writing the correction back

This is where Windows and macOS genuinely diverge, and it is the least certain part of the app.

**UIA's `TextPattern` is read-only.** There is no equivalent of the Mac's "set `AXSelectedText` over the burst range", which is that app's preferred write. So the ladder here is:

1. **Select and type.** Build a `TextPatternRange` over the burst span, read it back and confirm the provider means the same span we do, confirm the app is still in the foreground, re-read the selection and confirm it is *still* exactly that span, then send the replacement as Unicode key events (`SendInput` with `KEYEVENTF_UNICODE`, no virtual key, so it is layout-independent). This goes through the app's own editing pipeline, so its undo stack works.
2. **Whole-value write.** `ValuePattern.SetValue` with the spliced full text. Works in Win32 edits, WinForms and WPF text boxes, needs no foreground window, but it loses the app's undo stack and moves the caret to the end, which is why it is second, not first.
3. **Backspace and retype.** Deliberately the narrowest path in the app: it only runs when the burst is unambiguously the tail of the field *and* the caret is sitting at the end of it *and* the app is in the foreground. It is the only path that destroys text without first proving the app agrees where that text is, so it refuses rather than guesses. The backspaces and the replacement go out in one `SendInput` call, because in two the deletion can land and the retype fail.

Each step re-reads the field immediately before doing anything destructive, and verifies afterwards by re-reading again.

**A write that half-lands is recovered, not reported as a failure.** Only steps 1 and 3 can half-finish, and only through `SendInput`, which returns the number of events it accepted and may accept fewer than it was handed. Three things keep that from becoming corrupted text:

- **One call per write, never a loop.** `SendInput`'s guarantee that nothing interleaves is a guarantee about a single call. This used to send 400 INPUT records at a time and walk a longer array in several calls, so any replacement over 200 characters was several calls with gaps between them, and a later one failing left the earlier ones in the field. There is now a cap (`Keyboard.MaxKeyEvents`, 1000 key events) and no loop: a replacement too long for one call is refused by the keystroke path and made through `ValuePattern.SetValue` instead, which replaces the whole value in one go and cannot half-finish.
- **The leftover state is computed and checked.** `PartialWrite`, in the portable core so that it is tested, works out exactly what the field must hold when *n* of *m* key events landed, for both the select-and-type and the backspace shapes. The engine re-reads the field and proceeds only when the two agree; a field holding anything else is one it no longer understands, and it says so rather than guessing an offset to splice at.
- **Repair first, undo second.** A half-landed keystroke write falls through to the whole-value write, which repairs it outright because that write does not care what state the field was in. Where there is no writable `ValuePattern`, the undo ledger gets an entry describing the half-written state before the user is told anything, so Ctrl+Alt+Z puts their own text back, and the message says "only part of the correction went in" rather than "could not write".

An undo goes through the same ladder and is subject to the same rules, and its ledger entry is now consumed only once the write has succeeded. An undo that did nothing used to throw the entry away, leaving a correction that could no longer be reversed at all.

Re-reading the whole field is necessary and not sufficient, which is why step 1 checks the selection separately. Selecting the span takes several round trips, and in the gap before the keystrokes go out the user can press Home, End or an arrow key, or click somewhere else in the same field: the selection moves or collapses, **every character stays exactly where it was**, and a whole-text comparison sees nothing wrong. The correction would then be typed at the caret instead of over the span. So the selection is read back immediately before `SendInput` and compared by position as well as by text — "add the item, add the item" has two textually identical halves — and the write falls through to the value path rather than typing into the wrong place. `SendInput`'s guarantee that nothing interleaves covers only the call itself, never the gap in front of it.

## What it refuses to touch

Three independent guards, because each one on its own has a hole.

**All three are decided before the field's text is read, not after.** UI Automation will tell you a field's automation id, its labels, its class name, the title of its window and which executable owns it without ever touching its contents, and that metadata is all three guards need. Only a field that passes all three is asked for its value; a refused one is never read at all, so its text is never in this process's memory, where a crash dump or an attached debugger could reach it. (This is enforced in `FieldGate`, which `FocusWatcher` consults before its first read and again on every poll, because the exclusion list can change while the app it now covers still has focus. The same checks run again in `FixEngine.Settle` before the caret is read, once more before anything is sent to the local API, and once more before anything is written back, as defence in depth rather than as the guard itself.)

**The caret read is a read.** Asking UIA where the insertion point sits means cloning the document range and measuring the text in front of it, which pulls that text across the process boundary. `Settle` used to do that before its refusal check rather than after. The watcher drops a newly refused field before that timer can fire, so no case is known in which a refused field's text was actually read this way, but the ordering is what this page promises, and a promise that holds only because of the queue discipline in another class is not one worth making. The refusal now runs first, and the measurement takes the same `MaxFieldLength` cap as every other read instead of fetching the document in full.

**Undo is a read too.** Ctrl+Alt+Z reads the field and then writes into it, and it used to go straight to `ReadValue`. That made it the one path where excluding an app while it still held focus stopped neither the read nor the write, in a field the user believed they had just put out of reach. It goes through the same gate as everything else now; a refusal drops the ledger entry with it, because that entry holds the field's text.

**"Fix everywhere" off means nothing is read.** Turning the main switch off used to stop the corrections and leave the watcher reading and caching every focused field it was handed. It now stops the reads: no focus resolution, no event read, no poll, and whatever the last field held is dropped at once rather than at the next focus change. Which app is in front is still tracked, because that is metadata and the tray menu needs it. This matters because "turn it off" is the answer this page gives anyone who does not want their typing read at all, and that answer has to be true.

**1. `IsPassword`.** UIA's own answer for a masked input. Cheap, so it is checked first, and a field that says yes is never even watched.

**2. Excluded processes.** Matched on the executable name without its extension, case-insensitively; a trailing `*` matches a prefix. Excluded by default:

- **Terminals and shells**, because a rewrite in a shell is a command, not a sentence: Windows Terminal, `cmd`, `powershell`, `pwsh`, `conhost`, `OpenConsole`, mintty, Alacritty, WezTerm, kitty, PuTTY, ConEmu, Cmder, Hyper, Tabby, Terminus, MobaXterm, Tera Term.
- **Remote sessions** (`mstsc`, `vmconnect`, `ssh`), where the text belongs to another machine.
- **Windows' own credential surfaces**: `CredentialUIBroker`, `consent`, `LogonUI`, `keymgr`.
- **Password managers**, as vendor prefixes rather than exact names: `1password*`, `bitwarden*`, `dashlane*`, `lastpass*`, `keepass*`, `nordpass*`, `enpass*`, `proton pass*`, `keeper*`, `roboform*`, `strongbox*`, `zohovault*`, `safeincloud*`, `stickypassword*`, `psono*`, `pwsafe*`, `authy*`, `cryptomator*`, `veracrypt*`.

Prefixes, because an exact list is wrong the moment a vendor renames an executable, and being wrong here means reading a vault field and POSTing it to an HTTP endpoint. **If your manager is not on the list, add it**: focus it and use "Fix everywhere in `<app>`", or edit the list in Preferences.

Un-ticking "Fix everywhere in `<app>`" removes the *exact* entry for that executable and nothing else. It used to remove every rule that matched, wildcards included, so allowing one 1Password process deleted `1password*` and with it the cover for every other 1Password executable, silently and for good, since re-ticking only ever adds the exact name back. When a prefix rule still matches after the exact entry is gone, nothing is saved and the tray says which rule is holding the app, because deciding that a rule covering a whole password manager should come off is not something a checkbox should do on your behalf.

**An empty list means "exclude nothing", and says so.** Clearing the box in Preferences is a legitimate choice and is saved as one, the same as on macOS. It is also the only setting in that window that can put dictation into a password manager, so it never passes quietly: the grey hint under the box is replaced by a warning naming what is no longer covered, and saving a list that was not already empty asks first. What survives an empty list is `IsPassword` and the label heuristic, neither of which is a name on any list. Neither is a substitute for it: a manager's notes field, its search box and its custom fields are not masked and are not labelled "password". **Restore defaults** puts the list back.

**3. Fields whose labels suggest a secret.** The process list always lags reality, and `IsPassword` only protects the literal masked input; in any manager that is not on the list, the *ordinary* fields (an item's notes, a custom field, a TOTP seed box, a vault search field echoing a username) would otherwise be read and sent. So, independently of which app it is, a field is refused when its automation id, help text, name, localized control type, full description, class name, or the title of the window it sits in contains one of:

`password`, `passphrase`, `passcode`, `secret`, `token`, `api key`, `private key`, `seed`, `mnemonic`, `recovery`, `pin`, `cvv`, `cvc`, `security code`, `verification code`, `otp`, `totp`, `2fa`, `mfa`, `credential`, `keychain`, `vault`, `card number`, `account number`, `routing number`, `social security`.

Matching is on **whole words** after splitting camel case and punctuation, so `apiKeyField` and `api_key` match but "shipping" never matches "pin" and an ordinary Notes field is left alone. A refused field is never watched at all — its value is never fetched, not on the focus change, not on a UIA event, not on the poll — and the log says `not reading this field in <app>: the field's labels look like a secret (<term>)`.

One known Windows hole: the classic **Credential Manager** control panel runs inside `rundll32.exe`, which cannot be excluded by name without excluding every other control panel applet. The label heuristic is what covers it, which is exactly the case that heuristic exists for.

**The log never contains field text.** Only decisions about it. `skip in chrome: too short (1 words, 6 units)` is logged; the six units are not.

## The correction bubble

After a fix, a small dark panel appears just below and left of the caret: up to three `original → canonical` lines with the heard spelling struck through and the canonical bold, "+4 more" when there were more, and "Fixed 2 words" above them. Three buttons:

| Button | What it does | Call |
| --- | --- | --- |
| **Undo** | Puts the dictated text back, exactly as Ctrl+Alt+Z does. | none |
| **Never** | Records the original spelling under that term's `never` list, and undoes. | `POST /add {canonical, never: [original]}` |
| **Add** | Promotes the original to an explicit alias. Shown **only** when the rewrite came from a phonetic or fuzzy guess. | `POST /learn {heard, meant}` |

It fades in over ~120 ms and goes away after 4 seconds (0 to 30 in Preferences; 0 means until dismissed). Hovering pauses the countdown so it cannot vanish on the way to Undo.

**It must never take keyboard focus**: you are mid-sentence, and a window that stole focus would swallow the next word and move focus away from the field the undo applies to. On Windows that takes three things agreeing: `WS_EX_NOACTIVATE`, `ShowWithoutActivation`, and answering `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`. Without the third, the first click is eaten activating the window and Undo needs two clicks. `WS_EX_TOOLWINDOW` keeps it out of Alt+Tab.

Placement comes from `TextPatternRange.GetBoundingRectangles()` over the selection, falling back to the Win32 caret via `GetGUIThreadInfo`, then to the element's own box, then to the mouse. The result is clamped to the working area of the monitor the caret is on, so it never lands under the taskbar, and flips above the caret when there is no room below.

> Note for anyone comparing the two ports: this is the **one** piece of geometry that is a rewrite rather than a port. AppKit's screen origin is bottom-left with y growing up; Windows' is top-left with y growing down, so "below the caret" is `+` here and `-` there. Both directions are unit-tested.

## Where `serve.json` lives on Windows

The obvious guess is wrong and it is worth knowing why.

The Node side computes its config home in `src/core/store.ts` as:

```ts
const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
```

with **no `win32` branch at all**, and `src/serve/config.ts` writes `serve.json` next to the global lexicon. On Windows `os.homedir()` is `%USERPROFILE%`, so the real path is:

```
%USERPROFILE%\.config\lexicon\serve.json
```

**not** `%APPDATA%\lexicon\serve.json`. LexiconBar honours `LEXICON_PATH` and `XDG_CONFIG_HOME` first, exactly as the CLI does, then that path, and then probes `%APPDATA%\lexicon\serve.json` and `%LOCALAPPDATA%\lexicon\serve.json` anyway, so that if the Node side ever grows a proper Windows branch, this app keeps working without a release. **Run doctor** prints which one it actually found.

The token is read lazily and re-read after any failure, so restarting the server with a fresh token heals on the next burst rather than needing the tray app restarted.

## How this differs from the Mac app

| | macOS | Windows |
| --- | --- | --- |
| Accessibility API | AX (`AXObserver`, `AXUIElement`) | UI Automation (`IUIAutomation`, COM) |
| Permission needed | Yes: Privacy & Security > Accessibility, and it is a recurring source of pain | **None.** Any process may be a UIA client. |
| Observers | One per process | One global focus handler, per-element handlers on the focused element |
| App identity | Bundle id (`com.1password.*`) | Executable name (`1password*`) |
| Preferred write | Set `AXSelectedText` over the range | Select the range, then type over it (`TextPattern` has no setter) |
| Fallback write | Whole `AXValue` | Whole `ValuePattern`, then backspace-and-retype |
| Clipboard actions | Shells out to `lexicon daemon` | Done in-process against `POST /normalize` (fewer moving parts, and the CLI is not on the hot path) |
| Bubble y-axis | Origin bottom-left | Origin top-left |
| Start at login | `SMAppService` | `HKCU\...\Run` |
| Blocked by | Apps with no AX tree (VS Code, Cursor) | Elevated windows (UIPI), and apps with no UIA text provider |

**The Windows version needs no permission grant**, which removes the single worst part of the macOS experience (the code-signature / TCC trap documented at length in [MACOS-APP.md](MACOS-APP.md#signing-and-why-the-accessibility-grant-kept-disappearing)). The trade is UIPI: a non-elevated LexiconBar cannot read or type into an elevated window, silently. That is why the manifest says `asInvoker` and not `requireAdministrator`: running the whole tray app elevated would mean reading the text of every elevated window on the machine, which is a much worse deal than not correcting text in an admin PowerShell.

## What is verified and what is not

### Verified

- `dotnet build -c Release` succeeds for the whole solution, warnings-as-errors, on macOS.
- `dotnet publish -r win-x64 --self-contained` produces a single 72 MB `LexiconBar.exe` (`PE32+ executable (GUI) x86-64`), cross-compiled from macOS.
- **199 unit tests pass**, on macOS, covering:
  - the burst detector, ported case for case from `BurstDetectorTests.swift`: typing never fires, streamed dictation coalesces, a paste fires at the settle delay, the run cap, hard refusals, UTF-16 maths with emoji, CRLF;
  - the splice and alignment maths, ported from `BurstAlignmentTests.swift`, covering the ambiguous-window regression, caret anchoring, stale snapshots, multi-replacement splices, newline refusal, the undo ledger;
  - the secret-field heuristic, including the whole-word cases ("shipping" vs "pin") and a pinned known-miss for pluralized all-caps acronyms;
  - the read gate, through a fake field that counts the times anything asked for its value: an excluded app's field, a secret-looking field in an app nobody excluded, and a field whose app the user excludes mid-focus are each refused with that count still at zero, and a refusal itself costs no read either way, which is what lets it be put in front of the caret read and the undo read as well as the value read;
  - the master switch, against the same counting field: with "Fix everywhere" off, nothing is read at all, and turning it off asks the watcher to let go of the field it is holding and stop the poll rather than only decline the next read. This is what SECURITY.md offers a user who does not want their typing read, and it used to mean only that nothing was corrected while the watcher went on reading and caching every focused field;
  - the undo hotkey's decision, which is a read followed by a write and so asks the gate before either: excluding an app while it still holds focus refuses Ctrl+Alt+Z with the read count unmoved, and drops the ledger entry that held that field's text;
  - the write ladder's partial-write recovery: what the field holds when *n* of *m* key events landed, for both the select-and-type and the backspace shapes, and that undoing the recorded entry restores the user's own text at every point in between;
  - the exclusion list, including that an emptied list excludes nothing and knows it, and that un-excluding one executable does not take a vendor wildcard with it;
  - bubble content and actions, bubble placement in Windows y-down coordinates including the flip and the clamps;
  - `serve.json` path resolution, credential parsing, the `normalize` response parser, settings round-trip, CLI discovery.
- The CsWin32-generated UIA interfaces compile against the code that calls them, which is the reason for choosing CsWin32 over hand-written `[ComImport]` declarations: the vtable layout comes from Microsoft's own Win32 metadata, not from memory. A method out of order in a 60-method interface is a silent ABI bug that a Mac cannot catch.

### Not verified: the precise list

Nothing below has been executed. It compiles; that is all anyone can say.

| Area | File | What specifically is unproven |
| --- | --- | --- |
| COM activation | `Ui/TrayApplicationContext.cs` | That `CUIAutomation8` activates via `Type.GetTypeFromCLSID` + `Activator.CreateInstance` in a self-contained single-file app, and that the RCW casts to the CsWin32 `IUIAutomation`. |
| Threading model | `FixEverywhere/UiaThread.cs` | That an MTA worker thread receives UIA callbacks without a message pump, and that posting work out of a handler avoids the documented re-entrancy deadlock. |
| Focus events | `FixEverywhere/FocusWatcher.cs` | That `AddFocusChangedEventHandler` fires for the apps we care about; that `Text_TextChanged` / `ValueValueProperty` subscriptions attach and detach cleanly; whether 250 ms is the right poll; whether the managed callback objects survive GC long enough (they are held in fields, but this is exactly the kind of thing that only shows up live). |
| Reading text | `FixEverywhere/UiaField.cs` | `GetText(limit + 1)` capping; the `ValuePattern` fallback; whether `IsTextPatternAvailable` is trustworthy per app. |
| Caret offset | `FixEverywhere/UiaField.cs` `CaretEnd` | The clone-and-measure trick (`MoveEndpointByRange` then `GetText().Length`). **This is the highest-value unverified thing in the app.** Without a caret the detector refuses ambiguous bursts, so if it is wrong, dictation in front of similar text silently does nothing. |
| Character units | `FixEverywhere/UiaField.cs` `SelectSpan` | That `TextUnit_Character` maps 1:1 to UTF-16 units in each provider. It is read back and compared before any write, so a mismatch should degrade to "not selectable" rather than corrupt, but that guard itself is untested. |
| Writing | `FixEverywhere/FixEngine.cs` `Write` | The whole three-step ladder, its ordering, and every verification timeout in it (0.6 s / 0.3 s / 0.6 s). The partial-write recovery is reasoned, not run: the arithmetic it depends on is tested, but that a half-landed `SendInput` really leaves the field in that state is not. |
| Selection re-check | `FixEverywhere/UiaField.cs` `SelectionMatches` | That `GetSelection` answers one range for an ordinary caret or selection, and that measuring its start offset agrees with the offsets `SelectSpan` selected by. If a provider disagrees, the keystroke path degrades to the whole-value write rather than typing in the wrong place — safe, but it would make step 1 useless in that app, so watch for "always writes via the value path". |
| Synthesized input | `Interop/Keyboard.cs` | `SendInput` with `KEYEVENTF_UNICODE`; surrogate pairs as two events; that one call of up to 2,000 INPUT records is accepted whole; that a short return count means what the recovery path assumes it means. The *consequences* of a short count are tested (`PartialWriteTests`); the count itself is not. |
| SAFEARRAY reads | `Interop/SafeArrays.cs` | Reading VT_I4 runtime ids and VT_R8 rectangles from `pvData`, and that `SafeArrayDestroy` frees them correctly. Pointer code, unrunnable here. |
| BSTR lifetime | `Interop/SafeArrays.cs` `Bstr` | That every returned BSTR is freed exactly once and none is freed twice. A double free is a crash, not a leak. |
| Bubble | `Ui/CorrectionBubbleForm.cs` | The no-activate behaviour (the three things that must agree); whether the buttons receive clicks; sizing and rounding; multi-monitor and mixed-DPI placement. |
| Caret rectangle | `FixEverywhere/UiaField.cs` `CaretRect` | Whether `GetBoundingRectangles` returns `{l,t,w,h}` quads as assumed, and whether the `GetGUIThreadInfo` fallback finds a caret at all in Chromium. |
| Tray | `Ui/TrayApplicationContext.cs`, `Ui/TrayIconFactory.cs` | The runtime-drawn icon at real notification-area DPI; balloon tips; menu layout. |
| Hotkeys | `Ui/HotkeyWindow.cs` | `RegisterHotKey` on an `HWND_MESSAGE` window, and whether `WM_HOTKEY` reaches a `NativeWindow` parented there. |
| Clipboard | `Ui/TrayApplicationContext.cs` | The 500 ms poll, and the retry-on-`ExternalException` when another app holds the clipboard. |
| Registry | `StartupRegistration.cs` | The `Run` key write, and the quoting of a path with spaces. |
| Single-file | `LexiconBar.App.csproj` | That COM interop, WinForms and the drawn icon all survive `PublishSingleFile` with compression. |

**CI cannot close this gap.** A GitHub runner has no interactive desktop session: no focused element, no foreground window, no caret. The `build-windows` job in `.github/workflows/windows-app.yml` compiles, tests and packages; it does not and cannot test any of the above. Only a person at a real machine can.

### Most likely to be wrong on first contact

In the order I would bet on:

1. **The caret offset** (`CaretEnd`). Clone-and-measure is the standard technique but the endpoint-dragging direction is easy to get backwards, and a wrong answer is *silent*: the detector just refuses ambiguous bursts and dictation into non-empty fields appears to do nothing. First thing to check if "it works in an empty Notepad but not in a real document".
2. **`TextUnit_Character` in Chromium.** If Chrome maps it to something other than a UTF-16 unit, `SelectSpan` fails its read-back and every write in Chrome falls through to the value path or to nothing. Likely to show as "works in Notepad, does nothing in Chrome".
3. **The MTA callback delivery.** If UIA will not deliver events to an MTA thread without a pump, focus changes arrive only via the 250 ms poll, which mostly works, so the symptom is "feels laggy" rather than "broken", and it would be easy to misdiagnose.
4. **The bubble stealing focus.** If `WM_MOUSEACTIVATE` is not enough, the first click on Undo is eaten. Annoying, very visible, easy to fix.
5. **Balloon tips and the drawn icon at 150% DPI.** Cosmetic, near-certain to need a tweak.
6. **`Text_TextChanged` not firing in Electron.** Expected; the poll is the mitigation, and the symptom is a slower correction, not a wrong one.

The parts I am *least* worried about are the ones that are tested: if a correction lands, it should land on the right span, because that is the logic the 199 tests cover and it is the same logic that has been running on macOS.

## Manual test script

Ten minutes, on a real Windows machine. Do these in order; each one isolates a different layer.

**Setup**

1. Make sure the local API is up: in a terminal, `lexicon serve`. Leave it running.
2. Run `LexiconBar.exe`. A waveform icon appears in the notification area.
3. Right-click it > **Run doctor**. Confirm:
   - `serve.json` names a real path (expect `C:\Users\<you>\.config\lexicon\serve.json`);
   - `local API` says `up, N terms`.
   If either is wrong, stop here; nothing else can work.
4. Turn on Windows Voice Access: **Win+Ctrl+S**. (Settings > Accessibility > Speech, first time; it downloads a model.)

**Test 1: Notepad, the simplest possible provider**

1. Open Notepad. Click in the document.
2. Dictate: *"ping ashler about the cuban eats rollout on versal"*
3. **Expect:** about a second after you stop, the text becomes *"ping Ashlr.AI about the Kubernetes rollout on Vercel"*, and a small dark bubble appears just below the caret saying **Fixed 3 words**.
4. Click **Undo** on the bubble. **Expect:** the dictated text comes back, in one click, and the caret is still in Notepad; you should be able to keep typing immediately.
5. Press **Ctrl+Z**. **Expect:** Notepad's own undo works sensibly (this tells you the write went through the editing pipeline, not around it).

> If step 3 does nothing, open **Run doctor** and read the recent log. `typed, not dictated` means the burst detector saw key-by-key input. `insertion point is ambiguous` means the caret read failed (see failure 1 above).

**Test 2: Notepad, dictating in front of existing text**

This is the regression that corrupted a paragraph on macOS. It is the single most important case.

1. In a fresh Notepad document, **type** (do not dictate): `ping Ashlr.AI about the cooper netties rollout`
2. Put the caret at the very **start** of the line.
3. Dictate: *"ping ashler about the cuban eats rollout on versal"*
4. **Expect:** the dictated sentence is corrected, and the sentence you typed is **byte-for-byte untouched**. Read the whole line carefully.
5. **A correct alternative outcome:** nothing happens at all, and the log says `insertion point is ambiguous`. That is the app refusing to guess, which is the designed behaviour when the caret cannot be read. It is a degradation, not a bug.
6. **A failure:** the correction appears spliced into the middle of a word, or the typed sentence has changed. Stop and report it: that is the bug the whole caret-anchoring design exists to prevent.

**Test 3: WordPad, a rich-text provider**

1. Open WordPad (`write.exe`). Type a sentence, press Enter, then dictate the phrase from Test 1 on the new line.
2. **Expect:** the same correction; the first line untouched; no new blank lines.
3. Dictate a phrase ending with *"new line"*. **Expect:** the correction lands and the line break is preserved, because the trailing newline is deliberately kept out of the burst.

**Test 4: Chrome, a Chromium provider**

1. Open Chrome, go to any page with a big text box (a Gmail compose window, or `data:text/html,<textarea rows=10 cols=60>`).
2. Dictate the phrase from Test 1.
3. **Expect:** the same correction, possibly a beat slower.
4. Check **Run doctor**'s log for the strategy used on the last fix. The `Last correction` submenu footer says `via keystrokes` or `via value`. Either is fine; `via value` means Chrome refused the selection and the whole-field write took over (undo will be coarser).
5. Now find a **password field** (any sign-in page). Click into it and type a few characters. **Expect:** the log says `not watching this field: UIA reports IsPassword`, and nothing is ever sent.

**Test 5: the Codex or Claude desktop app, an Electron provider**

1. Open it and click into the message composer.
2. Dictate the phrase from Test 1.
3. **Expect:** the correction lands. Electron is the most likely place for it to fall through to the value write or to do nothing at all.
4. **Critically:** confirm the message was **not sent**. The app refuses any rewrite that would introduce a newline the burst did not have, precisely because a synthesized Return in a chat composer sends the message. If a message ever sends itself, stop using it and report that first.

**Test 6: the refusals**

1. Open Windows Terminal or PowerShell. Dictate anything. **Expect:** nothing happens; the log says `not watching <app>: excluded`.
2. Open your password manager. Click into an item's **Notes** field (not the password field) and type. **Expect:** the log says `it looks like it holds a secret (...)` or `excluded`, and nothing is read.
3. Right-click the tray icon with Notepad focused. **Expect:** the menu shows **Fix everywhere in notepad**, checked. Uncheck it, dictate into Notepad, confirm nothing happens, then check it again.

**Test 7: the rest of the menu**

1. Copy a sentence containing a misspelling onto the clipboard. **Fix clipboard now** (or Ctrl+Alt+V). Paste. **Expect:** corrected.
2. **Open lexicon file** opens your `lexicon.yaml`.
3. **Start at login**: tick it, then check Settings > Apps > Startup shows LexiconBar. Untick it and confirm it disappears.
4. **Quit**. The icon goes away and `LexiconBar.exe` is gone from Task Manager.

**What to send back if something fails**

The **Run doctor** window, copied whole. It has the resolved paths, the API state and the recent log, and the log never contains anything you dictated.

## Build from source

Requirements: the **.NET 8 SDK**. No Visual Studio, no Windows.

```bash
cd apps/windows
dotnet build -c Release                      # whole solution
dotnet test  -c Release                      # the 199 portable tests
dotnet publish src/LexiconBar.App/LexiconBar.App.csproj \
  -c Release -r win-x64 --self-contained -o artifacts/win-x64
```

Or use the scripts, which also run the tests and produce the zip:

```bash
apps/windows/build/publish.sh                # macOS, Linux or Windows
pwsh apps/windows/build/publish.ps1          # Windows
```

Building a WinForms project off Windows works because of `<EnableWindowsTargeting>true</EnableWindowsTargeting>` in `apps/windows/Directory.Build.props`, which lets the SDK restore the Windows Desktop targeting pack from NuGet.

### Layout

```
apps/windows/
  LexiconBar.sln
  Directory.Build.props
  src/LexiconBar.Core/        net8.0. PORTABLE, TESTED. No UIA, no WinForms, no Win32.
  src/LexiconBar.App/         net8.0-windows: the tray app. UNVERIFIED.
    Interop/                    SAFEARRAY, BSTR, SendInput
    FixEverywhere/              UiaThread, FocusWatcher, UiaField, FixEngine
    Ui/                         tray, bubble, preferences, hotkeys
  tests/LexiconBar.Core.Tests/ net8.0, xunit, headless
  build/                       publish.sh, publish.ps1
```

The split is load-bearing, not cosmetic: **every rule that can corrupt a user's text lives in `LexiconBar.Core`**, which targets plain `net8.0` and may not reference UI Automation, WinForms or Win32. That is what makes it testable on a machine that cannot run the app.

The same line is where the privacy decisions go, for the same reason. `FieldGate` decides whether a given field may be read; `ReadPolicy` adds the master switch and answers what the watcher must let go of when it moves; `UndoPlanner` holds everything the undo hotkey decides before it touches the field. All three take the field through `IInspectableField`, which hands over identity and labels freely and guards the one call that fetches the user's text, so a test can drive them with a field that counts reads. What is left in `LexiconBar.App` is the UI Automation that acts on the answer, and it is unverified like the rest of that project. A decision left there could only be checked by reading it: the test project references `LexiconBar.Core` alone, because `net8.0-windows` cannot load on the Linux runner that gates this repo.

### CI

`.github/workflows/windows-app.yml` runs on any change under `apps/windows/`. Its `test-portable` job runs the 199 portable tests and the win-x64 cross-build on Linux, which is the gate that matters day to day, since the app is built on a Mac. Its `build-windows` job builds the solution, runs the same tests and publishes `LexiconBar.exe` as an artifact on `windows-latest`. Neither job touches UI Automation, for the reason above.

## Troubleshooting

**Nothing happens anywhere.** Run doctor. If `serve.json` is `NOT FOUND`, the CLI has never run on this machine: run `lexicon serve` once. If the API is `not reachable`, the server is not running.

**Nothing happens in one particular app.** Some apps expose no UIA text provider at all. The log says nothing because there is nothing to say; the focused element simply has neither `TextPattern` nor `ValuePattern`. Nothing breaks; that app is just invisible to it.

**Nothing happens in an app running as administrator.** Expected, and deliberate. UIPI stops a non-elevated process from reading or typing into an elevated window. Running LexiconBar elevated would fix it and would also let it read every elevated window on the machine, which is not a trade worth making.

**It corrects, but slowly.** The correction fires on silence, by design: 700 ms after a single insertion, 1500 ms after the last word of a streamed run. If it is much slower than that, the app is probably falling back on the 250 ms poll because the provider raises no text-changed events. Lower **Poll interval** in Preferences.

**Undo is greyed out.** It only applies while the same field still holds exactly the corrected text. One keystroke after the fix and the offer goes away rather than firing at a stale offset.

**A correction went to the wrong place.** Stop using Fix everywhere (untick it in the menu) and send the Run doctor output. This is the failure mode the whole design is built around and it should be treated as a serious bug.

---

## See also

- [MACOS-APP.md](MACOS-APP.md) is the macOS app this is a port of, and the behaviour contract both share.
- [LOCAL-API.md](LOCAL-API.md) documents `POST /normalize` and the rest of the local API.
- [DAEMON.md](DAEMON.md) covers the clipboard watcher as a CLI command.

Back to [the docs index](README.md).
