# Module contract

Every module codes against `src/core/types.ts`. Import siblings only via
`../core/index.js` (ESM, `.js` suffix on relative imports, NodeNext resolution).
No default exports. Node >= 20, no `any` in public signatures.

## src/core/schema.ts
- `LexiconSchema`, `TermSchema` (zod v4) mirroring types.ts.
- `parseLexicon(raw: unknown): Lexicon` throws a readable error on invalid input.
- Limits in `LIMITS`: word 80, text 200, aliases 64, terms 5000, protectedWords 1000; no control characters; invisible/bidi characters stripped (`stripInvisible`, `hasControlChars`).
- `emptyLexicon(): Lexicon`

## src/core/store.ts
- `resolvePaths(opts?: { cwd?: string; globalPath?: string }): { global: string; project?: string }`
  - global: `$LEXICON_PATH` || `$XDG_CONFIG_HOME/lexicon/lexicon.yaml` || `~/.config/lexicon/lexicon.yaml`
  - project: walk up from cwd looking for `.lexicon.yaml` (stop at git root or `/`).
- `readLexiconFile(path, scope): Promise<LexiconFile>` (missing file => exists:false, empty lexicon)
- `writeLexiconFile(file: LexiconFile): Promise<void>` (atomic write, mkdir -p, YAML with header comment)
- `loadLexicon(opts?: StoreOptions & { includeUntrusted?: boolean }): Promise<LoadedLexicon>` merges global+project; project wins on canonical collision (case-insensitive); aliases unioned. The project file is merged only when trusted (see trust.ts) unless `includeUntrusted`; otherwise `LoadedLexicon.skippedProject` holds it and `projectTrust` says why (`'untrusted' | 'changed'`). Files over `MAX_LEXICON_BYTES` (2 MB) are refused.
- Project-scope writes are gated: `addTerm` (`scope: 'project'`) and `removeTerm` throw `ProjectTrustError` (`{ path, status: 'untrusted' | 'changed' }`, message `project lexicon at <path> is untrusted | has changed since it was trusted; review it and run \`lexicon trust\` first, or write to the global lexicon instead`) when the target `.lexicon.yaml` exists and is not trusted, before reading it. A file that does not exist yet is created and registered as trusted; an already-trusted file is re-pinned after the write. `recordHits` silently skips an untrusted project file.
- `addTerm(term: Term, opts?: { scope?: TermScope; cwd?: string; merge?: boolean }): Promise<{ file: LexiconFile; term: Term; created: boolean }>` — merges aliases into an existing canonical when merge !== false.
- `removeTerm(canonical: string, opts?): Promise<boolean>`
- `recordHits(canonicals: string[], opts?): Promise<void>` (best effort, never throws)
- `findTerm(lexicon: Lexicon, canonical: string): Term | undefined` (case-insensitive)

## src/core/trust.ts
- Registry `<dirname(global)>/trust.json`: `{ version: 1, trusted: { [absPath]: { sha256, trustedAt } } }`.
- `getTrustPath(opts?: StoreOptions): string`
- `isTrusted(file: LexiconFile, opts?): Promise<'trusted' | 'untrusted' | 'changed'>` — also 'trusted' when `LEXICON_TRUST_ALL=1`, when the file is the global lexicon or sits directly in its directory (not deeper), or when it does not exist.
- `trustProject(path, opts?): Promise<TrustEntry>`, `untrustProject(path, opts?): Promise<boolean>`, `refreshTrust(path, opts?): Promise<boolean>` (re-pin only if registered), `listTrusted(opts?): Promise<TrustListEntry[]>`.
- `readTrustRegistry`, `writeTrustRegistry` (atomic), `hashFile`, `trustAllEnabled`, `TRUST_FILE_NAME`, `TRUST_ALL_ENV`.

