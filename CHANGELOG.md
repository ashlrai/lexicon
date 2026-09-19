# Changelog

All notable changes to `@ashlr/lexicon` are recorded here. The format follows Keep a Changelog. Versions follow semver.

## Unreleased

### Added

- Self-contained Claude Code plugin: `plugin/mcp-server.mjs` and `plugin/hook.mjs` are committed esbuild bundles (every dependency inlined, Node 20+, unminified) that `.mcp.json` and `hooks/hooks.json` point at, so `claude plugin install lexicon@ashlrai` works from a bare clone with no `npm install` or build. `npm run build:bundle` regenerates them; `npm run check:bundle` (run in CI) fails when they are stale. `plugin/` ships in the npm package; `dist/` stays untracked.
- `SessionStart` hook (same `hook.mjs`, dispatched on `hook_event_name`): emits the `claude-md` export of the merged lexicon as `additionalContext` once per session (startup, resume, clear, compact), capped at about 4000 characters with a "... N more terms; read the lexicon://me resource" line, plus the untrusted-project note when one applies. Empty lexicon: nothing.
- `UserPromptSubmit` hook flags corrections: when `parseCorrection` recognises the prompt ("it's X not Y", "Y -> X", "replace Y with X", quoted forms) it appends `The user is correcting a spelling: "Y" should be "X". Call the lexicon learn_correction tool with these values, then continue.` The hook never writes to the lexicon.
- `lexicon doctor` checks the Claude Code wiring: the `lexicon@<marketplace>` plugin in `~/.claude/plugins/installed_plugins.json` or `enabledPlugins`, else the `UserPromptSubmit` and `SessionStart` hooks in `~/.claude/settings.json` (missing hooks are a `!` warning, not a failure, since the plugin provides them).

### Changed

- `lexicon install-claude` and `lexicon install claude` register `plugin/mcp-server.mjs` and merge both `SessionStart` and `UserPromptSubmit` hooks running `plugin/hook.mjs` (falling back to `dist/` paths when the bundles are absent). `hookConfigFor` and `mergeHookIntoSettings` take an optional list of events.
- The MCP server reads its version from the `package.json` one or two levels up (whichever is `@ashlr/lexicon`) so the bundled server reports the right version.
- `prepublishOnly` also builds the bundles.

## 0.1.0

Initial release.

### Added

