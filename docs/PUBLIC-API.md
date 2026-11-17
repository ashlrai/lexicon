# Public package API

Import runtime values and TypeScript types from `@ashlr/lexicon`. The only other package export is `@ashlr/lexicon/package.json` for metadata. The command binaries are `lexicon` and `lexicon-mcp`; see [CLI options](CLI.md), [MCP tools and arguments](MCP.md), and [HTTP routes and fields](LOCAL-API.md). Source paths below identify definitions, not supported package subpaths.

## Runtime inventory

Every value re-exported by `src/core/index.ts`, grouped by its first export. The documentation test compares these names with the loaded namespace.

<!-- public-api:begin -->
| Source relative to src/core | Exports |
|---|---|
| types.ts | `EXPORT_FORMATS`, `TERM_CATEGORIES`, `TERM_SCOPES`, `TERM_SOURCES`, `isTermCategory` |
| schema.ts | `DISPLAY_MAX_CHARS`, `LIMITS`, `LexiconSchema`, `LexiconSettingsSchema`, `MAX_LISTED_ISSUES`, `MODEL_PATH_MAX_CHARS`, `TermCategorySchema`, `TermSchema`, `TermScopeSchema`, `TermSourceSchema`, `UNENCODABLE_NOTE`, `emptyLexicon`, `escapeUnencodable`, `findUnencodableChar`, `hasControlChars`, `neutralizeForModel`, `neutralizeMarkup`, `parseLexicon`, `pathForModel`, `sanitizeForDisplay`, `sanitizeForDisplayMax`, `stripControlChars`, `stripInvisible` |
| store.ts | `CACHE_ENTRIES`, `HITS_FILE_NAME`, `INDEX_CACHE_FILE_NAME`, `INDEX_CACHE_MIN_TERMS`, `MAX_HITS_BYTES`, `MAX_LEXICON_BYTES`, `PARSE_CACHE_FILE_NAME`, `PARSE_CACHE_MIN_BYTES`, `PARSE_CACHE_VERSION`, `PARSE_FAILURE_FILE_NAME`, `PARSE_FAILURE_VERSION`, `PROJECT_FILE_NAME`, `PROJECT_PARSE_CACHE_FILE_NAME`, `PROJECT_PARSE_CACHE_VERSION`, `ProjectTrustError`, `STALE_GLOBAL_MIN_BYTES`, `addTerm`, `addTerms`, `cacheChecksum`, `dedupeAliases`, `defaultProjectPath`, `effectiveHits`, `findTerm`, `getHitsPath`, `hitsRegistryProblem`, `indexCacheProblem`, `isProjectTrustError`, `loadLexicon`, `loadMatcherIndex`, `mergeLexicons`, `projectWriteTrusted`, `readGlobalHits`, `readHitsFor`, `readLexiconFile`, `readProjectHits`, `recordHits`, `refreshIndexCache`, `removeAlias`, `removeTerm`, `resolvePaths`, `resolveScopeWritePath`, `spellingKey`, `termHolders`, `untrustedAliasHolder`, `untrustedTermHolder`, `withLexiconLock`, `writeLexiconFile` |
| edit-check.ts | `EDIT_CHECK_MAX_CHARS`, `checkLexiconEdit` |
| trust.ts | `TRUST_ALL_ENV`, `TRUST_FILE_NAME`, `TRUST_FULL_PREVIEW_NOTE`, `TRUST_MODEL_SAMPLE_MAX_CHARS`, `TRUST_MODEL_SAMPLE_ROWS`, `TRUST_PREVIEW_ROWS`, `TrustContentChangedError`, `TrustRegistryUnreadableError`, `getTrustPath`, `hashFile`, `isTrustContentChangedError`, `isTrustRegistryUnreadableError`, `isTrusted`, `listTrusted`, `parsedContentHash`, `readTrustRegistry`, `refreshTrust`, `restoreTrustEntry`, `trustAllEnabled`, `trustEntryOf`, `trustPreview`, `trustProject`, `trustRegistryProblem`, `trustSummaryForModel`, `untrustProject`, `untrustedByPath`, `withTrustLock`, `writeTrustRegistry` |
| matcher.ts | `DEFAULT_MIN_CONFIDENCE`, `STOPLIST`, `buildIndex`, `findReplacements`, `phoneticCandidates`, `phoneticKey`, `separatorOffsets`, `similarity` |
| matcher/tuning.ts | `INVENTED_BOUNDARY_CONFIDENCE` |
| matcher/tokenize.ts | `codeSpanRanges`, `collectRanges` |
| normalize.ts | `diffSummary`, `normalize`, `normalizeWithIndex`, `timeBudgetIncomplete` |
| collate.ts | `compareText` |
| harvest.ts | `HARVEST_MAX_FILES`, `HARVEST_MAX_LIMIT`, `HARVEST_STOPLIST`, `harvestAliases`, `harvestRepo`, `harvestReport`, `harvestTruncatedNote` |
| import-sources.ts | `IMPLEMENTED_IMPORT_SOURCES`, `IMPORT_SOURCE_IDS`, `applyImportCandidates`, `getImportSource`, `harvestImportSources`, `listImportSources`, `mergeCandidates`, `resolveImportSourceDeps` |
| import-preview.ts | `importCandidateId`, `importCandidatePreview`, `importPreviewDigest`, `selectImportCandidates` |
| exporters/index.ts | `EXPORT_ALIAS_ROW_FORMATS`, `EXPORT_FORMAT_ALIASES`, `EXPORT_FORMAT_INFO`, `EXPORT_MAX_LIMIT`, `exportAssemblyai`, `exportAzure`, `exportClaudeMd`, `exportClaudeMdWithin`, `exportCsv`, `exportDeepgram`, `exportEspanso`, `exportGoogle`, `exportJson`, `exportLexicon`, `exportLexiconWithNotes`, `exportMacos`, `exportMarkdown`, `exportOpenai`, `exportSuperwhisper`, `exportText`, `exportWhisperPrompt`, `exportWispr`, `isExportFormat`, `resolveExportFormat`, `selectExportTerms`, `suggestExportFormat` |
| importers/index.ts | `IMPORT_FORMATS`, `IMPORT_FORMAT_INFO`, `REPLACEMENT_CHAR`, `decodeImportBytes`, `detectImportEncoding`, `detectImportFormat`, `importEncodingError`, `importLexicon`, `isImportFormat`, `mergeRows`, `parseCsvImport`, `parseEspansoImport`, `parseJsonImport`, `parseMacosImport`, `parseMarkdownImport`, `parseSuperwhisperImport`, `parseTextImport`, `parseWisprImport` |
| suggest.ts | `suggestAliases` |
| learn.ts | `CORRECTION_EXAMPLES`, `MAX_CORRECTION_LENGTH`, `conflictNote`, `conflictRemoveCommand`, `conflictRemoveTermCommand`, `learnCorrection`, `learnUnchangedNote`, `parseCorrection`, `reversedCorrectionNote`, `spellingConflicts`, `spellingsAlike`, `suggestCanonicalFor`, `unchangedTermNote` |
| pending.ts | `MAX_PENDING`, `MAX_REJECTED`, `PENDING_FILE_NAME`, `PendingFileError`, `acceptPending`, `alreadyKnown`, `listPending`, `pendingId`, `pendingPath`, `pendingPathFor`, `queueCorrections`, `queueRefusal`, `readPending`, `readPendingFile`, `rejectPending` |
| stats.ts | `NEVER_HIT_CAP`, `TOP_TERMS`, `computeStats` |
| notes.ts | `FIRST_TERM_STEP`, `TRUST_STEP`, `emptyExportNote`, `emptyExportReason`, `emptyLexiconNote`, `emptyNormalizeHint`, `emptyStatsNote`, `noTermMatchesNote`, `noTermsYet`, `offsetPastEndNote`, `onlyUntrustedTerms`, `pageTermList`, `skippedProjectNote` |
| suggestTerms.ts | `AUTO_APPLY_CONFIDENCE`, `STALE_AFTER_DAYS`, `SUGGEST_DEFAULT_LIMIT`, `SUGGEST_MAX_LIMIT`, `VOICE_HISTORY_READ_MAX_BYTES`, `loadVoiceHistory`, `suggestTerms`, `syllableHint`, `voiceHistoryPath` |
| packs.ts | `DEFAULT_PACKS`, `PACKS_DIR_NAME`, `PACK_NAME_RE`, `PackNotFoundError`, `findPackageRoot`, `installLoadedPack`, `installPack`, `installedPacks`, `listPacks`, `loadPack`, `loadPackFile`, `packAlreadyInstalledNote`, `packsDir`, `parsePackText`, `uninstallLoadedPack`, `uninstallPack` |
| registry.ts | `MAX_REGISTRY_FILE_BYTES`, `REGISTRIES_ENV`, `REGISTRY_FETCH_TIMEOUT_MS`, `REGISTRY_REF_RE`, `applyRegistryUpdate`, `assertSecureRegistryUrl`, `assertUserRegistry`, `cachedPackCanonicals`, `cachedPackPath`, `canonicalRegistrySource`, `downloadPack`, `findRegistryEntry`, `findRegistryRecordMismatch`, `installRegistryPack`, `installedRegistryPacks`, `isRegistryRef`, `loadRegistryIndex`, `parseRegistryRef`, `previewRegistryUpdates`, `readRegistryState`, `recordedRegistrySource`, `registryDir`, `registryRecordMismatch`, `resolvePackUrl`, `searchRegistryIndex`, `sha256Hex`, `uninstallRegistryPack`, `userRegistrySources`, `validateCommunityPack`, `verifyPackChecksum`, `writeRegistryState` |
| demo.ts | `DEMO_LEXICON`, `buildDemonstration`, `demonstrate`, `isEmptyLexicon` |
| shell.ts | `commandLine`, `hostPlatform`, `posixShellWord`, `powerShellWord`, `shellWord` |
| ../serve/info.ts | `SERVER_FEATURES`, `ServerInfoSchema` |
<!-- public-api:end -->

