# Module contract

The per-module API of `@ashlr/lexicon`, in dependency order. Every module codes against `src/core/types.ts`. Import siblings only via `../core/index.js` (ESM, `.js` suffix on relative imports, NodeNext resolution). No default exports. Node >= 20, no `any` in public signatures. Update this file when a public signature changes.

## src/core/types.ts
Dependency-free shared types.
- `TermCategory = 'brand' | 'person' | 'product' | 'acronym' | 'identifier' | 'place' | 'other'`, `TermScope = 'global' | 'project'`, `TermSource = 'user' | 'harvest:repo' | 'harvest:git' | 'harvest:package' | 'import' | 'learned'`.
- `Term { canonical; aliases: string[]; phonetic?; category?; caseSensitive?; scope?; source?; notes?; createdAt?; hits?; never?: string[] }`.
- `LexiconSettings { minConfidence?; phonetic?; fuzzy?; protectedWords?; skipCode? }`, `Lexicon { version: 1; terms: Term[]; settings? }`.
- `LexiconFile { path; scope; lexicon; exists }`, `LoadedLexicon { merged; global: LexiconFile; project?: LexiconFile; projectTrust?: 'trusted' | 'untrusted' | 'changed'; skippedProject?: LexiconFile }`.
- `MatchReason = 'alias' | 'phonetic' | 'fuzzy'`, `Replacement { start; end; original; replacement; canonical; reason; confidence }`, `NormalizeResult { input; output; replacements; changed }`, `NormalizeOptions { minConfidence?; phonetic?; fuzzy?; skipCode?; dryRun? }`.
- `HarvestCandidate { canonical; category; source; evidence: string[]; count; suggestedAliases }`, `HarvestOptions { limit?; minCount?; git?; packages?; identifiers?; ignore?: string[] }`.
- `ExportFormat` union of the 15 format names (see exporters), `ExportOptions { categories?: TermCategory[]; limit? }`.

## src/core/schema.ts
- `LexiconSchema`, `TermSchema`, `LexiconSettingsSchema`, `TermCategorySchema`, `TermScopeSchema`, `TermSourceSchema` (zod v4) mirroring types.ts.
- `parseLexicon(raw: unknown): Lexicon` throws a readable error on invalid input.
- `LIMITS`: `word` 80 (canonical, alias), `text` 200 (notes, phonetic), `aliases` 64 (aliases and `never` per term), `terms` 5000, `protectedWords` 1000. No control characters or line breaks in any field (including U+2028/U+2029 and NEL). `stripInvisible(s)` removes zero-width (U+200B to U+200F), bidi controls (U+202A to U+202E), bidi isolates (U+2066 to U+2069) and the BOM; `hasControlChars(s)`. `stripControlChars(s)` removes every control character (C0 incl. CR/LF/tab, DEL, C1 incl. NEL, U+2028/U+2029) plus everything `stripInvisible` removes, without truncating. `sanitizeForDisplay(s)` additionally strips whole ANSI escape sequences and every `\p{C}` code point and caps the result at `DISPLAY_MAX_CHARS` (200) with a trailing ellipsis; use it for anything printed to a terminal.
- `emptyLexicon(): Lexicon`.

## src/core/store.ts
- `PROJECT_FILE_NAME = '.lexicon.yaml'`, `MAX_LEXICON_BYTES` (2 MB; larger files are refused).
- `StoreOptions { cwd?; globalPath? }`, `LoadOptions extends StoreOptions { includeUntrusted? }`.
- `resolvePaths(opts?: StoreOptions): { global: string; project?: string }`
  - global: `$LEXICON_PATH` || `$XDG_CONFIG_HOME/lexicon/lexicon.yaml` || `~/.config/lexicon/lexicon.yaml` (or `opts.globalPath`).
  - project: walk up from cwd looking for `.lexicon.yaml` (stop at git root or `/`).
- `defaultProjectPath(cwd?): string` (git root, else cwd, joined with `.lexicon.yaml`).
- `readLexiconFile(path, scope): Promise<LexiconFile>` (missing file => exists:false, empty lexicon).
- `writeLexiconFile(file: LexiconFile): Promise<void>` (atomic write, mkdir -p, YAML with header comment).
- `loadLexicon(opts?: LoadOptions): Promise<LoadedLexicon>` merges global + project via `mergeLexicons(global, project?)`: project wins on canonical collision (case-insensitive), aliases unioned, settings follow the same precedence. The project file is merged only when trusted (see trust.ts) unless `includeUntrusted`; otherwise `skippedProject` holds it and `projectTrust` says why (`'untrusted' | 'changed'`).
- `addTerm(term: Term, opts?: StoreOptions & { scope?: TermScope; merge?: boolean }): Promise<{ file: LexiconFile; term: Term; created: boolean }>` merges aliases into an existing canonical when merge !== false.
- `removeTerm(canonical: string, opts?: StoreOptions & { scope?: TermScope }): Promise<boolean>`.
- `recordHits(canonicals: string[], opts?): Promise<void>` (best effort, never throws; project file consulted first so a hit is not double-counted in global).
- `findTerm(lexicon, canonical): Term | undefined` (case-insensitive), `dedupeAliases(aliases, canonical): string[]` (case-insensitive dedupe, drops the canonical itself).
- Trust gate for project-scope writes: `addTerm` (`scope: 'project'`) and `removeTerm` throw `ProjectTrustError` (`{ name: 'ProjectTrustError', path, status: 'untrusted' | 'changed' }`, message `project lexicon at <path> is untrusted | has changed since it was trusted; review it and run \`lexicon trust\` first, or write to the global lexicon instead`) when the target `.lexicon.yaml` exists and is not trusted, before reading it. A file that does not exist yet is created and registered as trusted; an already-trusted file is re-pinned after the write. `recordHits` silently skips an untrusted project file and never auto-trusts it.

