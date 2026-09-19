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

## src/hooks/user-prompt-submit.ts (bin via `lexicon hook`)
Claude Code UserPromptSubmit hook: reads JSON from stdin ({ prompt, cwd, ... }), runs normalize, and if changed prints
`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<note listing corrections + canonical>"}}`.
Exit 0 always. Must finish < 200ms for a 1KB prompt.
When `loadLexicon` reports `skippedProject`, appends one line naming the path (never the contents) so the user can run `lexicon trust`.

## src/cli/index.ts  (bin: lexicon)
commander. Commands: `init`, `add <canonical> [aliases...]` (`--phonetic`, `--category`, `--notes`, `--project`, `--suggest`, `--never <word...>`), `remove <canonical>`, `list`, `normalize [text]` (stdin if omitted, `--json`, `--diff`),
`harvest [path]` (`--add`, `--limit`, `--min-count`, `--json`), `export <format>` (`--out`), `path`, `doctor`, `mcp` (starts server), `hook` (runs hook), `daemon` (clipboard watcher), `install-claude` (prints/apply `claude mcp add` + hook config), `install [client]` (see `src/cli/cmd-install.ts`).
`trust [path]` (`--list`), `untrust [path]` (cmd-trust.ts). `normalize --include-untrusted`. `list`, `normalize`, `doctor` warn on stderr when a project lexicon was skipped.

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

## src/daemon/clipboard.ts
macOS clipboard watcher: poll `pbpaste` every 250ms (configurable), if text changed since last seen and normalize changes it, write back with `pbcopy`, print diff to stdout. Loop guard: remember last written value to avoid rewriting own output. Graceful SIGINT.

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