## Type inventory

Type-only exports from the same barrel (classes and schemas appear above). The source declarations describe every option and result field; [CONTRACT.md](CONTRACT.md) gives the longer module reference.

`AcceptedAlias`, `AddTermOptions`, `AliasEntry`, `ApplyImportResult`, `CanonicalSuggestion`, `CappedClaudeMd`, `CommunityPackValidation`, `ConcreteImportFormat`, `ConflictNoteAudience`, `Correction`, `CorrectionLexicon`, `DecodedImport`, `Demonstration`, `EmptyExportReason`, `EmptyExportSteps`, `ExportFormat`, `ExportOptions`, `ExportResult`, `ExportSink`, `Exporter`, `HarvestCandidate`, `HarvestOptions`, `HarvestReport`, `HitsRegistry`, `ImportEncoding`, `ImportExec`, `ImportFormat`, `ImportOptions`, `ImportResult`, `ImportRow`, `ImportSkip`, `ImportSource`, `ImportSourceDeps`, `ImportSourceId`, `InstallPackResult`, `InstallRegistryOptions`, `LearnConflict`, `LearnResult`, `LearnUnchangedContext`, `Lexicon`, `LexiconFile`, `LexiconSettings`, `LexiconStats`, `LoadOptions`, `LoadedLexicon`, `LoadedRegistryIndex`, `MatchReason`, `MatcherIndex`, `NormalizeIncomplete`, `NormalizeOptions`, `NormalizeResult`, `Pack`, `PackInfo`, `PackOptions`, `ParseCorrectionOptions`, `PendingAlias`, `PhoneticEntry`, `QueueOptions`, `QueueResult`, `RawImport`, `RegistryDeps`, `RegistryIndex`, `RegistryIndexEntry`, `RegistryPackState`, `RegistryRecordMismatch`, `RegistryRef`, `RegistryState`, `RegistryStoreOptions`, `RegistryUpdatePreview`, `RegistryUpdateReport`, `RejectedAlias`, `RemoveAliasResult`, `Replacement`, `ResolveSelection`, `ServerInfoResponse`, `SourceAvailability`, `StoreOptions`, `SuggestInput`, `SuggestionKind`, `Term`, `TermCategory`, `TermHolder`, `TermLister`, `TermPage`, `TermPageRequest`, `TermScope`, `TermSource`, `TermSuggestion`, `TrustEntry`, `TrustListEntry`, `TrustModelSummary`, `TrustNoteVoice`, `TrustPreview`, `TrustPreviewRow`, `TrustProjectResult`, `TrustRegistry`, `TrustStatus`, `UninstallPackResult`, `UnsupportedImportEncoding`, `VocabImportSource`, `VoiceHistoryEntry`.

