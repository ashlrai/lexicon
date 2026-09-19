# @ashlr/lexicon

Personal lexicon for voice-to-agents. Maps canonical spellings (Ashlr.AI) to what
speech-to-text actually writes (Ashler, Ashlar) and rewrites transcripts before an
agent sees them. Not a dictation app.

## Layout
- `src/core/` pure library: `types.ts` (contract), `schema.ts`, `store.ts` (YAML files), `matcher.ts` (alias > phonetic > fuzzy), `normalize.ts`, `suggest.ts`, `harvest.ts`, `exporters/`.
- `src/mcp/server.ts` stdio MCP server (bin `lexicon-mcp`). stderr logging only.
- `src/hooks/user-prompt-submit.ts` Claude Code UserPromptSubmit hook (injects corrections as additionalContext, never rewrites the prompt).
- `src/cli/` commander CLI (bin `lexicon`); handlers live in `commands.ts`, `index.ts` only wires commander.
- `src/daemon/clipboard.ts` macOS clipboard watcher.
- `skills/`, `hooks/hooks.json`, `commands/`, `.mcp.json`, `.claude-plugin/plugin.json` make the repo a Claude Code plugin.
- `CONTRACT.md` is the module API contract. Update it when a public signature changes.

## Conventions
- ESM, NodeNext: relative imports end in `.js`. No default exports. No `any` in exported signatures.
- Cross-module imports go through `src/core/index.js` only.
- Tests live in `tests/*.test.ts` (vitest). Core tests import the module directly; MCP/CLI tests mock `src/core/index.js`.
- Lexicon files: global `~/.config/lexicon/lexicon.yaml` (override `LEXICON_PATH`), project `.lexicon.yaml` at git root. Project wins on collision.

## Commands
```bash
npm run build      # tsc -> dist/
npm test           # vitest
npm run typecheck
node dist/mcp/server.js   # manual stdio check
```