## src/core/trust.ts
- Registry `<dirname(global)>/trust.json` (`TRUST_FILE_NAME`): `TrustRegistry { version: 1, trusted: { [absPath]: TrustEntry { sha256, trustedAt } } }`, keyed by symlink-resolved absolute path.
- `TrustStatus = 'trusted' | 'untrusted' | 'changed'`, `TrustListEntry extends TrustEntry { path; status: TrustStatus | 'missing' }`.
- `getTrustPath(opts?: StoreOptions): string`.
- `isTrusted(file: LexiconFile, opts?): Promise<TrustStatus>`: also 'trusted' when `LEXICON_TRUST_ALL=1` (`TRUST_ALL_ENV`, `trustAllEnabled()`), when the file is the global lexicon or sits directly in its directory (not deeper), or when it does not exist.
- `trustProject(path, opts?): Promise<TrustEntry>`, `untrustProject(path, opts?): Promise<boolean>`, `refreshTrust(path, opts?): Promise<boolean>` (re-pin only if already registered), `listTrusted(opts?): Promise<TrustListEntry[]>`.
- `readTrustRegistry(opts?)`, `writeTrustRegistry(registry, opts?)` (atomic), `hashFile(path): Promise<string | undefined>`.

## src/core/matcher.ts
Pure functions, no IO, no environment, no logging.
- `DEFAULT_MIN_CONFIDENCE = 0.82`, `STOPLIST: ReadonlySet<string>` (about 300 common English words).
- `buildIndex(lexicon: Lexicon): MatcherIndex` precomputes the alias map (`AliasEntry`, diacritics folded, `explicit` flag), phonetic keys (`PhoneticEntry`), token counts, `protectedWords` and per-term `hasExplicitAliases`.
- `findReplacements(text: string, index: MatcherIndex, opts?: NormalizeOptions): Replacement[]`
  - non-overlapping, sorted by start. Overlaps are resolved in two tiers: exact alias hits first (longest span, then earliest start), then phonetic/fuzzy hits that do not overlap an accepted span.
  - exact alias (word-boundary, multi-word, case-insensitive, diacritic-insensitive; also punctuation-stripped) => confidence 1. `caseSensitive` terms match case-sensitively and skip the phonetic pass.
  - phonetic: double metaphone of a token window equals that of an alias/canonical => confidence `0.9 * (1 - 0.25 * lenDiff/maxLen)` (`PHONETIC_LENGTH_WEIGHT`; the literal length formula rejected every headline case). Requires a key of >= 3 characters, a window of >= 4 letters unless the alias is that short; aliases whose every token is 1 or 2 letters ("j w t") get no key.
  - fuzzy: normalized optimal-string-alignment (Damerau, adjacent transpositions) similarity >= threshold => confidence = similarity. Each candidate is bounded with `fastest-levenshtein` (bit-parallel) before the O(n*m) OSA distance runs, since OSA >= Levenshtein / 2.
  - inexact windows of 2+ tokens never start or end on a function word (articles, prepositions, conjunctions, pronouns except "her", auxiliaries, wh-words).
  - a lone all-lowercase token matched inexactly against a term with explicit aliases needs confidence >= 0.88 (`ALIASED_PLAIN_WORD_MIN`).
  - a span already equal to a canonical (with or without a trailing possessive) is claimed during overlap resolution and omitted from the result.
  - a trailing possessive is preserved for every reason: the base view wins when it matches the same term or at least as confidently.
  - never rewrite: `settings.protectedWords` (blocks all passes including explicit aliases), `term.never` (blocks all passes for that term), the built-in `STOPLIST` (blocks phonetic/fuzzy only; explicit aliases win), text inside code spans/fences/URLs/emails when skipCode.
  - never rewrite tokens shorter than 3 characters via fuzzy/phonetic (exact alias only).
- `phoneticKey(s: string): string` (double metaphone primary, alpha-only).
- `similarity(a: string, b: string): number` 0..1; optimal string alignment distance up to 40 characters, plain Levenshtein beyond, so its value does not depend on the caller.

## src/core/normalize.ts
- `normalize(text: string, lexicon: Lexicon, opts?: NormalizeOptions): NormalizeResult` applies findReplacements, preserves surrounding whitespace/punctuation, writes the canonical exactly as stored. `dryRun` returns `changed: false` with the candidate `replacements`; callers inspect `replacements.length`.
- `diffSummary(result: NormalizeResult): string` one line per replacement: `"Ashler" -> "Ashlr.AI" (alias, 1.00)`.

## src/core/suggest.ts
- `suggestAliases(canonical: string): string[]` generates likely STT misspellings: split camel/dots ("Ashlr.AI" -> "Ashlr AI", "Ashler", "Ashlar"), vowel insertions for consonant clusters, drop dots/hyphens, common phoneme confusions. Deterministic, <= 8 results, never returns the canonical itself.