## Additional helpers with examples

After `npm i @ashlr/lexicon`, open `node` and paste `const api = await import("@ashlr/lexicon");`. Each expression below then runs independently. Export examples use the built-in demo lexicon. Prefer `exportLexicon` when choosing a format dynamically: it applies filtering and format handling before dispatching to the individual exporters.

| Helper | Purpose and expression |
|---|---|
| `TERM_CATEGORIES` | Valid categories: `api.TERM_CATEGORIES` |
| `TERM_SCOPES` | Writable scopes: `api.TERM_SCOPES` |
| `isTermCategory` | Check a category: `api.isTermCategory("brand")` |
| `REGISTRY_REF_RE` | Recognize a community pack reference: `api.REGISTRY_REF_RE.test("team/names@1.0.0")` |
| `harvestAliases` | Conservative aliases for a harvested name: `api.harvestAliases("Ashlr.AI", "brand")` |
| `isEmptyLexicon` | Check for zero terms: `api.isEmptyLexicon(api.DEMO_LEXICON)` |
| `parseMarkdownImport` | Parse rows before merging: `api.parseMarkdownImport("- **Ashlr.AI**: Ashler")` |
| `phoneticCandidates` | Filter an internal candidate array by length: `api.phoneticCandidates([], 6, 0.82)` |
| `syllableHint` | Propose a pronunciation hint: `api.syllableHint("Kubernetes")` |
| `trustEntryOf` | Read a saved trust entry: `await api.trustEntryOf("./.lexicon.yaml")` |
| `restoreTrustEntry` | Restore a saved entry after rollback; preview removing one: `await api.restoreTrustEntry("./.lexicon.yaml", undefined, { dryRun: true })` |
| `exportAssemblyai` | Render AssemblyAI: `api.exportAssemblyai(api.DEMO_LEXICON)` |
| `exportAzure` | Render Azure: `api.exportAzure(api.DEMO_LEXICON)` |
| `exportClaudeMd` | Render Claude Markdown: `api.exportClaudeMd(api.DEMO_LEXICON)` |
| `exportCsv` | Render CSV: `api.exportCsv(api.DEMO_LEXICON)` |
| `exportDeepgram` | Render Deepgram: `api.exportDeepgram(api.DEMO_LEXICON)` |
| `exportEspanso` | Render espanso: `api.exportEspanso(api.DEMO_LEXICON)` |
| `exportGoogle` | Render Google: `api.exportGoogle(api.DEMO_LEXICON)` |
| `exportJson` | Render JSON: `api.exportJson(api.DEMO_LEXICON)` |
| `exportMacos` | Render macOS: `api.exportMacos(api.DEMO_LEXICON)` |
| `exportMarkdown` | Render Markdown: `api.exportMarkdown(api.DEMO_LEXICON)` |
| `exportOpenai` | Render OpenAI: `api.exportOpenai(api.DEMO_LEXICON)` |
| `exportSuperwhisper` | Render Superwhisper: `api.exportSuperwhisper(api.DEMO_LEXICON)` |
| `exportText` | Render Text: `api.exportText(api.DEMO_LEXICON)` |
| `exportWhisperPrompt` | Render Whisper prompt: `api.exportWhisperPrompt(api.DEMO_LEXICON)` |
| `exportWispr` | Render Wispr: `api.exportWispr(api.DEMO_LEXICON)` |

The following additional types are available to TypeScript callers as `import type { Name } from "@ashlr/lexicon"`. These example declarations use the package type directly:

| Type | Purpose and TypeScript example |
|---|---|
| `ImportExec` | Injectable command runner: `const exec: import("@ashlr/lexicon").ImportExec = (_file, _args) => "";` |
| `LoadedRegistryIndex` | Parsed index and resolution base: `const index: import("@ashlr/lexicon").LoadedRegistryIndex = { index: { packs: [] }, base: "/tmp/packs" };` |
| `RegistryPackState` | Installed pack receipt: `const receipt: import("@ashlr/lexicon").RegistryPackState = { checksum: "0".repeat(64), version: "1.0.0", indexSource: "/tmp/index.json", installedAt: new Date().toISOString() };` |
| `RegistryState` | Installed receipts by reference: `const state: import("@ashlr/lexicon").RegistryState = { packs: {} };` |
| `RegistryUpdateReport` | Update outcome: `const report: import("@ashlr/lexicon").RegistryUpdateReport = { ref: "team/names", status: "not-installed" };` |
| `CommunityPackValidation` | Pack review findings: `const review: import("@ashlr/lexicon").CommunityPackValidation = { errors: [], warnings: [] };` |
