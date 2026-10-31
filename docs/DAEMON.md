# Clipboard daemon

For correcting text in anything that has no hook, no extension and no MCP server: if you can copy it, this can fix it. If you want the dictation itself as well, see [VOICE.md](VOICE.md); on macOS, [LexiconBar](MACOS-APP.md) wraps this same command in a menu bar hotkey, and on Windows [the tray app](WINDOWS-APP.md) aims at the same job from the notification area.

Dictate anywhere, copy the text, paste the corrected version. macOS, Linux and Windows.

```bash
lexicon daemon                 # watch the clipboard, rewrite in place
lexicon daemon --once          # correct the clipboard once and exit (bind this to a shortcut)
lexicon daemon --once --paste  # ...then send Cmd+V to the frontmost app (macOS)
lexicon daemon --dry-run       # print what would change, do not write
lexicon daemon --interval 500  # poll every 500ms instead of 250
lexicon daemon --quiet         # rewrite silently
lexicon daemon --which         # print the detected clipboard backend and exit
lexicon daemon --backend xsel  # force a backend: pbcopy | wl | xclip | xsel | powershell
```

The watcher polls the clipboard every 250ms. When the text changes and `normalize` would alter it, it writes the corrected text back, prints the diff and records the hits. A loop guard remembers the last value it wrote so it never rewrites its own output. The lexicon is re-read when a lexicon file or `trust.json` has changed, checked (a few `stat` calls) each time a new clipboard text is about to be corrected, so a term you just learned is used on the next copy; it is also re-read every 5 seconds as a backstop. Ctrl-C stops it cleanly; when a clipboard read is still in flight it waits for it and says so, and a second Ctrl-C stops at once. Either way the exit status follows the signal: 130 after Ctrl-C (SIGINT), 143 after SIGTERM.

## Backends

The clipboard tool is detected per platform (`lexicon daemon --which` and `lexicon doctor` show which one):

| Platform | Backend | Commands |
|---|---|---|
| macOS | `pbcopy` | `pbpaste` / `pbcopy` (built in) |
| Linux, Wayland (`WAYLAND_DISPLAY` set) | `wl` | `wl-paste --no-newline --type text` / `wl-copy --type text/plain` (`sudo apt install wl-clipboard`) |
| Linux, X11 | `xclip`, else `xsel` | `xclip -selection clipboard -o` / `-i` (`sudo apt install xclip`) |
| Windows | `powershell` | `Get-Clipboard -Raw` / `Set-Clipboard` (built in; CRLF preserved) |

An empty or non-text clipboard (an image, a file) is treated as no text and skipped, as is anything over 20,000 characters. Content a tool hands over as bytes that are not UTF-8 text (a NUL, or bytes that do not decode) is never rewritten either, so a copied image stays an image.

## One-shot mode for a keyboard shortcut

`lexicon daemon --once` reads the clipboard once, corrects it, writes it back if anything changed, prints the diff (or `no changes`) and exits 0. With no terms in the lexicon it says so, `no changes (the lexicon has no terms yet; run \`lexicon setup\`, or add one with: lexicon learn <heard> <meant>)`, and the watching daemon says it once when it starts. Bind it to a key: dictate, copy, press the key, paste. With `--paste` (macOS only) it also sends Cmd+V to the frontmost app, so the shortcut becomes "dictate, press the key". A clipboard it leaves as it was (empty, too large, binary such as an image, or with no letters) is not pasted, and stderr says why. `--paste` with `--dry-run` is refused (exit 1) before the clipboard is read: a dry run leaves the clipboard uncorrected, so the paste would send the original text.

`--paste` uses `osascript` and needs Accessibility permission for whatever runs the shortcut (Raycast, Alfred, Keyboard Maestro, Terminal): System Settings > Privacy & Security > Accessibility. Nothing else in the daemon needs a permission. On Linux and Windows `--paste` prints a notice and leaves the corrected text on the clipboard. On macOS the [LexiconBar](MACOS-APP.md) app wraps the same command in a menu bar hotkey; [the Windows tray app](WINDOWS-APP.md) has its own equivalent, though nothing in it has been run on Windows yet. [PLATFORMS.md](PLATFORMS.md) has the full picture.

### Raycast

Save as `~/raycast-scripts/lexicon-fix.sh`, `chmod +x`, add the folder in Raycast > Extensions > Script Commands, then give it a hotkey.

```bash
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Fix dictation
# @raycast.mode silent
# @raycast.packageName Lexicon
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
lexicon daemon --once --paste --quiet
```

Alfred (Workflow > Run Script, `/bin/bash`) and Keyboard Maestro (Execute Shell Script) take the same last two lines as a one-liner.

### Windows, AutoHotkey v2