## src/core/matcher.ts
Pure functions, no IO.
- `buildIndex(lexicon: Lexicon): MatcherIndex` — precomputes alias map (diacritics folded), phonetic keys, token counts, per-term `hasExplicitAliases`.
- `findReplacements(text: string, index: MatcherIndex, opts?: NormalizeOptions): Replacement[]`
  - non-overlapping, sorted by start. Overlaps are resolved in two tiers: exact alias hits first (longest span, then earliest start), then phonetic/fuzzy hits that do not overlap an accepted span.
  - exact alias (word-boundary, multi-word, case-insensitive, diacritic-insensitive; also punctuation-stripped) => confidence 1.
  - phonetic: double metaphone of a token window equals that of an alias/canonical => confidence ~0.9 scaled by length similarity. Requires a key of >= 3 characters, a window of >= 4 letters unless the alias is that short; aliases whose every token is 1–2 letters ("j w t") get no key.
  - fuzzy: normalized optimal-string-alignment (Damerau, adjacent transpositions) similarity >= threshold => confidence = similarity.
  - inexact windows of 2+ tokens never start or end on a function word (articles, prepositions, conjunctions, pronouns except "her", auxiliaries, wh-words).
  - a lone all-lowercase token matched inexactly against a term with explicit aliases needs confidence >= 0.88 (`ALIASED_PLAIN_WORD_MIN`).
  - a span already equal to a canonical (with or without a trailing possessive) is claimed during overlap resolution and omitted from the result.
  - a trailing possessive is preserved for every reason: the base view wins when it matches the same term or at least as confidently.
  - never rewrite: tokens in built-in STOPLIST (common English words, ~300), `settings.protectedWords`, `term.never`, text inside code spans/fences/URLs/emails when skipCode.
  - never rewrite tokens shorter than 3 chars via fuzzy/phonetic (exact alias only).
- `export const STOPLIST: ReadonlySet<string>`
- `phoneticKey(s: string): string` (double metaphone primary, alpha-only)
- `similarity(a: string, b: string): number` 0..1; optimal string alignment distance up to 40 chars, plain Levenshtein beyond.

## src/core/normalize.ts
- `normalize(text: string, lexicon: Lexicon, opts?: NormalizeOptions): NormalizeResult` — applies findReplacements, preserves surrounding whitespace/punctuation, handles casing of canonical exactly as stored.
- `diffSummary(result: NormalizeResult): string` — one line per replacement: `"Ashler" -> "Ashlr.AI" (alias, 1.00)`.

## src/core/suggest.ts
- `suggestAliases(canonical: string): string[]` — generates likely STT misspellings: split camel/dots ("Ashlr.AI" -> "Ashlr AI", "Ashler", "Ashlar"), vowel insertions for consonant clusters, drop dots/hyphens, common phoneme confusions. Deterministic, <= 8 results, never returns the canonical itself.

## src/core/harvest.ts
- `harvestRepo(root: string, opts?: HarvestOptions): Promise<HarvestCandidate[]>`
  - package/module names (package.json name+deps, pyproject, Cargo.toml, go.mod)
  - PascalCase identifiers >= 2 humps from source files (ts/js/py/go/rs/java/rb/swift/kt), exported classes/types preferred
  - git log author names (`git log --format=%an`), deduped
  - project dir name
  - README headings' proper nouns (Capitalized tokens not at sentence start)
  - Filters STOPLIST and generic identifiers (String, Error, Component...).
  - Ranks by count, returns HarvestCandidate[] with suggestedAliases from suggest.ts.
  - Never reads node_modules/dist/.git/vendor/build; caps file size 512KB; caps files scanned 5000.

## src/core/exporters/index.ts
- `exportLexicon(lexicon: Lexicon, format: ExportFormat, opts?: ExportOptions): string`
- `EXPORT_FORMATS: readonly ExportFormat[]` with descriptions map `EXPORT_FORMAT_INFO: Record<ExportFormat, { description: string; ext: string }>`
- one file per format under exporters/, each `export function export<Format>(lexicon, opts): string`.
  Formats: `wispr`, `superwhisper`, `whisper-prompt`, `macos`, `claude-md`, `csv`, `json`, `deepgram`, `espanso`,
  `assemblyai` (`{ word_boost, boost_param: "high" }`), `azure` (`{ phraseList }`), `google` (`{ adaptation: { phraseSets: [{ phrases: [{ value, boost }] }] } }`, boost 20 for brand/person/product else 10),
  `openai` (delegates to whisper-prompt), `text` (`Canonical: alias1, alias2`, sorted, round-trips with the text importer), `markdown` (`- **Canonical** (category): aliases`).
