# `lexicon voice`: local push-to-talk dictation

A minimal, fully local dictation path for people who do not want a dictation app.
It exists so the lexicon can be used end to end without Wispr Flow or Superwhisper,
and so a hotkey can drop corrected text into whatever is focused. It is not a
dictation product: no floating UI, no streaming, no voice commands, no per-app
modes. If you already run Wispr Flow, Superwhisper, MacWhisper or the macOS
dictation, keep using it and feed the lexicon into it with `lexicon export`; their
UX is better than this and will stay better. `lexicon voice` is the fallback and
the test bench.

## How it works

```
microphone -> ffmpeg (16 kHz mono s16 WAV) -> whisper.cpp (--prompt <canonicals>) -> normalize() -> stdout | clipboard | Cmd+V
```

1. **Record.** `ffmpeg` captures the default input device to a 16 kHz mono PCM WAV,
   the format whisper.cpp expects. macOS uses `-f avfoundation -i ":default"`,
   Linux `-f pulse -i default` (ALSA when ffmpeg has no pulse demuxer), Windows
   `-f dshow -i audio=<device>`.
2. **Transcribe.** `whisper-cli` runs on the WAV with `-nt -np -oj` and, unless
   `--no-prompt`, `--prompt` set to `lexicon export whisper-prompt` (the canonicals of
   your merged lexicon, comma-separated, capped at 100). Whisper biases toward
   spellings it sees in the prompt; on the audio benchmark that alone lifts
   `base.en` term recall from 42% to 67% (see below). Bracketed tags like
   `[BLANK_AUDIO]` and noise annotations like `(applause)` are stripped.
3. **Correct.** `normalize()` applies the lexicon (alias, phonetic, fuzzy) to what
   Whisper wrote. Matched terms get a `hits` bump like every other entry point.
4. **Output.** The corrected text goes to stdout (default), the clipboard (`--copy`),
   or the frontmost app (`--paste`: copy plus an AppleScript Cmd+V, macOS only for
   now; elsewhere it falls back to `--copy` with a notice). `--json` prints
   `{ raw, output, replacements, summary, model, seconds, ms: { record, transcribe, normalize } }`.
5. **Remember.** Each transcription appends `{ at, raw, output, model, ms }` to
   `~/.config/lexicon/voice/history.jsonl` (newest 1000 kept). The raw/output pairs
   are the material for `lexicon learn` and future alias suggestions; `--no-history`
   opts out.

Exit codes: `0` ok, `1` error, `2` ffmpeg or whisper-cli missing (with an install
hint), `3` nothing heard. `--status` exits `0` while a toggle recording is running
and `1` when idle, so scripts can branch on it.

## Install

```bash
brew install ffmpeg whisper-cpp          # macOS
sudo apt install ffmpeg                  # Linux, then build whisper.cpp and set LEXICON_WHISPER_BIN
winget install Gyan.FFmpeg               # Windows, then set LEXICON_WHISPER_BIN to whisper-cli.exe
lexicon doctor                           # shows whisper-cli, ffmpeg, the model and the mic-permission note
```

`whisper-cli` is found on `PATH` (also as `whisper-cpp`), then in `/opt/homebrew/bin`
and `/usr/local/bin` because hotkey launchers usually run with a minimal `PATH`.
`LEXICON_WHISPER_BIN` points at any binary, including `main` from a whisper.cpp
checkout; `LEXICON_FFMPEG_BIN` does the same for ffmpeg.

### First-run model download

