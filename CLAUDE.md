# @ashlr/lexicon

Personal lexicon for voice-to-agents. Maps canonical spellings (Ashlr.AI) to what
speech-to-text actually writes (Ashler, Ashlar) and rewrites transcripts before an
agent sees them. Not a dictation app. Ground truth for every doc is the code;
`CONTRACT.md` is the module API, `docs/ARCHITECTURE.md` the design.

## Layout
- `src/core/` pure library: `types.ts` (contract), `schema.ts`, `store.ts` (YAML files, project-write trust gate), `trust.ts` (trust.json registry), `matcher.ts` (alias > phonetic > fuzzy), `normalize.ts`, `suggest.ts`, `learn.ts` (parseCorrection, learnCorrection, suggestCanonicalFor), `stats.ts`, `harvest.ts`, `exporters/` (15 formats), `importers/` (7 formats + auto). `index.ts` is the only cross-module import path.
- `src/mcp/server.ts` stdio MCP server (bin `lexicon-mcp`): 9 tools, 2 resources, 1 prompt. stderr logging only.
- `src/hooks/user-prompt-submit.ts` Claude Code hook for `UserPromptSubmit` (injects corrections as additionalContext, flags "it's X not Y" corrections for `learn_correction`, never rewrites the prompt or writes to the lexicon) and `SessionStart` (injects the claude-md export, capped at 4000 chars). `runHook` dispatches on `hook_event_name`.
- `plugin/mcp-server.mjs`, `plugin/hook.mjs` committed esbuild bundles that `.mcp.json` and `hooks/hooks.json` point at. `dist/` stays untracked.
- `src/cli/` commander CLI (bin `lexicon`, 21 commands): `index.ts` only wires commander; handlers in `commands.ts` and `cmd-import.ts`, `cmd-install.ts`, `cmd-trust.ts`, `cmd-learn.ts`, `cmd-review.ts` (interactive harvest/review/edit); `prompt.ts` is the readline prompter.
- `src/daemon/clipboard.ts` clipboard watcher (loop and `--once`); `src/daemon/clipboard-backends.ts` pbcopy/wl/xclip/xsel/powershell backends + PATH detection.
- `skills/`, `commands/`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/` make the repo a Claude Code plugin.
- `tests/` vitest, one file per module, `e2e.test.ts` spawns the real CLI/hook/MCP; `bench/` accuracy benchmark; `scripts/` bundle and CLI-docs generators; `docs/CLI.md` is generated.

## Conventions
- ESM, NodeNext: relative imports end in `.js`. No default exports. No `any` in exported signatures.
- Cross-module imports go through `src/core/index.js` only. `src/core/matcher.ts` stays pure (no IO, env or logging).
- Tests live in `tests/*.test.ts` (vitest). Core tests import the module directly; MCP/CLI tests mock `src/core/index.js`. Interactive handlers take a `Prompter` so tests script answers.
- Lexicon files: global `~/.config/lexicon/lexicon.yaml` (override `LEXICON_PATH`), project `.lexicon.yaml` at git root, merged only when trusted (`lexicon trust`). Project wins on collision.
- The hook always exits 0 and stays under 200ms. Stdout is the protocol channel for `mcp` and `hook`; log to stderr.
- No em-dashes in docs or user-facing strings. "Ashlr.AI" (never "Ashlr AI" outside a quoted STT error); `lexicon` for the CLI, `@ashlr/lexicon` for the package.

## Rules
- Rebuild the plugin bundle (`npm run build:bundle`) before committing any change under `src/core`, `src/mcp`, `src/hooks` or a dependency bump, and commit `plugin/`. CI runs `npm run check:bundle` and fails on drift.
- Run `npm run docs:cli` after changing any command or flag so `docs/CLI.md` matches `--help`.
- Update `CONTRACT.md` when a public signature changes; update the README tables when a tool, format or command is added.

## Commands
```bash
npm run build          # tsc -> dist/
npm run build:bundle   # esbuild -> plugin/mcp-server.mjs + plugin/hook.mjs
npm run check:bundle   # rebuild and git diff --exit-code plugin/ (CI)
npm test               # vitest, everything (LEXICON_SKIP_E2E=1 to skip the subprocess journeys)
npm run test:e2e       # only tests/e2e.test.ts
npm run typecheck      # tsc --noEmit
npm run bench          # accuracy benchmark, see bench/README.md
npm run docs:cli       # regenerate docs/CLI.md
node dist/mcp/server.js   # manual stdio check
```
