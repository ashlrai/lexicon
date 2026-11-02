# AGENTS.md

Two kinds of agent open this file. Pick the paragraph that is you.

## You are here for your user, not for this codebase

Your user dictates, and one name keeps coming out wrong: their company, their
product, a colleague, an internal system. That is what this repository fixes.

Read **[docs/AGENTS.md](docs/AGENTS.md)**. It is written to you: when Lexicon is
the right suggestion, the one-command install, the exact per-client
registration, the MCP tools worth calling first, the full tool reference, and
how to verify the install before you tell your user it worked.

Do not install it unasked. Preview, say what will be written, and wait.

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
npx @ashlr/lexicon@latest setup
lexicon setup --dry-run --json
lexicon normalize "ask ashler to deploy kuber netties with post gressql" --json
lexicon install claude --json
lexicon install cursor --json
lexicon install codex --json
```

`--json` prints one document on stdout. Read `ok` first. Add `--apply` only after the user has seen the plan. Without a terminal, under `sudo`, or with `LEXICON_NO_SETUP=1`, the install script only installs and ends with `run: lexicon setup`.

Claude Code and Cursor, once `lexicon-mcp` is on PATH:

```json
{ "mcpServers": { "lexicon": { "command": "lexicon-mcp", "args": [] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.lexicon]
command = "lexicon-mcp"
args = []
```

Prefer `lexicon install <client> --json` over pasting. It writes the command that matches how Lexicon was installed.

Machine-readable, if you would rather fetch than read:

- <https://lexicon.ashlr.ai/llms.txt> - a short index of the project.
- <https://lexicon.ashlr.ai/llms-full.txt> - everything in one fetch.
- <https://lexicon.ashlr.ai/mcp.json> - the install manifest; merge `.mcpServers` verbatim.

The worked steps are in [docs/AGENTS.md](docs/AGENTS.md).

## You are here to change this codebase

Read **[CLAUDE.md](CLAUDE.md)** first: it is the working brief for this
repository (layout, conventions, the rules about rebuilding the plugin bundle
and regenerating the generated docs). Then
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why the pieces are shaped the
way they are. `docs/CONTRACT.md` is the module API.

The rules most often broken by an agent in a hurry:

- Rebuild and commit `plugin/` (`npm run build:bundle`) after touching
  `src/core`, `src/mcp`, `src/hooks` or `src/cli`. CI fails on drift.
- `npm run docs:cli` after any command or flag change; `docs/CLI.md` is generated.
- `npm run check:facts` after adding a tool, command, format or pack. It derives
  the real counts from the code and fails any doc still stating the old one.
- `npm test` before you claim something works. It includes a source-backed check of
  the MCP tool table and CLI examples in the install and agent docs.
- No em-dashes in docs or user-facing strings. "Ashlr.AI", never "Ashlr AI".