- `src/mcp/server.ts` keeps an `EXPORT_FORMAT_VALUES` tuple with a compile-time exhaustiveness check; extend it whenever `ExportFormat` grows.

## src/core/importers/index.ts
Pure, no IO.
- `type ImportFormat = 'wispr' | 'superwhisper' | 'macos' | 'csv' | 'espanso' | 'text' | 'json' | 'auto'`, `ConcreteImportFormat = Exclude<ImportFormat, 'auto'>`
- `IMPORT_FORMATS: readonly ImportFormat[]`, `IMPORT_FORMAT_INFO: Record<ImportFormat, { description: string }>`, `isImportFormat(value): value is ImportFormat`
- `importLexicon(content: string, format: ImportFormat, opts?: { source?: TermSource; filename?: string }): ImportResult`
  - `ImportResult = { terms: Term[]; format: ConcreteImportFormat; skipped: { line: number; reason: string }[] }` (`line` is 1-based; an entry index for JSON inputs).
  - rows are merged by canonical (case-insensitive, first spelling wins); aliases deduped case-insensitively, an alias equal to the canonical dropped; `source` defaults to `'import'`; blank canonicals are reported in `skipped`.
  - throws a readable Error on unparseable input (bad JSON/YAML/plist) or an unknown format.
- `detectImportFormat(content, filename?): ConcreteImportFormat` — plist header -> macos; JSON array of `{original,replacement}` (or `{replacements}`) -> superwhisper; JSON/YAML with `terms` -> json; YAML `matches:` -> espanso; `word,replacement` header -> wispr; header containing `canonical` -> csv; then the extension (`.plist`, `.csv` -> wispr, `.yml`) ; else text. Unknown JSON shapes throw.
- one file per format: `parseWisprImport`, `parseSuperwhisperImport`, `parseMacosImport` (regex plist scanner, entities decoded), `parseCsvImport` (`canonical,alias,category,phonetic`, header-ordered, unknown category dropped), `parseEspansoImport` (skips `vars`, regex and multi-line matches; strips a leading `:`/`;` trigger prefix), `parseTextImport` (`Canonical`, `Canonical: a, b`, `Canonical = a | b`, `#` comments), `parseJsonImport` (parseLexicon; drops scope/createdAt/hits). Each returns `RawImport = { rows: ImportRow[]; skipped }`.
- `importers/csv-parse.ts`: `parseCsv(content): { line, fields }[]` (RFC 4180 quoting, CRLF, BOM), shared by wispr and csv.

## src/cli/cmd-import.ts
- `registerImportCommands(program, io)` adds `import <file> [format]` (`-` reads stdin) with `--format <f>` (default auto), `--project`, `--dry-run`, `--source <s>`, `--category <c>` (applied to terms lacking one), `--json`.
- `runImport(file, opts: ImportCliOptions, io, readInput?): Promise<number>` — the testable handler. Prints a canonical/aliases/status table and `imported N terms (M new, K merged, S skipped)`; skipped reasons go to stderr; unknown format lists `IMPORT_FORMAT_INFO` and returns 1. `--dry-run` reads the target file to label new vs merged without writing.

## src/mcp/server.ts  (bin: lexicon-mcp)
stdio MCP server, name "lexicon". Tools:
- `normalize_transcript({ text, dryRun? })` -> { output, changed, replacements[], summary }
- `add_term({ canonical, aliases?, phonetic?, category?, notes?, never?, scope? })` — if aliases omitted, uses suggestAliases.
- `remove_term({ canonical })`
- `list_terms({ query?, category? })`
- `harvest_repo({ path?, limit?, minCount?, add? })` — returns candidates; when add:true writes them to the harvested repo's project lexicon.
- `export_lexicon({ format })`
Resources:
- `lexicon://me` (text/markdown) — the claude-md export of the merged lexicon (what the agent should always read)
- `lexicon://json`
Prompt:
- `voice-context` — system-style snippet telling the agent to prefer canonical forms.
Server must instantiate once, read lexicon fresh on every call (file may change), log to stderr only.