`Ctrl+Alt+V` corrects the clipboard, then pastes.

```autohotkey
^!v:: {
    RunWait('lexicon daemon --once --quiet', , 'Hide')
    Send('^v')
}
```

### Linux, GNOME custom shortcut

Settings > Keyboard > View and Customize Shortcuts > Custom Shortcuts, command:

```bash
sh -c 'lexicon daemon --once --quiet && xdotool key ctrl+v'   # X11; drop the xdotool part on Wayland and paste by hand
```

Use the absolute path to `lexicon` (`which lexicon`) if the shortcut runner has a minimal PATH.

## Resident expander (opt-in)

`lexicon daemon --expander` starts a separate, long-lived process instead of
the clipboard watcher. It keeps the lexicon in memory (reloaded when a lexicon
file or `trust.json` changes) and answers over a local socket, so a shortcut or
a key-capture helper gets a correction without a Node cold start. Nothing
starts it but the flag.

```bash
lexicon daemon --expander                      # $XDG_RUNTIME_DIR/lexicon/expander.sock, else ~/.local/state/lexicon/expander.sock
lexicon daemon --expander --socket /tmp/lx.sock
```

The socket is mode 0600 in a 0700 directory: only your user can connect (on
Windows it is a per-user named pipe). A stale socket left by a crash is
replaced; a live expander or a path that is not a socket is refused, never
removed. Typed text is never logged.

The protocol is newline-delimited JSON, one response line per request line,
in order; an `id` is echoed back.

| Request | Response |
| --- | --- |
| `{"op":"cli-read","argv":["list","--json"],"context":"..."}` | `{"ok":true,"stdout":"...","stderr":"","code":0}` |
| `{"op":"ping"}` | `{"ok":true,"version":"...","terms":12}` |
| `{"op":"normalize","text":"..."}` | `{"ok":true,"output":"...","changed":true,"replacements":[...]}` |
| `{"op":"clipboard","paste":true}` | `{"ok":true,"changed":true,"written":true,"corrections":1,"pasted":true}` |
| `{"op":"type","text":"a"}` | `{"ok":true,"action":null}` or an action |
| `{"op":"key","key":"Backspace"}` | `{"ok":true,"action":null}` or an undo action |
| `{"op":"reset"}` | `{"ok":true}` |

The CLI automatically tries the default socket for command-first `list` (`ls`),
`path`, `stats`, and stdout-only `export` invocations. The internal `cli-read`
operation uses the same CLI handlers and fresh file/trust checks. Its opaque
`context` comes from `cliReadContext()`: version, working directory, home,
lexicon/config overrides, trust override, and terminal colour settings must
match the resident process. `--cwd` after the command is supported; a global
option before it uses the direct path. File exports, help, mutations and stdin
commands use the direct path too. A missing daemon, an older protocol, a bad
response or a 100 ms total deadline silently falls back, preserving stdout,
stderr and status. Nothing starts a daemon automatically. Custom `--socket`
paths remain available to explicit protocol clients. See [BENCH-DAEMON.md](BENCH-DAEMON.md)
for measured latency, memory and reproduction.

`clipboard` is `--once [--paste]` in the resident process, so a hotkey can run:

```bash
echo '{"op":"clipboard","paste":true}' | nc -U ~/.local/state/lexicon/expander.sock
```

`type`, `key` and `reset` drive the expansion core for a key-capture helper
(one connection per keyboard). The helper sends each typed character (or a
chunk a dictation tool injected), `key` for Backspace, Enter, Tab, Escape,
Delete, the arrows, Home, End, PageUp and PageDown, and `reset` for a click,
a shortcut or a focus change. An action means: press Backspace `backspaces`
times (grapheme clusters), then type `insert`.

```json
{"ok":true,"action":{"kind":"expand","backspaces":7,"insert":"Ashlr.AI ","replacements":[{"original":"Ashler","replacement":"Ashlr.AI","canonical":"Ashlr.AI"}]}}
```

The core expands only when whitespace finishes a word, only the words just
finished, and only exact aliases (no phonetic or fuzzy guesses while you
type). Punctuation does not finish a word, so `foo@ashler.io` and
`ashler.com` are left alone. Enter, Tab and every navigation key forget the
buffer instead of expanding, since the field may have been submitted or the
cursor moved. Backspace straight after an expansion undoes it, and that word
is not expanded again.

## See also

- [VOICE.md](VOICE.md) records and transcribes locally, rather than correcting what another tool produced.
- [EXPORTS.md](EXPORTS.md) pushes your terms into a dictation app, so there is less left to correct.
- [MATCHING.md](MATCHING.md) explains what the daemon is doing to the clipboard.

Back to [the docs index](README.md).
