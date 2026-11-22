# LexiconBar for Windows

The Windows counterpart of `apps/macos/LexiconBar`: a tray app that corrects dictated text in place, in any application, through UI Automation.

**User documentation, and the honest account of what is and is not verified, is in [`docs/WINDOWS-APP.md`](../../docs/WINDOWS-APP.md). Read that first.**

## Quick start

From `apps/windows`:

```bash
dotnet build  -c Release          # whole solution, warnings as errors
dotnet test   -c Release          # 227 portable tests, no Windows needed
./build/publish.sh                # tests, then one self-contained LexiconBar.exe + artifacts/LexiconBar-win-x64.zip
```

Requires the .NET 8 SDK. Does not require Visual Studio. Does not require Windows: `<EnableWindowsTargeting>` in `Directory.Build.props` lets the whole thing cross-compile from macOS or Linux, which is how it was written. On Windows, `pwsh build/publish.ps1` does the same as `publish.sh`.

## Layout

| Path | Target | Status |
| --- | --- | --- |
| `src/LexiconBar.Core` | `net8.0` | **Tested.** Burst detection, splice and rewrite maths, the secret-field heuristic, the read gate, partial-write recovery and keystroke settle, the undo ledger, exclusions, bubble content and placement, `serve.json` discovery, locating the `lexicon` CLI, settings. No UIA, no WinForms, no Win32. That restriction is what makes it testable off Windows. |
| `src/LexiconBar.App` | `net8.0-windows10.0.19041.0` | **Unverified.** UI Automation, `SendInput`, the tray, the bubble, hotkeys, the registry. Compiles; has never been run. |
| `tests/LexiconBar.Core.Tests` | `net8.0` | xunit, headless, runs anywhere. |
| `build/` | | `publish.sh` and `publish.ps1`. CI lives in `.github/workflows/windows-app.yml`. |

## The rule for contributors

If you are adding logic that could put the wrong text into somebody's document, it goes in `LexiconBar.Core` with a test. The four rules in `BurstDetector` that look over-engineered (chunk size rather than rate, coalescing a streamed run, anchoring the edit window to the caret, and refusing a stale snapshot) each came from a real text-corruption bug on macOS. Do not simplify them, and keep them in step with `apps/macos/LexiconBar/Sources/LexiconBarKit/BurstDetector.swift`; the test suites are deliberately ports of each other.