## src/hooks/user-prompt-submit.ts (bin via `lexicon hook`; bundled as `plugin/hook.mjs`)
Claude Code hook entry for two events, dispatched on the payload's `hook_event_name`. Exit 0 always; every error path prints nothing (message to stderr). Must finish < 200ms for a 1KB prompt.
- `runHook(input: string, opts?: HookOptions): Promise<string>` — the dispatcher `main()` uses. `SessionStart` -> `runSessionStartHook`; anything else (including a missing event name) -> `runUserPromptSubmitHook`. Returns the JSON to print or `''` (print nothing).
- `runUserPromptSubmitHook(input, opts?)` — reads `{ prompt, cwd, ... }`, runs normalize, and prints
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<parts joined by \n>"}}` when any part exists. Parts, in order: the corrections note (`formatAdditionalContext`: diff summary + corrected prompt) when normalize changed something; the correction note (`formatCorrectionNote`) when `parseCorrection(prompt)` yields both sides non-empty: `The user is correcting a spelling: "<heard>" should be "<meant>". Call the lexicon learn_correction tool with these values, then continue.` (the hook never writes to the lexicon); the skipped-project note (`formatSkippedProjectNote`, one line naming the path, never the contents) when `loadLexicon` reports `skippedProject`.
- `runSessionStartHook(input, opts?)` — when the merged lexicon has >= 1 term prints
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<claude-md export>[\n<skipped-project note>]"}}`, else `''`. The export is capped by `truncateSessionContext(text, max = SESSION_CONTEXT_MAX_CHARS /* 4000 */)`: table rows are dropped from the end and a line `... N more terms; read the lexicon://me resource for the full list.` is inserted before the footer (text without a table is hard-cut with `...`).
- `HookEventName = 'UserPromptSubmit' | 'SessionStart'`, `HookOptions { cwd? }`.
- `hooks/hooks.json` registers `plugin/hook.mjs` for both events; `lexicon install-claude --apply` merges both into `~/.claude/settings.json`.

## plugin/ (committed esbuild bundles)
- `plugin/mcp-server.mjs` (<- `src/mcp/server.ts`) and `plugin/hook.mjs` (<- `src/hooks/user-prompt-submit.ts`): ESM, Node >= 20, every dependency inlined, unminified, shebang preserved, prefixed with a `createRequire` banner so bundled CommonJS (`yaml`) can `require` builtins. Built by `scripts/build-bundle.mjs` (`npm run build:bundle`); `npm run check:bundle` fails when they differ from `src/`. `.mcp.json` and `hooks/hooks.json` point at them via `${CLAUDE_PLUGIN_ROOT}`; `dist/` stays untracked.
- `src/mcp/server.ts` `readPackageVersion` looks for `package.json` two levels up (dist/src) then one level up (plugin/), accepting only `@ashlr/lexicon`.

## src/cli/index.ts  (bin: lexicon)
commander. Commands: `init`, `add <canonical> [aliases...]` (`--phonetic`, `--category`, `--notes`, `--project`, `--suggest`, `--never <word...>`), `remove <canonical>`, `list`, `normalize [text]` (stdin if omitted, `--json`, `--diff`),
`harvest [path]` (`--add`, `--limit`, `--min-count`, `--json`), `export <format>` (`--out`), `path`, `doctor`, `mcp` (starts server), `hook` (runs hook), `daemon` (clipboard watcher; `--once`, `--paste`, `--backend`, `--which`), `install-claude` (prints/apply `claude mcp add` + hook config), `install [client]` (see `src/cli/cmd-install.ts`).
`trust [path]` (`--list`), `untrust [path]` (cmd-trust.ts). `normalize --include-untrusted`. `list`, `normalize`, `doctor` warn on stderr when a project lexicon was skipped.

