# LexiconBar for Windows

The Windows counterpart of `apps/macos/LexiconBar`: a tray app that corrects dictated text in place, in any application, through UI Automation.

**User documentation, and the honest account of what is and is not verified, is in [`docs/WINDOWS-APP.md`](../../docs/WINDOWS-APP.md). Read that first.**

## Quick start

```bash
dotnet build  -c Release          # whole solution, warnings as errors
dotnet test   -c Release          # 144 portable tests, no Windows needed
./build/publish.sh                # one self-contained LexiconBar.exe + zip
```

Requires the .NET 8 SDK. Does not require Visual Studio. Does not require Windows — `<EnableWindowsTargeting>` lets the whole thing cross-compile from macOS or Linux, which is how it was written.

## Layout

| Path | Target | Status |
| --- | --- | --- |
| `src/LexiconBar.Core` | `net8.0` | **Tested.** Burst detection, splice maths, the secret-field heuristic, exclusions, bubble content and placement, `serve.json` discovery, settings. No UIA, no WinForms, no Win32 — that restriction is what makes it testable off Windows. |
| `src/LexiconBar.App` | `net8.0-windows` | **Unverified.** UI Automation, `SendInput`, the tray, the bubble, hotkeys, the registry. Compiles; has never been run. |
| `tests/LexiconBar.Core.Tests` | `net8.0` | xunit, headless, runs anywhere. |
| `build/` | | `publish.sh`, `publish.ps1`, and `windows-app.yml` **to be copied to `.github/workflows/`**. |

## The rule for contributors

If you are adding logic that could put the wrong text into somebody's document, it goes in `LexiconBar.Core` with a test. The four rules in `BurstDetector` that look over-engineered — chunk size rather than rate, coalescing a streamed run, anchoring the edit window to the caret, and refusing a stale snapshot — each came from a real text-corruption bug on macOS. Do not simplify them, and keep them in step with `apps/macos/LexiconBar/Sources/LexiconBarKit/BurstDetector.swift`; the test suites are deliberately ports of each other.