## src/core/learn.ts
- `Correction { heard; meant }` (`heard` may be empty when the sentence only names the intended spelling; the caller fills it from context), `LearnResult { term; created; file; aliasAdded }`, `CanonicalSuggestion { term; confidence }`, `MAX_CORRECTION_LENGTH = 60`.
- `parseCorrection(text): Correction | undefined` table-driven detection; `CORRECTION_EXAMPLES` holds one example per pattern: "it's X, not Y" (also spelled/spelt/written/called), "I said X not Y", "I meant X not Y", `"X" not "Y"` (quoted only), "not Y, X", "replace Y with X", "Y -> X" (also `=>`, `→`), "that/this/it should be X", "Y should be X", "spelled X". Sides may be double-quoted, curly-quoted, backticked or bare (1 to 4 words); bare sides must look like a name for the `replace` and `Y should be` forms; a side made only of stoplist words is rejected.
- `learnCorrection(c: Correction, opts?: StoreOptions & { scope? }): Promise<LearnResult)` adds `heard` as an alias of the term whose canonical or alias equals `meant` (written to that term's file unless `scope` is given), else creates a term `meant` with `heard` plus `suggestAliases(meant)` and `source: 'learned'`. Throws on an empty side, sides over 60 characters, or identical spellings. No stoplist check: user intent wins.
- `suggestCanonicalFor(heard, lexicon): CanonicalSuggestion[]` top 3 existing terms by max(similarity, phonetic-key match ? 0.9 : 0), confidence >= 0.6, exact alias/canonical = 1.

## src/core/stats.ts
- `TOP_TERMS = 10`, `NEVER_HIT_CAP = 20`.
- `computeStats(loaded: LoadedLexicon): LexiconStats { termCount; aliasCount; totalHits; topTerms: { canonical; hits }[]; neverHit: string[]; byCategory; bySource; files: { path; scope; terms }[] }`.

## src/core/harvest.ts
- `harvestRepo(root: string, opts?: HarvestOptions): Promise<HarvestCandidate[]>`
  - package/module names (package.json name + deps, pyproject, Cargo.toml, go.mod)
  - PascalCase identifiers >= 2 humps from source files (ts/js/py/go/rs/java/rb/swift/kt), exported classes/types preferred
  - git log author names (`git log --format=%an`, 5s timeout), deduped
  - project dir name
  - README headings' proper nouns (capitalised tokens not at sentence start)
  - filters `HARVEST_STOPLIST` (README-word filter, distinct from matcher `STOPLIST` to avoid an `export *` collision in `core/index.ts`) and generic identifiers (String, Error, Component, ...).
  - ranks by count, returns candidates with `suggestedAliases` from suggest.ts.
  - never reads node_modules/dist/.git/vendor/build (plus `opts.ignore`); caps file size 512 KB; caps files scanned 5000.

## src/core/importers/index.ts
Pure, no IO.
- `ImportFormat = 'wispr' | 'superwhisper' | 'macos' | 'csv' | 'espanso' | 'text' | 'json' | 'auto'`, `ConcreteImportFormat = Exclude<ImportFormat, 'auto'>`.
- `IMPORT_FORMATS: readonly ImportFormat[]`, `IMPORT_FORMAT_INFO: Record<ImportFormat, { description }>`, `isImportFormat(value): value is ImportFormat`.
- `importLexicon(content: string, format: ImportFormat, opts?: ImportOptions { source?: TermSource; filename? }): ImportResult { terms: Term[]; format: ConcreteImportFormat; skipped: { line: number; reason: string }[] }` (`line` is 1-based; an entry index for JSON inputs). Rows are merged by `mergeRows(rows, source?)`: one term per canonical (case-insensitive, first spelling wins), aliases deduped case-insensitively, an alias equal to the canonical dropped, `source` defaults to `'import'`, blank canonicals reported in `skipped`. Throws a readable Error on unparseable input or an unknown format.
- `detectImportFormat(content, filename?): ConcreteImportFormat`: plist header -> macos; JSON array of `{original,replacement}` (or `{replacements}`) -> superwhisper; JSON/YAML with `terms` -> json; YAML `matches:` -> espanso; `word,replacement` header -> wispr; header containing `canonical` -> csv; then the extension (`.plist` -> macos, `.csv` -> wispr, `.yml`/`.yaml` -> espanso); else text. JSON of an unknown shape throws.
- One file per format, each returning `RawImport { rows: ImportRow[]; skipped: ImportSkip[] }` (`importers/shared.ts`): `parseWisprImport`, `parseSuperwhisperImport`, `parseMacosImport` (regex plist scanner, entities decoded), `parseCsvImport` (`canonical,alias,category,phonetic`, header-ordered, unknown category dropped), `parseEspansoImport` (skips `vars`, regex and multi-line matches; strips a leading `:`/`;` trigger prefix), `parseTextImport` (`Canonical`, `Canonical: a, b`, `Canonical = a | b`, `#` comments), `parseJsonImport` (parseLexicon; drops scope/createdAt/hits).
- `importers/csv-parse.ts`: `parseCsv(content): CsvRecord { line; fields }[]` (RFC 4180 quoting, CRLF, BOM), shared by wispr and csv.

## src/core/exporters/index.ts
- `exportLexicon(lexicon: Lexicon, format: ExportFormat, opts?: ExportOptions): string`.
- `EXPORT_FORMATS: readonly ExportFormat[]` (15), `EXPORT_FORMAT_INFO: Record<ExportFormat, { description; ext }>`, `isExportFormat(value)`.
- One file per format, each `export function export<Format>(lexicon, opts): string`, ordered by `sortByImportance()` from `shared.ts`: `wispr` (CSV word,replacement), `superwhisper` (replacements JSON), `whisper-prompt` (one line, `WHISPER_PROMPT_DEFAULT_LIMIT` 100 terms), `macos` (Text Replacement plist), `claude-md` (markdown table under `CLAUDE_MD_HEADING = '## Voice lexicon'`; `|` and every kind of line break escaped in cells), `csv` (canonical,alias), `json` (raw lexicon), `deepgram` (keywords with boost), `espanso` (match YAML), `assemblyai` (`{ word_boost, boost_param: "high" }`), `azure` (`{ phraseList }`), `google` (`{ adaptation: { phraseSets: [{ phrases: [{ value, boost }] }] } }`, boost 20 for brand/person/product else 10), `openai` (delegates to whisper-prompt), `text` (`Canonical: alias1, alias2`, sorted, round-trips with the text importer), `markdown` (`- **Canonical** (category): aliases`).
- `src/mcp/server.ts` keeps an `EXPORT_FORMAT_VALUES` tuple with a compile-time exhaustiveness check; extend it whenever `ExportFormat` grows.

## src/core/index.ts
Re-exports everything above (`types`, `schema`, `store`, `trust`, `matcher`, `normalize`, `harvest`, `exporters`, `importers`, `suggest`, `learn`, `stats`). The only cross-module import path; also the package entry point (`main` / `exports["."]`).

## src/mcp/server.ts  (bin: lexicon-mcp; bundled as plugin/mcp-server.mjs)
- `createServer(opts?: ServerOptions { cwd? }): McpServer`, `main()`. Server name `lexicon`, stdio transport, version from `readPackageVersion()` (looks for `package.json` two levels up for dist/src, then one level up for plugin/, accepting only `@ashlr/lexicon`). Instantiated once; reads the lexicon fresh on every call; logs to stderr only. Sends `SERVER_INSTRUCTIONS` at initialize (read lexicon://me first, normalize dictated input, learn corrections, suggest before guessing, never rewrite code).
- Every tool body runs inside `guarded()`, which turns a thrown error into an `isError` result. Tools:
  - `normalize_transcript({ text, dryRun?, minConfidence? })` -> `{ output, changed, replacements[], summary }`; on a real change calls `recordHits` for the matched canonicals (best effort).
  - `add_term({ canonical, aliases?, phonetic?, category?, notes?, never?, scope? })` -> `{ term, path, created }`; if aliases omitted, uses `suggestAliases`.
  - `remove_term({ canonical, scope? })` -> `{ canonical, removed }`.
  - `list_terms({ query?, category? })` -> `{ terms, counts: { matched, total, global, project }, paths, projectTrust?, skippedProject?, note? }` (skipped file reported by path only).
  - `harvest_repo({ path?, limit?, minCount?, add? })` -> `{ root, candidates, count, added?, failures? }`; with `add: true` writes to the harvested repo's own project lexicon (`cwd: root`); a `ProjectTrustError` is surfaced once as the tool error instead of per candidate.
  - `export_lexicon({ format, categories?, limit? })` -> the export as text.
  - `learn_correction({ heard, meant, scope? })` -> `{ term, path, created, aliasAdded, summary }`.
  - `suggest_canonical({ heard })` -> `{ heard, suggestions: { canonical, confidence, aliases, category? }[] }`.
  - `lexicon_stats({})` -> `LexiconStats`.
- Resources: `lexicon://me` (text/markdown; the claude-md export, plus one line naming a skipped untrusted or changed project file), `lexicon://json` (application/json; the merged lexicon).
- Prompt: `voice-context` (the claude-md export followed by `VOICE_CONTEXT_INSTRUCTION`).

## src/hooks/user-prompt-submit.ts  (bin via `lexicon hook`; bundled as plugin/hook.mjs)
Claude Code hook entry for two events, dispatched on the payload's `hook_event_name`. Exit 0 always; every error path prints nothing (message to stderr). Must finish < 200ms for a 1KB prompt.
- `HookEventName = 'UserPromptSubmit' | 'SessionStart'`, `HookOptions { cwd? }`, `SESSION_CONTEXT_MAX_CHARS = 4000`.
- `runHook(input: string, opts?: HookOptions): Promise<string>` is the dispatcher `main()` uses: `SessionStart` -> `runSessionStartHook`; anything else (including a missing event name) -> `runUserPromptSubmitHook`. Returns the JSON to print or `''` (print nothing).
- `runUserPromptSubmitHook(input, opts?)` reads `{ prompt, cwd, ... }`, runs normalize, and prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<parts joined by \n>"}}` when any part exists. Parts, in order: the corrections note (`formatAdditionalContext(result)`: diff summary + corrected prompt) when normalize changed something; the correction note (`formatCorrectionNote(correction)`) when `parseCorrection(prompt)` yields both sides non-empty: `The user is correcting a spelling: "<heard>" should be "<meant>". Call the lexicon learn_correction tool with these values, then continue.` (the hook never writes to the lexicon); the skipped-project note (`formatSkippedProjectNote(loaded)`, one line naming the path, never the contents) when `loadLexicon` reports `skippedProject`.
- `runSessionStartHook(input, opts?)` when the merged lexicon has >= 1 term prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<claude-md export>[\n<skipped-project note>]"}}`, else `''`. The export is capped by `truncateSessionContext(text, max = SESSION_CONTEXT_MAX_CHARS)`: table rows are dropped from the end and a line `... N more terms; read the lexicon://me resource for the full list.` is inserted before the footer (text without a table is hard-cut with `...`). Untrusted content never appears: the skipped file contributes its path only.
- `hooks/hooks.json` registers `plugin/hook.mjs` for both events; `lexicon install-claude --apply` merges both into `~/.claude/settings.json`.

## plugin/ (committed esbuild bundles)
- `plugin/mcp-server.mjs` (<- `src/mcp/server.ts`) and `plugin/hook.mjs` (<- `src/hooks/user-prompt-submit.ts`): ESM, Node >= 20, every dependency inlined, unminified, shebang preserved, prefixed with a `createRequire` banner so bundled CommonJS (`yaml`) can `require` builtins. Built by `scripts/build-bundle.mjs` (`npm run build:bundle`); `npm run check:bundle` fails when they differ from `src/`. `.mcp.json` and `hooks/hooks.json` point at them via `${CLAUDE_PLUGIN_ROOT}` (`.mcp.json` uses `${CLAUDE_PLUGIN_ROOT:-.}` so it also works when the repo itself is the cwd); `dist/` stays untracked.

## src/cli/index.ts  (bin: lexicon)
commander wiring only; handlers live in `commands.ts` and `cmd-*.ts`. Global `--cwd <dir>`. Commands defined here: `init` (`--project`), `add <canonical> [aliases...]` (`--phonetic`, `--category`, `--notes`, `--project`, `--suggest`, `-i/--interactive`, `--never <word...>`), `remove|rm <canonical>` (`--project`), `list|ls` (`--json`, `--category`, `--query`), `normalize [text...]` (stdin if omitted; `--json`, `--diff`, `--dry-run`, `--min-confidence`, `--no-phonetic`, `--no-fuzzy`, `--include-untrusted`), `harvest [path]` (`--limit`, `--min-count`, `--add`, `-i/--interactive`, `--yes`, `--json`), `export [format]` (`--out`, `--category <c...>`, `--limit`), `path`, `doctor`, `mcp`, `hook`, `daemon` (`--once`, `--paste`, `--interval`, `--dry-run`, `--quiet`, `--backend`, `--which`), `install-claude` (`--apply`, `--scope`). Then `registerImportCommands`, `registerInstallCommands`, `registerTrustCommands`, `registerLearnCommands`, `registerReviewCommands` add `import`, `install`, `trust`, `untrust`, `learn`, `stats`, `review`, `edit`. 21 commands in total; `docs/CLI.md` is generated from their `--help`.

## src/cli/commands.ts
- `IO { stdout; stderr }`, `processIO`, `CommonOptions { cwd? }`, `renderTable(rows, headers)`, `readStdin(maxBytes?)`, `whichBin(name)`.
- Handlers: `runInit(opts: InitOptions)`, `runAdd(canonical, aliases, opts: AddOptions, io, prompter?)`, `runRemove`, `runList`, `runNormalize` (`buildNormalizeOptions`; always exits 0 and passes input through on lexicon load errors), `runHarvest(root, opts: HarvestCliOptions, io, deps?: HarvestDeps { isInteractive?; createPrompter? })`, `runExport`, `runPath`, `runDoctor(opts, io, deps?: DoctorDeps)`, `runInstallClaude(opts: InstallClaudeOptions, io, deps?: InstallClaudeDeps)`. `list`, `normalize` and `doctor` warn on stderr when a project lexicon was skipped.
- `runAdd` with `-i` (`AddOptions.interactive`): when no aliases were given the suggestions become a multi-select checklist followed by `more aliases (comma-separated, Enter for none)`; then `phonetic hint` (default `--phonetic`, empty = none) and `category` (default `--category` or `other`, re-asked until valid). Without a prompter and not on a TTY throws `add --interactive needs a terminal ...`. `AddOptions.globalPath` is a test hook.
- `runHarvest`: `--interactive`, or `--add` on a TTY without `--yes`/`--json`, hands the candidates to `runHarvestInteractive` (cmd-review.ts); otherwise prints the table and, with `--add`, adds every candidate. `--interactive` off a TTY throws `harvest --interactive needs a terminal ...`; `--interactive` + `--json` is rejected.
- `runDoctor`: three tiers, `✓` ok, `!` warn, `✗` fail (exit 1), `·` info. Checks both lexicon files, trust status, term conflicts, the Claude Code wiring and the clipboard backend. `DoctorDeps` gains `settingsPath?` (default `~/.claude/settings.json`) and `installedPluginsPath?` (default `~/.claude/plugins/installed_plugins.json`). `findInstalledLexiconPlugin(settings, installedPlugins): string | undefined` (a `lexicon@<marketplace>` key under `installed_plugins.json` `plugins`, or a true `enabledPlugins` entry) -> `✓ lexicon plugin installed as <id>`; otherwise per event `settingsHasLexiconHook(settings, event)` (a hook command matching `user-prompt-submit.js`, `plugin/hook.mjs` or `lexicon`) -> `✓` or the warning `! <event> hook not found in <settings> (fine if you use the plugin; otherwise run: lexicon install-claude --apply)`. An unparseable settings.json is a warning. When the plugin is installed, a missing `claude mcp list` entry is a warning instead of a failure. A missing clipboard backend is a warning.
- Claude Code integration helpers: `HOOK_EVENTS: readonly string[] = ['UserPromptSubmit', 'SessionStart']`; `resolveIntegrationPaths(cliDir?): IntegrationPaths { server; hook; bundled }` returns `<root>/plugin/mcp-server.mjs` + `<root>/plugin/hook.mjs` when both exist (root = `cliDir/../..`), else `dist/mcp/server.js` + `dist/hooks/user-prompt-submit.js`; `hookConfigFor(command, timeout = 5, events = ['UserPromptSubmit'])`, `mergeHookIntoSettings(settings, command, timeout = 5, events = ['UserPromptSubmit'])` (one group per event; an event that already has the identical command is skipped; `changed` is true when any event was added); `CLAUDE_MD_SNIPPET`. `runInstallClaude` prints the three steps and, with `--apply`, runs `claude mcp add --scope <user|project> lexicon -- node "<server>"` and merges hooks for every `HOOK_EVENTS` entry (paths quoted).

## src/cli/prompt.ts
Dependency-free interactive helper over `node:readline`. No ANSI beyond bold/dim, and only when the output is a TTY.
- `Prompter { ask(question, opts?: { default? }): Promise<string>; confirm(question, def?): Promise<boolean>; choose<T>(question, choices: PromptChoice<T>[], opts?: { multi? }): Promise<T[]>; close(): void }`, `PromptChoice<T> = { label; value }`.
  - `ask`: Enter returns `opts.default` (or `''`). `confirm`: Enter returns `def` (default false), accepts y/yes/n/no.
  - `choose` single: numbered list, a number (Enter = first). Multi: every item starts selected, numbers toggle, `a` all, `n` none, Enter accepts. Empty choices resolve to `[]`.
  - A prompt whose input closes (EOF) rejects with `PromptClosedError`.
- `createPrompter(io?: PrompterIO { input?; output? }): Prompter` (defaults to process stdin/stdout; readline is created lazily).
- `isInteractive(): boolean` (`process.stdin.isTTY && process.stdout.isTTY`).
- `askKey(prompter, question, keys: readonly string[], def?): Promise<string>` first character of the line, lower-cased, repeated until it is one of `keys`; empty line returns `def` when given.
- `splitList(input): string[]` comma-separated, trimmed, empties dropped, case-insensitive dedupe (first spelling wins).
- `styler(output?): Styler { bold(s); dim(s) }`, `PromptClosedError`.

## src/cli/cmd-import.ts
- `MAX_IMPORT_BYTES` (8 MB; files and stdin over it are refused before parsing).
- `registerImportCommands(program, io)` adds `import <file> [format]` (`-` reads stdin) with `--format <f>` (default auto), `--project`, `--dry-run`, `--source <s>`, `--category <c>` (applied to terms lacking one), `--json`.
- `runImport(file, opts: ImportCliOptions, io, readInput?): Promise<number>` the testable handler. Prints a canonical/aliases/status table and `imported N terms (M new, K merged, S skipped)`; skipped reasons go to stderr; unknown format lists `IMPORT_FORMAT_INFO` and returns 1. `--dry-run` reads the target file to label new vs merged without writing. Project-scope writes go through `addTerm` and therefore the trust gate.

## src/cli/cmd-install.ts
`lexicon install [client]` (`install-claude` stays in index.ts). Registered via `registerInstallCommands(program, io)`.
- `INSTALL_CLIENTS: readonly ['claude','codex','cursor','windsurf','gemini','claude-desktop','vscode','generic']`, `InstallClient` union.
- `runInstall(client: string | undefined, opts: InstallOptions, io, deps?: InstallDeps): Promise<number>`
  - `InstallOptions extends CommonOptions { apply?; scope?: 'user'|'project' (string, validated); project?; home? }`; `InstallDeps { platform?; env?; cliDir? }` (test hooks, like `DoctorDeps`).
  - `claude` delegates to `runInstallClaude` (scope passed through; `--home` maps to `settingsPath`). `generic` / no client prints the `mcpServers` snippet and the client list. Unknown client throws.
  - Server path from `resolveServerPath(cliDir?)`, which delegates to `resolveIntegrationPaths` (bundle preferred, `dist/mcp/server.js` fallback).
  - Without `--apply` prints the file and the exact block/JSON that would be merged. With `--apply` reads the file (missing => `{}` / empty), merges, writes 2-space JSON + trailing newline (or TOML text), reports `created` / `updated` / `nothing changed`. Never clobbers unrelated keys or other servers; a stale `lexicon` entry is replaced; invalid JSON or a non-object server map throws without writing.
  - Always ends with the hint `lexicon export claude-md >> <rules file>` (CLAUDE.md, AGENTS.md, .cursor/rules/lexicon.mdc, .windsurfrules, GEMINI.md, copilot-instructions.md).
- `configPathFor(client, ctx: { home, cwd, platform, env, project }): string`: codex `~/.codex/config.toml` | `./.codex/config.toml`; cursor `~/.cursor/mcp.json` | `./.cursor/mcp.json`; windsurf `~/.codeium/windsurf/mcp_config.json`; gemini `~/.gemini/settings.json` | `./.gemini/settings.json`; claude-desktop macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, win32 `%APPDATA%/Claude/...`, else `~/.config/Claude/...`; vscode macOS `~/Library/Application Support/Code/User/mcp.json`, win32 `%APPDATA%/Code/User/mcp.json`, linux `~/.config/Code/User/mcp.json`, project `./.vscode/mcp.json`. windsurf and claude-desktop throw on `--project`. `targetFor(client, ctx)` bundles path, key and entry.
- `mergeServerIntoJson(current: unknown, key: 'mcpServers'|'servers', entry): MergeResult { next, changed }` pure, never mutates input. vscode uses `servers` + `{ type: 'stdio', command, args }` (`VsCodeServerEntry`); everyone else `mcpServers` + `{ command: 'node', args: [serverPath] }` (`StdioServerEntry`).
- `codexBlock(entry): string` => `[mcp_servers.lexicon]\ncommand = "node"\nargs = ["<abs server path>"]` (`CODEX_TABLE`; strings escaped with JSON.stringify, valid TOML basic strings). `upsertTomlTable(text, header, block): { next, changed }` replaces the table from its header line up to the next `[` header (sub-tables such as `[mcp_servers.lexicon.env]` survive), else appends after a blank line. No TOML library.

## src/cli/cmd-trust.ts
- `registerTrustCommands(program, io)` adds `trust [path]` (`--list`) and `untrust [path]`.
- `runTrust(target, opts: TrustOptions { list? }, io)`: resolves the project file for cwd (or the given path), refuses a missing or invalid file, prints a preview table (canonical, first alias, capped rows), then `trustProject` and reports `trusted` / `updated` / `re-pinned` with the registry path. `--list` prints every registry entry with its status (`trusted`, `changed`, `missing`) and notes when `LEXICON_TRUST_ALL` is set.
- `runUntrust(target, opts, io)`: `untrustProject`; reports when the file was not trusted.

## src/cli/cmd-learn.ts
- `registerLearnCommands(program, io)` adds `learn [words...]` (`--from <sentence>`, `--project`, `--json`) and `stats` (`--json`).
- `correctionFromArgs(words, from): Correction | undefined`: `--from` is parsed with `parseCorrection`; exactly two words are `<heard> <meant>`; any other word list is joined and parsed as a sentence.
- `runLearn(words, opts: LearnOptions, io)`: prints the usage examples (`CORRECTION_EXAMPLES`) and returns 1 when nothing parses; otherwise `learnCorrection` and reports the alias added (or already known) and the file. `--project` forces `scope: 'project'`.
- `runStats(opts: StatsOptions, io)`: `computeStats(await loadLexicon({ cwd }))`, rendered by `renderStats(stats)` or as JSON.

## src/cli/cmd-review.ts
Interactive workflows. Every handler takes a `Prompter` (or an injectable spawner) so tests script the answers. `InteractiveOptions extends CommonOptions { globalPath?: string }` is a test hook (no CLI flag) forwarded to the store.
- `runHarvestInteractive(candidates: readonly HarvestCandidate[], opts: HarvestInteractiveOptions, io, prompter: Prompter): Promise<number>`: `opts.cwd` is the harvested root (the project lexicon written to). Checks the trust gate up front: an existing untrusted/changed `.lexicon.yaml` prints the `ProjectTrustError` message to stderr and returns 1 before any prompt; a `ProjectTrustError` thrown mid-walk does the same. Per candidate shows `[i/n] canonical  category, seen Nx`, up to three evidence entries and the suggested aliases, then asks `add? [y/n/e/c/a/q]` (Enter = y): `y` `addTerm(scope: 'project')`, `n` skip, `e` replace aliases with a comma-separated list (the canonical itself is dropped), `c` change category (re-asked until valid), `a` add this and every remaining candidate without asking, `q` stop (the rest counts as skipped). Candidates are copied before editing. Ends with `added N new terms, merged M, skipped S in <path>` and the trusted note.
- `runReview(opts: ReviewOptions, io, prompter?): Promise<number>`: `ReviewOptions extends InteractiveOptions { neverHit?; project?; global?; category? }`. Global file by default, `--project` the project file found for cwd (error when none; `--project` + `--global` is an error). Without a prompter and not on a TTY throws `review needs a terminal ...`. A missing file or an empty selection prints a note and returns 0. An untrusted project file returns 1 with the `ProjectTrustError` message. Per term shows `[i/n] canonical  category, N hits[, source]`, aliases, phonetic and notes, then `[k/d/e/p/n/q]` (Enter = k): `k` keep, `d` delete, `e` edit aliases (comma-separated), `p` phonetic hint (empty clears), `n` notes (empty clears), `q` stop. Writes via `writeLexiconFile` once at the end only when something changed, then `refreshTrust` for a project file. Ends with `kept K, deleted D, edited E, wrote <path>` or `(nothing written)`.
- `runEdit(opts: EditOptions, io, spawnEditor?: SpawnEditor, env?): Promise<number>`: `EditOptions extends InteractiveOptions { project? }`; `SpawnEditor = (command, args, filePath) => Promise<number>` (exit code), default `spawnEditorInherit` (`spawn` with `stdio: 'inherit'`). A missing global file is created empty first. Editor from `$VISUAL` then `$EDITOR`, split on whitespace (`editorCommand(env)`); none set prints the path and returns 0. After the editor exits (a non-zero code is reported on stderr and the file still checked) the file is re-read with `readLexiconFile` (which uses `parseLexicon`): on error prints the message plus `your edits are still in <path>` and returns 1 without touching the file. A project file that was trusted before the edit is re-pinned (`refreshTrust`); an untrusted one stays untrusted with a `lexicon trust` hint.
- `registerReviewCommands(program, io)` adds `review` (`--never-hit`, `--project`, `--global`, `--category <c>`) and `edit` (`--project`).

## src/daemon/clipboard-backends.ts
- `ClipboardBackend { name; description?; read(): Promise<string>; write(text): Promise<void> }`. `read` resolves `''` for an empty or non-text clipboard (the tool exits non-zero or prints nothing); a missing binary (`ENOENT`) or a display/session error still rejects.
- `ClipboardExec = (cmd, args, stdin?) => Promise<string>`; `defaultClipboardExec` spawns without a shell (writes ignore stdout and resolve on exit so `xclip -i`'s forked child cannot hold the pipe). `ExecError { cmd, exitCode, stderr }`.
- `CLIPBOARD_BACKEND_NAMES`, `ClipboardBackendName = 'pbcopy' | 'wl' | 'xclip' | 'xsel' | 'powershell'`, `isClipboardBackendName(v)`, `createClipboardBackend(name, exec?)`, and the factories `pbcopyBackend`, `wlBackend`, `xclipBackend`, `xselBackend`, `powershellBackend`: `pbpaste`/`pbcopy`; `wl-paste --no-newline`/`wl-copy`; `xclip -selection clipboard -o`/`-i`; `xsel --clipboard --output`/`--input`; `powershell -NoProfile -NonInteractive -Command` with `Get-Clipboard -Raw` written via `[Console]::Out.Write` (no trailing newline, UTF-8) and `Set-Clipboard -Value` of `[Console]::In.ReadToEnd()` from stdin. The PowerShell backend normalizes CRLF to `\n` on read and restores CRLF on the next write when the read had it.
- `detectClipboardBackend(platform?, env?, which?, exec?)`: darwin -> pbcopy (both binaries on PATH); linux/BSD -> wl when `WAYLAND_DISPLAY` is set and `wl-paste` + `wl-copy` exist, else xclip, else xsel, else throws with `LINUX_INSTALL_HINT` (`sudo apt install wl-clipboard` / `xclip`); win32 -> powershell (falls back to `pwsh`); anything else throws. `which` defaults to `findOnPath`.
- `findOnPath(bin, opts?: FindOnPathOptions { env?; platform?; exists? })`: splits `PATH` (`;` on win32, `:` elsewhere), on win32 tries each `PATHEXT` extension (default `.COM;.EXE;.BAT;.CMD`, upper then lower case) then the bare name, else requires `X_OK`. No process spawned.

## src/daemon/clipboard.ts
Clipboard watcher for macOS, Linux and Windows using the backends above. `ClipboardCommonOptions { dryRun?; quiet?; cwd?; read?; write?; backend?; platform?; env?; exec?; out?; err? }`; `resolveClipboard(opts)` prefers injected `read`/`write` over `backend`/detection (a single injected function is completed from the detected backend).
- `MAX_CLIPBOARD_CHARS = 20000`, `LEXICON_RELOAD_MS = 5000`, `PASTE_APPLESCRIPT`.
- `runClipboardDaemon(opts: ClipboardDaemonOptions { intervalMs?; signal? })` (loop): poll every 250ms (configurable), if text changed since last seen and normalize changes it, write back, print diff to stdout. Loop guard: remember last written value to avoid rewriting own output. Lexicon re-read at most every 5s. Graceful SIGINT/SIGTERM/`signal`.
- `runClipboardOnce(opts: ClipboardOnceOptions { paste?; sendPaste? }): Promise<ClipboardOnceResult { changed; written; corrections; pasted }>` (`--once`): read once, normalize, write back if changed (unless `dryRun`), print `N correction(s)` + diff or `no changes` (`quiet` silences). With `paste: true` on darwin runs `osascript -e 'tell application "System Events" to keystroke "v" using command down'` (injectable `sendPaste`) whether or not the text changed, and throws with an Accessibility hint if that fails; off darwin it prints a one-line notice to stderr and skips. Empty, oversized (> `MAX_CLIPBOARD_CHARS`) or letterless text is reported as no changes.
- `runDaemonCommand(opts: DaemonCommandOptions { once?; which? } & both option sets): Promise<number>`: `--which` prints `clipboard backend: <name> (<description>)` (+ `--paste` availability) and returns 0, or 1 with the detection error; `--paste` without `--once` throws; `--once` runs once; else loops. `parseBackendName(value)` validates `--backend`. `main(argv)` is the standalone entry. `pbpaste()` / `pbcopy()` remain for callers of the old macOS-only API.
