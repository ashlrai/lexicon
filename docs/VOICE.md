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
new launcher triggers the permission prompt; until it is granted ffmpeg exits without
opening its output, so nothing is recorded and `lexicon voice` reports
"the recorder ... stopped on its own and left no audio", quotes ffmpeg's own last
line, and prints this hint. `--paste` additionally needs Accessibility permission for
the same app (it sends a keystroke).

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
`recording` and exits immediately. The second call stops that pid, waits up to 3 s,
transcribes, outputs, and removes the state file and the WAV. The recorded length
reported in `--json` and in `history.jsonl` is wall clock for a recording this command
stopped, and the audio's own length (bytes over 32000 a second) for one that had
already ended on its own.

Stopping differs by platform. On macOS and Linux the recorder gets SIGINT and ffmpeg
finalizes the WAV header on its way out. Windows has no equivalent: Node maps every
signal to `TerminateProcess`, and a detached recorder stopped by a different process
shares no console, so there is nothing to deliver a real interrupt through. The
recorder is killed outright and the header is left unfinalized. The recording itself
survives, because ffmpeg runs with `-flush_packets 1` and the transcriber validates
the container rather than trusting the header: measured on macOS with ffmpeg 9.0.2, a
SIGKILL and a SIGINT at the same point left the same 112,640 bytes of audio and
differed only in the header. What is lost on Windows is whatever the input device was
still holding. `ffmpegRecordArgs` passes no `-audio_buffer_size`, so dshow uses the
device's default, which ffmpeg documents as typically a multiple of 500 ms: budget
half a second or so off the end of each toggle, not "a fraction of a second". Nothing
here has measured it, because dshow does not exist off Windows.

A forgotten recording stops itself after 10 minutes (`-t 600`). **That is a finished
recording, not a mess to clear up**: the next press finds a pid that is gone, looks at
the WAV, and transcribes it like any other. The same goes for a recorder that crashed
partway, whose header ffmpeg never finalized. A recorder that left nothing usable (no
microphone permission, so ffmpeg never opened its output) is reported with ffmpeg's
own last lines instead of silently starting another doomed recording, and the command
exits 1.

Nothing deletes a capture that holds bytes. A WAV is removed when whisper has read it,
and when it is empty (the placeholder a start creates before ffmpeg runs). A capture
this command refuses to transcribe is kept, and the error names the file, because a
refusal is a parser's opinion about a container and the audio is the user's. ffmpeg's
stderr for a toggle recording goes to `voice/recorder.log`.

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
the four benchmark passes over 330 clips took 19 s (`base.en`), 25 s (`base.en` with
prompt), 42 s (`small.en`) and 50 s (`small.en` with prompt), so roughly 0.06 s and
0.15 s of transcription per short sentence. On the 3 s check clip used while
building this command, `base.en` transcribed in about 0.2 s and `small.en` in about
0.35 s; `normalize()` is under 5 ms. Add ffmpeg start-up and the 3 s stop grace in
toggle mode (usually well under 0.5 s in practice, ffmpeg exits as soon as it
flushes). Expect a hotkey round trip of about one second with `base.en`.

Accuracy from the same benchmark, over the 279 proper nouns in those clips: `base.en`
spelled 42% of lexicon terms right on its own, 67% with the prompt, 92% with prompt
plus lexicon (86% with the lexicon but no prompt); `small.en` 46% / 76% / 96%.
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
- The macOS capture path is the tested one. `-f pulse` (with the ALSA fallback) on
  Linux and `-f dshow` on Windows are implemented and unit-tested with injected
  processes, but neither has met a real microphone: no CI runner has audio hardware.
  Expect to have to name your device with `--device` on those platforms, and see
  [PLATFORMS.md](PLATFORMS.md).
- `--paste` is macOS only (AppleScript Cmd+V). Elsewhere the text is copied and a
  notice is printed; wire the paste keystroke in the launcher as shown above.
- No streaming: nothing appears until you stop. For long dictation a real dictation
  app is a better fit.

## See also

- [EXPORTS.md](EXPORTS.md) covers Wispr Flow and Superwhisper, which are nicer dictation apps to export into.
- [SUGGEST.md](SUGGEST.md) mines the history this command writes for what to add next.
- [MATCHING.md](MATCHING.md) explains the corrections applied to each transcript.

Back to [the docs index](README.md).