### src/cli/commands.ts: Claude Code integration helpers
- `HOOK_EVENTS: readonly string[]` = `['UserPromptSubmit', 'SessionStart']`.
- `resolveIntegrationPaths(cliDir?): IntegrationPaths { server; hook; bundled }` — `<root>/plugin/mcp-server.mjs` + `<root>/plugin/hook.mjs` when both exist (root = `cliDir/../..`), else `dist/mcp/server.js` + `dist/hooks/user-prompt-submit.js`. `cmd-install.ts` `resolveServerPath` delegates to it. `runInstallClaude` prints and registers these paths and merges hooks for every `HOOK_EVENTS` entry.
- `hookConfigFor(command, timeout = 5, events = ['UserPromptSubmit'])`, `mergeHookIntoSettings(settings, command, timeout = 5, events = ['UserPromptSubmit'])` — one group per event; an event that already has the identical command is skipped; `changed` is true when any event was added.
- `runDoctor` deps gained `settingsPath?` (default `~/.claude/settings.json`) and `installedPluginsPath?` (default `~/.claude/plugins/installed_plugins.json`). Checks: `findInstalledLexiconPlugin(settings, installedPlugins): string | undefined` (a `lexicon@<marketplace>` key under `installed_plugins.json` `plugins`, or a true `enabledPlugins` entry in settings.json) -> `✓ lexicon plugin installed as <id>`; otherwise per event `settingsHasLexiconHook(settings, event)` (a hook command matching `user-prompt-submit.js`, `plugin/hook.mjs` or `lexicon`) -> `✓` or the warning `! <event> hook not found in <settings> (fine if you use the plugin; otherwise run: lexicon install-claude --apply)`. An unparseable settings.json is a warning. When the plugin is installed, a missing `claude mcp list` entry is a warning instead of a failure.

## src/cli/cmd-install.ts
`lexicon install [client]` (`install-claude` stays as-is in index.ts). Registered via `registerInstallCommands(program: Command, io: IO): void`.
- `INSTALL_CLIENTS: readonly ['claude','codex','cursor','windsurf','gemini','claude-desktop','vscode','generic']`, `InstallClient` union.
- `runInstall(client: string | undefined, opts: InstallOptions, io: IO, deps?: InstallDeps): Promise<number>`
  - `InstallOptions extends CommonOptions { apply?; scope?: 'user'|'project' (string, validated); project?; home? }`; `InstallDeps { platform?; env?; cliDir? }` (test hooks, like `DoctorDeps`).
  - `claude` delegates to `runInstallClaude` (scope passed through; `--home` maps to `settingsPath`). `generic` / no client prints the `mcpServers` snippet and the client list. Unknown client throws.
  - Server path is `path.resolve(cliDir ?? dirname(import.meta.url), '../mcp/server.js')` (`resolveServerPath`).
  - Without `--apply` prints the file and the exact block/JSON that would be merged. With `--apply` reads the file (missing => `{}` / empty), merges, writes 2-space JSON + trailing newline (or TOML text), reports `created` / `updated` / `nothing changed`. Never clobbers unrelated keys or other servers; a stale `lexicon` entry is replaced; invalid JSON or a non-object server map throws without writing.
  - Always ends with the hint `lexicon export claude-md >> <rules file>` (CLAUDE.md, AGENTS.md, .cursor/rules/lexicon.mdc, .windsurfrules, GEMINI.md, copilot-instructions.md).
- `configPathFor(client, ctx: { home, cwd, platform, env, project }): string` — codex `~/.codex/config.toml` | `./.codex/config.toml`; cursor `~/.cursor/mcp.json` | `./.cursor/mcp.json`; windsurf `~/.codeium/windsurf/mcp_config.json`; gemini `~/.gemini/settings.json` | `./.gemini/settings.json`; claude-desktop macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, win32 `%APPDATA%/Claude/...`, else `~/.config/Claude/...`; vscode macOS `~/Library/Application Support/Code/User/mcp.json`, win32 `%APPDATA%/Code/User/mcp.json`, linux `~/.config/Code/User/mcp.json`, project `./.vscode/mcp.json`. windsurf and claude-desktop throw on `--project`.
- `mergeServerIntoJson(current: unknown, key: 'mcpServers'|'servers', entry): { next, changed }` pure, never mutates input. vscode uses `servers` + `{ type: 'stdio', command, args }`; everyone else `mcpServers` + `{ command: 'node', args: [serverPath] }`.
- `codexBlock(entry): string` => `[mcp_servers.lexicon]\ncommand = "node"\nargs = ["<abs server.js>"]` (strings escaped with JSON.stringify, valid TOML basic strings). `upsertTomlTable(text, header, block): { next, changed }` replaces the table from its header line up to the next `[` header (sub-tables such as `[mcp_servers.lexicon.env]` survive), else appends after a blank line. No TOML library.