`--model` defaults to `base.en`. A model name maps to `ggml-<name>.bin` under
`~/.config/lexicon/models/` (override with `LEXICON_WHISPER_MODELS`); a repo checkout
also looks in `bench/audio/models/` so the benchmark's download is reused. A missing
named model is fetched from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin` with a
progress line on stderr (`base.en` is 148 MB, `small.en` 488 MB). `--model /path/to/ggml-x.bin`
uses a file directly and never downloads.

### Microphone permission (macOS)

macOS attributes the microphone to the app that launched the recorder, so the
**terminal, Raycast, Hammerspoon or whatever runs `lexicon voice`** must be allowed
under System Settings > Privacy & Security > Microphone. The first recording from a
new launcher triggers the permission prompt; until it is granted ffmpeg writes an
empty WAV and `lexicon voice` reports "recording failed (no audio written)" with this
hint. `--paste` additionally needs Accessibility permission for the same app (it
sends a keystroke).

## Usage

```bash
lexicon voice                            # record until Enter or Ctrl-C, print corrected text
lexicon voice --seconds 5                # fixed length
lexicon voice --copy                     # also on the clipboard
lexicon voice --paste                    # copy and Cmd+V into the frontmost app (macOS)
lexicon voice --json                     # machine-readable result
lexicon voice --model small.en           # slower, more accurate (downloaded on first use)
lexicon voice --device "External Microphone"   # by name or index; see --list-devices
lexicon voice --list-devices
lexicon voice --lang de --translate      # non-English audio, English text
lexicon voice --no-prompt --no-history
```

### Hotkey mode: `--toggle`

One command that starts on the first press and stops on the second, so a single
hotkey is push-to-talk:

```bash
lexicon voice --toggle --paste           # press once: "recording"; press again: text is pasted
lexicon voice --status                   # "recording since <time>" (exit 0) or "idle" (exit 1)
```

The first call spawns ffmpeg detached, writes
`~/.config/lexicon/voice/recording.json` (`{ pid, wav, startedAt }`), prints
`recording` and exits immediately. The second call sends SIGINT to that pid (ffmpeg
finalizes the WAV header), waits up to 3 s, transcribes, outputs, and removes the
state file and the WAV. A state file whose pid is gone is treated as "start". A
forgotten recording stops itself after 10 minutes. ffmpeg's stderr for a toggle
recording goes to `voice/recorder.log`.

### Hotkey recipes

All of them call the same command; pick the launcher you already have. Give that
launcher Microphone (and, for `--paste`, Accessibility) permission.

**Raycast script command** (`~/raycast-scripts/dictate.sh`, then bind a hotkey in Raycast):

```bash
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Dictate (lexicon)
# @raycast.mode silent
# @raycast.packageName Lexicon
export PATH="/opt/homebrew/bin:$PATH"
lexicon voice --toggle --paste --quiet
```

**Hammerspoon** (`~/.hammerspoon/init.lua`):

```lua
hs.hotkey.bind({"ctrl", "alt"}, "space", function()
  hs.task.new("/opt/homebrew/bin/lexicon", function(code, out, err)
    if out:match("^recording") then hs.alert.show("Recording...") end
    if code ~= 0 and code ~= 3 then hs.alert.show("lexicon voice: " .. err) end
  end, {"voice", "--toggle", "--paste", "--quiet"}):start()
end)
```

**Karabiner-Elements** (`complex_modifications`, right Option as push-to-talk):

```json
{
  "description": "Right Option: lexicon voice toggle",
  "manipulators": [{
    "type": "basic",
    "from": { "key_code": "right_option", "modifiers": { "optional": ["any"] } },
    "to": [{ "shell_command": "/opt/homebrew/bin/lexicon voice --toggle --paste --quiet" }]
  }]
}
```

**AutoHotkey** (Windows; `--paste` falls back to `--copy`, so the script pastes):

```ahk
^!Space::
    RunWait, lexicon voice --toggle --copy --quiet, , Hide, pid
    if (ErrorLevel = 0)
        Send, ^v
return
```

**GNOME** (Settings > Keyboard > Custom Shortcuts, command
`sh -c 'lexicon voice --toggle --copy --quiet && wtype -M ctrl v -m ctrl'`; use
`xdotool key ctrl+v` on X11).

### Latency

Numbers from `docs/BENCHMARK.md` (macOS TTS clips, M5 Max, whisper.cpp with Metal):
the four benchmark passes over 279 clips took 19 s (`base.en`), 25 s (`base.en` with
prompt), 42 s (`small.en`) and 50 s (`small.en` with prompt), so roughly 0.07 s and
0.15 s of transcription per short sentence. On the 3 s check clip used while
building this command, `base.en` transcribed in about 0.2 s and `small.en` in about
0.35 s; `normalize()` is under 5 ms. Add ffmpeg start-up and the 3 s stop grace in
toggle mode (usually well under 0.5 s in practice, ffmpeg exits as soon as it
flushes). Expect a hotkey round trip of about one second with `base.en`.

Accuracy from the same benchmark: `base.en` spelled 42% of lexicon terms right on its
own, 67% with the prompt, 92% with prompt plus lexicon; `small.en` 46% / 76% / 96%.
`base.en` is the default because it is the fastest model that is good enough once
the lexicon runs after it; switch to `small.en` if you dictate a lot of ordinary
vocabulary Whisper gets wrong, since the lexicon cannot fix words it does not know.

## Caveats

- Whisper hallucinates on silence ("You", "Thank you."). A recording with no speech
  may therefore print a word instead of "(nothing heard)"; exit 3 fires only when the
  transcript is empty after tag stripping.
- Whisper is not deterministic across runs on the same audio; the same clip produced
  "Kuper Nettie's" once and "Kubernettys" the next time. The lexicon catches the
  first (phonetic) and not the second. That is exactly what `history.jsonl` is for:
  `lexicon learn Kubernettys Kubernetes`.
- `--paste` is macOS only (AppleScript Cmd+V). Elsewhere the text is copied and a
  notice is printed; wire the paste keystroke in the launcher as shown above.
- No streaming: nothing appears until you stop. For long dictation a real dictation
  app is a better fit.
