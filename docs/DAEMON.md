# Clipboard daemon

For correcting text in anything that has no hook, no extension and no MCP server: if you can copy it, this can fix it. If you want the dictation itself as well, see [VOICE.md](VOICE.md); on macOS, [LexiconBar](MACOS-APP.md) wraps this same command in a menu bar hotkey.

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

The watcher polls the clipboard every 250ms. When the text changes and `normalize` would alter it, it writes the corrected text back, prints the diff and records the hits. A loop guard remembers the last value it wrote so it never rewrites its own output. The lexicon is re-read at most every 5 seconds. Ctrl-C stops it cleanly.

## Backends

The clipboard tool is detected per platform (`lexicon daemon --which` and `lexicon doctor` show which one):

| Platform | Backend | Commands |
|---|---|---|
| macOS | `pbcopy` | `pbpaste` / `pbcopy` (built in) |
| Linux, Wayland (`WAYLAND_DISPLAY` set) | `wl` | `wl-paste --no-newline` / `wl-copy` (`sudo apt install wl-clipboard`) |
| Linux, X11 | `xclip`, else `xsel` | `xclip -selection clipboard -o` / `-i` (`sudo apt install xclip`) |
| Windows | `powershell` | `Get-Clipboard -Raw` / `Set-Clipboard` (built in; CRLF preserved) |

An empty or non-text clipboard (an image, a file) is treated as no text and skipped, as is anything over 20,000 characters.

## One-shot mode for a keyboard shortcut

`lexicon daemon --once` reads the clipboard once, corrects it, writes it back if anything changed, prints the diff (or `no changes`) and exits 0. Bind it to a key: dictate, copy, press the key, paste. With `--paste` (macOS only) it also sends Cmd+V to the frontmost app, so the shortcut becomes "dictate, press the key".

`--paste` uses `osascript` and needs Accessibility permission for whatever runs the shortcut (Raycast, Alfred, Keyboard Maestro, Terminal): System Settings > Privacy & Security > Accessibility. Nothing else in the daemon needs a permission. On Linux and Windows `--paste` prints a notice and leaves the corrected text on the clipboard. On macOS the [LexiconBar](MACOS-APP.md) app wraps the same command in a menu bar hotkey.

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

## See also

- [VOICE.md](VOICE.md) — recording and transcribing locally, rather than correcting what another tool produced.
- [LOCAL-API.md](LOCAL-API.md) — when a script needs the structured replacement list instead of the clipboard.
- [MACOS-APP.md](MACOS-APP.md) — the same actions as a macOS menu bar app.