## src/daemon/clipboard-backends.ts
- `interface ClipboardBackend { name: string; description?: string; read(): Promise<string>; write(text: string): Promise<void> }`. `read` resolves `''` for an empty or non-text clipboard (the tool exits non-zero or prints nothing); a missing binary (`ENOENT`) or a display/session error still rejects.
- `type ClipboardExec = (cmd, args, stdin?) => Promise<string>`; `defaultClipboardExec` spawns without a shell (writes ignore stdout and resolve on exit so `xclip -i`'s forked child cannot hold the pipe). `ExecError { cmd, exitCode, stderr }`.
- Backends (`ClipboardBackendName = 'pbcopy' | 'wl' | 'xclip' | 'xsel' | 'powershell'`, `createClipboardBackend(name, exec?)`): `pbpaste`/`pbcopy`; `wl-paste --no-newline`/`wl-copy`; `xclip -selection clipboard -o`/`-i`; `xsel --clipboard --output`/`--input`; `powershell -NoProfile -NonInteractive -Command` with `Get-Clipboard -Raw` written via `[Console]::Out.Write` (no trailing newline, UTF-8) and `Set-Clipboard -Value` of `[Console]::In.ReadToEnd()` from stdin. The PowerShell backend normalizes CRLF to `\n` on read and restores CRLF on the next write when the read had it.
- `detectClipboardBackend(platform?, env?, which?, exec?)`: darwin -> pbcopy (both binaries on PATH); linux/BSD -> wl when `WAYLAND_DISPLAY` is set and `wl-paste` + `wl-copy` exist, else xclip, else xsel, else throws with `sudo apt install wl-clipboard` / `xclip` hints; win32 -> powershell (falls back to `pwsh`); anything else throws. `which` defaults to `findOnPath`.
- `findOnPath(bin, { env?, platform?, exists? })`: splits `PATH` (`;` on win32, `:` elsewhere), on win32 tries each `PATHEXT` extension (default `.COM;.EXE;.BAT;.CMD`, upper then lower case) then the bare name, else requires `X_OK`. No process spawned.

## src/daemon/clipboard.ts
Clipboard watcher for macOS, Linux and Windows using the backends above; read/write stay injectable (`read`/`write` options win over `backend`/detection; a single injected function is completed from the detected backend).
- `runClipboardDaemon(opts)` (loop): poll every 250ms (configurable), if text changed since last seen and normalize changes it, write back, print diff to stdout. Loop guard: remember last written value to avoid rewriting own output. Lexicon re-read at most every 5s. Graceful SIGINT/SIGTERM/`signal`.
- `runClipboardOnce(opts): Promise<ClipboardOnceResult>` (`--once`): read once, normalize, write back if changed (unless `dryRun`), print `N correction(s)` + diff or `no changes` (`quiet` silences), return `{ changed, written, corrections, pasted }`. With `paste: true` on darwin runs `osascript -e 'tell application "System Events" to keystroke "v" using command down'` (`PASTE_APPLESCRIPT`, injectable `sendPaste`) whether or not the text changed, and throws with an Accessibility hint if that fails; off darwin it prints a one-line notice to stderr and skips. Empty/oversized (> `MAX_CLIPBOARD_CHARS` = 20000)/letterless text is reported as no changes.
- `runDaemonCommand(opts): Promise<number>`: `--which` prints `clipboard backend: <name> (<description>)` (+ `--paste` availability) and returns 0, or 1 with the detection error; `--paste` without `--once` throws; `--once` runs once; else loops. `parseBackendName(value)` validates `--backend`. `main(argv)` is the standalone entry.
- Options shared by both modes: `dryRun`, `quiet`, `cwd`, `read`, `write`, `backend`, `platform`, `env`, `exec`, `out`, `err`.

## Implementation notes (deviations agreed during build)
- `harvest.ts` exports `HARVEST_STOPLIST` (README-word filter), distinct from `matcher.ts` `STOPLIST` (prose guard), to avoid an `export *` collision in `core/index.ts`.
- Phonetic confidence is `0.9 * (1 - 0.25 * lenDiff/maxLen)` (see `PHONETIC_LENGTH_WEIGHT` in matcher.ts); the literal length formula rejected every headline case.
- The fuzzy pass bounds each candidate with `fastest-levenshtein` (bit-parallel) before running the O(n*m) OSA distance, since OSA >= Levenshtein / 2; `similarity()` itself is always OSA up to 40 chars so its value does not depend on the caller.
- `settings.protectedWords` blocks all passes including explicit aliases; the built-in `STOPLIST` only blocks phonetic/fuzzy (explicit aliases win). `term.never` blocks all passes for that term.
- `caseSensitive` terms skip the phonetic pass.
- `dryRun` returns `changed: false`; callers inspect `replacements.length`.
- `normalize` CLI command always exits 0 and passes input through on lexicon load errors.
- `doctor` has three tiers: ✓ pass, ! warn, ✗ fail (exit 1).
- `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT:-.}` so it works both installed as a plugin and when the repo itself is the cwd.

## src/core/learn.ts
- `parseCorrection(text): Correction | undefined` — table-driven detection of "it's X not Y", "I said X not Y", "Y -> X", "replace Y with X", quoted forms.
- `learnCorrection({ heard, meant }, opts?)` — adds `heard` as an alias of the term whose canonical/alias equals `meant`, else creates a term with source 'learned'.
- `suggestCanonicalFor(heard, lexicon)` — top 3 existing terms by similarity/phonetic key, confidence >= 0.6.

## src/core/stats.ts
- `computeStats(loaded: LoadedLexicon): LexiconStats` — counts, top 10 by hits, never-hit list, by category/source, files.

## MCP additions
- Tools `learn_correction { heard, meant, scope? }`, `suggest_canonical { heard }`, `lexicon_stats {}`.
- `list_terms` and `lexicon://me` surface `projectTrust`/`skippedProject` (path only) when a project lexicon was not loaded.
- Server passes `instructions` (read lexicon://me first, normalize dictated input, learn corrections, never rewrite code).

## src/cli/cmd-learn.ts
- `learn <heard> <meant>` / `learn --from "<sentence>"` (`--project`, `--json`), `stats` (`--json`).

## src/cli/prompt.ts
Dependency-free interactive helper over `node:readline`. No ANSI beyond bold/dim, and only when the output is a TTY.
- `interface Prompter { ask(question, opts?: { default?: string }): Promise<string>; confirm(question, def?: boolean): Promise<boolean>; choose<T>(question, choices: PromptChoice<T>[], opts?: { multi?: boolean }): Promise<T[]>; close(): void }`, `PromptChoice<T> = { label: string; value: T }`.
  - `ask`: Enter returns `opts.default` (or `''`). `confirm`: Enter returns `def` (default false), accepts y/yes/n/no.
  - `choose` single: numbered list, a number (Enter = first). Multi: every item starts selected, numbers toggle, `a` all, `n` none, Enter accepts. Empty choices resolve to `[]`.
  - A prompt whose input closes (EOF) rejects with `PromptClosedError`.
- `createPrompter(io?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Prompter` (defaults to process stdin/stdout; readline is created lazily).
- `isInteractive(): boolean` — `process.stdin.isTTY && process.stdout.isTTY`.
- `askKey(prompter, question, keys: readonly string[], def?: string): Promise<string>` — first character of the line, lower-cased, repeated until it is one of `keys`; empty line returns `def` when given.
- `splitList(input: string): string[]` — comma-separated, trimmed, empties dropped, case-insensitive dedupe (first spelling wins).
- `styler(output?): { bold(s): string; dim(s): string }`, `PromptClosedError`.

## src/cli/cmd-review.ts
Interactive workflows. Every handler takes a `Prompter` (or an injectable spawner) so tests script the answers. `InteractiveOptions extends CommonOptions { globalPath?: string }` is a test hook (no CLI flag) forwarded to the store.
- `runHarvestInteractive(candidates: readonly HarvestCandidate[], opts: HarvestInteractiveOptions, io: IO, prompter: Prompter): Promise<number>` — `opts.cwd` is the harvested root (the project lexicon written to). Checks the trust gate up front: an existing untrusted/changed `.lexicon.yaml` prints the `ProjectTrustError` message to stderr and returns 1 before any prompt; a `ProjectTrustError` thrown mid-walk does the same. Per candidate shows `[i/n] canonical  category, seen Nx`, up to three evidence entries and the suggested aliases, then asks `add? [y/n/e/c/a/q]` (Enter = y): `y` `addTerm(scope: 'project')`, `n` skip, `e` replace aliases with a comma-separated list (the canonical itself is dropped), `c` change category (re-asked until valid), `a` add this and every remaining candidate without asking, `q` stop (the rest counts as skipped). Candidates are copied before editing. Ends with `added N new terms, merged M, skipped S in <path>` and the trusted note. Called by `runHarvest` (commands.ts) when `--interactive`, or when `--add` is given on a TTY without `--yes`/`--json`; `runHarvest(root, opts, io, deps?: { isInteractive?; createPrompter? })` throws `harvest --interactive needs a terminal ...` when not a TTY and rejects `--interactive` + `--json`.
- `runReview(opts: ReviewOptions, io: IO, prompter?: Prompter): Promise<number>` — `ReviewOptions extends InteractiveOptions { neverHit?; project?; global?; category? }`. Global file by default, `--project` the project file found for cwd (error when none; `--project` + `--global` is an error). Without a prompter and not on a TTY throws `review needs a terminal ...`. A missing file or an empty selection prints a note and returns 0. An untrusted project file returns 1 with the `ProjectTrustError` message. Per term shows `[i/n] canonical  category, N hits[, source]`, aliases, phonetic and notes, then `[k/d/e/p/n/q]` (Enter = k): `k` keep, `d` delete, `e` edit aliases (comma-separated), `p` phonetic hint (empty clears), `n` notes (empty clears), `q` stop. Writes via `writeLexiconFile` once at the end only when something changed, then `refreshTrust` for a project file. Ends with `kept K, deleted D, edited E — wrote <path>` or `(nothing written)`.
- `runEdit(opts: EditOptions, io: IO, spawnEditor?: SpawnEditor, env?: NodeJS.ProcessEnv): Promise<number>` — `EditOptions extends InteractiveOptions { project? }`; `SpawnEditor = (command, args: readonly string[], filePath) => Promise<number>` (exit code), default `spawnEditorInherit` (`spawn` with `stdio: 'inherit'`). A missing global file is created empty first. Editor from `$VISUAL` then `$EDITOR`, split on whitespace (`editorCommand(env)`); none set prints the path and returns 0. After the editor exits (a non-zero code is reported on stderr and the file still checked) the file is re-read with `readLexiconFile` (which uses `parseLexicon`): on error prints the message plus `your edits are still in <path>` and returns 1 without touching the file. A project file that was trusted before the edit is re-pinned (`refreshTrust`); an untrusted one stays untrusted with a `lexicon trust` hint.
- `registerReviewCommands(program, io)` adds `review` (`--never-hit`, `--project`, `--global`, `--category <c>`) and `edit` (`--project`).

## src/cli/commands.ts interactive additions
- `AddOptions` gains `interactive?: boolean` (`-i`) and `globalPath?: string` (test hook); `runAdd(canonical, aliases, opts, io, prompter?: Prompter)`. With `-i`: when no aliases were given the suggestions become a multi-select checklist followed by `more aliases (comma-separated, Enter for none)`; then `phonetic hint` (default `--phonetic`, empty = none) and `category` (default `--category` or `other`, re-asked until valid). The `suggested aliases:` line is not printed in interactive mode. Without a prompter and not on a TTY throws `add --interactive needs a terminal ...`.
- `HarvestCliOptions` gains `interactive?`, `yes?`, `globalPath?`; see `runHarvestInteractive` above.