- Lexicon file format (`version: 1`): terms with `canonical`, `aliases`, `phonetic`, `category`, `notes`, `never`, `caseSensitive`; settings `minConfidence`, `phonetic`, `fuzzy`, `protectedWords`, `skipCode`.
- Global file at `~/.config/lexicon/lexicon.yaml` (override with `LEXICON_PATH` or `XDG_CONFIG_HOME`) and project `.lexicon.yaml` at the git root. Project wins on collision, aliases unioned.
- Matcher with three tiers: exact alias, phonetic (double metaphone), fuzzy (Damerau-Levenshtein). Built-in stoplist of about 300 common English words, `protectedWords`, per-term `never`, code span and URL skipping, three-character minimum for guessed matches. Explicit aliases always beat the stoplist.
- Matcher precision (benchmark in `docs/BENCHMARK.md`, prose false positives 18.9% -> 0.0% excl. hard, positive sentence accuracy 88.1% -> 94.2%): exact hits win overlap resolution; inexact windows never start or end on a function word; possessives survive phonetic and fuzzy matches; spans already equal to a canonical are claimed; no phonetic match on keys under 3 characters, windows under 4 letters or spelled-out aliases; lone lowercase words against aliased terms need 0.88; diacritics folded in the exact pass; transposition-aware similarity.
- `normalize` with replacement offsets, reasons, confidence and a one-line-per-change diff summary. Dry-run mode.
- Alias suggestion (`suggestAliases`) that generates likely STT misspellings of a canonical.
- Repo harvester: package and module names, PascalCase identifiers, git authors, directory name, README proper nouns. Bounded scan, ignores build and dependency directories.
- Exporters: `wispr`, `superwhisper`, `macos`, `espanso`, `whisper-prompt`, `deepgram`, `claude-md`, `csv`, `json`, `assemblyai`, `azure`, `google`, `openai`, `text`, `markdown`.
- Importers (`lexicon import <file> [format]`, `importLexicon`): `wispr`, `superwhisper`, `macos`, `espanso`, `text`, `csv`, `json`, with `auto` content detection; rows merged by canonical, `--dry-run`, `--project`, `--source`, `--category`, `--json`. `text` and `macos` round-trip with their exporters.
- MCP stdio server `lexicon-mcp` with tools `normalize_transcript`, `add_term`, `remove_term`, `list_terms`, `harvest_repo`, `export_lexicon`; resources `lexicon://me` and `lexicon://json`; prompt `voice-context`.
- Claude Code `UserPromptSubmit` hook (`lexicon hook`) that injects the diff and corrected prompt as `additionalContext`. Prints nothing when unchanged, always exits 0, about 100ms measured.
- CLI `lexicon`: `init --project`, `add` (`--phonetic --category --notes --project --suggest`), `remove --project`, `list` (`--json --category --query`), `normalize` (`--json --diff --dry-run --min-confidence --no-phonetic --no-fuzzy`, always exits 0 and passes text through on error), `harvest` (`--limit --min-count --add --json`), `export` (`--out --category --limit`), `path`, `doctor` (ok/warn/fail tiers, exit 1 on failure), `mcp`, `hook`, `daemon` (`--once --paste --interval --dry-run --quiet --backend --which`), `install-claude` (`--apply --scope`). Global `--cwd`.
- `lexicon doctor` term checks: canonical defined in both scopes, alias shared by several terms, alias that is a common English word.
- Clipboard daemon for macOS (`pbpaste`/`pbcopy`), Linux (`wl-clipboard` on Wayland, `xclip` or `xsel` on X11) and Windows (PowerShell `Get-Clipboard`/`Set-Clipboard`, CRLF preserved), with loop guard, `--dry-run`, `--interval` and `--quiet`. `lexicon daemon --once` corrects the clipboard once and exits (for a Raycast/Alfred/Keyboard Maestro/AutoHotkey/GNOME shortcut); `--once --paste` also sends Cmd+V on macOS (needs Accessibility permission); `--backend <name>` forces a backend; `--which` prints the detected one. `lexicon doctor` reports the clipboard backend (a warning, not a failure, when none is found).
- Claude Code plugin packaging: `.mcp.json`, `hooks/hooks.json`, a `lexicon` skill and a `/lexicon` command.
- Claude Code plugin marketplace manifest (`.claude-plugin/marketplace.json`): `claude plugin marketplace add ashlrai/lexicon` then `claude plugin install lexicon@ashlrai`.
- Interactive CLI workflows: `lexicon harvest --interactive` (implied by `--add` on a terminal; `--yes` opts out) walks candidates with `y`/`n`/`e` (edit aliases)/`c` (category)/`a` (add all)/`q`; `lexicon add -i` turns the suggested aliases into a checklist and asks for the phonetic hint and category; `lexicon review` (`--never-hit`, `--project`, `--category`) walks existing terms with `k`/`d`/`e`/`p`/`n`/`q` and writes once at the end; `lexicon edit` opens the file in `$VISUAL`/`$EDITOR` and validates it afterwards without ever rewriting it. All of it is dependency-free (`src/cli/prompt.ts` over `node:readline`) and refuses to run without a TTY.
- `lexicon install [client]`: prints or (`--apply`) merges the MCP config for `claude`, `codex` (`~/.codex/config.toml`), `cursor`, `windsurf`, `gemini`, `claude-desktop` and `vscode`; `--project` / `--scope project` for repo-level files, `--home` override. Idempotent, keeps unrelated keys, ends with the `lexicon export claude-md` hint for that client's rules file.
- GitHub automation: CI (Node 20/22/24, typecheck, build, test, CLI and MCP smoke), tag-triggered npm publish with provenance and a GitHub release, Dependabot, issue templates (bug report, misheard term), PR template, funding, Contributor Covenant 2.1 code of conduct.
- Docs: README, architecture, research memo, contributing guide, annotated example lexicon.

### Security

- Project `.lexicon.yaml` files are skipped until approved with `lexicon trust` (preview, sha256 pinned in `<config dir>/trust.json`; `lexicon trust --list`, `lexicon untrust`). A changed file drops back to untrusted until re-trusted. Files written by `init --project`, `add --project`, `harvest --add` and the MCP `add_term` tool are trusted automatically. `LEXICON_TRUST_ALL=1` bypasses the gate for CI. `loadLexicon()` gained `includeUntrusted` and reports `projectTrust` / `skippedProject`; the hook adds a one-line note (path only) when a project file was skipped; `list`, `normalize` (`--include-untrusted`) and `doctor` warn.
- Schema hardening: canonical/alias at most 80 chars, notes/phonetic 200, 64 aliases per term, 5000 terms, no control characters; zero-width, bidi and BOM characters are stripped. Lexicon files over 2 MB are refused. See SECURITY.md.
